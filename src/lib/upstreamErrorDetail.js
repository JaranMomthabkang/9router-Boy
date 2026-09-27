// Classify an upstream error into one of OUR OWN fixed explanations.
const REASONS = {
  billing: "out of credits or subscription required (billing, not auth — refreshing the token will not help)",
  quota: "usage quota or rate limit exceeded — retry later",
  auth_invalid: "credentials rejected by the upstream — re-authenticate this connection",
  auth_expired: "credentials expired and could not be refreshed — re-authenticate this connection",
  auth_missing: "no credentials were accepted — check the connection is configured",
  permission: "this account lacks permission for the models endpoint",
  not_found: "the models endpoint was not found at this base URL",
  unsupported: "the upstream does not support listing models",
  server: "the upstream reported a server-side error — retry later",
  unavailable: "the upstream is temporarily unavailable or overloaded — retry later",
  timeout: "the upstream timed out",
  network: "could not reach the upstream — check the base URL and network",
  blocked: "the request was blocked by the upstream (region, policy, or firewall)",
};

const SIGNALS = [
  [/out of credits|no credits|insufficient[_ -](?:credits|balance|funds|quota)|spending[- ]?limit|payment required|subscription (?:required|expired)|billing|past due|add credits|top ?up|upgrade your plan/, "billing"],
  [/rate ?limit|too many requests|quota (?:exceeded|exhausted)|usage limit|throttl|resource[- ]?exhausted/, "quota"],
  [/(?:token|credentials?|key|session|grant|authorization|jwt|login)\b[^.]{0,20}\bexpired|expired[^.]{0,20}\b(?:token|credentials?|key|session|grant)/, "auth_expired"],
  [/invalid[_ ]?(?:api[_ ]?)?key|incorrect api key|invalid token|invalid[_ ]?grant|invalid credentials?|authentication[_ ]?(?:failed|error)|could not be validated|unauthenticated|bad credentials|signature (?:mismatch|invalid)|revoked/, "auth_invalid"],
  [/missing (?:api ?key|token|credential|authorization)|no (?:api ?key|token|credentials?) (?:provided|supplied|found)|api ?key (?:is )?required|authorization (?:header )?required/, "auth_missing"],
  [/\bblocked\b|\bgeo(?:graphic|graphical|blocking|-?restricted)?\b|region(?:al)? (?:not )?(?:supported|restricted|policy)|country (?:not )?(?:supported|allowed)|firewall|policy violation|denied by (?:the )?(?:(?:regional|geo|country|network) )?(?:policy|firewall|gateway|proxy|cdn|waf)\b/, "blocked"],
  [/permission|forbidden|not authorized|unauthorized_client|insufficient (?:permission|scope|privileges)|access denied|\b(?:missing|invalid|insufficient|required) scopes?\b|\bscopes? (?:missing|invalid|required|insufficient)\b/, "permission"],
  [/not found|no such (?:model|endpoint|route)|unknown (?:model|endpoint)|404|does not exist/, "not_found"],
  [/not supported|unsupported|not implemented|method not allowed/, "unsupported"],
  [/timed? ?out|timeout|deadline exceeded|etimedout/, "timeout"],
  [/unavailable|overloaded|high load|capacity|try again later|temporarily|maintenance|503/, "unavailable"],
  [/econnrefused|enotfound|dns|connect(?:ion)? (?:refused|error|reset)|socket hang ?up|network/, "network"],
  [/internal (?:server )?error|server error|bad gateway|upstream error|exception|traceback/, "server"],
];

const STATUS_REASONS = {
  401: "auth_invalid",
  402: "billing",
  403: "permission",
  404: "not_found",
  405: "unsupported",
  408: "timeout",
  429: "quota",
  501: "unsupported",
  502: "unavailable",
  503: "unavailable",
  504: "timeout",
};

const MAX_MATCH_LENGTH = 16384;

const INVISIBLE_RANGES = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f],
  [0x061c, 0x061c], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
];
const INVISIBLE = new RegExp(
  "[" + INVISIBLE_RANGES.map(([lo, hi]) => `${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`).join("") + "]",
  "g"
);

function normalize(body) {
  return String(body).replace(INVISIBLE, "").replace(/\s+/g, " ").toLowerCase();
}

function toStatusCode(status) {
  if (typeof status === "number") {
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  }
  if (typeof status === "string" && status.length <= 16) {
    const trimmed = status.trim();
    if (/^[1-5]\d{2}$/.test(trimmed)) return Number(trimmed);
  }
  return null;
}

function statusLabel(code) {
  return code === null ? "unknown status" : String(code);
}

export function classifyUpstreamError(status, body) {
  if (typeof body === "string" && body.length > 0) {
    const haystack = normalize(body.slice(0, MAX_MATCH_LENGTH));
    if (haystack.trim()) {
      for (const [pattern, reason] of SIGNALS) {
        if (pattern.test(haystack)) return reason;
      }
    }
  }
  const code = toStatusCode(status);
  if (code === null) return null;
  if (Object.hasOwn(STATUS_REASONS, code)) return STATUS_REASONS[code];
  return code >= 500 ? "server" : null;
}

export function explainUpstreamError(status, body) {
  const reason = classifyUpstreamError(status, body);
  return reason && Object.hasOwn(REASONS, reason) ? REASONS[reason] : "";
}

export function formatModelsFetchError(status, body) {
  const detail = explainUpstreamError(status, body);
  const label = statusLabel(toStatusCode(status));
  return detail ? `Failed to fetch models: ${label} — ${detail}` : `Failed to fetch models: ${label}`;
}

export function safeLogDetail(status, body) {
  const reason = classifyUpstreamError(status, body);
  const codeUnits = typeof body === "string" ? body.length : 0;
  return `status=${statusLabel(toStatusCode(status))} reason=${reason || "unclassified"} body=${codeUnits}codeUnits (not logged)`;
}

export const UPSTREAM_ERROR_REASONS = Object.freeze({ ...REASONS });
