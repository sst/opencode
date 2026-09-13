import { Effect, Schema } from "effect"
import { Protocol } from "../route/protocol.js"
import type { LanguageModelCompatibility } from "../schema/index.js"
import { OpenAIChat } from "./openai-chat.js"
import { JsonObject, ProviderShared } from "./shared.js"
import { OpenResponsesOptions } from "./utils/open-responses-options.js"

export type ReasoningEffort = OpenResponsesOptions.ReasoningEffort

const Options = Schema.Struct({
  reasoningEffort: OpenResponsesOptions.Options.fields.reasoningEffort,
  enableThinking: Schema.optional(Schema.Boolean),
  thinkingBudget: Schema.optional(Schema.Int),
  preserveThinking: Schema.optional(Schema.Boolean),
  clearThinking: Schema.optional(Schema.Boolean),
  thinking: Schema.optional(
    Schema.Struct({
      type: Schema.declare<"adaptive" | "disabled" | (string & {})>(Schema.is(Schema.String)),
    }),
  ),
  toolStream: Schema.optional(Schema.Boolean),
  parallelToolCalls: OpenResponsesOptions.Options.fields.parallelToolCalls,
  repetitionPenalty: Schema.optional(Schema.Number),
  responseFormat: Schema.optional(
    Schema.Struct({
      type: Schema.declare<"text" | "json_object" | "json_schema" | (string & {})>(Schema.is(Schema.String)),
      json_schema: Schema.optional(JsonObject),
    }),
  ),
  enableSearch: Schema.optional(Schema.Boolean),
  searchOptions: Schema.optional(
    Schema.Struct({
      forced_search: Schema.optional(Schema.Boolean),
      search_strategy: Schema.optional(
        Schema.declare<"turbo" | "max" | "agent" | "agent_max" | (string & {})>(Schema.is(Schema.String)),
      ),
      enable_search_extension: Schema.optional(Schema.Boolean),
    }),
  ),
})
export type OptionsInput = typeof Options.Type

export const compatibility = {
  maxTokensField: "max_completion_tokens",
  supportsStore: false,
  supportsStrictMode: false,
  reasoningField: "reasoning_content",
  zaiToolStream: false,
} satisfies LanguageModelCompatibility

export const protocol = Protocol.make({
  id: "alibaba-chat",
  body: {
    schema: Schema.Struct({
      ...OpenAIChat.bodyFields,
      enable_thinking: Options.fields.enableThinking,
      thinking_budget: Options.fields.thinkingBudget,
      preserve_thinking: Options.fields.preserveThinking,
      clear_thinking: Options.fields.clearThinking,
      thinking: Options.fields.thinking,
      parallel_tool_calls: Options.fields.parallelToolCalls,
      repetition_penalty: Options.fields.repetitionPenalty,
      top_k: Schema.optional(Schema.Int),
      response_format: Options.fields.responseFormat,
      enable_search: Options.fields.enableSearch,
      search_options: Options.fields.searchOptions,
    }),
    from: Effect.fn("AlibabaChat.fromRequest")(function* (req) {
      const opts = yield* ProviderShared.validateWith(Schema.decodeUnknownEffect(Options))(req.providerOptions ?? {})
      return {
        ...(yield* OpenAIChat.protocol.body.from(req)),
        enable_thinking: opts.enableThinking,
        thinking_budget: opts.thinkingBudget,
        preserve_thinking: opts.preserveThinking,
        clear_thinking: opts.clearThinking,
        thinking: opts.thinking,
        tool_stream: opts.toolStream,
        parallel_tool_calls:
          opts.parallelToolCalls ??
          (req.toolChoice?.disableParallelToolUse === undefined ? undefined : !req.toolChoice.disableParallelToolUse),
        repetition_penalty: opts.repetitionPenalty,
        top_k: req.generation?.topK,
        response_format: opts.responseFormat,
        enable_search: opts.enableSearch,
        search_options: opts.searchOptions,
      }
    }),
  },
  stream: OpenAIChat.protocol.stream,
})

export * as AlibabaChat from "./alibaba-chat.js"
