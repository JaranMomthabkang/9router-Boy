import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, CLAUDE_BLOCK, MODEL_FALLBACK } from "../schema/index.js";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../config/defaultThinkingSignature.js";
import { fromOpenAIFinish } from "../concerns/finishReason.js";
import { extractReasoningText, processStreamThinkingTags } from "../concerns/reasoning.js";
import { accumulateToolName } from "../concerns/toolCall.js";
import { repairDuplicatedJsonArguments } from "../concerns/toolArgs.js";

// Legacy "proxy_" prefix used by older request translators. Response strips it
// defensively so tool names from such turns resolve back (e.g. proxy_Read → Read
// for arg sanitization). Current request translator emits no prefix ("") — strip
// is then a no-op. Kept intentionally; do NOT couple to request's empty prefix.
const CLAUDE_OAUTH_TOOL_PREFIX = "proxy_";

// Sanitize tool call arguments to fix bad params from non-Anthropic models
function sanitizeToolArgs(toolName, argsJson) {
  try {
    const args = JSON.parse(argsJson);
    const name = toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
      ? toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
      : toolName;
    if (name === "Read") sanitizeReadArgs(args);
    return JSON.stringify(args);
  } catch {
    return argsJson;
  }
}

function sanitizeReadArgs(args) {
  if (typeof args.limit === "string" && /^\d+$/.test(args.limit)) args.limit = Number(args.limit);
  if (typeof args.offset === "string" && /^-?\d+$/.test(args.offset)) args.offset = Number(args.offset);

  if (typeof args.limit === "number") {
    if (args.limit > 2000) args.limit = 2000;
    if (args.limit < 1) delete args.limit;
  }
  if (typeof args.offset === "number" && args.offset < 0) args.offset = 0;

  if ("pages" in args && !isValidPdfPagesArg(args.file_path, args.pages)) {
    delete args.pages;
  }
}

function isValidPdfPagesArg(filePath, pages) {
  return typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".pdf") &&
    typeof pages === "string" &&
    /^\d+(?:-\d+)?$/.test(pages);
}

// Helper: stop thinking block if started
function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({
    type: "content_block_stop",
    index: state.thinkingBlockIndex
  });
  state.thinkingBlockStarted = false;
}

// Helper: stop text block if started
function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({
    type: "content_block_stop",
    index: state.textBlockIndex
  });
  state.textBlockStarted = false;
}

