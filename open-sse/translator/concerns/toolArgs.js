// Shared helpers for OpenAI-shaped → Claude streaming translators.
// Used by both response/openai-to-claude.js and response/kiro-to-claude.js
// so the two direct Claude routes don't drift.

// Repair duplicated / repeated JSON objects emitted by upstream proxies or
// cumulative streams: exact-half repeats ("{...}" + "{...}") and concatenated
// objects ("{...}{...}"). Returns the original string when nothing matches.
export function repairDuplicatedJsonArguments(raw) {
  if (typeof raw !== "string" || raw.length < 4) return raw;
  try {
    JSON.parse(raw);
    return raw;
  } catch {}

  const len = raw.length;
  if (len % 2 === 0) {
    const half = raw.slice(0, len / 2);
    if (half === raw.slice(len / 2)) {
      try {
        JSON.parse(half);
        return half;
      } catch {}
    }
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const objects = [];
    const chunks = [];
    let depth = 0;
    let inString = false;
    let escape = false;
    let start = 0;
    let lastEnd = 0;

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === "{") {
        if (depth === 0) {
          if (trimmed.slice(lastEnd, i).trim().length > 0) return raw;
          start = i;
        }
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const chunk = trimmed.slice(start, i + 1);
          lastEnd = i + 1;
          try {
            objects.push(JSON.parse(chunk));
            chunks.push(chunk);
          } catch {
            return raw;
          }
        }
      }
    }

    if (depth === 0 && trimmed.slice(lastEnd).trim().length === 0 && chunks.length > 1) {
      const firstStr = JSON.stringify(objects[0]);
      const allIdentical = objects.every((obj) => JSON.stringify(obj) === firstStr);
      if (allIdentical) {
        return chunks[0];
      }
    }
  }

  return raw;
}
