import type { APIEvent } from "@solidjs/start/server"
import { ZenData } from "@opencode-ai/console-core/model.js"
import { buildModelsResponse, buildOptionsResponse } from "../../util/modelsHandler"
import { inferenceUnavailable, proxyInference } from "~/lib/inference-proxy"

export async function OPTIONS(_input: APIEvent) {
  return buildOptionsResponse()
}

export async function GET(input: APIEvent) {
  const response = await proxyInference(input.request).catch(inferenceUnavailable)
  if (response) return response
  const models = Object.keys(ZenData.list("lite").models)
  return buildModelsResponse(models)
}
