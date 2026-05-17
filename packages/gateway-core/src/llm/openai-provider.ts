/**
 * OpenAIProvider — Task #51
 *
 * Implements LLMProvider using the openai npm package (optional dependency).
 * Translates between provider-agnostic LLM types and OpenAI API types.
 *
 * Supported models: gpt-4o, gpt-4-turbo, o1, o3-mini
 *
 * NOTE: openai is an optional dependency. Import is done dynamically so that
 * gateway-core does not require it at startup.
 */

import type { LLMProvider, LLMProviderConfig } from "./provider.js";
import type {
  LLMMessage,
  LLMContentBlock,
  LLMToolDefinition,
  LLMToolCall,
  LLMToolResult,
  LLMResponse,
  LLMInvokeParams,
  LLMToolContinuationParams,
} from "./types.js";
import { buildToolsSystemPrompt, parseToolCallsFromText } from "./ollama-provider.js";

// ---------------------------------------------------------------------------
// OpenAI type shims (avoid hard dependency on the openai package types at
// import-time; actual types are inferred at runtime)
// ---------------------------------------------------------------------------

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIChoice {
  message: {
    role: string;
    content: string | null;
    /**
     * Reasoning trace emitted by some OpenAI-compatible servers (notably
     * llama.cpp / Lemonade) when the model produces a chain-of-thought
     * before its visible answer. NOT in the standard OpenAI schema, but
     * common enough in local-model land that ignoring it leaks "[No
     * response]" UX when the model spent its budget thinking. Cycle 157
     * — Gemma-4-E2B on Lemonade behaves this way.
     */
    reasoning_content?: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string | null;
}

interface OpenAICompletion {
  id: string;
  model: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Required<LLMProviderConfig> = {
  apiKey: "",
  defaultModel: "gpt-4o",
  maxTokens: 4096,
  maxRetries: 3,
  retryBaseMs: 1000,
  baseUrl: "https://api.openai.com/v1",
  timeoutMs: 0,
};

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

// Chat-template special tokens that local models (Gemma, Mistral, Llama) emit
// in the text body when they attempt tool calls but the OpenAI-compatible
// server doesn't translate them to choices[0].message.tool_calls. Strip these
// unconditionally so they never reach user output.
const CHAT_TEMPLATE_TOKEN_RE = /<\|tool_call\|?>|<\/?tool_call>|<\/?function_calls>|\[TOOL_CALLS\]/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

// ---------------------------------------------------------------------------
// Translation functions
// ---------------------------------------------------------------------------

/**
 * Convert provider-agnostic LLMMessage array to OpenAI chat messages.
 * System prompt is included as the first message with role "system".
 */
export function toOpenAIMessages(
  system: string,
  messages: LLMMessage[],
  toolsPromptSuffix?: string,
): OpenAIChatMessage[] {
  const systemContent = toolsPromptSuffix ? system + toolsPromptSuffix : system;
  const result: OpenAIChatMessage[] = [{ role: "system", content: systemContent }];

  for (const msg of messages) {
    if (msg.role === "system") {
      // Additional system messages merged into content
      const content = typeof msg.content === "string"
        ? msg.content
        : msg.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
      result.push({ role: "system", content });
      continue;
    }

    if (typeof msg.content === "string") {
      result.push({ role: msg.role as "user" | "assistant", content: msg.content });
    } else {
      // Handle structured content blocks
      const textContent = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");
      const toolResultBlocks = msg.content.filter((b) => b.type === "tool_result");

      if (toolUseBlocks.length > 0) {
        // Assistant message with tool calls
        const toolCalls: OpenAIToolCall[] = toolUseBlocks.map((b) => ({
          id: b.id ?? "",
          type: "function" as const,
          function: {
            name: b.name ?? "",
            arguments: JSON.stringify(b.input ?? {}),
          },
        }));
        result.push({
          role: "assistant",
          content: textContent || null,
          tool_calls: toolCalls,
        });
      } else if (toolResultBlocks.length > 0) {
        // Tool result messages (one per result)
        for (const block of toolResultBlocks) {
          result.push({
            role: "tool",
            tool_call_id: block.tool_use_id ?? "",
            content: block.content ?? "",
          });
        }
      } else {
        result.push({
          role: msg.role as "user" | "assistant",
          content: textContent,
        });
      }
    }
  }

  return result;
}

/**
 * Convert provider-agnostic LLMToolDefinition to OpenAI function tools format.
 */
export function toOpenAITools(tools: LLMToolDefinition[]): OpenAITool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/**
 * Convert LLMToolResult to OpenAI tool messages.
 */
export function toOpenAIToolMessages(results: LLMToolResult[]): OpenAIChatMessage[] {
  return results.map((r) => ({
    role: "tool" as const,
    tool_call_id: r.tool_use_id,
    content: r.content,
  }));
}

/**
 * Translate an OpenAI chat completion to provider-agnostic LLMResponse.
 *
 * @param usePromptFallback When true, parses ```tool_call JSON blocks from
 *   the text body instead of reading choices[0].message.tool_calls. Used for
 *   local models (e.g. Gemma via Lemonade) that don't populate tool_calls.
 */
export function fromOpenAICompletion(
  completion: OpenAICompletion,
  usePromptFallback = false,
): LLMResponse {
  // Defensive: OpenAI-compatible servers (e.g. Lemonade) sometimes return
  // a completion envelope with a missing or non-array `choices` key,
  // which would throw "Cannot read properties of undefined (reading '0')"
  // on the bare `completion.choices[0]` access — the guard below catches
  // an empty array but NOT an absent key. Optional-chain so the
  // `choice === undefined` branch returns a clean empty response and
  // the chat surfaces "no completion" instead of crashing the agent
  // invocation pipeline. Reproduced cycle 157 morning when civicognita_ops
  // chat hit Lemonade/Gemma and the response envelope shape didn't carry
  // a choices array.
  const choice = completion.choices?.[0];
  if (choice === undefined) {
    return {
      text: "",
      toolCalls: [],
      contentBlocks: [],
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      model: completion.model,
      thinkingBlocks: [],
    };
  }

  // Cycle 157 — some OpenAI-compatible servers (Lemonade/llama.cpp with
  // reasoning models like Gemma) split the model output into:
  //   - message.content: the user-visible answer (often empty when the
  //     model spent its budget thinking, or stops before producing the
  //     answer)
  //   - message.reasoning_content: the chain-of-thought trace that
  //     preceded the answer
  // Our LLMResponse contract represents thinking via thinkingBlocks
  // (Anthropic-shaped) and visible text via .text. Map reasoning_content
  // into a thinkingBlock so callers can surface it as a foldable trace,
  // and fall back to using it AS the visible text when content is empty
  // — better than showing the user "[No response]" while the model
  // actually thought through the question.
  const rawReasoning = choice.message.reasoning_content ?? "";
  let rawContent = choice.message.content ?? "";
  if (rawContent.length === 0 && rawReasoning.length > 0) {
    rawContent = rawReasoning;
  }

  // Safety net: strip leaked chat-template tool tokens so they never reach
  // user output. Local models (Gemma, Mistral, Llama) emit these in the
  // text body when they attempt a tool call but the OpenAI-compatible server
  // doesn't translate them into tool_calls. Unconditional — independent of
  // usePromptFallback — so the guard applies even if fallback is off.
  rawContent = rawContent.replace(CHAT_TEMPLATE_TOKEN_RE, "").trim();

  const rawToolCalls = choice.message.tool_calls ?? [];

  let toolCalls: LLMToolCall[];
  let text = rawContent;

  if (rawToolCalls.length > 0) {
    // Native tool calls populated by the server — use them directly.
    toolCalls = rawToolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: (() => {
        try {
          return JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          return {};
        }
      })(),
    }));
  } else if (usePromptFallback) {
    // Prompt-fallback path: model was instructed to emit ```tool_call JSON
    // blocks; parse them out of the text body.
    const parsed = parseToolCallsFromText(rawContent);
    toolCalls = parsed.toolCalls;
    text = parsed.cleanText;
  } else {
    toolCalls = [];
  }

  const contentBlocks: LLMContentBlock[] = [];
  if (text) {
    contentBlocks.push({ type: "text", text });
  }
  for (const tc of toolCalls) {
    contentBlocks.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: tc.input,
    });
  }

  // Map OpenAI finish_reason to our stopReason
  let stopReason: string | null = null;
  if (choice.finish_reason === "stop") stopReason = "end_turn";
  else if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  else if (choice.finish_reason !== null) stopReason = choice.finish_reason;

  // When prompt-fallback parsed tool calls from a "stop" turn, promote
  // the stopReason so the agent-invoker continues the tool loop.
  if (toolCalls.length > 0 && stopReason === "end_turn") stopReason = "tool_use";

  // Always preserve the reasoning trace (when present) as a thinking
  // block — orthogonal to the content/empty-fallback above. Lets the
  // dashboard render it as a foldable trace AND keeps the content
  // surface clean when the model produced both.
  const thinkingBlocks = rawReasoning.length > 0
    ? [{ thinking: rawReasoning, signature: "" }]
    : [];

  return {
    text,
    toolCalls,
    contentBlocks,
    stopReason,
    thinkingBlocks,
    usage: {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    },
    model: completion.model,
  };
}

