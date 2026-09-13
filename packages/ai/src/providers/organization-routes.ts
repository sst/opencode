import type { ProviderPackage } from "../provider-package.js"
import { OrganizationRoutes } from "../protocols/organization-routes.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import type { RouteDefaultsInput } from "../route/client.js"
import { ProviderID, type ModelID } from "../schema/index.js"
import type { OpenResponsesProviderOptionsInput } from "./open-responses-options.js"

export type Options = Pick<
  OpenResponsesProviderOptionsInput,
  "reasoningEffort" | "textVerbosity" | "parallelToolCalls" | "metadata" | "allowedTools"
>

export const id = ProviderID.make("organization-routes")

export type Config = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly provider?: string
    readonly baseURL: string
    readonly providerOptions?: Options
  }

export interface Settings extends ProviderPackage.Settings {
  readonly apiKey?: string
  readonly baseURL: string
  readonly provider?: string
  readonly providerOptions?: Options
}

export const routes = [OrganizationRoutes.route]

export const configure = (input: Config) => {
  const provider = input.provider ?? "organization-routes"
  const { provider: _, baseURL, apiKey: _apiKey, auth: _auth, ...rest } = input
  const route = OrganizationRoutes.route.with({
    ...rest,
    provider,
    endpoint: { baseURL },
    auth: AuthOptions.bearer(input, []),
  })
  return {
    id: ProviderID.make(provider),
    model: (modelID: string | ModelID) => route.model<Options>({ id: modelID }),
    configure,
  }
}

export const provider = { id, configure }

export const model: ProviderPackage.Definition<Settings, Options>["model"] = (modelID, settings) =>
  configure({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    headers: settings.headers === undefined ? undefined : { ...settings.headers },
    http: settings.body === undefined ? undefined : { body: { ...settings.body } },
    provider: settings.provider,
    providerOptions: settings.providerOptions,
  }).model(modelID)
