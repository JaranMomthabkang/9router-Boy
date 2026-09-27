import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isPublicModelsProvider } from "@/shared/constants/providers";
import { GEMINI_CONFIG, ZED_HOSTED_CONFIG } from "@/lib/oauth/constants/oauth";
import { refreshGoogleToken, refreshCodexToken, updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { resolveOllamaLocalHost, PROVIDERS } from "open-sse/config/providers.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";
import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { resolveZedModels } from "open-sse/shared/zedAuth.js";
import { resolveClineModels, resolveClinepassModels } from "open-sse/services/clinepassModels.js";
import { parseCloudflareModelsResponse } from "@/lib/cloudflareAiModels";
import { formatModelsFetchError, safeLogDetail } from "@/lib/upstreamErrorDetail";
import { refreshProviderCredentials } from "open-sse/services/oauthCredentialManager.js";

const GEMINI_CLI_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";

// The /codex/models endpoint gates each entry by minimal_client_version against this
// value, and codex CLI's own manifest (openai/codex codex-rs/models-manager/models.json)
// already requires 0.144.0 for its newest models, so a stale client_version here comes
// back 200 with those entries quietly missing instead of erroring.
const CODEX_CLIENT_VERSION = "0.144.6";
const CODEX_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`;

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

const parseGeminiCliModels = (data) => {
  if (Array.isArray(data?.models)) {
    return data.models
      .map((item) => {
        const id = item?.id || item?.model || item?.name;
        if (!id) return null;
        return { id, name: item?.displayName || item?.name || id };
      })
      .filter(Boolean);
  }

  if (data?.models && typeof data.models === "object") {
    return Object.entries(data.models)
      .filter(([, info]) => !info?.isInternal)
      .map(([id, info]) => ({
        id,
        name: info?.displayName || info?.name || id,
      }));
  }

  return [];
};

const appendCodexReviewModels = (models) => models.flatMap((model) => {
  const id = model?.id || model?.slug || model?.model || model?.name;
  if (!id) return [];
  const name = model?.display_name || model?.displayName || model?.name || id;
  const normalized = { ...model, id, name };
  const isChatModel = (model?.type || "llm") !== "image" && !id.toLowerCase().includes("embed");
  if (!isChatModel || id.endsWith("-review")) return [normalized];
  return [
    normalized,
    {
      ...normalized,
      id: `${id}-review`,
      name: `${name} Review`,
      upstreamModelId: id,
      quotaFamily: "review",
    },
  ];
});

const parseCodexModels = (data) => appendCodexReviewModels(parseOpenAIStyleModels(data));

const createOpenAIModelsConfig = (url) => ({
  url,
  method: "GET",
  headers: { "Content-Type": "application/json" },
  authHeader: "Authorization",
  authPrefix: "Bearer ",
  parseResponse: parseOpenAIStyleModels
});

const getStaticProviderModels = (providerId) =>
  getModelsByProviderId(providerId).map((model) => ({
    ...model,
    id: model.id,
    name: model.name || model.id,
  }));

// Enrich models with lastSyncedAt / firstSeenAt from the syncedModels kv.
// Only stamps when models.length > 0 (empty list is a static-fallback signal).
export async function buildModelsResponse({ provider, connectionId, models, warning }) {
  const rawModels = Array.isArray(models) ? models.filter((m) => m && m.id) : [];
  // Dedup by model ID (upstream may return duplicates)
  const seen = new Set();
  const safeModels = [];
  for (const m of rawModels) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    safeModels.push(m);
  }
  let stampMap = {};
  if (safeModels.length > 0 && connectionId) {
    try {
      const db = await import("@/lib/db");
      if (typeof db.stampSyncedModels === "function") {
        await db.stampSyncedModels(safeModels.map((m) => ({ connectionId, modelId: m.id })));
      }
      if (typeof db.getSyncedModelsMap === "function") {
        stampMap = (await db.getSyncedModelsMap()) || {};
      }

      // Extract & persist dynamic capabilities metadata from upstream response
      try {
        if (typeof db.saveModelDynamicCapabilities === "function") {
          for (const m of safeModels) {
            const id = m.id;
            const ctx = m.max_context_window || m.context_length || m.contextWindow || m.context_window || m.maxInputTokens || m.contextLength || m.details?.context_length;
            const vision = m.vision ?? m.supportsImages ?? m.supportsVision ?? m.details?.families?.includes("vision")
              ?? (Array.isArray(m.input_modalities) ? m.input_modalities.includes("image") : undefined);
            
            let resolvedReasoning = undefined;
            if (typeof m.reasoning === "boolean") {
              resolvedReasoning = m.reasoning;
            } else if (Array.isArray(m.thinking) && m.thinking.length > 0) {
              resolvedReasoning = true;
            } else if (typeof m.thinking === "boolean") {
              resolvedReasoning = m.thinking;
            }

            const ctxNum = Number(ctx);
            const hasValidCtx = Number.isFinite(ctxNum) && ctxNum > 0;

            if (hasValidCtx || vision !== undefined || resolvedReasoning !== undefined) {
              const caps = {};
              if (hasValidCtx) caps.contextWindow = ctxNum;
              if (vision !== undefined) caps.vision = Boolean(vision);
              if (resolvedReasoning !== undefined) caps.reasoning = resolvedReasoning;
              await db.saveModelDynamicCapabilities(provider, id, caps);
            }
          }
        }
      } catch (capErr) {
        console.log("Failed to save dynamic capabilities:", capErr?.message);
      }
    } catch (error) {
      console.log("Failed to stamp synced models:", error?.message);
      stampMap = {};
    }
  }
  const enrichedModels = safeModels.map((m) => {
    const entry = stampMap[`${connectionId}:${m.id}`];
    return {
      ...m,
      lastSyncedAt: entry?.lastSyncedAt ?? null,
      firstSeenAt: entry?.firstSeenAt ?? null,
    };
  });
  const payload = {
    provider,
    connectionId,
    models: enrichedModels,
  };
  if (warning !== undefined) payload.warning = warning;
  return NextResponse.json(payload);
}

// Generic custom resolver for OAuth providers that need refresh-on-401 + token persist.
// Receives a `fetchFn(token)` and returns parsed models or throws.
const buildOAuthResolver = ({ refreshFn, fetchFn, parseFn, errorLabel }) => async (connection) => {
  const { accessToken, refreshToken } = connection;
  if (!accessToken) {
    return { error: "No valid token found", status: 401 };
  }
  let warning;
  try {
    let response = await fetchFn(accessToken, connection);
    if (!response.ok && (response.status === 401 || response.status === 403) && refreshToken) {
      const refreshed = await refreshFn(connection);
      if (refreshed?.accessToken) {
        await updateProviderCredentials(connection.id, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken || refreshToken,
          expiresIn: refreshed.expiresIn,
        });
        connection.accessToken = refreshed.accessToken;
        if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
        response = await fetchFn(refreshed.accessToken, connection);
      }
    }
    if (response.ok) {
      const data = await response.json();
      const models = parseFn(data);
      if (models.length > 0) return { models };
    } else {
      const errorText = await response.text();
      warning = `${errorLabel}: ${response.status} ${errorText}`;
      console.log(`${errorLabel} (falling back to static):`, errorText);
    }
  } catch (error) {
    warning = `${errorLabel}: ${error.message}`;
    console.log(`${errorLabel} (falling back to static):`, error.message);
  }
  return { models: [], warning };
};

// Qoder shares one resolver across intl (qoder) and CN (qoder-cn); the
// credentials carry the connection's provider so qoderModels picks the right
// region's catalog endpoint, and the ids keep the provider prefix.
function buildQoderModelsResolver(providerId) {
  return {
    customResolver: async (connection) => {
      const credentials = {
        provider: providerId,
        accessToken: connection.accessToken,
        apiKey: connection.apiKey,
        refreshToken: connection.refreshToken,
        email: connection.email,
        displayName: connection.displayName,
        providerSpecificData: connection.providerSpecificData || {},
      };
      let warning;
      try {
        const result = await resolveQoderModels(credentials, { forceRefresh: true });
        if (result?.models?.length) {
          return {
            models: result.models.map((m) => ({
              // Use the canonical "<providerId>/<key>" id so the dashboard
              // surfaces the same identifier the chat router expects.
              id: `${providerId}/${m.id}`,
              name: m.name,
              contextLength: m.contextLength,
              isVL: m.isVL,
              isReasoning: m.isReasoning,
              maxOutputTokens: m.maxOutputTokens,
              description: m.description,
            })),
          };
        }
        warning = "Qoder returned no models; falling back to static catalog.";
      } catch (error) {
        warning = `Failed to fetch Qoder models: ${error.message}`;
        console.log("Failed to fetch Qoder models dynamically, falling back to static:", error.message);
      }
      return { models: [], warning };
    },
  };
}

// Provider models endpoints configuration
const PROVIDER_MODELS_CONFIG = {
  claude: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Content-Type": "application/json"
    },
    authHeader: "x-api-key",
    parseResponse: (data) => data.data || []
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authQuery: "key", // Use query param for API key
    parseResponse: (data) => data.models || []
  },
  codex: {
    customResolver: buildOAuthResolver({
      refreshFn: (conn) => refreshCodexToken(conn.refreshToken),
      fetchFn: (token) => fetch(CODEX_MODELS_URL, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${token}`,
          "originator": "codex_cli_rs"
        }
      }),
      parseFn: parseCodexModels,
      errorLabel: "Failed to fetch Codex models"
    })
  },
  antigravity: {
    url: "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:models",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    body: {},
    parseResponse: (data) => data.models || []
  },
  github: {
    url: "https://api.githubcopilot.com/models",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
      "editor-version": "vscode/1.107.1",
      "editor-plugin-version": "copilot-chat/0.26.7",
      "user-agent": "GitHubCopilotChat/0.26.7"
    },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => {
      if (!data?.data) return [];
      // Filter out embeddings, non-chat models, and disabled models
      return data.data
        .filter(m => m.capabilities?.type === "chat")
        .filter(m => m.policy?.state !== "disabled") // Only return explicitly enabled models
        .map(m => ({
          id: m.id,
          name: m.name || m.id,
          version: m.version,
          capabilities: m.capabilities,
          isDefault: m.model_picker_enabled === true
        }));
    }
  },
  openai: createOpenAIModelsConfig("https://api.openai.com/v1/models"),
  openrouter: createOpenAIModelsConfig("https://openrouter.ai/api/v1/models"),
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Content-Type": "application/json"
    },
    authHeader: "x-api-key",
    parseResponse: (data) => data.data || []
  },

  alicode: {
    url: "https://coding.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || []
  },
  "alicode-intl": {
    url: "https://coding-intl.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || []
  },
  "alims-intl": {
    url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || []
  },
  "volcengine-ark": createOpenAIModelsConfig("https://ark.cn-beijing.volces.com/api/coding/v3/models"),
  byteplus: createOpenAIModelsConfig("https://ark.ap-southeast.bytepluses.com/api/coding/v3/models"),

  // OpenAI-compatible API key providers
  deepseek: createOpenAIModelsConfig("https://api.deepseek.com/models"),
  groq: createOpenAIModelsConfig("https://api.groq.com/openai/v1/models"),
  xai: createOpenAIModelsConfig("https://api.x.ai/v1/models"),
  mistral: createOpenAIModelsConfig("https://api.mistral.ai/v1/models"),
  perplexity: createOpenAIModelsConfig("https://api.perplexity.ai/v1/models"),
  "perplexity-agent": createOpenAIModelsConfig("https://api.perplexity.ai/v1/models"),
  together: createOpenAIModelsConfig("https://api.together.xyz/v1/models"),
  fireworks: createOpenAIModelsConfig("https://api.fireworks.ai/inference/v1/models"),
  cerebras: createOpenAIModelsConfig("https://api.cerebras.ai/v1/models"),
  cohere: createOpenAIModelsConfig("https://api.cohere.ai/v1/models"),
  nebius: createOpenAIModelsConfig("https://api.studio.nebius.ai/v1/models"),
  siliconflow: createOpenAIModelsConfig("https://api.siliconflow.com/v1/models"),
  hyperbolic: createOpenAIModelsConfig("https://api.hyperbolic.xyz/v1/models"),
  ollama: createOpenAIModelsConfig("https://ollama.com/api/tags"),
  // ollama-local: url resolved dynamically below via providerSpecificData.baseUrl
  nanobanana: createOpenAIModelsConfig("https://api.nanobananaapi.ai/v1/models"),
  chutes: createOpenAIModelsConfig("https://llm.chutes.ai/v1/models"),
  nvidia: createOpenAIModelsConfig("https://integrate.api.nvidia.com/v1/models"),
  assemblyai: createOpenAIModelsConfig("https://api.assemblyai.com/v1/models"),
  "vercel-ai-gateway": createOpenAIModelsConfig("https://ai-gateway.vercel.sh/v1/models"),
  // OpenAI-compatible aggregators.
  tokenharbor: createOpenAIModelsConfig("https://tokenharbor.ai/v1/models"),
  dahl: createOpenAIModelsConfig("https://inference.dahl.global/v1/models"),
  atria: createOpenAIModelsConfig("https://api.atria-asi.ai/v1/models"),
  agnes: createOpenAIModelsConfig("https://apihub.agnes-ai.com/v1/models"),
  bai: createOpenAIModelsConfig("https://api.b.ai/v1/models"),
  kimchi: {
    customResolver: async (connection) => {
      const result = await resolveKimchiModels({
        accessToken: connection.accessToken,
        apiKey: connection.apiKey,
        providerSpecificData: connection.providerSpecificData || {},
      }, { forceRefresh: true, log: console });
      if (result?.models?.length) {
        return { models: result.models };
      }
      return {
        models: getStaticProviderModels("kimchi"),
        warning: "Kimchi returned no live models; falling back to static catalog.",
      };
    }
  },
  cursor: {
    customResolver: async (connection) => {
      const result = await resolveCursorModels({
        accessToken: connection.accessToken,
        providerSpecificData: connection.providerSpecificData || {},
      }, { forceRefresh: true, log: console });
      if (result?.models?.length) return { models: result.models };
      return {
        models: getStaticProviderModels("cursor"),
        warning: "Cursor returned no live models; falling back to static catalog.",
      };
    },
  },
  // Zed has no static catalog by design (live /models only) — same cursor
  // direct pattern: resolve with the connection's own credentials (never
  // exposed to the browser), return rich metadata, drop disabled entries.
  // Empty/failure yields an explicit warning, never a silent zero list.
  zed: {
    customResolver: async (connection) => {
      try {
        const result = await resolveZedModels({
          accessToken: connection.accessToken,
          providerSpecificData: connection.providerSpecificData || {},
        }, { config: ZED_HOSTED_CONFIG, forceRefresh: true });
        const models = (result?.models || [])
          .filter((m) => m && !m.isDisabled)
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            provider: m.provider,
            contextLength: m.contextLength,
            contextLengthInMaxMode: m.contextLengthInMaxMode,
            maxOutputTokens: m.maxOutputTokens,
            supportsTools: m.supportsTools,
            supportsImages: m.supportsImages,
            supportsThinking: m.supportsThinking,
            supportsDisablingThinking: m.supportsDisablingThinking,
            supportsFastMode: m.supportsFastMode,
            supportsServerSideCompaction: m.supportsServerSideCompaction,
            supportedEffortLevels: m.supportedEffortLevels || [],
            supportsStreamingTools: m.supportsStreamingTools,
            supportsParallelToolCalls: m.supportsParallelToolCalls,
          }));
        if (models.length > 0) return { models };
        return { models: [], warning: "Zed returned no live models." };
      } catch (error) {
        console.log("Failed to fetch Zed models dynamically:", error.message);
        return { models: [], warning: `Failed to fetch Zed models: ${error.message}` };
      }
    },
  },

  // Cline/ClinePass share api.cline.bot/api/v1/models. The service layer already
  // handles Bearer-vs-`workos:` auth and swallows failures into null, so these follow
  // the cursor direct pattern (no refreshFn) and only differ in filtering:
  // cline returns the whole catalog verbatim, clinepass keeps cline-pass/* only.
  cline: {
    customResolver: async (connection) => {
      const result = await resolveClineModels({
        accessToken: connection.accessToken,
        apiKey: connection.apiKey,
      });
      if (result?.models?.length) return { models: result.models };
      return {
        models: getStaticProviderModels("cline"),
        warning: "Cline returned no live models; falling back to static catalog.",
      };
    },
  },
  clinepass: {
    customResolver: async (connection) => {
      const result = await resolveClinepassModels({
        accessToken: connection.accessToken,
        apiKey: connection.apiKey,
      });
      if (result?.models?.length) return { models: result.models };
      return {
        models: getStaticProviderModels("clinepass"),
        warning: "ClinePass returned no live models; falling back to static catalog.",
      };
    },
  },

  // Custom resolvers (non-OpenAI-shaped APIs / token-refresh flows)
  kiro: {
    customResolver: async (connection) => {
      const credentials = {
        accessToken: connection.accessToken,
        refreshToken: connection.refreshToken,
        providerSpecificData: connection.providerSpecificData || {}
      };
      let warning;
      try {
        const result = await resolveKiroModels(credentials, {
          log: console,
          onCredentialsRefreshed: async (refreshed) => {
            if (refreshed?.accessToken) {
              await updateProviderCredentials(connection.id, {
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken || connection.refreshToken,
                expiresIn: refreshed.expiresIn,
              });
              connection.accessToken = refreshed.accessToken;
              if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
            }
          }
        });
        if (result?.models?.length) {
          return {
            models: result.models.map((m) => ({
              id: m.id,
              name: m.name,
              upstreamModelId: m.upstreamModelId,
              contextLength: m.contextLength,
              rateMultiplier: m.rateMultiplier,
              capabilities: m.capabilities,
              description: m.description
            }))
          };
        }
        warning = "Kiro returned no models; falling back to static catalog.";
      } catch (error) {
        warning = `Failed to fetch Kiro models: ${error.message}`;
        console.log("Failed to fetch Kiro models dynamically, falling back to static:", error.message);
      }
      return { models: [], warning };
    }
  },
  qoder: buildQoderModelsResolver("qoder"),
  "qoder-cn": buildQoderModelsResolver("qoder-cn"),
  "gemini-cli": {
    customResolver: buildOAuthResolver({
      refreshFn: (conn) => refreshGoogleToken(conn.refreshToken, GEMINI_CONFIG.clientId, GEMINI_CONFIG.clientSecret),
      fetchFn: (token, conn) => {
        const projectId = conn.projectId || conn.providerSpecificData?.projectId;
        const body = projectId ? { project: projectId } : {};
        return fetch(GEMINI_CLI_MODELS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": "google-api-nodejs-client/9.15.1",
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1"
          },
          body: JSON.stringify(body)
        });
      },
      parseFn: parseGeminiCliModels,
      errorLabel: "Failed to fetch Gemini CLI models"
    })
  },
  "grok-cli": {
    customResolver: async (connection) => {
      const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      const result = await resolveGrokCliModels({
        ...connection,
        connectionId: connection.id,
      }, {
        log: console,
        proxyOptions: {
          connectionProxyEnabled: proxy.connectionProxyEnabled === true,
          connectionProxyUrl: proxy.connectionProxyUrl || "",
          connectionNoProxy: proxy.connectionNoProxy || "",
          vercelRelayUrl: proxy.vercelRelayUrl || "",
          strictProxy: proxy.strictProxy === true,
        },
        onCredentialsRefreshed: async (refreshed) => {
          await updateProviderCredentials(connection.id, {
            ...refreshed,
            existingProviderSpecificData: connection.providerSpecificData || {},
          });
        },
      });
      if (result.models.length) return result;
      return {
        models: getStaticProviderModels("grok-cli"),
        warning: result.warning || "Grok CLI returned no live models; using static catalog.",
      };
    },
  },
  "ollama-local": {
    customResolver: async (connection) => {
      const url = `${resolveOllamaLocalHost(connection)}/api/tags`;
      const response = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" }
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.log("Error fetching models from ollama-local:", errorText);
        return { error: `Failed to fetch models: ${response.status}`, status: response.status };
      }
      const data = await response.json();
      const raw = data.models || data.data || [];
      const models = raw.map((m) => {
        if (typeof m === "string") return { id: m, name: m };
        const id = m.name || m.model || m.id;
        if (!id) return null;
        return {
          id,
          name: m.name || m.id || id,
          size: m.size || 0,
          details: m.details || {},
          contextLength: m.contextLength || m.details?.context_length || 0,
          modified_at: m.modified_at,
        };
      }).filter(Boolean);
      return { models };
    }
  },
  "cloudflare-ai": {
    url: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/models/search",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: parseCloudflareModelsResponse,
  },
};