// ---------------------------------------------------------------------------
// OpenAIProvider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  private readonly config: Required<LLMProviderConfig>;
  /** When true, injects tool definitions as system prompt text and parses
   * ```tool_call JSON blocks from the response instead of using the tools API
   * parameter. Required for local models (e.g. Gemma via Lemonade) that don't
   * populate choices[0].message.tool_calls in OpenAI-compatible responses. */
  private readonly usePromptFallback: boolean;

  constructor(config?: Partial<LLMProviderConfig> & { usePromptFallback?: boolean }) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.usePromptFallback = config?.usePromptFallback ?? false;
  }

  // ---------------------------------------------------------------------------
  // Core request method
  // ---------------------------------------------------------------------------

  private async request(
    messages: OpenAIChatMessage[],
    tools: OpenAITool[] | undefined,
    model: string,
    maxTokens: number,
  ): Promise<OpenAICompletion> {
    const apiKey = this.config.apiKey || process.env["OPENAI_API_KEY"] || "";
    const baseUrl = this.config.baseUrl || DEFAULT_CONFIG.baseUrl;

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages,
    };
    if (tools && tools.length > 0) {
      body["tools"] = tools;
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      // Per-request deadline. timeoutMs > 0 wraps the fetch in an
      // AbortController so the promise rejects predictably when the deadline
      // hits (vs hanging on a slow CPU-bound local Provider). 0 = no timeout
      // (cloud SDK default; preserves pre-t413 behavior). Cleared on every
      // path so the timer doesn't leak across retries.
      const controller = this.config.timeoutMs > 0 ? new AbortController() : undefined;
      const timer =
        controller !== undefined
          ? setTimeout(() => controller.abort(), this.config.timeoutMs)
          : undefined;
      try {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          ...(controller !== undefined ? { signal: controller.signal } : {}),
        });

        if (!resp.ok) {
          const status = resp.status;
          if (isRetryableStatus(status) && attempt < this.config.maxRetries) {
            lastError = new Error(`OpenAI API error: HTTP ${String(status)}`);
            const delay =
              (this.config.retryBaseMs ?? 1000) * Math.pow(2, attempt) +
              Math.floor(Math.random() * 500);
            await sleep(delay);
            continue;
          }
          const text = await resp.text();
          throw new Error(`OpenAI API error: HTTP ${String(status)}: ${text}`);
        }

        return (await resp.json()) as OpenAICompletion;
      } catch (err) {
        lastError = err;

        // AbortError from the deadline timer surfaces as a clear timeout error
        // instead of bubbling the cryptic native AbortError up the stack.
        if (err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"))) {
          throw new Error(`OpenAI request timed out after ${String(this.config.timeoutMs)}ms`);
        }

        // Network errors (fetch failed)
        if (
          err instanceof Error &&
          (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) &&
          attempt < this.config.maxRetries
        ) {
          const delay =
            (this.config.retryBaseMs ?? 1000) * Math.pow(2, attempt) +
            Math.floor(Math.random() * 500);
          await sleep(delay);
          continue;
        }

        if (attempt === this.config.maxRetries) {
          throw err;
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    throw lastError;
  }

  // ---------------------------------------------------------------------------
  // LLMProvider.invoke
  // ---------------------------------------------------------------------------

  async invoke(params: LLMInvokeParams): Promise<LLMResponse> {
    const model = params.model ?? this.config.defaultModel;
    const maxTokens = params.maxTokens ?? this.config.maxTokens;

    let toolsPromptSuffix: string | undefined;
    let openAITools: ReturnType<typeof toOpenAITools> | undefined;

    if (params.tools && params.tools.length > 0) {
      if (this.usePromptFallback) {
        toolsPromptSuffix = buildToolsSystemPrompt(params.tools);
      } else {
        openAITools = toOpenAITools(params.tools);
      }
    }

    const messages = toOpenAIMessages(params.system, params.messages, toolsPromptSuffix);
    const completion = await this.request(messages, openAITools, model, maxTokens);
    return fromOpenAICompletion(completion, this.usePromptFallback);
  }

  // ---------------------------------------------------------------------------
  // LLMProvider.continueWithToolResults
  // ---------------------------------------------------------------------------

  async continueWithToolResults(
    params: LLMToolContinuationParams,
  ): Promise<LLMResponse> {
    const model = params.original.model ?? this.config.defaultModel;
    const maxTokens = params.original.maxTokens ?? this.config.maxTokens;

    let toolsPromptSuffix: string | undefined;
    let openAITools: ReturnType<typeof toOpenAITools> | undefined;

    if (params.original.tools && params.original.tools.length > 0) {
      if (this.usePromptFallback) {
        toolsPromptSuffix = buildToolsSystemPrompt(params.original.tools);
      } else {
        openAITools = toOpenAITools(params.original.tools);
      }
    }

    const messages = toOpenAIMessages(params.original.system, params.original.messages, toolsPromptSuffix);

    const toolCallBlocks = params.assistantContent.filter((b) => b.type === "tool_use");
    const textBlocks = params.assistantContent.filter((b) => b.type === "text");
    const textContent = textBlocks.map((b) => b.text ?? "").join("\n");

    if (this.usePromptFallback) {
      // Prompt-fallback path: format tool calls as ```tool_call blocks in the
      // assistant text, then inject results as a user message — the model
      // doesn't understand the `role: "tool"` turn in this mode.
      const toolCallText = toolCallBlocks
        .map(
          (b) =>
            "```tool_call\n" +
            JSON.stringify({ tool: b.name, input: b.input }) +
            "\n```",
        )
        .join("\n");
      messages.push({
        role: "assistant",
        content: [textContent, toolCallText].filter(Boolean).join("\n"),
      });
      const toolResultText = params.toolResults
        .map((r) => `Tool result for ${r.tool_use_id}:\n${r.content}`)
        .join("\n\n");
      messages.push({ role: "user", content: toolResultText });
    } else {
      // Native OpenAI tool calling path.
      const textOrNull = textContent || null;
      if (toolCallBlocks.length > 0) {
        const toolCalls: OpenAIToolCall[] = toolCallBlocks.map((b) => ({
          id: b.id ?? "",
          type: "function" as const,
          function: {
            name: b.name ?? "",
            arguments: JSON.stringify(b.input ?? {}),
          },
        }));
        messages.push({ role: "assistant", content: textOrNull, tool_calls: toolCalls });
      } else {
        messages.push({ role: "assistant", content: textOrNull ?? "" });
      }
      const toolMessages = toOpenAIToolMessages(params.toolResults);
      messages.push(...toolMessages);
    }

    const completion = await this.request(messages, openAITools, model, maxTokens);
    return fromOpenAICompletion(completion, this.usePromptFallback);
  }

  // ---------------------------------------------------------------------------
  // LLMProvider.summarize
  // ---------------------------------------------------------------------------

  async summarize(text: string, prompt: string): Promise<string> {
    const messages: OpenAIChatMessage[] = [
      { role: "system", content: prompt },
      { role: "user", content: text },
    ];

    const completion = await this.request(
      messages,
      undefined,
      this.config.defaultModel,
      1024,
    );

    return completion.choices?.[0]?.message.content ?? "";
  }
}
