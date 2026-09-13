import { Struct } from "effect"
import type { ProviderPackage } from "../provider-package.js"
import { AlibabaChat } from "../protocols/alibaba-chat.js"
import { AlibabaMessages } from "../protocols/alibaba-messages.js"
import { AlibabaResponses } from "../protocols/alibaba-responses.js"
import { AuthOptions, type AtLeastOne, type ProviderAuthOption } from "../route/auth-options.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { Framing } from "../route/framing.js"
import { ProviderConfigurationError, ProviderID, ToolDefinition, type ModelID } from "../schema/index.js"

export const id = ProviderID.make("alibaba")

export type Region =
  | "ap-southeast-1"
  | "cn-beijing"
  | "cn-hongkong"
  | "us-east-1"
  | "eu-central-1"
  | "ap-northeast-1"
  | (string & {})
export type ChatOptionsInput = AlibabaChat.OptionsInput
export type MessagesOptionsInput = AlibabaMessages.OptionsInput
export type ResponsesOptionsInput = AlibabaResponses.OptionsInput

type Location = AtLeastOne<{
  readonly region: Region
  /** Overrides the selected API's complete base URL, including its version prefix. */
  readonly baseURL: string
}> & { readonly workspaceID?: string }

export type Config = Location &
  Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly providerOptions?: ChatOptionsInput | MessagesOptionsInput | ResponsesOptionsInput
  }
export type Settings<Options = ChatOptionsInput> = Location &
  ProviderPackage.Settings &
  Options & {
    readonly apiKey?: string
  }

const hosts = new Map<string, string>([
  ["ap-southeast-1", "dashscope-intl.aliyuncs.com"],
  ["cn-beijing", "dashscope.aliyuncs.com"],
  ["cn-hongkong", "cn-hongkong.dashscope.aliyuncs.com"],
  ["us-east-1", "dashscope-us.aliyuncs.com"],
])
const chatRoute = Route.make({
  id: "alibaba-chat",
  provider: id,
  providerMetadataKey: "alibaba",
  protocol: AlibabaChat.protocol,
  endpoint: Endpoint.path("/chat/completions"),
  framing: Framing.sse,
})
const messagesRoute = Route.make({
  id: "alibaba-messages",
  provider: id,
  providerMetadataKey: "alibaba",
  protocol: AlibabaMessages.protocol,
  endpoint: Endpoint.path("/messages"),
  framing: Framing.sse,
  headers: () => ({ "anthropic-version": "2023-06-01" }),
})
const responsesRoute = Route.make({
  id: "alibaba-responses",
  provider: id,
  providerMetadataKey: "alibaba",
  protocol: AlibabaResponses.protocol,
  endpoint: Endpoint.path("/responses"),
  framing: Framing.sse,
})

export const routes = [chatRoute, messagesRoute, responsesRoute]

export const configure = (input: Config) => {
  const { apiKey: _key, auth: _auth, region, workspaceID, baseURL, ...rest } = input
  const host =
    region === undefined
      ? undefined
      : workspaceID === undefined
        ? hosts.get(region)
        : `${workspaceID}.${region}.maas.aliyuncs.com`
  if (baseURL === undefined) {
    if (region === undefined)
      throw new ProviderConfigurationError({ provider: id, message: "Alibaba requires region or baseURL" })
    if (host === undefined)
      throw new ProviderConfigurationError({
        provider: id,
        message: `Alibaba region ${region} requires workspaceID or baseURL`,
      })
  }
  const opts = { ...rest, auth: AuthOptions.bearer(input, ["DASHSCOPE_API_KEY", "ALIBABA_API_KEY"]) }
  const common = { ...opts, endpoint: { baseURL: baseURL ?? `https://${host}/compatible-mode/v1` } }
  const chat = (id: string | ModelID) =>
    chatRoute.with(common).model<ChatOptionsInput>({ id, compatibility: AlibabaChat.compatibility })
  const messages = (id: string | ModelID) =>
    messagesRoute
      .with({
        ...opts,
        endpoint: { baseURL: baseURL ?? `https://${host}/apps/anthropic/v1` },
      })
      .model<MessagesOptionsInput>({ id, compatibility: { requireSignature: false } })
  const responses = (id: string | ModelID) => responsesRoute.with(common).model<ResponsesOptionsInput>({ id })
  return { id, model: chat, chat, messages, responses, configure }
}

export const provider = { id, configure }

export const model: ProviderPackage.Definition<Settings, ChatOptionsInput>["model"] = (id, input) =>
  fromSettings(input).chat(id)
export const messagesModel: ProviderPackage.Definition<
  Settings<MessagesOptionsInput>,
  MessagesOptionsInput
>["model"] = (id, input) => fromSettings(input).messages(id)
export const responsesModel: ProviderPackage.Definition<
  Settings<ResponsesOptionsInput>,
  ResponsesOptionsInput
>["model"] = (id, input) => fromSettings(input).responses(id)

function fromSettings(input: Settings<Config["providerOptions"]>) {
  const { body, ...rest } = input
  return configure({
    ...rest,
    http: body === undefined ? undefined : { body },
    providerOptions: Struct.omit(rest, ["apiKey", "baseURL", "headers", "region", "workspaceID"]),
  })
}

export const webSearch = () => hostedTool("web_search", "Search the web with Alibaba's hosted search tool.")
export const webExtractor = () => hostedTool("web_extractor", "Extract web page content with Alibaba's hosted tool.")
export const codeInterpreter = () => hostedTool("code_interpreter", "Execute code with Alibaba's hosted interpreter.")

function hostedTool(type: "web_search" | "web_extractor" | "code_interpreter", description: string) {
  return ToolDefinition.make({
    name: type,
    description,
    inputSchema: { type: "object", properties: {} },
    native: { alibaba: { type } },
  })
}

export * as Alibaba from "./alibaba.js"
