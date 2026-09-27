import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const USAGE_URL = "https://ollama.com/api/usage";
const ME_URL = "https://ollama.com/api/me";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE_USAGE = {
  activity: {
    cost: "0.00000",
    period: {
      type: "last_4_weeks",
      starting_at: "2026-07-01T00:00:00Z",
      ending_at: "2026-07-29T00:00:00Z",
    },
    models: [],
  },
  limits: {
    session: { usage: 0, models: [] },
    weekly: {
      usage: 1,
      models: [
        { name: "glm-5.2", request_count: 5967 },
        { name: "kimi-k2.5", request_count: 2 },
      ],
    },
  },
};

const SAMPLE_FREE_USAGE = {
  activity: {
    cost: "0.00000",
    period: {
      type: "last_4_weeks",
      starting_at: "2026-08-24T00:00:00Z",
      ending_at: "2026-09-18T15:03:00Z",
    },
    models: [],
  },
  limits: {
    monthly: {
      usage: 0.021,
      models: [
        { name: "gpt-oss:120b", request_count: 6 },
        { name: "gemma4:31b", request_count: 6 },
      ],
    },
  },
};

const SAMPLE_ME = {
  Plan: "max",
};

describe("ollama registry usage flags", () => {
  it("is listed for apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("ollama");
    expect(USAGE_APIKEY_PROVIDERS).toContain("ollama");
  });
});

