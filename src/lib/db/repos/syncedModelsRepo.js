import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function entryKey(connectionId, modelId) {
  return `${connectionId}:${modelId}`;
}

export async function getSyncedModelsMap() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = 'syncedModels'`);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, {});
  return out;
}

// entries: [{ connectionId, modelId }]
// Returns the map of just-stamped keys → { lastSyncedAt, firstSeenAt }.
export async function stampSyncedModels(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return {};
  const db = await getAdapter();
  const now = new Date().toISOString();
  const stamped = {};

  db.transaction(() => {
    for (const { connectionId, modelId } of entries) {
      if (!connectionId || !modelId) continue;
      const key = entryKey(connectionId, modelId);
      const row = db.get(`SELECT value FROM kv WHERE scope = 'syncedModels' AND key = ?`, [key]);
      const existing = row ? parseJson(row.value, {}) : {};
      const firstSeenAt = existing.firstSeenAt || now;
      const value = { lastSyncedAt: now, firstSeenAt };
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('syncedModels', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [key, stringifyJson(value)]
      );
      stamped[key] = value;
    }
  });

  return stamped;
}

export async function upsertSyncedModel(connectionId, modelId) {
  return await stampSyncedModels([{ connectionId, modelId }]);
}

/**
 * Dynamic Capabilities Repo
 * Stores & reads model capabilities extracted dynamically from provider sync APIs or online lookup.
 *
 * Keys are scoped `providerId:modelId` so one provider's synced capabilities cannot bleed
 * into the same model id on another connection.
 */
function capabilityKey(providerId, modelId) {
  const baseId = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  return providerId ? `${providerId}:${baseId}` : baseId;
}

export async function getModelDynamicCapabilities(providerId, modelId) {
  if (!modelId) return null;
  const scoped = capabilityKey(providerId, modelId);
  const db = await getAdapter();
  let row = db.get(`SELECT value FROM kv WHERE scope = 'modelCapabilities' AND key = ?`, [scoped]);
  if (!row && providerId) {
    // Legacy bare-key rows
    row = db.get(`SELECT value FROM kv WHERE scope = 'modelCapabilities' AND key = ?`, [modelId.split("/").pop()]);
  }
  if (!row) return null;
  return parseJson(row.value, null);
}

/**
 * Bulk-read all synced dynamic capabilities into a Map keyed by the raw row
 * key (`providerId:baseId`, or legacy bare `baseId`).
 */
export async function getAllModelDynamicCapabilities() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = 'modelCapabilities'`);
  const out = new Map();
  for (const r of rows) {
    const caps = parseJson(r.value, null);
    if (!caps || typeof caps !== "object") continue;
    const cw = caps.contextWindow;
    if (!Number.isFinite(cw) || cw <= 0) continue;
    const { updatedAt, ...clean } = caps;
    out.set(r.key, clean);
  }
  return out;
}

export async function saveModelDynamicCapabilities(providerId, modelId, caps) {
  if (!modelId || !caps) return;
  const key = capabilityKey(providerId, modelId);
  const db = await getAdapter();
  const now = new Date().toISOString();
  const value = { ...caps, updatedAt: now };
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES('modelCapabilities', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [key, stringifyJson(value)]
  );
}
