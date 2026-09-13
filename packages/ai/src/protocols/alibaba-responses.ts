import { Effect, Schema } from "effect"
import { Protocol } from "../route/protocol.js"
import { OpenResponses } from "./open-responses.js"
import { JsonObject, optionalArray, ProviderShared } from "./shared.js"
import { OpenResponsesOptions } from "./utils/open-responses-options.js"
import { ResponsesHostedTools } from "./utils/responses-hosted-tools.js"

const Options = Schema.Struct({
  reasoningEffort: OpenResponsesOptions.Options.fields.reasoningEffort,
  enableThinking: Schema.optional(Schema.Boolean),
  store: OpenResponsesOptions.Options.fields.store,
  previousResponseId: Schema.optional(Schema.String),
  conversation: Schema.optional(Schema.String),
})
export type OptionsInput = typeof Options.Type
const NativeTool = Schema.Struct({ type: Schema.Literals(["web_search", "web_extractor", "code_interpreter"]) })
const WebExtractorItem = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literal("web_extractor_call"),
    id: Schema.String,
    urls: Schema.optional(Schema.Array(Schema.String)),
    goal: Schema.optional(Schema.String),
  }),
  [JsonObject],
)
const Body = Schema.Struct({
  ...OpenResponses.coreFields,
  input: Schema.Array(Schema.Union([OpenResponses.InputItem, WebExtractorItem])),
  tools: optionalArray(Schema.Union([OpenResponses.Tool, NativeTool])),
  enable_thinking: Options.fields.enableThinking,
  previous_response_id: Options.fields.previousResponseId,
  conversation: Options.fields.conversation,
  stream: Schema.Literal(true),
})
const adapter = {
  id: "alibaba-responses",
  name: "Alibaba Responses",
  nativeTool: (native) => ProviderShared.validateWith(Schema.decodeUnknownEffect(NativeTool))(native.alibaba),
  restoreHostedToolItem: (item: unknown) => (Schema.is(WebExtractorItem)(item) ? item : undefined),
} satisfies OpenResponses.ProviderAdapter

const tools = {
  web_search_call: { name: "web_search", input: (item) => item.action ?? {} },
  code_interpreter_call: { name: "code_interpreter", input: (item) => ({ code: item.code }) },
} satisfies ResponsesHostedTools.Definitions

export const protocol = Protocol.make({
  id: adapter.id,
  body: {
    schema: Body,
    from: Effect.fn("AlibabaResponses.fromRequest")(function* (req) {
      const opts = yield* ProviderShared.validateWith(Schema.decodeUnknownEffect(Options))(req.providerOptions ?? {})
      const body = yield* OpenResponses.fromRequestWithAdapter(req, adapter)
      const choice = body.tool_choice
      return yield* ProviderShared.validateWith(Schema.decodeUnknownEffect(Body))({
        ...body,
        enable_thinking: opts.enableThinking,
        previous_response_id: opts.previousResponseId,
        conversation: opts.conversation,
        // Model Studio expresses named selection through allowed_tools.
        tool_choice:
          typeof choice === "object" && choice.type === "function"
            ? { type: "allowed_tools" as const, mode: "required" as const, tools: [choice] }
            : choice,
      })
    }),
  },
  stream: {
    event: OpenResponses.protocol.stream.event,
    initial: (req) => OpenResponses.initial(req, adapter),
    step: (state, input) =>
      Effect.gen(function* () {
        const event = OpenResponses.normalize(state, input)
        if (event.type !== "response.output_item.done" || !event.item) return yield* OpenResponses.step(state, event)
        if (event.item.type === "web_extractor_call") {
          const item = yield* Schema.decodeUnknownEffect(WebExtractorItem)(event.item).pipe(
            Effect.mapError((cause) =>
              ProviderShared.eventError(
                adapter.id,
                "Alibaba returned an invalid web extraction item",
                ProviderShared.encodeJson(event),
                cause,
              ),
            ),
          )
          return yield* ResponsesHostedTools.onDone(state, item, {
            web_extractor_call: { name: "web_extractor", input: () => ({ urls: item.urls, goal: item.goal }) },
          })
        }
        if (ResponsesHostedTools.isItem(event.item, tools))
          return yield* ResponsesHostedTools.onDone(state, event.item, tools)
        return yield* OpenResponses.step(state, event)
      }),
    terminal: OpenResponses.terminal,
  },
})

export * as AlibabaResponses from "./alibaba-responses.js"