describe("getUsageForProvider(ollama)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("GETs /api/usage with Bearer apiKey and POSTs /api/me for plan", async () => {
    // Pin the clock: session/weekly resets are derived from Ollama's fixed
    // global schedule, not from anything in the response.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));

    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(SAMPLE_USAGE))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_ME));

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "k",
      providerSpecificData: {},
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Max");
    expect(usage.quotas["Session (5h)"]).toMatchObject({
      used: 0,
      total: 100,
      remainingPercentage: 100,
      unlimited: false,
    });
    expect(usage.quotas["Weekly (7d)"]).toMatchObject({
      used: 100,
      total: 100,
      remainingPercentage: 0,
      unlimited: false,
    });
    // Must not set absolute remaining — UI treats remaining as %
    expect(usage.quotas["Session (5h)"].remaining).toBeUndefined();
    expect(usage.quotas["Weekly (7d)"].remaining).toBeUndefined();

    // Session resets on the next 5h Unix-epoch boundary, weekly next Monday
    // 00:00 UTC. Verified against the stamps ollama.com/settings renders.
    expect(usage.quotas["Session (5h)"].resetAt).toBe("2026-09-27T13:00:00.000Z");
    expect(usage.quotas["Weekly (7d)"].resetAt).toBe("2026-09-28T00:00:00.000Z");

    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);

    const [usageUrl, usageOpts] = proxyAwareFetch.mock.calls[0];
    expect(usageUrl).toBe(USAGE_URL);
    expect(usageOpts.headers.Authorization).toBe("Bearer k");
    expect(usageOpts.headers.Accept).toBe("application/json");

    const [meUrl, meOpts] = proxyAwareFetch.mock.calls[1];
    expect(meUrl).toBe(ME_URL);
    expect(meOpts.method).toBe("POST");
    expect(meOpts.headers.Authorization).toBe("Bearer k");
    expect(meOpts.headers["Content-Length"]).toBe("0");
  });

  it("maps the free plan's monthly window", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(SAMPLE_FREE_USAGE))
      .mockResolvedValueOnce(jsonResponse({ Plan: "free" }));

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "k",
      providerSpecificData: {},
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Free");
    expect(Object.keys(usage.quotas)).toEqual(["Monthly"]);
    expect(usage.quotas["Monthly"]).toMatchObject({
      used: 2,
      total: 100,
      remainingPercentage: 98,
      unlimited: false,
    });
    expect(usage.quotas["Monthly"].remaining).toBeUndefined();
    // No anchor on /api/me, so the monthly anniversary is unknowable.
    expect(usage.quotas["Monthly"].resetAt).toBeNull();
  });

  describe("session/weekly resets follow Ollama's fixed global schedule", () => {
    async function resetsAt(now) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      proxyAwareFetch
        .mockResolvedValueOnce(jsonResponse(SAMPLE_USAGE))
        .mockResolvedValueOnce(jsonResponse(SAMPLE_ME));

      const usage = await getUsageForProvider({
        provider: "ollama",
        apiKey: "k",
        providerSpecificData: {},
      });
      return {
        session: usage.quotas["Session (5h)"].resetAt,
        weekly: usage.quotas["Weekly (7d)"].resetAt,
      };
    }

    it("uses the next 5h Unix-epoch boundary, which drifts across the day", async () => {
      // The 5h grid is not midnight-aligned (86400 % 18000 ≠ 0): on 2026-09-27
      // the boundaries are 03:00 / 08:00 / 13:00 / 18:00 / 23:00 UTC.
      expect((await resetsAt("2026-09-27T12:00:00Z")).session).toBe("2026-09-27T13:00:00.000Z");
      expect((await resetsAt("2026-09-27T13:00:01Z")).session).toBe("2026-09-27T18:00:00.000Z");
      // A real stamp from the settings page: 2026-04-23T11:00:00Z sits exactly
      // on the grid, so the next reset is five hours later.
      expect((await resetsAt("2026-04-23T11:00:00Z")).session).toBe("2026-04-23T16:00:00.000Z");
    });

    it("uses Monday 00:00 UTC for the weekly window", async () => {
      expect((await resetsAt("2026-08-16T12:00:00Z")).weekly).toBe("2026-08-17T00:00:00.000Z");
      // Exactly on the boundary rolls a full week forward.
      expect((await resetsAt("2026-08-17T00:00:00Z")).weekly).toBe("2026-08-24T00:00:00.000Z");
    });
  });

  describe("monthly reset from the billing-period anchor", () => {
    async function monthlyResetAt(me, now) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      proxyAwareFetch
        .mockResolvedValueOnce(jsonResponse(SAMPLE_FREE_USAGE))
        .mockResolvedValueOnce(jsonResponse(me));

      const usage = await getUsageForProvider({
        provider: "ollama",
        apiKey: "k",
        providerSpecificData: {},
      });
      return usage.quotas["Monthly"].resetAt;
    }

    it("prefers the billing period end, which /api/me sends as a Go NullTime", async () => {
      const me = {
        Plan: "pro",
        CreatedAt: "2025-09-06T22:15:39.871687Z",
        SubscriptionPeriodEnd: { Time: "2026-10-02T18:08:50Z", Valid: true },
      };
      expect(await monthlyResetAt(me, "2026-09-18T15:03:00Z")).toBe("2026-10-02T18:08:50.000Z");
    });

    it("falls back to the signup date when no period end is reported", async () => {
      expect(await monthlyResetAt(
        { Plan: "free", CreatedAt: "2025-09-06T22:15:39.871687Z" },
        "2026-09-18T15:03:00Z",
      )).toBe("2026-10-06T22:15:39.000Z");
    });

    it("ignores a NullTime whose Valid flag is false", async () => {
      const me = {
        Plan: "pro",
        CreatedAt: "2025-09-06T22:15:39.871687Z",
        SubscriptionPeriodEnd: { Time: "2026-10-02T18:08:50Z", Valid: false },
      };
      expect(await monthlyResetAt(me, "2026-09-18T15:03:00Z")).toBe("2026-10-06T22:15:39.000Z");
    });

    it("stays in the current month when the anniversary day is still ahead", async () => {
      expect(await monthlyResetAt(
        { Plan: "free", CreatedAt: "2026-09-18T09:50:49.514335Z" },
        "2026-09-18T15:33:33Z",
      )).toBe("2026-10-18T09:50:49.000Z");
      expect(await monthlyResetAt(
        { Plan: "free", CreatedAt: "2025-09-25T10:00:00Z" },
        "2026-09-18T15:33:33Z",
      )).toBe("2026-09-25T10:00:00.000Z");
    });

    it("clamps the anniversary day to shorter months", async () => {
      expect(await monthlyResetAt(
        { Plan: "free", CreatedAt: "2026-01-31T12:00:00Z" },
        "2026-02-10T00:00:00Z",
      )).toBe("2026-02-28T12:00:00.000Z");
    });
  });

  it("reports no limits when no known window is present", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ activity: {}, limits: {} }))
      .mockResolvedValueOnce(jsonResponse({ Plan: "free" }));

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "k",
      providerSpecificData: {},
    });

    expect(usage.message).toMatch(/no usage limits/i);
    expect(usage.quotas).toEqual({});
  });

  it("surfaces invalid key message on 401", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ error: "unauthorized" }, 401),
    );

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "bad",
    });

    expect(usage.message).toMatch(/invalid/i);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("returns message when apiKey missing", async () => {
    const usage = await getUsageForProvider({
      provider: "ollama",
      providerSpecificData: {},
    });

    expect(usage.message).toMatch(/api key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("parseQuotaData(ollama)", () => {
  it("forwards remainingPercentage for dashboard bars", () => {
    const rows = parseQuotaData("ollama", {
      plan: "Max",
      quotas: {
        "Session (5h)": {
          used: 0,
          total: 100,
          remainingPercentage: 100,
          resetAt: null,
        },
        "Weekly (7d)": {
          used: 100,
          total: 100,
          remainingPercentage: 0,
          resetAt: null,
        },
      },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "Session (5h)",
      used: 0,
      total: 100,
      remainingPercentage: 100,
    });
    expect(rows[1]).toMatchObject({
      name: "Weekly (7d)",
      used: 100,
      total: 100,
      remainingPercentage: 0,
    });
  });
});
