import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MAX_RECORDS = 3000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
// 1-day retention: requestDetails blobs dominate DB size (615MB/10k rows
// observed); dashboard history beyond a day is not worth the disk.
const DEFAULT_RETENTION_DAYS = 1;
const PRUNE_THROTTLE_MS = 5 * 60 * 1000; // 5 min
let lastPruneTs = 0;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

function parseNum(val, fallback) {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim() !== "") {
    const parsed = parseInt(val, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function resetPruneThrottle() {
  lastPruneTs = 0;
}

export function pruneRequestDetailsSync(adapter, config = {}) {
  const retentionDays = parseNum(config.retentionDays, DEFAULT_RETENTION_DAYS);
  const maxRecords = parseNum(config.maxRecords, DEFAULT_MAX_RECORDS);

  if (retentionDays > 0) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    try { adapter.run(`DELETE FROM requestDetails WHERE timestamp < ?`, [cutoff]); } catch {}
  }

  if (maxRecords > 0) {
    try {
      const cnt = adapter.get(`SELECT COUNT(*) as c FROM requestDetails`);
      if (cnt && cnt.c > maxRecords) {
        adapter.run(
          `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
          [cnt.c - maxRecords]
        );
      }
    } catch {}
  }
}

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envRequestLogs = process.env.ENABLE_REQUEST_LOGS;
    const envFallback = process.env.OBSERVABILITY_ENABLED !== "false";
    const uiFlag = typeof settings.enableObservability === "boolean";
    const enabled = envRequestLogs !== undefined
      ? envRequestLogs.toLowerCase() === "true"
      : (uiFlag ? settings.enableObservability : envFallback);

    cachedConfig = {
      enabled,
      maxRecords: parseNum(settings.observabilityMaxRecords, parseNum(process.env.OBSERVABILITY_MAX_RECORDS, DEFAULT_MAX_RECORDS)),
      retentionDays: parseNum(settings.observabilityRetentionDays, parseNum(process.env.OBSERVABILITY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)),
      batchSize: parseNum(settings.observabilityBatchSize, parseNum(process.env.OBSERVABILITY_BATCH_SIZE, DEFAULT_BATCH_SIZE)),
      flushIntervalMs: parseNum(settings.observabilityFlushIntervalMs, parseNum(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS, DEFAULT_FLUSH_INTERVAL_MS)),
      maxJsonSize: parseNum(settings.observabilityMaxJsonSize, parseNum(process.env.OBSERVABILITY_MAX_JSON_SIZE, 5)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      retentionDays: DEFAULT_RETENTION_DAYS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

export const __test__ = { sanitizeHeaders };

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function estimatePayloadSize(obj) {
  if (typeof obj?.prompt === "string") return obj.prompt.length;
  let total = 0;
  const list = Array.isArray(obj?.messages) ? obj.messages : (Array.isArray(obj?.contents) ? obj.contents : null);
  if (list) {
    for (const item of list) {
      if (typeof item?.content === "string") {
        total += item.content.length;
      } else if (Array.isArray(item?.content)) {
        for (const block of item.content) {
          if (typeof block?.text === "string") total += block.text.length;
        }
      } else if (Array.isArray(item?.parts)) {
        for (const part of item.parts) {
          if (typeof part?.text === "string") total += part.text.length;
        }
      }
      if (total > 64 * 1024) break;
    }
  }
  return total;
}

function truncateField(obj, maxSize) {
  if (!obj) return {};
  if (typeof obj === "string") {
    if (obj.length > maxSize) {
      return { _truncated: true, _originalSize: obj.length, _preview: obj.substring(0, 200) };
    }
    return obj;
  }
  const est = estimatePayloadSize(obj);
  if (est > maxSize) {
    let preview = "[large payload]";
    if (typeof obj.prompt === "string") preview = obj.prompt.substring(0, 200);
    else if (Array.isArray(obj.messages) && typeof obj.messages[0]?.content === "string") preview = obj.messages[0].content.substring(0, 200);
    return { _truncated: true, _originalSize: est, _preview: preview };
  }
  const str = JSON.stringify(obj);
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj;
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, writeBuffer.length);
      const db = await getAdapter();
      const config = await getObservabilityConfig();

      db.transaction(() => {
        for (const item of items) {
          if (!item.id) item.id = generateDetailId(item.model);
          if (!item.timestamp) item.timestamp = new Date().toISOString();
          if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

          const record = {
            id: item.id,
            provider: item.provider || null,
            model: item.model || null,
            connectionId: item.connectionId || null,
            timestamp: item.timestamp,
            status: item.status || null,
            latency: item.latency || {},
            tokens: item.tokens || {},
            request: truncateField(item.request, config.maxJsonSize),
            providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
            providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
            response: truncateField(item.response, config.maxJsonSize),
            pxpipe: item.pxpipe || undefined,
          };

          db.run(
            `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`,
            [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(record)]
          );
        }

        // Time-based retention (throttled to at most once per 5 minutes):
        const nowMs = Date.now();
        if (config.retentionDays > 0 && (nowMs - lastPruneTs >= PRUNE_THROTTLE_MS)) {
          const cutoff = new Date(nowMs - config.retentionDays * 24 * 60 * 60 * 1000).toISOString();
          db.run(`DELETE FROM requestDetails WHERE timestamp < ?`, [cutoff]);
          lastPruneTs = nowMs;
        }

        // Count cap as a safety net: keep the newest maxRecords rows
        if (config.maxRecords > 0) {
          const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
          if (cnt && cnt.c > config.maxRecords) {
            db.run(
              `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
              [cnt.c - config.maxRecords]
            );
          }
        }
      });
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) {return;}

  writeBuffer.push(detail);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getDistinctProviders() {
  const db = await getAdapter();
  const rows = db.all(`SELECT DISTINCT provider FROM requestDetails WHERE provider IS NOT NULL ORDER BY provider ASC`);
  return rows.map((r) => r.provider);
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

const _shutdownHandler = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();