/**
 * GET /api/providers/[id]/models - Get models list from provider
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    let connection = await getProviderConnectionById(id);

    if (!connection) {
      if (isPublicModelsProvider(id)) {
        connection = {
          id: `public:${id}`,
          provider: id,
          authType: "none",
          isActive: true,
        };
      } else {
        return NextResponse.json({ error: "Connection not found" }, { status: 404 });
      }
    }

    if (isOpenAICompatibleProvider(connection.provider)) {
      const baseUrl = connection.providerSpecificData?.baseUrl;
      if (!baseUrl) {
        return NextResponse.json({ error: "No base URL configured for OpenAI compatible provider" }, { status: 400 });
      }
      const url = `${baseUrl.replace(/\/$/, "")}/models`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${connection.apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`Error fetching models from ${connection.provider}:`, safeLogDetail(response.status, errorText));
        return NextResponse.json(
          { error: formatModelsFetchError(response.status, errorText) },
          { status: response.status }
        );
      }

      const data = await response.json();
      const models = data.data || data.models || [];

      return buildModelsResponse({
        provider: connection.provider,
        connectionId: connection.id,
        models
      });
    }

    if (isAnthropicCompatibleProvider(connection.provider)) {
      let baseUrl = connection.providerSpecificData?.baseUrl;
      if (!baseUrl) {
        return NextResponse.json({ error: "No base URL configured for Anthropic compatible provider" }, { status: 400 });
      }

      baseUrl = baseUrl.replace(/\/$/, "");
      if (baseUrl.endsWith("/messages")) {
        baseUrl = baseUrl.slice(0, -9);
      }

      const url = `${baseUrl}/models`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": connection.apiKey,
          "anthropic-version": "2023-06-01",
          "Authorization": `Bearer ${connection.apiKey}`
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`Error fetching models from ${connection.provider}:`, safeLogDetail(response.status, errorText));
        return NextResponse.json(
          { error: formatModelsFetchError(response.status, errorText) },
          { status: response.status }
        );
      }

      const data = await response.json();
      const models = data.data || data.models || [];

      return buildModelsResponse({
        provider: connection.provider,
        connectionId: connection.id,
        models
      });
    }

    let config = PROVIDER_MODELS_CONFIG[connection.provider];
    const pDef = PROVIDERS[connection.provider];

    if (!config && pDef) {
      const baseUrl = pDef.baseUrl || pDef.transport?.baseUrl || "";
      const modelsUrl = pDef.transport?.validateUrl ||
        (baseUrl ? baseUrl.replace(/\/chat\/completions$/, "/models").replace(/\/conversation$/, "/models").replace(/\/messages$/, "/models") : "");

      if (modelsUrl) {
        config = {
          url: modelsUrl,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            ...(pDef.transport?.headers || pDef.headers || {}),
          },
          authHeader: pDef.authHeader === "x-api-key" ? "x-api-key" : (pDef.authType === "none" ? undefined : "Authorization"),
          authPrefix: pDef.authHeader === "x-api-key" ? "" : (pDef.authType === "none" ? "" : "Bearer "),
          parseResponse: (data) => parseOpenAIStyleModels(data),
        };
      }
    }

    if (!config) {
      const staticModels = pDef?.models || [];
      if (staticModels.length > 0) {
        return buildModelsResponse({
          provider: connection.provider,
          connectionId: connection.id,
          models: staticModels.map((m) => typeof m === "string" ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id, ...m }),
        });
      }
      return NextResponse.json(
        { error: `Provider ${connection.provider} does not support models listing` },
        { status: 400 }
      );
    }

    // Config-driven custom resolver path (OAuth refresh, non-OpenAI shape, etc.)
    if (typeof config.customResolver === "function") {
      const result = await config.customResolver(connection);
      if (result.error) {
        return NextResponse.json({ error: result.error }, { status: result.status || 500 });
      }
      return buildModelsResponse({
        provider: connection.provider,
        connectionId: connection.id,
        models: result.models,
        warning: result.warning
      });
    }

    // Get auth token
    let token = connection.providerSpecificData?.copilotToken || connection.accessToken || connection.apiKey;
    if (!token && !isPublicModelsProvider(connection.provider)) {
      return NextResponse.json({ error: "No valid token found" }, { status: 401 });
    }

    // Build request URL
    let url = config.url;
    if (url.includes("{accountId}")) {
      const accountId = connection.providerSpecificData?.accountId;
      if (!accountId) {
        return NextResponse.json({ error: "cloudflare-ai requires accountId in providerSpecificData" }, { status: 400 });
      }
      url = url.replace("{accountId}", encodeURIComponent(accountId));
    }
    if (config.authQuery && token) {
      url += `?${config.authQuery}=${token}`;
    }

    // Build headers
    const headers = { ...config.headers };
    if (config.authHeader && !config.authQuery && token) {
      headers[config.authHeader] = (config.authPrefix || "") + token;
    }

    // Make request
    const fetchOptions = {
      method: config.method,
      headers
    };

    if (config.body && config.method === "POST") {
      fetchOptions.body = JSON.stringify(config.body);
    }

    let response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (networkErr) {
      console.log(`Network error fetching models from ${connection.provider}:`, networkErr?.message);
      const staticModels = pDef?.models || [];
      if (staticModels.length > 0) {
        return buildModelsResponse({
          provider: connection.provider,
          connectionId: connection.id,
          models: staticModels.map((m) => typeof m === "string" ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id, ...m }),
        });
      }
      throw networkErr;
    }

    // OAuth token refresh on 401/403
    const usesCopilotToken = !!connection.providerSpecificData?.copilotToken;
    const isGoogleCliProvider = connection.provider === "antigravity" || connection.provider === "gemini-cli";
    const isRefreshableStatus = isGoogleCliProvider ? response.status === 401 : (response.status === 401 || response.status === 403);
    if (
      !response.ok &&
      isRefreshableStatus &&
      connection.refreshToken &&
      !usesCopilotToken
    ) {
      try {
        const refreshed = await refreshProviderCredentials(connection.provider, connection, console);

        if (refreshed?.accessToken) {
          await updateProviderCredentials(connection.id, refreshed);

          token = refreshed.accessToken;
          if (config.authHeader && !config.authQuery && token) {
            headers[config.authHeader] = (config.authPrefix || "") + token;
          }
          response = await fetch(url, fetchOptions);
        }
      } catch (refreshError) {
        console.log(`Error refreshing token for ${connection.provider}:`, refreshError);
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`Error fetching models from ${connection.provider}:`, safeLogDetail(response.status, errorText));
      const staticModels = pDef?.models || [];
      const isPublic = connection.id?.startsWith("public:") || isPublicModelsProvider(connection.provider);
      if (staticModels.length > 0 && isPublic) {
        return buildModelsResponse({
          provider: connection.provider,
          connectionId: connection.id,
          models: staticModels.map((m) => typeof m === "string" ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id, ...m }),
        });
      }
      return NextResponse.json(
        { error: formatModelsFetchError(response.status, errorText) },
        { status: response.status }
      );
    }

    const data = await response.json();
    const parsed = config.parseResponse(data);
    let models = (Array.isArray(parsed) && parsed.length > 0) ? [...parsed] : (pDef?.models ? [...pDef.models] : []);

    return buildModelsResponse({
      provider: connection.provider,
      connectionId: connection.id,
      models
    });
  } catch (error) {
    console.log("Error fetching provider models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}
