/**
 * Misc usage handlers (iFlow, Ollama, GLM, Vercel AI Gateway, Qoder)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";

export { getGlmUsage } from "./glm.js";


// Vercel AI Gateway credits endpoint
// Returns { balance: "95.50", total_used: "4.50" } (USD as decimal strings).
const VERCEL_AI_GATEWAY_CREDITS_URL = U("vercel-ai-gateway").url;

/**
 * iFlow Usage
 */
export async function getIflowUsage(accessToken) {
  try {
    // iFlow may have usage endpoint
    return { message: "iFlow connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch iFlow usage." };
  }
}

const OLLAMA_LIMIT_WINDOWS = {
  session: "Session (5h)",
  weekly: "Weekly (7d)",
  monthly: "Monthly",
};

// Ollama runs the session and weekly windows on a fixed global schedule — they
// are not per-account rolling windows — and /api/usage reports only how much of
// each is used, never when it ends (ollama/ollama#15660, #15663). Both are
// derived here from the schedule and match the timestamp the settings page
// itself renders for a real window:
//   session — every 5h on the Unix-epoch grid. The grid lands on whole hours
//             but drifts 4h/day (86400 % 18000 ≠ 0), so it is NOT midnight
//             based; it is not per-account, because a rolling window would
//             start at the first request. Sample: 2026-04-23T11:00:00Z.
//   weekly  — Monday 00:00 UTC. Sample: 2026-04-27T00:00:00Z. Note that
//             activity.period.starting_at is NOT this boundary — it marks a
//             rolling last_4_weeks activity window and lands on any weekday.
const OLLAMA_SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const OLLAMA_WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function nextOllamaSessionReset(now = new Date()) {
  const nowMs = now.getTime();
  const intoPeriod = ((nowMs % OLLAMA_SESSION_WINDOW_MS) + OLLAMA_SESSION_WINDOW_MS) % OLLAMA_SESSION_WINDOW_MS;
  return new Date(nowMs + (OLLAMA_SESSION_WINDOW_MS - intoPeriod)).toISOString();
}

function nextOllamaWeeklyReset(now = new Date()) {
  const dayOffset = (now.getUTCDay() + 6) % 7; // Monday = 0 … Sunday = 6
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOffset);
  return new Date(start + OLLAMA_WEEKLY_WINDOW_MS).toISOString();
}

function addUtcMonths(date, months) {
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year, month, Math.min(date.getUTCDate(), lastDay),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
  ));
}

// Monthly included usage resets on the anniversary of the billing period, in
// UTC, clamping to a shorter month's last day and restoring the original day
// afterwards: "usage resets monthly on the same day of the month your
// subscription started" for paid plans, "monthly from the date you signed up"
// on Free (ollama.com/pricing). Either date works as the anchor — a period end
// that is already current is returned as-is, an older one rolls forward.
function nextMonthlyReset(anchorDate, now = new Date()) {
  const anchor = new Date(anchorDate);
  if (Number.isNaN(anchor.getTime())) return null;
  const elapsedMonths = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12
    + (now.getUTCMonth() - anchor.getUTCMonth());
  for (let i = Math.max(0, elapsedMonths); i <= elapsedMonths + 1; i++) {
    const candidate = addUtcMonths(anchor, i);
    if (candidate > now) return candidate.toISOString();
  }
  return null;
}

// /api/me is served by a Go struct, so SubscriptionPeriodEnd arrives as a
// nullable-time object ({ Time, Valid }) — but tolerate a bare string too, in
// case the field is ever serialised differently.
function readMeDate(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && value.Valid === true && typeof value.Time === "string") {
    return value.Time;
  }
  return null;
}

/**
 * Ollama Cloud Usage
 * GET https://ollama.com/api/usage — `limits.<window>.usage` is a 0..1 ratio
 *   (1.0 = limit reached). Paid plans report session (5h) + weekly (7d); the
 *   free plan reports a single monthly window. No reset timestamp exposed, so
 *   session/weekly are derived from Ollama's fixed global window schedule and
 *   monthly from the billing-period anchor on /api/me.
 * POST https://ollama.com/api/me — plan label, CreatedAt, SubscriptionPeriodEnd
 *   (fail-open).
 * Auth: Authorization: Bearer <apiKey>
 */
