/**
 * Parse Cloudflare Workers AI /ai/models/search API response.
 * Handles both legacy boolean task flags and modern { id, name } task objects.
 * Supports @cf/ (Workers AI) and @hf/ (HuggingFace) model slugs.
 */
const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isWorkersAiSlug = (s) =>
  typeof s === "string" && s.length > 0 && (s.startsWith("@cf/") || s.startsWith("@hf/")) && !IS_UUID.test(s);

function resolveModelId(m) {
  const nameStr = typeof m?.name === "string" ? m.name : "";
  const idStr = typeof m?.id === "string" ? m.id : "";
  if (isWorkersAiSlug(nameStr)) return nameStr;
  if (isWorkersAiSlug(idStr)) return idStr;
  // Fallback: use first non-UUID value, then nameStr as last resort
  if (idStr && !IS_UUID.test(idStr)) return idStr;
  if (nameStr && !IS_UUID.test(nameStr)) return nameStr;
  return null;
}

function taskKeyFromTask(task) {
  if (!task) return "";
  if (typeof task === "string") return task.toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
  if (typeof task.name === "string" && task.name.trim()) return task.name.toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
  // Legacy boolean flags
  if (task["text-generation"] || task["text_generation"]) return "text-generation";
  if (task["text-to-image"]) return "text-to-image";
  if (task["text-to-text"]) return "text-to-text";
  if (task["image-to-text"]) return "image-to-text";
  if (task["image-text-to-text"]) return "image-text-to-text";
  return "";
}

function kindForTaskKey(key) {
  if (!key) return null;
  if (
    key === "text-generation" ||
    key === "text-to-text" ||
    key === "image-to-text" ||
    key === "image-text-to-text" ||
    key === "chat" ||
    key === "visual-question-answering" ||
    key.startsWith("visual-")
  ) {
    return "llm";
  }
  if (key === "text-to-image") return "image";
  return null;
}

export function parseCloudflareModelsResponse(data) {
  const list = Array.isArray(data?.result) ? data.result : Array.isArray(data) ? data : [];
  return list
    .map((m) => {
      const modelId = resolveModelId(m);
      if (!modelId) return null;
      const kind = kindForTaskKey(taskKeyFromTask(m?.task));
      if (!kind) return null;
      return {
        id: modelId,
        name: m?.name || modelId,
        description: m?.description || "",
        kind,
      };
    })
    .filter(Boolean);
}