// Convert OpenAI stream chunk to Claude format
export function openaiToClaudeResponse(chunk, state) {
  // Stream teardown (flush path passes null): drop pending whitespace so
  // pooled/reused state cannot leak it into the next stream. Non-null
  // chunks without choices[0] are legitimate metadata/usage frames
  // (e.g. stream_options.include_usage) — ignore without touching state.
  if (!chunk) {
    if (state) state.leadingWhitespaceBuf = "";
    return null;
  }
  if (!chunk.choices?.[0]) return null;

  const results = [];
  const choice = chunk.choices[0];
  const delta = choice.delta;

  // Track usage from OpenAI chunk if available
  if (chunk.usage && typeof chunk.usage === "object") {
    const promptTokens = typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : 0;
    const outputTokens = typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : 0;

    // Extract cache tokens from prompt_tokens_details
    const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
    const cacheCreationTokens = chunk.usage.prompt_tokens_details?.cache_creation_tokens;
    const cacheReadTokens = typeof cachedTokens === "number" ? cachedTokens : 0;
    const cacheCreateTokens = typeof cacheCreationTokens === "number" ? cacheCreationTokens : 0;

    // input_tokens = prompt_tokens - cached_tokens - cache_creation_tokens
    // Because OpenAI's prompt_tokens includes all prompt-side tokens
    const inputTokens = promptTokens - cacheReadTokens - cacheCreateTokens;

    state.usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    };

    // Add cache_read_input_tokens if present
    if (cacheReadTokens > 0) {
      state.usage.cache_read_input_tokens = cacheReadTokens;
    }

    // Add cache_creation_input_tokens if present
    if (cacheCreateTokens > 0) {
      state.usage.cache_creation_input_tokens = cacheCreateTokens;
    }

    // Note: completion_tokens_details.reasoning_tokens is already included in output_tokens
    // No need to add separately as Claude expects total output_tokens
  }

  // First chunk - ALWAYS send message_start first
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId = chunk.id?.replace("chatcmpl-", "") || `msg_${Date.now()}`;
    if (!state.messageId || state.messageId === "chat" || state.messageId.length < 8) {
      state.messageId = chunk.extend_fields?.requestId ||
        chunk.extend_fields?.traceId ||
        `msg_${Date.now()}`;
    }
    state.model = chunk.model || MODEL_FALLBACK;
    state.nextBlockIndex = 0;
    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: ROLE.ASSISTANT,
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  // Handle reasoning (thinking) across vendor shapes - GLM/DeepSeek/Qwen/MiniMax/etc.
  const reasoningContent = extractReasoningText(delta);
  if (reasoningContent) {
    stopTextBlock(state, results);

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: CLAUDE_BLOCK.THINKING, thinking: "", signature: DEFAULT_THINKING_CLAUDE_SIGNATURE }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent }
    });
  }

  // Handle regular content (supporting inline <think> tags statefully across SSE chunks)
  const { thinking: inlineThinking, text: cleanedText } = processStreamThinkingTags(delta?.content, state);

  if (inlineThinking) {
    stopTextBlock(state, results);

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: CLAUDE_BLOCK.THINKING, thinking: "", signature: DEFAULT_THINKING_CLAUDE_SIGNATURE }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: inlineThinking }
    });
  }

  const hasText = typeof cleanedText === "string" && cleanedText.length > 0;
  const hasNonWhitespaceText = hasText && cleanedText.trim().length > 0;

  if (hasNonWhitespaceText) {
    stopThinkingBlock(state, results);

    // Reopen when never opened OR after a close (closed block index is dead).
    if (!state.textBlockStarted || state.textBlockClosed) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: CLAUDE_BLOCK.TEXT, text: "" }
      });
      // Flush buffered leading whitespace first so indented/code responses
      // keep their exact formatting.
      if (state.leadingWhitespaceBuf) {
        results.push({
          type: "content_block_delta",
          index: state.textBlockIndex,
          delta: { type: "text_delta", text: state.leadingWhitespaceBuf }
        });
        state.leadingWhitespaceBuf = "";
      }
    }

    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: cleanedText }
    });
  } else if (hasText) {
    stopThinkingBlock(state, results);
    // Forward whitespace-only deltas when a text block is already open so
    // newlines/indentation inside lists and code blocks are preserved.
    if (state.textBlockStarted && !state.textBlockClosed) {
      results.push({
        type: "content_block_delta",
        index: state.textBlockIndex,
        delta: { type: "text_delta", text: cleanedText }
      });
    } else {
      // Buffer whenever no writable text block exists — before the first
      // block AND after a close (pending whitespace for the next block).
      // Overflow policy: open a text block and flush instead of silently
      // truncating, so exact formatting is never lost without a signal.
      const MAX_LEADING_WHITESPACE = 64 * 1024;
      const current = state.leadingWhitespaceBuf || "";
      const pending = current + cleanedText;
      if (pending.length > MAX_LEADING_WHITESPACE) {
        state.textBlockIndex = state.nextBlockIndex++;
        state.textBlockStarted = true;
        state.textBlockClosed = false;
        results.push({
          type: "content_block_start",
          index: state.textBlockIndex,
          content_block: { type: CLAUDE_BLOCK.TEXT, text: "" }
        });
        results.push({
          type: "content_block_delta",
          index: state.textBlockIndex,
          delta: { type: "text_delta", text: pending }
        });
        state.leadingWhitespaceBuf = "";
      } else {
        state.leadingWhitespaceBuf = pending;
      }
    }
  }

  // Tool calls
  // Providers disagree on WHEN the tool name arrives: deepseek/claude send it
  // in the first chunk (alongside the id), while GLM 5.2 / GPT / grok open the
  // call with an id and stream the name in a LATER chunk (sometimes split across
  // several). The old code read `tc.function?.name || ""` once, at first sight
  // of the id, and emitted content_block_start immediately — so a late name was
  // lost and the block shipped with name:"" (Claude clients then reject it with
  // "No such tool available: "). We now ACCUMULATE both name and args across
  // chunks and defer the block emission to finish (the same shape the
  // antigravity translator already uses), so the name is always complete.
  if (delta?.tool_calls) {
    // A tool turn supersedes pending pre-tool whitespace: flush it into its
    // own text block first so upstream ordering (text, then tool) survives.
    // A text chunk carrying both content + tool_calls in one delta is
    // processed above (text first), so by here the buffer only holds
    // whitespace from strictly earlier whitespace-only deltas.
    if (state.leadingWhitespaceBuf) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: CLAUDE_BLOCK.TEXT, text: "" }
      });
      results.push({
        type: "content_block_delta",
        index: state.textBlockIndex,
        delta: { type: "text_delta", text: state.leadingWhitespaceBuf }
      });
      results.push({
        type: "content_block_stop",
        index: state.textBlockIndex
      });
      state.textBlockClosed = true;
      state.leadingWhitespaceBuf = "";
    }
    if (!state.toolCalls) state.toolCalls = new Map();
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;

      // Open a provisional slot keyed on index alone so a name/args fragment
      // that arrives before the id is not lost (some providers stream them out
      // of order). The id and name are filled in as their fragments arrive; a
      // slot that never gets both is dropped at finish.
      if (!state.toolCalls.has(idx)) {
        state.toolCalls.set(idx, { id: null, name: "" });
      }
      const toolInfo = state.toolCalls.get(idx);
      if (tc.id) toolInfo.id = toolInfo.id || tc.id;

      // Merge the name fragment, tolerating split / re-echo / snapshot shapes.
      if (tc.function?.name) {
        toolInfo.name = accumulateToolName(toolInfo.name, tc.function.name);
      }

      // Buffer args — sanitized and emitted at finish to fix bad params.
      if (tc.function?.arguments) {
        if (!state.toolArgBuffers) state.toolArgBuffers = new Map();
        state.toolArgBuffers.set(idx, (state.toolArgBuffers.get(idx) || "") + tc.function.arguments);
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);
    // Whitespace-only streams never opened a block: clear any buffered
    // leading whitespace so pooled/reused state cannot leak it.
    state.leadingWhitespaceBuf = "";

    let emittedToolBlocks = 0;
    for (const [idx, toolInfo] of (state.toolCalls || [])) {
      // Resolve the fully-accumulated name; strip the legacy proxy_ prefix.
      let toolName = toolInfo.name || "";
      if (toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
        toolName = toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
      }

      // A provisional slot that never received both an id and a name cannot be
      // a valid tool_use — a nameless (or id-less) block is exactly what Claude
      // clients reject, so drop it.
      if (!toolInfo.id || !toolName) continue;
      emittedToolBlocks++;

      // Allocate the block index now (deferred from first-sight of the id) so
      // it always follows any text/thinking blocks already flushed above.
      const toolBlockIndex = state.nextBlockIndex++;
      results.push({
        type: "content_block_start",
        index: toolBlockIndex,
        content_block: {
          type: CLAUDE_BLOCK.TOOL_USE,
          id: toolInfo.id,
          name: toolName,
          input: {}
        }
      });

      // Emit buffered + sanitized args as a single delta before stop.
      const buffered = state.toolArgBuffers?.get(idx);
      if (buffered) {
        const sanitized = sanitizeToolArgs(toolInfo.name, repairDuplicatedJsonArguments(buffered));
        results.push({
          type: "content_block_delta",
          index: toolBlockIndex,
          delta: { type: "input_json_delta", partial_json: sanitized }
        });
      }
      results.push({
        type: "content_block_stop",
        index: toolBlockIndex
      });
    }

    // Mark finish for later usage injection in stream.js
    state.finishReason = choice.finish_reason;

    // If every tool call was dropped (no valid block emitted), a
    // stop_reason of "tool_use" would tell the client to run tools that
    // don't exist — some clients hang on that. Downgrade to end_turn.
    let stopReason = convertFinishReason(choice.finish_reason);
    if (stopReason === "tool_use" && emittedToolBlocks === 0) {
      stopReason = "end_turn";
    }

    // Use tracked usage (will be estimated in stream.js if not valid)
    const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
    results.push({
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: finalUsage
    });
    results.push({ type: "message_stop" });
  }

  return results.length > 0 ? results : null;
}

const convertFinishReason = (reason) => fromOpenAIFinish(reason, "claude");

// Register
register(FORMATS.OPENAI, FORMATS.CLAUDE, null, openaiToClaudeResponse);
