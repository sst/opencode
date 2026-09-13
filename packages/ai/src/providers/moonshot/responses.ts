import type { ProviderPackage } from "../../provider-package.js"
import { Moonshot } from "../moonshot.js"

export type Settings = Moonshot.Settings<Moonshot.ResponsesOptionsInput>

export const model: ProviderPackage.Definition<Settings, Moonshot.ResponsesOptionsInput>["model"] = (
  modelID,
  { apiKey, baseURL, body, headers, ...providerOptions },
) =>
  Moonshot.configure({
    apiKey,
    baseURL,
    headers,
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
  }).responses(modelID)
