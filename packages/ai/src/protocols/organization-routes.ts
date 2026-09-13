import { Effect, Schema } from "effect"
import { Route } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { Protocol } from "../route/protocol.js"
import { HttpTransport } from "../route/transport/index.js"
import type { LLMRequest } from "../schema/index.js"
import { OpenResponses } from "./open-responses.js"
import { ProviderShared } from "./shared.js"

const ADAPTER = "organization-routes"

const adapter = {
  id: ADAPTER,
  name: "Organization routes",
  preserveProviderMetadata: true,
} satisfies OpenResponses.ProviderAdapter

const Body = Schema.Struct({
  ...OpenResponses.coreFields,
  store: Schema.Literal(false),
  provider_options: Schema.Struct({
    "openai-responses": Schema.Struct({ include: Schema.Array(Schema.String) }),
  }),
  stream: Schema.Literal(true),
})

const fromRequest = Effect.fn("OrganizationRoutes.fromRequest")(function* (request: LLMRequest) {
  const body = yield* OpenResponses.fromRequestWithAdapter(request, adapter)
  // A route can select another provider on each call. Keep full history and only
  // portable options; native caching and stored IDs would exclude translated
  // targets. Scope encrypted reasoning to native Responses targets so their
  // stateless continuations remain replayable without blocking other protocols.
  return yield* ProviderShared.validateWith(Schema.decodeUnknownEffect(Body))({
    model: body.model,
    input: body.input,
    instructions: body.instructions,
    tools: body.tools,
    tool_choice: body.tool_choice,
    stream: true as const,
    store: false as const,
    provider_options: { "openai-responses": { include: ["reasoning.encrypted_content"] } },
    max_output_tokens:
      body.max_output_tokens !== undefined && body.max_output_tokens > 0 ? body.max_output_tokens : undefined,
    temperature: body.temperature,
    top_p: body.top_p,
    parallel_tool_calls: body.parallel_tool_calls,
    metadata: body.metadata,
    reasoning: body.reasoning?.effort === undefined ? undefined : { effort: body.reasoning.effort },
    text: body.text,
  })
})

export const protocol = Protocol.make({
  ...OpenResponses.protocol,
  id: ADAPTER,
  body: { schema: Body, from: fromRequest },
  stream: {
    ...OpenResponses.protocol.stream,
    initial: (request: LLMRequest) => OpenResponses.initial(request, adapter),
  },
})

export const route = Route.make({
  id: ADAPTER,
  providerMetadataKey: ADAPTER,
  protocol,
  endpoint: Endpoint.path(OpenResponses.PATH),
  transport: HttpTransport.sseJson.with<typeof Body.Type>(),
  defaults: { providerOptions: { store: false, include: [] } },
})

export * as OrganizationRoutes from "./organization-routes.js"
