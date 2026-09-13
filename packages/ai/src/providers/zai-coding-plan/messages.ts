import type { ProviderPackage } from "../../provider-package.js"
import { ZAICodingPlan } from "../zai-coding-plan.js"

export type Settings = ZAICodingPlan.Settings<ZAICodingPlan.MessagesOptionsInput>

export const model: ProviderPackage.Definition<Settings, ZAICodingPlan.MessagesOptionsInput>["model"] = (
  modelID,
  { apiKey, baseURL, body, headers, ...providerOptions },
) =>
  ZAICodingPlan.configure({
    apiKey,
    baseURL,
    headers,
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
  }).messages(modelID)
