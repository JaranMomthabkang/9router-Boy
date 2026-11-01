import { describe, expect, it } from "vitest";

import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { ANTIGRAVITY_IDE_USER_AGENT } from "../../open-sse/providers/shared.js";
import { applyThinking, stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("Antigravity client fingerprint", () => {
  // Upstream gates the catalog AND serves models by UA scheme: `antigravity/ide/*`
  // returns 23 legacy models and 404s on Gemini 4 Argon, `antigravity/hub/*` returns
  // 26 including gemini-4-argon-{high,medium,low}.
  it("uses the hub UA scheme so the Argon tiers are reachable", () => {
    expect(ANTIGRAVITY_IDE_USER_AGENT).toBe("antigravity/hub/2.24.0 darwin/arm64");
    expect(antigravity.transport.headers["User-Agent"]).toBe(ANTIGRAVITY_IDE_USER_AGENT);
  });

  it("registers all three Argon tiers ahead of the flash models", () => {
    const ids = antigravity.models.map((m) => m.id);
    expect(ids.slice(0, 3)).toEqual([
      "gemini-4-argon-high",
      "gemini-4-argon-medium",
      "gemini-4-argon-low",
    ]);
  });
});

describe("Gemini 4 Argon capabilities", () => {
  it("declares level-based always-on reasoning", () => {
    const caps = getCapabilitiesForModel("antigravity", "gemini-4-argon-high");
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
    expect(getThinkingLevels("antigravity", "gemini-4-argon-high")).toEqual(["low", "medium", "high"]);
  });
});

describe("Gemini 4 Argon thinking clamp", () => {
  // Argon rejects thinkingLevel "minimal" (and thinkingBudget) with HTTP 400 —
  // every path that would emit "minimal" must clamp to the lowest supported level.
  const agBody = (extra = {}) => ({
    model: "gemini-4-argon-high",
    request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    ...extra,
  });

  it("clamps an explicit reasoning_effort none to low", () => {
    const body = agBody({ reasoning_effort: "none" });
    applyThinking("antigravity", "gemini-4-argon-high", body, "antigravity");
    expect(body.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("passes supported levels through untouched", () => {
    const body = agBody({ reasoning_effort: "high" });
    applyThinking("antigravity", "gemini-4-argon-high", body, "antigravity");
    expect(body.request.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });

  it("keeps minimal for Gemini 3 models (regression guard)", () => {
    const body = { model: "gemini-3.8-flash-high", request: { contents: [] }, reasoning_effort: "none" };
    applyThinking("antigravity", "gemini-3.8-flash-high", body, "antigravity");
    expect(body.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal", includeThoughts: false });
  });
});

describe("Gemini 4 Argon Antigravity tier", () => {
  it.each([
    ["gemini-4-argon-high", "high"],
    ["gemini-4-argon-medium", "medium"],
    ["gemini-4-argon-low", "low"],
  ])("maps %s to the wire model with a %s thinking level", (modelId, expectedLevel) => {
    const upstreamModel = getModelUpstreamId("ag", modelId);
    expect(upstreamModel).toBe(`${modelId}(${expectedLevel})`);

    const body = {
      model: stripThinkingSuffix(upstreamModel),
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: {},
      },
    };

    applyThinking("antigravity", upstreamModel, body, "antigravity");
    const finalBody = new AntigravityExecutor().transformRequest(
      modelId,
      body,
      true,
      { projectId: "project", connectionId: "connection" }
    );

    expect(finalBody.model).toBe(modelId);
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: expectedLevel, includeThoughts: true });
  });
});