export async function getOllamaUsage(apiKey, providerSpecificData, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Ollama Cloud API key not available." };
  }

  try {
    const response = await proxyAwareFetch("https://ollama.com/api/usage", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Ollama Cloud API key invalid or expired." };
    }

    if (!response.ok) {
      return { message: `Ollama Cloud usage API error (${response.status}).` };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return { message: "Ollama Cloud usage response was not JSON." };
    }

    // Best-effort plan label from /api/me
    const me = await proxyAwareFetch("https://ollama.com/api/me", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Length": "0",
      },
    }, proxyOptions).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const planRaw = typeof me?.Plan === "string" ? me.Plan : "";
    const plan = planRaw
      ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1).toLowerCase()
      : "Ollama Cloud";

    const limits = data?.limits && typeof data.limits === "object" ? data.limits : {};

    // Ollama `usage` is a 0..1 ratio (1.0 = limit reached). Convert to a 0..100
    // bar. Do NOT set absolute `remaining` — QuotaTable reads remainingPercentage.
    function ratioQuota(usageRatio, resetAt = null) {
      const ratio = Math.max(0, Math.min(1, Number(usageRatio) || 0));
      const usedPct = Math.round(ratio * 100);
      return { used: usedPct, total: 100, remainingPercentage: 100 - usedPct, resetAt, unlimited: false };
    }

    const now = new Date();
    // Monthly needs an anchor Ollama does not put on /api/usage. Use the
    // billing-period end when /api/me reports one; otherwise fall back to the
    // signup date, which is the documented anniversary on Free and a good
    // approximation on paid plans whose anniversary matches their signup day.
    const monthlyAnchor = readMeDate(me?.SubscriptionPeriodEnd) || readMeDate(me?.CreatedAt);
    const resetAtFor = {
      session: () => nextOllamaSessionReset(now),
      weekly: () => nextOllamaWeeklyReset(now),
      monthly: (anchor) => (anchor ? nextMonthlyReset(anchor, now) : null),
    };

    const quotas = {};
    for (const [key, label] of Object.entries(OLLAMA_LIMIT_WINDOWS)) {
      const raw = limits[key]?.usage;
      if (raw === undefined || raw === null) continue;
      const ratio = Number(raw);
      if (Number.isNaN(ratio)) continue;
      quotas[label] = ratioQuota(ratio, resetAtFor[key](monthlyAnchor));
    }

    if (Object.keys(quotas).length === 0) {
      return {
        plan,
        message: "Ollama Cloud connected. No usage limits reported.",
        quotas: {},
      };
    }

    return { plan, quotas };
  } catch (error) {
    return { message: `Ollama Cloud error: ${error.message}` };
  }
}



/**
 * Vercel AI Gateway usage — credit balance for the API key
 *
 * Calls GET /v1/credits which returns:
 *   { "balance": "95.50", "total_used": "4.50" }   (USD as decimal strings)
 *
 * We surface this as a single "Balance ($)" quota row so the existing
 * QuotaTable / progress-bar UI can render it. used = total_used,
 * total = balance + total_used (the original credit allotment), so the
 * remaining percentage equals balance / total.
 *
 * Docs: https://vercel.com/docs/ai-gateway/usage
 */
export async function getVercelAiGatewayUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Vercel AI Gateway API key not available." };
  }

  try {
    const response = await proxyAwareFetch(VERCEL_AI_GATEWAY_CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Vercel AI Gateway API key invalid or expired." };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const trimmed = errorText ? `: ${errorText.slice(0, 200)}` : "";
      return { message: `Vercel AI Gateway credits API error (${response.status})${trimmed}` };
    }

    const data = await response.json();

    // Vercel returns numeric strings; coerce safely.
    const balance = Number(data?.balance) || 0;
    const totalUsed = Number(data?.total_used) || 0;

    // Vercel gives $5/month free credit. The API doesn't return the
    // monthly allocation so we use the known constant as the denominator.
    const MONTHLY_CREDIT = 5;
    const remainingPercentage = (balance / MONTHLY_CREDIT) * 100;

    if (balance <= 0 && totalUsed <= 0) {
      return {
        plan: "Pay-as-you-go",
        message: "Vercel AI Gateway connected. No credit allocation found (BYOK or unfunded account).",
        quotas: {},
      };
    }

    // "Used (USD)": how much has been spent this month (no fixed cap → unlimited).
    // "Remaining (USD)": balance remaining out of the $5 monthly allocation.
    return {
      plan: "Pay-as-you-go",
      quotas: {
        "Used (USD)": {
          used: totalUsed,
          total: 0,
          remaining: 0,
          remainingPercentage: 100,
          unlimited: true,
        },
        "Remaining (USD)": {
          used: balance,
          total: MONTHLY_CREDIT,
          remaining: balance,
          remainingPercentage,
          unlimited: false,
        },
      },
    };
  } catch (error) {
    return { message: `Vercel AI Gateway error: ${error.message}` };
  }
}

export async function getQoderUsage(accessToken, proxyOptions = null, providerId = "qoder") {
  if (!accessToken) {
    return { message: "Qoder usage unavailable: no access token" };
  }
  try {
    const response = await proxyAwareFetch(
      U(providerId).url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    if (!response.ok) {
      return { message: `Qoder connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    if (!body) {
      return { message: "Qoder connected. Usage response was not JSON." };
    }
    // Quota records live under `quotas`; scalar metadata
    // (totalUsagePercentage, isQuotaExceeded, expiresAt) are surfaced as
    // siblings so the dashboard parser doesn't try to render them as rows.
    const userQuota = body.userQuota || {};
    const orgQuota = body.orgResourcePackage || {};
    // Qoder publishes a single absolute reset timestamp (`expiresAt` in ms);
    // surface it on every quota record as ISO so the table can render
    // "resets at" alongside used/total.
    const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
      ? Number(body.expiresAt)
      : null;
    const resetAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;
    const quotas = {
      user: {
        total: Number(userQuota.total) || 0,
        used: Number(userQuota.used) || 0,
        remaining: Number(userQuota.remaining) || 0,
        unit: userQuota.unit || "credits",
        resetAt,
      },
      organization: {
        total: Number(orgQuota.total) || 0,
        used: Number(orgQuota.used) || 0,
        remaining: Number(orgQuota.remaining) || 0,
        unit: orgQuota.unit || "credits",
        resetAt,
      },
    };
    return {
      quotas,
      totalUsagePercentage: Number(body.totalUsagePercentage) || 0,
      isQuotaExceeded: !!body.isQuotaExceeded,
      expiresAt: expiresAtMs,
    };
  } catch (error) {
    return { message: `Qoder connected. Unable to fetch usage: ${error.message}` };
  }
}
