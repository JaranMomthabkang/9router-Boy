import { ROLE } from "../schema/index.js";

// Build OpenAI delta carrying reasoning_content (optional leading assistant role)
export function reasoningDelta(text, withRole = false) {
  return withRole
    ? { role: ROLE.ASSISTANT, reasoning_content: text }
    : { reasoning_content: text };
}

// Extract reasoning text from a streamed OpenAI-compatible delta across vendor shapes:
//   - reasoning_content (GLM, Qwen, DeepSeek, Kimi, Step, Hunyuan)
//   - reasoning (some compat layers)
//   - reasoning_details[] (MiniMax reasoning_split=true): [{ text|content }]
// Returns concatenated reasoning string, or "" when none.
export function extractReasoningText(delta) {
  if (!delta || typeof delta !== "object") return "";
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) return delta.reasoning_content;
  if (typeof delta.reasoning === "string" && delta.reasoning) return delta.reasoning;
  const details = delta.reasoning_details;
  if (Array.isArray(details)) {
    return details.map((d) => (typeof d === "string" ? d : d?.text || d?.content || "")).join("");
  }
  return "";
}

/**
 * Stateful stream processor for inline <think>...</think> or <reasoning>...</reasoning> tags.
 * Preserves reasoning by separating thinking content from regular text across SSE chunks.
 *
 * @param {string} text incoming delta content
 * @param {object} state stream state object (persisted across chunks)
 * @returns {{ thinking: string, text: string }} extracted thinking and text fragments
 */
export function processStreamThinkingTags(text, state) {
  if (typeof text !== "string" || !text || !state) return { thinking: "", text: text || "" };

  if (state.inInlineThinking === undefined) state.inInlineThinking = false;
  if (!state.thinkingTagBuffer) state.thinkingTagBuffer = "";

  const full = state.thinkingTagBuffer + text;
  state.thinkingTagBuffer = "";

  let thinkingOut = "";
  let textOut = "";
  let cursor = 0;

  while (cursor < full.length) {
    if (state.inInlineThinking) {
      const closeThink = full.toLowerCase().indexOf("</think>", cursor);
      const closeReasoning = full.toLowerCase().indexOf("</reasoning>", cursor);

      let closeIdx = -1;
      let closeLen = 0;
      if (closeThink !== -1 && (closeReasoning === -1 || closeThink < closeReasoning)) {
        closeIdx = closeThink;
        closeLen = 8;
      } else if (closeReasoning !== -1) {
        closeIdx = closeReasoning;
        closeLen = 12;
      }

      if (closeIdx !== -1) {
        thinkingOut += full.slice(cursor, closeIdx);
        state.inInlineThinking = false;
        cursor = closeIdx + closeLen;
      } else {
        const partialCloseMatch = full.slice(cursor).match(/<\/?(?:t(?:h(?:i(?:n(?:k)?)?)?)?|r(?:e(?:a(?:s(?:o(?:n(?:i(?:n(?:g)?)?)?)?)?)?)?)?)$/i);
        if (partialCloseMatch) {
          const cut = full.length - partialCloseMatch[0].length;
          thinkingOut += full.slice(cursor, cut);
          state.thinkingTagBuffer = partialCloseMatch[0];
          break;
        } else {
          thinkingOut += full.slice(cursor);
          break;
        }
      }
    } else {
      const openThink = full.toLowerCase().indexOf("<think>", cursor);
      const openReasoning = full.toLowerCase().indexOf("<reasoning>", cursor);

      let openIdx = -1;
      let openLen = 0;
      if (openThink !== -1 && (openReasoning === -1 || openThink < openReasoning)) {
        openIdx = openThink;
        openLen = 7;
      } else if (openReasoning !== -1) {
        openIdx = openReasoning;
        openLen = 11;
      }

      if (openIdx !== -1) {
        textOut += full.slice(cursor, openIdx);
        state.inInlineThinking = true;
        cursor = openIdx + openLen;
      } else {
        const partialOpenMatch = full.slice(cursor).match(/<(?:t(?:h(?:i(?:n(?:k)?)?)?)?|r(?:e(?:a(?:s(?:o(?:n(?:i(?:n(?:g)?)?)?)?)?)?)?)?)$/i);
        if (partialOpenMatch) {
          const cut = full.length - partialOpenMatch[0].length;
          textOut += full.slice(cursor, cut);
          state.thinkingTagBuffer = partialOpenMatch[0];
          break;
        } else {
          textOut += full.slice(cursor);
          break;
        }
      }
    }
  }

  return { thinking: thinkingOut, text: textOut };
}
