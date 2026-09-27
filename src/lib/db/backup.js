// DB safety backups — taken ONLY before a schema change (see migrate.js).
//
// ⚠️ AGENT/DEV NOTES:
// - Backups are a best-effort safety net before schema migrations. There is NO
//   automated restore path; recovery is manual (copy a backup file back).
// - Backups intentionally EXCLUDE the `requestDetails` table (observability log,
//   auto-pruned, non-critical) so a multi-hundred-MB DB backs up as a few MB.
// - Only the newest KEEP_BACKUPS are kept; older ones are pruned automatically.
import fs from "node:fs";
import path from "node:path";
import { BACKUPS_DIR, ensureDirs } from "./paths.js";
import { timestampSlug, getAppVersion } from "./version.js";

function parseNonNeg(val, fallback) {
  if (val === undefined || val === null || val === "") return fallback;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const KEEP_BACKUPS = parseNonNeg(process.env.KEEP_BACKUPS, 2);
const KEEP_BACKUPS_TOTAL_BYTES = parseNonNeg(process.env.KEEP_BACKUPS_TOTAL_BYTES, 3 * 1024 * 1024 * 1024);

// Tables excluded from safety backups (large, non-critical, reproducible).
const BACKUP_EXCLUDE_TABLES = ["requestDetails"];

export function makeBackupDir(label) {
  ensureDirs();
  const ver = getAppVersion();
  const slug = `${label}-${ver}-${timestampSlug()}`;
  const dir = path.join(BACKUPS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function backupFile(srcPath, destDir, destName = null) {
  if (!fs.existsSync(srcPath)) return null;
  const name = destName || path.basename(srcPath);
  const dest = path.join(destDir, name);
  fs.copyFileSync(srcPath, dest);
  return dest;
}

function dirSize(full) {
  let total = 0;
  const stack = [full];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else total += fs.statSync(p).size;
    }
  }
  return total;
}

// Lightweight DB backup via ATTACH: create an empty sqlite file, copy every
// table EXCEPT the excluded ones into it. Avoids duplicating the huge
// observability log, so the backup stays small regardless of DB size.
export function backupDbLite(adapter, destDir, destName = "data.sqlite") {
  const dest = path.join(destDir, destName);
  try { fs.rmSync(dest, { force: true }); } catch {}
  const escaped = dest.replace(/'/g, "''");

  adapter.exec(`ATTACH DATABASE '${escaped}' AS bak`);
  try {
    const excluded = new Set(BACKUP_EXCLUDE_TABLES);
    const tables = adapter
      .all(`SELECT name, sql FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .filter((t) => !excluded.has(t.name));

    adapter.transaction(() => {
      for (const t of tables) {
        // Recreate table structure in backup DB, then copy rows.
        const createSql = t.sql.replace(/CREATE TABLE\s+/i, "CREATE TABLE bak.");
        adapter.exec(createSql);
        adapter.exec(`INSERT INTO bak.${t.name} SELECT * FROM main.${t.name}`);
      }
    });
  } finally {
    try { adapter.exec("DETACH DATABASE bak"); } catch {}
  }
  return dest;
}

export function pruneOldBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  let entries;
  try {
    entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, full: path.join(BACKUPS_DIR, e.name), mtime: fs.statSync(path.join(BACKUPS_DIR, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return; // fail-open: prune must never break startup
  }

  for (const old of entries.slice(KEEP_BACKUPS)) {
    try { fs.rmSync(old.full, { recursive: true, force: true }); } catch {}
  }

  // Size budget: after the count cap, still trim oldest-first until the
  // remaining backups fit under KEEP_BACKUPS_TOTAL_BYTES. The newest is always kept.
  const kept = entries.slice(0, KEEP_BACKUPS);
  let total = 0;
  const sizes = new Map();
  for (const e of kept) {
    try { sizes.set(e.full, dirSize(e.full)); } catch { sizes.set(e.full, 0); }
  }
  for (const e of kept) total += sizes.get(e.full) || 0;
  for (const e of kept.slice().reverse()) {
    if (total <= KEEP_BACKUPS_TOTAL_BYTES) break;
    if (e === kept[0]) break; // never delete the newest
    try { fs.rmSync(e.full, { recursive: true, force: true }); } catch { continue; }
    total -= sizes.get(e.full) || 0;
  }
}
