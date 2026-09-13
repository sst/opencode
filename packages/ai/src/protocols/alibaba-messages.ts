import { Effect, Schema } from "effect"
import { Protocol } from "../route/protocol.js"
import { LLMRequest } from "../schema/index.js"
import { AnthropicMessages } from "./anthropic-messages.js"
import { ProviderShared } from "./shared.js"
import { OpenResponsesOptions } from "./utils/open-responses-options.js"

const Options = Schema.Struct({
  effort: Schema.optional(OpenResponsesOptions.ReasoningEffort),
  thinking: Schema.optional(
    Schema.Struct({
      type: Schema.declare<"enabled" | "disabled" | (string & {})>(Schema.is(Schema.String)),
      budgetTokens: Schema.optional(Schema.Int),
      budget_tokens: Schema.optional(Schema.Int),
    }),
  ),
})
export type OptionsInput = typeof Options.Type & Pick<AnthropicMessages.OptionsInput, "outputConfig">
export const protocol = Protocol.make({
  id: "alibaba-messages",
  body: {
    schema: Schema.Struct({
      ...AnthropicMessages.AnthropicMessagesBody.fields,
      thinking: Schema.optional(Schema.Struct({ type: Schema.String, budget_tokens: Schema.optional(Schema.Int) })),
    }),
    from: Effect.fn("AlibabaMessages.fromRequest")(function* (req) {
      const opts = yield* ProviderShared.validateWith(Schema.decodeUnknownEffect(Options))(req.providerOptions ?? {})
      // Model Studio accepts enabled thinking without Anthropic's mandatory token budget.
      return {
        ...(yield* AnthropicMessages.protocol.body.from(
          LLMRequest.update(req, {
            providerOptions: { ...req.providerOptions, thinking: undefined },
          }),
        )),
        thinking:
          opts.thinking === undefined
            ? undefined
            : {
                type: opts.thinking.type,
                budget_tokens: opts.thinking.budgetTokens ?? opts.thinking.budget_tokens,
              },
      }
    }),
  },
  stream: AnthropicMessages.protocol.stream,
})

export * as AlibabaMessages from "./alibaba-messages.js"
