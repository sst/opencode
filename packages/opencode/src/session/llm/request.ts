import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Record } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"

const USER_AGENT = `opencode/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
  readonly maxOutputTokens?: number
  readonly systemPrepared?: boolean
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const system = yield* prepareSystem(input)

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

  const maxOutputTokens = Math.min(
    ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
    input.maxOutputTokens ?? Infinity,
  )
  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens,
      options,
    },
  )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  const tools = resolveTools(input)
  // Codex parity: OpenAI Responses-family providers hardcode `strict: false`
  // on every function tool so MCP-sourced and dynamic schemas that don't
  // satisfy OpenAI's structured-outputs constraints still register.
  if (
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/azure" ||
    input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  ) {
    for (const key of Object.keys(tools)) tools[key] = { ...tools[key], strict: false }
  }
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const opencodeProjectID = input.model.providerID.startsWith("opencode")
    ? (yield* InstanceState.context).project.id
    : undefined

  return {
    system,
    messages,
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params:
      input.maxOutputTokens === undefined
        ? params
        : { ...params, maxOutputTokens: Math.min(params.maxOutputTokens ?? maxOutputTokens, maxOutputTokens) },
    messageTransformOptions: options,
    headers: {
      ...(input.model.providerID.startsWith("opencode")
        ? {
            ...(opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {}),
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": input.flags.client,
            "User-Agent": USER_AGENT,
          }
        : {
            "x-session-affinity": input.sessionID,
            "X-Session-Id": input.sessionID,
            "User-Agent": USER_AGENT,
          }),
      ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
      ...input.model.headers,
      ...headers,
    },
  }
})

export const prepareSystem = Effect.fn("LLMRequestPrep.prepareSystem")(function* (
  input: Pick<PrepareInput, "agent" | "model" | "plugin" | "sessionID" | "system" | "user" | "systemPrepared">,
) {
  if (input.systemPrepared) return input.system
  const system = [
    [
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }
  return system
})

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
