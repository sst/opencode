import type { APIEvent } from "@solidjs/start/server"
import { and, Database, eq, isNull, lt, or, sql } from "@opencode-ai/console-core/drizzle/index.js"
import { KeyTable } from "@opencode-ai/console-core/schema/key.sql.js"
import { BillingTable, LiteTable, SubscriptionTable, UsageTable } from "@opencode-ai/console-core/schema/billing.sql.js"
import { centsToMicroCents } from "@opencode-ai/console-core/util/price.js"
import { getMonthlyBounds, getWeekBounds } from "@opencode-ai/console-core/util/date.js"
import { Identifier } from "@opencode-ai/console-core/identifier.js"
import { Billing } from "@opencode-ai/console-core/billing.js"
import { Actor } from "@opencode-ai/console-core/actor.js"
import { WorkspaceTable } from "@opencode-ai/console-core/schema/workspace.sql.js"
import { ZenData } from "@opencode-ai/console-core/model.js"
import { Subscription } from "@opencode-ai/console-core/subscription.js"
import { BlackData } from "@opencode-ai/console-core/black.js"
import { UserTable } from "@opencode-ai/console-core/schema/user.sql.js"
import { ModelTable } from "@opencode-ai/console-core/schema/model.sql.js"
import { ProviderTable } from "@opencode-ai/console-core/schema/provider.sql.js"
import { logger } from "./logger"
import {
  AuthError,
  CreditsError,
  MonthlyLimitError,
  UserLimitError,
  ModelError,
  RegionError,
  DataPolicyError,
  RateLimitError,
  FreeUsageLimitError,
  GoUsageLimitError,
  BlackUsageLimitError,
} from "./error"
import { buildCostChunk, createStreamPartConverter, createResponseConverter, UsageInfo } from "./provider/provider"
import { anthropicHelper } from "./provider/anthropic"
import { googleHelper } from "./provider/google"
import { openaiHelper } from "./provider/openai"
import { oaCompatHelper } from "./provider/openai-compatible"
import { createRateLimiter as createIpRateLimiter } from "./ipRateLimiter"
import { createRateLimiter as createKeyRateLimiter } from "./keyRateLimiter"
import { createTrialLimiter } from "./trialLimiter"
import { createStickyTracker } from "./stickyProviderTracker"
import { LiteData } from "@opencode-ai/console-core/lite.js"
import { Resource } from "@opencode-ai/console-resource"
import { i18n, type Key } from "~/i18n"
import { localeFromRequest } from "~/lib/language"
import { createModelTpmLimiter } from "./modelTpmLimiter"
import { createModelTpsLimiter } from "./modelTpsLimiter"
import { createProviderBudgetTracker } from "./providerBudgetTracker"
import { accumulateUsage, HOT_WORKSPACES } from "./usageBatcher"
import { Workspace } from "@opencode-ai/console-core/workspace.js"
import { countryFromRequest, isModelCountryRestricted } from "~/lib/request-country"
import { isPeakPricing } from "./pricing"
import { prepareRequestBody } from "./requestBody"
import { requiresGoTrainingConsent } from "./trainingConsent"
import { inferenceUnavailable, proxyInference } from "~/lib/inference-proxy"

type ZenData = Awaited<ReturnType<typeof ZenData.list>>
type PreparedBody = Awaited<ReturnType<typeof prepareRequestBody>>
type BillingSource = "anonymous" | "free" | "byok" | "subscription" | "lite" | "balance"

function resolve(text: string, params?: Record<string, string | number>) {
  if (!params) return text
  return text.replace(/\{\{(\w+)\}\}/g, (raw, key) => {
    const value = params[key]
    if (value === undefined || value === null) return raw
    return String(value)
  })
}

export async function handler(
  input: APIEvent,
  opts: {
    format: ZenData.Format
    modelList: "lite" | "full"
    parseApiKey: (headers: Headers) => string | undefined
    parseModel: (url: string, body: any) => string
    parseVariant: (url: string, body: any) => string | undefined
    parseIsStream: (url: string, body: any) => boolean
  },
) {
  type AuthInfo = Awaited<ReturnType<typeof authenticate>>
  type ModelInfo = Awaited<ReturnType<typeof validateModel>>
  type ProviderInfo = Awaited<ReturnType<typeof selectProvider>>
  type CostInfo = ReturnType<typeof calculateCost>

  const dict = i18n(localeFromRequest(input.request))
  const t = (key: Key, params?: Record<string, string | number>) => resolve(dict[key], params)
  const ADMIN_WORKSPACES = [
    "wrk_01K46JDFR0E75SG2Q8K172KF3Y", // anomaly
    "wrk_01K6W1A3VE0KMNVSCQT43BG2SX", // benchmark
    "wrk_01KKZDKDWCS1VTJF8QTX62DD50", // contributors
  ]

  let requestBody: PreparedBody | undefined
  try {
    const url = input.request.url
    const body = input.request.body
    if (!body) throw new Error("Missing request body")
    requestBody = opts.format === "google" ? undefined : await prepareRequestBody(body)
    const model = opts.format === "google" ? opts.parseModel(url, undefined) : (requestBody?.model ?? "")
    const googleStream = opts.format === "google" ? opts.parseIsStream(url, undefined) : undefined
    const rawIp = input.request.headers.get("x-real-ip") ?? ""
    const ip = rawIp.includes(":") ? rawIp.split(":").slice(0, 4).join(":") : rawIp
    const rawZenApiKey = opts.parseApiKey(input.request.headers)
    const zenApiKey = rawZenApiKey === "public" ? undefined : rawZenApiKey
    const zenData = ZenData.list(opts.modelList)
    if (model) {
      // Read routing metadata without running legacy model, auth, or balance checks.
      const configured = zenData.models[model]
      const entry = Array.isArray(configured)
        ? configured.find((entry) => entry.formatFilter === opts.format)
        : configured
      const response = await proxyInference(input.request, {
        provider: opts.modelList === "full" ? entry?.byokProvider : undefined,
        model:
          opts.modelList === "full"
            ? entry?.providers.find((provider) => provider.id === entry.byokProvider)?.model
            : undefined,
        body: (providerModel) => requestBody?.stream(providerModel ?? model, false) ?? body,
      }).catch(() => {
        void (requestBody ? requestBody.cancel() : body.cancel()).catch(() => {})
        return inferenceUnavailable()
      })
      if (response) return response
    }
    const sessionId = input.request.headers.get("x-opencode-session") ?? ""
    const requestId = input.request.headers.get("x-opencode-request") ?? ""
    const ocClient = input.request.headers.get("x-opencode-client") ?? ""
    const projectId = input.request.headers.get("x-opencode-project") ?? ""
    const userAgent = input.request.headers.get("user-agent") ?? ""
    logger.metric({
      session: sessionId,
      request: requestId,
      client: ocClient,
      user_agent: userAgent,
      "model.tier": opts.modelList === "full" ? "zen" : "go",
    })
    const modelInfo = validateModel(zenData, model)
    const country = countryFromRequest(input.request)
    if (isModelCountryRestricted(modelInfo.id, country)) throw new RegionError(t("zen.api.error.countryNotAllowed"))
    const trialLimiter = createTrialLimiter(modelInfo.trialProvider, ip)
    const trialProviders = await trialLimiter?.check()
    const rateLimiter = modelInfo.allowAnonymous
      ? createIpRateLimiter(modelInfo.id, modelInfo.rateLimit, ip, input.request)
      : createKeyRateLimiter(modelInfo.id, modelInfo.rateLimit, zenApiKey, input.request)
    await rateLimiter?.check()
    const authInfo = await authenticate(modelInfo, zenApiKey)
    if (authInfo && opts.modelList === "lite" && requiresGoTrainingConsent(modelInfo.id) && !authInfo.allowTraining)
      throw new DataPolicyError(
        t("zen.api.error.trainingNotAllowed", {
          consoleGoUrl: `https://opencode.ai/workspace/${authInfo.workspaceID}/go`,
        }),
      )
    const allowedRegions = authInfo?.region
      ? authInfo.region
      : await (async () => {
          if (!authInfo) return
          return Actor.provide("system", { workspaceID: authInfo.workspaceID }, () =>
            Workspace.setDefaultRegion({ country }),
          )
        })()
    if (
      authInfo &&
      opts.modelList === "lite" &&
      ["deepseek-v4-flash", "deepseek-v4-pro"].includes(modelInfo.id) &&
      !allowedRegions?.includes("cn")
    )
      throw new RegionError(
        t("zen.api.error.regionNotAllowed", {
          consoleGoUrl: `https://opencode.ai/workspace/${authInfo.workspaceID}/go`,
        }),
      )
    const stickyId = sessionId ? sessionId : (authInfo?.workspaceID ?? ip)
    const stickyTracker = createStickyTracker(modelInfo.id, modelInfo.stickyProvider, stickyId)
    const stickyProvider = await stickyTracker?.get()
    const billingSource = validateBilling(authInfo, modelInfo)
    logger.metric({ source: billingSource })
    const modelTpmLimiter = createModelTpmLimiter(modelInfo.providers)
    const modelTpmLimits = await modelTpmLimiter?.check()
    const modelTpsLimiter = createModelTpsLimiter(modelInfo.providers)
    const modelTpsLimits = await modelTpsLimiter?.check()
    const providerBudgetTracker = createProviderBudgetTracker(
      modelInfo.providers.map((provider) => ({ ...zenData.providers[provider.id], ...provider })),
    )
    const providerBudget = await providerBudgetTracker?.check()

    const providerRequest = async () => {
      const providerInfo = selectProvider(
        model,
        zenData,
        authInfo,
        modelInfo,
        stickyId,
        trialProviders,
        stickyProvider,
        modelTpmLimits,
        modelTpsLimits,
        providerBudget,
      )
      validateModelSettings(billingSource, authInfo)
      updateProviderKey(authInfo, providerInfo)
      logger.metric({
        provider: providerInfo.id,
        "provider.model": providerInfo.model,
        shallowProvider: providerInfo.id,
        "shallowProvider.model": providerInfo.model,
      })

      const startTimestamp = Date.now()
      const reqUrl = providerInfo.modifyUrl(providerInfo.api, googleStream ?? false)
      const specialAnthropic =
        providerInfo.format === "anthropic" &&
        (providerInfo.model.startsWith("arn:aws:bedrock:") ||
          providerInfo.model.startsWith("global.anthropic.") ||
          providerInfo.model.startsWith("databricks-claude-"))
      if (providerInfo.format !== opts.format) throw new Error("Zen provider format must match request format")
      if (specialAnthropic) throw new Error("Anthropic provider body modifiers are incompatible with streaming")
      const prepared = requestBody

      const reqBody = (() => {
        if (opts.format === "google") return body
        if (!prepared) throw new Error("Missing prepared request body")
        return prepared.stream(providerInfo.model, providerInfo.format === "oa-compat")
      })()
      logger.debug("REQUEST URL: " + reqUrl)
      logger.debug("REQUEST: " + (requestBody?.preview ?? "") + "...")
      const isNewInference =
        providerInfo.id.startsWith("console.") ||
        providerInfo.id.startsWith("console-go.") ||
        providerInfo.id.startsWith("inf.") ||
        providerInfo.id.startsWith("inf-go.")
      const res = await fetch(reqUrl, {
        method: "POST",
        headers: (() => {
          const headers = new Headers(input.request.headers)
          providerInfo.modifyHeaders(headers, providerInfo.apiKey, stickyId)
          Object.entries(providerInfo.headerModifier ?? {}).forEach(([k, v]) => {
            if (v === "$ip") return headers.set(k, ip)
            if (v === "$caller") return headers.set(k, stickyId)
            if (v === "$session") return headers.set(k, sessionId)
            if (v === "$model") return headers.set(k, model)
            if (v === "$request") return headers.set(k, requestId)
            if (v === "$client") return headers.set(k, ocClient)
            if (v === "$project") return headers.set(k, projectId)
            if (v === "$workspace") {
              if (authInfo?.workspaceID) headers.set(k, authInfo.workspaceID)
              return
            }
            if (v === "$org") {
              if (authInfo?.workspaceID) headers.set(k, authInfo.workspaceID.replace("wrk_", "org_"))
              return
            }
            headers.set(k, v)
          })
          if (isNewInference) {
            headers.set("x-zen-model", model)
          }
          headers.delete("host")
          headers.delete("content-length")
          if (!isNewInference) {
            headers.delete("x-opencode-session")
            headers.delete("x-opencode-project")
            headers.delete("x-opencode-client")
            headers.delete("x-opencode-request")
            headers.delete("x-zen-model")
          }
          return headers
        })(),
        body: reqBody,
        duplex: "half",
        // Propagate caller disconnects to the upstream provider request so
        // abandoned Console requests do not leave orphaned inference work open.
        signal: input.request.signal,
      } as RequestInit & { duplex: "half" })
      const isStream = res.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false
      logger.metric({ is_stream: isStream })

      if (isNewInference) {
        const resEndpointId = res.headers.get("x-opencode-endpoint-id")
        const resEndpointModelId = res.headers.get("x-opencode-upstream-model-id")
        if (resEndpointId && resEndpointModelId)
          logger.metric({
            provider: resEndpointId,
            "provider.model": resEndpointModelId,
          })
      }

      if (res.status !== 200) {
        logger.metric({
          "llm.error.code": res.status,
          "llm.error.message": res.statusText,
        })
      }

      return { providerInfo, res, startTimestamp, isStream }
    }

    const { providerInfo, res, startTimestamp, isStream } = await providerRequest()

    // Store sticky provider
    if (res.status === 200) await stickyTracker?.set(providerInfo.id)

    // Temporarily change 404 to 400 status code b/c solid start automatically override 404 response
    const resStatus = res.status === 404 ? 400 : res.status

    // Scrub response headers
    const resHeaders = new Headers()
    const keepHeaders = ["content-type", "cache-control"]
    for (const [k, v] of res.headers.entries()) {
      if (keepHeaders.includes(k.toLowerCase())) {
        resHeaders.set(k, v)
      }
    }
    logger.debug("STATUS: " + res.status + " " + res.statusText)

    // Handle non-streaming response
    if (!isStream || [400, 404, 429, 529].includes(res.status)) {
      const json = await res.json()
      await rateLimiter?.track()
      const usage = providerInfo.extractUsage(json)
      if (usage) {
        const usageInfo = providerInfo.normalizeUsage(usage)
        const costInfo = calculateCost(modelInfo, usageInfo)
        await trialLimiter?.track(usageInfo)
        await modelTpmLimiter?.track(providerInfo.id, providerInfo.model, usageInfo)
        await providerBudgetTracker?.track(providerInfo.id, providerInfo.budgetPriority, costInfo.totalCostInCent)
        await trackUsage(sessionId, billingSource, authInfo, modelInfo, providerInfo, usageInfo, costInfo)
        await reload(billingSource, authInfo, costInfo)
        json.cost = calculateOccurredCost(billingSource, costInfo)
      }
      if (res.status === 400) {
        logger.metric({ "error.response": JSON.stringify(json) })
      }
      if (json.error?.message) {
        json.error.message = `Error from provider${providerInfo.displayName ? ` (${providerInfo.displayName})` : ""}: ${json.error.message}`
      }

      const responseConverter = createResponseConverter(providerInfo.format, opts.format)
      const body = JSON.stringify(responseConverter(json))
      logger.metric({ response_length: body.length })
      logger.debug("RESPONSE: " + body)
      return new Response(body, {
        status: resStatus,
        statusText: res.statusText,
        headers: resHeaders,
      })
    }

    // Handle streaming response
    const streamConverter = createStreamPartConverter(providerInfo.format, opts.format)
    const usageParser = providerInfo.createUsageParser()
    const binaryDecoder = providerInfo.createBinaryStreamDecoder()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const stream = new ReadableStream({
      start(c) {
        reader = res.body?.getReader()
        const decoder = new TextDecoder()
        const encoder = new TextEncoder()

        let buffer = ""
        let responseLength = 0
        let timestampFirstByte = 0

        function pump(): Promise<void> {
          return (
            reader?.read().then(async ({ done, value: rawValue }) => {
              if (done) {
                const timestampLastByte = Date.now()
                logger.metric({
                  response_length: responseLength,
                  "timestamp.last_byte": timestampLastByte,
                })
                await rateLimiter?.track()
                const usage = usageParser.retrieve()
                if (usage) {
                  const usageInfo = providerInfo.normalizeUsage(usage)
                  const costInfo = calculateCost(modelInfo, usageInfo)
                  await trialLimiter?.track(usageInfo)
                  await modelTpmLimiter?.track(providerInfo.id, providerInfo.model, usageInfo)
                  await modelTpsLimiter?.track(
                    providerInfo.id,
                    providerInfo.model,
                    providerInfo.tpsGoal,
                    timestampFirstByte,
                    timestampLastByte,
                    usageInfo,
                  )
                  await providerBudgetTracker?.track(
                    providerInfo.id,
                    providerInfo.budgetPriority,
                    costInfo.totalCostInCent,
                  )
                  await trackUsage(sessionId, billingSource, authInfo, modelInfo, providerInfo, usageInfo, costInfo)
                  await reload(billingSource, authInfo, costInfo)
                  const cost = calculateOccurredCost(billingSource, costInfo)
                  c.enqueue(encoder.encode(buildCostChunk(opts.format, cost)))
                }
                c.close()
                return
              }

              if (responseLength === 0) {
                timestampFirstByte = Date.now()
                logger.metric({
                  time_to_first_byte: timestampFirstByte - startTimestamp,
                  "timestamp.first_byte": timestampFirstByte,
                })
              }

              const value = binaryDecoder ? binaryDecoder(rawValue) : rawValue
              if (!value) return

              responseLength += value.length
              buffer += decoder.decode(value, { stream: true })

              const parts = buffer.split(/\r\n\r\n|\n\n|\r\r/)
              buffer = parts.pop() ?? ""

              for (let part of parts) {
                logger.debug("PART: " + part)

                part = part.trim()
                usageParser.parse(part)

                if (providerInfo.format !== opts.format) {
                  part = streamConverter(part)
                  c.enqueue(encoder.encode(part + "\n\n"))
                }
              }

              if (providerInfo.format === opts.format) {
                c.enqueue(value)
              }

              return pump()
            }) || Promise.resolve()
          )
        }

        return pump()
      },
      cancel() {
        // When the downstream caller stops reading, release the upstream
        // response body instead of keeping the provider/inference stream alive.
        return reader?.cancel()
      },
    })
    return new Response(stream, {
      status: resStatus,
      statusText: res.statusText,
      headers: resHeaders,
    })
  } catch (error: any) {
    if (requestBody) void requestBody.cancel().catch(() => {})
    else void input.request.body?.cancel().catch(() => {})
    // The caller disconnected before we finished. Because the outbound provider
    // request shares input.request.signal, an aborted caller surfaces here as an
    // AbortError. There is no client left to receive a body, so skip the error
    // metric and 500 and return a quiet client-closed response.
    if (input.request.signal.aborted || error?.name === "AbortError") {
      logger.debug("REQUEST ABORTED BY CALLER")
      return new Response(null, { status: 499 })
    }

    logger.metric({
      "error.type": error.constructor.name,
      "error.message": error.message,
      "error.cause": error.cause?.toString(),
    })
    if (error.message.startsWith("Failed query")) {
      try {
        logger.metric({
          "error.cause2": JSON.stringify(error.cause),
        })
      } catch {}
    }

    if (error instanceof RegionError || error instanceof DataPolicyError)
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: error.constructor.name, message: error.message },
        }),
        { status: 403 },
      )

    // Note: both top level "type" and "error.type" fields are used by the @ai-sdk/anthropic client to render the error message.
    if (
      error instanceof AuthError ||
      error instanceof CreditsError ||
      error instanceof MonthlyLimitError ||
      error instanceof UserLimitError ||
      error instanceof ModelError
    )
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: error.constructor.name, message: error.message },
        }),
        { status: 401 },
      )

    if (
      error instanceof RateLimitError ||
      error instanceof FreeUsageLimitError ||
      error instanceof GoUsageLimitError ||
      error instanceof BlackUsageLimitError
    ) {
      const headers = new Headers()
      if (error.retryAfter) {
        headers.set("retry-after", String(error.retryAfter))
      }
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: error.constructor.name,
            message: error.message,
          },
          metadata:
            error instanceof GoUsageLimitError
              ? {
                  workspace: error.workspace,
                  limitName: error.limitName,
                }
              : {},
        }),
        { status: 429, headers },
      )
    }

    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "error",
          message: "Internal server error",
        },
      }),
      { status: 500 },
    )
  }

  function validateModel(zenData: ZenData, reqModel: string) {
    if (!(reqModel in zenData.models)) throw new ModelError(t("zen.api.error.modelNotSupported", { model: reqModel }))

    const modelId = reqModel
    const modelData = Array.isArray(zenData.models[modelId])
      ? zenData.models[modelId].find((model) => opts.format === model.formatFilter)
      : zenData.models[modelId]

    if (!modelData)
      throw new ModelError(
        t("zen.api.error.modelFormatNotSupported", {
          model: reqModel,
          format: opts.format,
        }),
      )

    if (modelData.trialEnded)
      throw new ModelError(
        `${t("zen.api.error.trialEnded", {
          model: modelData.name,
          link: "https://opencode.ai/go",
        })}`,
      )

    logger.metric({ model: modelId })

    return { id: modelId, ...modelData }
  }

  function selectProvider(
    reqModel: string,
    zenData: ZenData,
    authInfo: AuthInfo,
    modelInfo: ModelInfo,
    stickyId: string,
    trialProviders: string[] | undefined,
    stickyProviderId: string | undefined,
    modelTpmLimits: Record<string, number> | undefined,
    modelTpsLimits: Record<string, { qualify: number; unqualify: number }> | undefined,
    providerBudget:
      | {
          qualify: (providerId: string, priority: number) => boolean
          prefer: (providerId: string, priority: number) => boolean
        }
      | undefined,
  ) {
    const modelProvider = (() => {
      // Byok is top priority b/c if user set their own API key, we should use it
      // instead of using the sticky provider for the same session
      if (authInfo?.provider?.credentials) {
        return modelInfo.providers.find((provider) => provider.id === modelInfo.byokProvider)
      }

      // Prioritize trial providers
      let allProviders = modelInfo.providers.filter((provider) => !provider.disabled)
      if (trialProviders) {
        allProviders = allProviders.map((provider) => ({
          ...provider,
          priority: trialProviders.includes(provider.id) ? 0 : provider.priority,
        }))
      }

      const fallbackProvider = allProviders.find((provider) => provider.id === modelInfo.fallbackProvider)

      let topPriority = Infinity
      const providers = allProviders
        .filter((provider) => provider.weight !== 0)
        .filter((provider) => {
          if (provider.budgetPriority === undefined) return true
          if (!providerBudget) return true
          return providerBudget.qualify(provider.id, provider.budgetPriority)
        })
        .filter((provider) => {
          if (!provider.tpmLimit) return true
          const usage = modelTpmLimits?.[`${provider.id}/${provider.model}`] ?? 0
          return usage < provider.tpmLimit * 1_000_000
        })
        .filter((provider) => {
          if (!provider.tpsGoal) return true
          const tps = modelTpsLimits?.[`${provider.id}/${provider.model}/${provider.tpsGoal}`] ?? {
            qualify: 0,
            unqualify: 0,
          }
          const isLowTps = tps.qualify + tps.unqualify > 10 && tps.qualify < tps.unqualify
          return !isLowTps
        })
        .map((provider) => {
          topPriority = Math.min(topPriority, provider.priority)
          return provider
        })
        .filter((p) => p.priority <= topPriority)
        .flatMap((provider) => Array<typeof provider>(provider.weight).fill(provider))

      // Use the last 4 characters of session ID to select a provider
      let h = 0
      const l = stickyId.length
      for (let i = l - 4; i < l; i++) {
        h = (h * 31 + stickyId.charCodeAt(i)) | 0 // 32-bit int
      }
      const index = (h >>> 0) % providers.length // make unsigned + range 0..length-1
      const provider = providers[index || 0] ?? fallbackProvider

      // sticky provider does not exist => use selected provider
      if (!stickyProviderId) return provider
      const stickProvider = allProviders.find((provider) => provider.id === stickyProviderId)
      if (!stickProvider) return provider

      const preferBudgetProvider =
        provider.budgetPriority !== undefined && providerBudget?.prefer(provider.id, provider.budgetPriority)

      const preferTpsProvider = (() => {
        if (!provider.tpsGoal) return false
        const tps = modelTpsLimits?.[`${provider.id}/${provider.model}/${provider.tpsGoal}`] ?? {
          qualify: 0,
          unqualify: 0,
        }
        return tps.qualify > tps.unqualify * 3
      })()

      if (!preferBudgetProvider && !preferTpsProvider) return stickProvider

      return provider
    })()

    if (!modelProvider) throw new ModelError(t("zen.api.error.noProviderAvailable"))
    if (!(modelProvider.id in zenData.providers))
      throw new ModelError(t("zen.api.error.providerNotSupported", { provider: modelProvider.id }))

    return {
      ...modelProvider,
      ...zenData.providers[modelProvider.id],
      ...(() => {
        const providerProps = zenData.providers[modelProvider.id]
        const format = providerProps.format
        const opts = {
          reqModel,
          providerModel: modelProvider.model,
          adjustCacheUsage: providerProps.adjustCacheUsage,
          workspaceID: authInfo?.workspaceID,
        }
        if (format === "anthropic") return anthropicHelper(opts)
        if (format === "google") return googleHelper(opts)
        if (format === "openai") return openaiHelper(opts)
        return oaCompatHelper(opts)
      })(),
    }
  }

  async function authenticate(modelInfo: ModelInfo, zenApiKey?: string) {
    if (!zenApiKey) {
      if (modelInfo.allowAnonymous) return
      throw new AuthError(t("zen.api.error.missingApiKey"))
    }

    const data = await Database.use((tx) =>
      tx
        .select({
          apiKey: KeyTable.id,
          workspace: {
            id: WorkspaceTable.id,
            region: WorkspaceTable.region,
            allowTraining: WorkspaceTable.allow_training,
            isBlocked: WorkspaceTable.is_blocked,
            isFlaggedByAnthropic: WorkspaceTable.is_flagged_by_anthropic,
            isFlaggedByOpenAI: WorkspaceTable.is_flagged_by_openai,
          },
          billing: {
            balance: BillingTable.balance,
            paymentMethodID: BillingTable.paymentMethodID,
            monthlyLimit: BillingTable.monthlyLimit,
            monthlyUsage: BillingTable.monthlyUsage,
            timeMonthlyUsageUpdated: BillingTable.timeMonthlyUsageUpdated,
            reloadTrigger: BillingTable.reloadTrigger,
            timeReloadLockedTill: BillingTable.timeReloadLockedTill,
            subscription: BillingTable.subscription,
            lite: BillingTable.lite,
          },
          user: {
            id: UserTable.id,
            monthlyLimit: UserTable.monthlyLimit,
            monthlyUsage: UserTable.monthlyUsage,
            timeMonthlyUsageUpdated: UserTable.timeMonthlyUsageUpdated,
          },
          black: {
            id: SubscriptionTable.id,
            rollingUsage: SubscriptionTable.rollingUsage,
            fixedUsage: SubscriptionTable.fixedUsage,
            timeRollingUpdated: SubscriptionTable.timeRollingUpdated,
            timeFixedUpdated: SubscriptionTable.timeFixedUpdated,
          },
          lite: {
            id: LiteTable.id,
            timeCreated: LiteTable.timeCreated,
            rollingUsage: LiteTable.rollingUsage,
            weeklyUsage: LiteTable.weeklyUsage,
            monthlyUsage: LiteTable.monthlyUsage,
            timeRollingUpdated: LiteTable.timeRollingUpdated,
            timeWeeklyUpdated: LiteTable.timeWeeklyUpdated,
            timeMonthlyUpdated: LiteTable.timeMonthlyUpdated,
          },
          provider: {
            credentials: ProviderTable.credentials,
          },
          timeDisabled: ModelTable.timeCreated,
        })
        .from(KeyTable)
        .innerJoin(WorkspaceTable, eq(WorkspaceTable.id, KeyTable.workspaceID))
        .innerJoin(BillingTable, eq(BillingTable.workspaceID, KeyTable.workspaceID))
        .innerJoin(UserTable, and(eq(UserTable.workspaceID, KeyTable.workspaceID), eq(UserTable.id, KeyTable.userID)))
        .leftJoin(ModelTable, and(eq(ModelTable.workspaceID, KeyTable.workspaceID), eq(ModelTable.model, modelInfo.id)))
        .leftJoin(
          ProviderTable,
          modelInfo.byokProvider
            ? and(
                eq(ProviderTable.workspaceID, KeyTable.workspaceID),
                eq(ProviderTable.provider, modelInfo.byokProvider),
              )
            : sql`false`,
        )
        .leftJoin(
          SubscriptionTable,
          and(
            eq(SubscriptionTable.workspaceID, KeyTable.workspaceID),
            eq(SubscriptionTable.userID, KeyTable.userID),
            isNull(SubscriptionTable.timeDeleted),
          ),
        )
        .leftJoin(
          LiteTable,
          and(
            eq(LiteTable.workspaceID, KeyTable.workspaceID),
            eq(LiteTable.userID, KeyTable.userID),
            isNull(LiteTable.timeDeleted),
          ),
        )
        .where(and(eq(KeyTable.key, zenApiKey), isNull(KeyTable.timeDeleted)))
        .then((rows) => rows[0]),
    )

    if (!data) throw new AuthError(t("zen.api.error.invalidApiKey"))
    if (
      data.workspace.isBlocked ||
      (data.workspace.isFlaggedByAnthropic && modelInfo.id.startsWith("claude-")) ||
      (data.workspace.isFlaggedByOpenAI && modelInfo.id.startsWith("gpt-"))
    )
      throw new AuthError(t("zen.api.error.requestBlockedByUpstreamProvider"))
    if (
      modelInfo.id.startsWith("alpha-") &&
      Resource.App.stage === "production" &&
      !ADMIN_WORKSPACES.includes(data.workspace.id)
    )
      throw new AuthError(t("zen.api.error.modelNotSupported", { model: modelInfo.id }))

    logger.metric({
      api_key: data.apiKey,
      workspace: data.workspace.id,
      user_id: data.user.id,
      ...(() => {
        if (data.billing.subscription)
          return {
            subscription: data.billing.subscription.plan,
          }
        if (data.billing.lite)
          return {
            subscription: "lite",
          }
        return {}
      })(),
    })

    return {
      apiKeyId: data.apiKey,
      workspaceID: data.workspace.id,
      region: data.workspace.region,
      allowTraining: data.workspace.allowTraining ?? false,
      billing: data.billing,
      user: data.user,
      black: data.black,
      lite: data.lite,
      provider: data.provider,
      isFree: ADMIN_WORKSPACES.includes(data.workspace.id),
      isDisabled: !!data.timeDisabled,
    }
  }

  function validateBilling(authInfo: AuthInfo, modelInfo: ModelInfo): BillingSource {
    if (!authInfo) return "anonymous"
    if (authInfo.provider?.credentials) return "byok"
    if (authInfo.isFree) return "free"
    if (modelInfo.allowAnonymous) return "free"

    const formatRetryTime = (seconds: number) => {
      const days = Math.floor(seconds / 86400)
      if (days >= 1) return `${days} day${days > 1 ? "s" : ""}`
      const hours = Math.floor(seconds / 3600)
      const minutes = Math.ceil((seconds % 3600) / 60)
      if (hours >= 1) return `${hours}hr ${minutes}min`
      return `${minutes}min`
    }

    // Validate black subscription billing
    if (authInfo.billing.subscription && authInfo.black) {
      try {
        const sub = authInfo.black
        const plan = authInfo.billing.subscription.plan

        // Check weekly limit
        if (sub.fixedUsage && sub.timeFixedUpdated) {
          const blackData = BlackData.getLimits({ plan })
          const result = Subscription.analyzeWeeklyUsage({
            limit: blackData.fixedLimit,
            usage: sub.fixedUsage,
            timeUpdated: sub.timeFixedUpdated,
          })
          if (result.status === "rate-limited")
            throw new BlackUsageLimitError(
              t("zen.api.error.subscriptionQuotaExceeded", {
                retryIn: formatRetryTime(result.resetInSec),
              }),
              result.resetInSec,
            )
        }

        // Check rolling limit
        if (sub.rollingUsage && sub.timeRollingUpdated) {
          const blackData = BlackData.getLimits({ plan })
          const result = Subscription.analyzeRollingUsage({
            limit: blackData.rollingLimit,
            window: blackData.rollingWindow,
            usage: sub.rollingUsage,
            timeUpdated: sub.timeRollingUpdated,
          })
          if (result.status === "rate-limited")
            throw new BlackUsageLimitError(
              t("zen.api.error.subscriptionQuotaExceeded", {
                retryIn: formatRetryTime(result.resetInSec),
              }),
              result.resetInSec,
            )
        }

        return "subscription"
      } catch (e) {
        if (!authInfo.billing.subscription.useBalance) throw e
      }
    }

    // Validate lite subscription billing
    if (opts.modelList === "lite" && authInfo.billing.lite && authInfo.lite) {
      if (Object.values(modelInfo.cost).every((price) => price === 0)) return "lite"

      try {
        const consoleGoUrl = `https://opencode.ai/workspace/${authInfo.workspaceID}/go`
        const sub = authInfo.lite
        const liteData = LiteData.getLimits()

        // Check weekly limit
        if (sub.weeklyUsage && sub.timeWeeklyUpdated) {
          const result = Subscription.analyzeWeeklyUsage({
            limit: liteData.weeklyLimit,
            usage: sub.weeklyUsage,
            timeUpdated: sub.timeWeeklyUpdated,
          })
          if (result.status === "rate-limited")
            throw new GoUsageLimitError(
              t("zen.api.error.goSubscriptionWeeklyLimitExceeded", {
                retryIn: formatRetryTime(result.resetInSec),
                consoleGoUrl,
              }),
              authInfo.workspaceID,
              "weekly",
              result.resetInSec,
            )
        }

        // Check monthly limit
        if (sub.monthlyUsage && sub.timeMonthlyUpdated) {
          const result = Subscription.analyzeMonthlyUsage({
            limit: liteData.monthlyLimit,
            usage: sub.monthlyUsage,
            timeUpdated: sub.timeMonthlyUpdated,
            timeSubscribed: sub.timeCreated,
          })
          if (result.status === "rate-limited")
            throw new GoUsageLimitError(
              t("zen.api.error.goSubscriptionMonthlyLimitExceeded", {
                retryIn: formatRetryTime(result.resetInSec),
                consoleGoUrl,
              }),
              authInfo.workspaceID,
              "monthly",
              result.resetInSec,
            )
        }

        // Check rolling limit
        if (sub.rollingUsage && sub.timeRollingUpdated) {
          const result = Subscription.analyzeRollingUsage({
            limit: liteData.rollingLimit,
            window: liteData.rollingWindow,
            usage: sub.rollingUsage,
            timeUpdated: sub.timeRollingUpdated,
          })
          if (result.status === "rate-limited")
            throw new GoUsageLimitError(
              t("zen.api.error.goSubscriptionRollingLimitExceeded", {
                retryIn: formatRetryTime(result.resetInSec),
                consoleGoUrl,
              }),
              authInfo.workspaceID,
              "5 hour",
              result.resetInSec,
            )
        }

        return "lite"
      } catch (e) {
        if (!authInfo.billing.lite.useBalance) throw e
      }
    }

    // Validate pay as you go billing
    const billing = authInfo.billing
    const billingUrl = `https://opencode.ai/workspace/${authInfo.workspaceID}/billing`
    const membersUrl = `https://opencode.ai/workspace/${authInfo.workspaceID}/members`
    if (!billing.paymentMethodID && billing.balance <= 0)
      throw new CreditsError(t("zen.api.error.noPaymentMethod", { billingUrl }))
    if (billing.balance <= 0) throw new CreditsError(t("zen.api.error.insufficientBalance", { billingUrl }))

    const now = new Date()
    const currentYear = now.getUTCFullYear()
    const currentMonth = now.getUTCMonth()
    if (
      billing.monthlyLimit &&
      billing.monthlyUsage &&
      billing.timeMonthlyUsageUpdated &&
      billing.monthlyUsage >= centsToMicroCents(billing.monthlyLimit * 100) &&
      currentYear === billing.timeMonthlyUsageUpdated.getUTCFullYear() &&
      currentMonth === billing.timeMonthlyUsageUpdated.getUTCMonth()
    )
      throw new MonthlyLimitError(
        t("zen.api.error.workspaceMonthlyLimitReached", {
          amount: billing.monthlyLimit,
          billingUrl,
        }),
      )

    if (
      authInfo.user.monthlyLimit &&
      authInfo.user.monthlyUsage &&
      authInfo.user.timeMonthlyUsageUpdated &&
      authInfo.user.monthlyUsage >= centsToMicroCents(authInfo.user.monthlyLimit * 100) &&
      currentYear === authInfo.user.timeMonthlyUsageUpdated.getUTCFullYear() &&
      currentMonth === authInfo.user.timeMonthlyUsageUpdated.getUTCMonth()
    )
      throw new UserLimitError(
        t("zen.api.error.userMonthlyLimitReached", {
          amount: authInfo.user.monthlyLimit,
          membersUrl,
        }),
      )

    return "balance"
  }

  function validateModelSettings(billingSource: BillingSource, authInfo: AuthInfo) {
    if (billingSource === "lite") return
    if (billingSource === "anonymous") return
    if (authInfo!.isDisabled) throw new ModelError(t("zen.api.error.modelDisabled"))
  }

  function updateProviderKey(authInfo: AuthInfo, providerInfo: ProviderInfo) {
    if (!authInfo?.provider?.credentials) return
    providerInfo.apiKey = authInfo.provider.credentials
  }

  function calculateCost(modelInfo: ModelInfo, usageInfo: UsageInfo) {
    const { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens } =
      usageInfo

    const modelCost =
      modelInfo.costPeak && isPeakPricing(new Date())
        ? modelInfo.costPeak
        : modelInfo.cost200K &&
            inputTokens + (cacheReadTokens ?? 0) + (cacheWrite5mTokens ?? 0) + (cacheWrite1hTokens ?? 0) >
              modelInfo.cost200K.threshold
          ? modelInfo.cost200K
          : modelInfo.cost

    const inputCost = modelCost.input * inputTokens * 100
    const outputCost = modelCost.output * outputTokens * 100
    const cacheReadCost = (() => {
      if (!cacheReadTokens) return undefined
      if (!modelCost.cacheRead) return undefined
      return modelCost.cacheRead * cacheReadTokens * 100
    })()
    const cacheWrite5mCost = (() => {
      if (!cacheWrite5mTokens) return undefined
      if (!modelCost.cacheWrite5m) return undefined
      return modelCost.cacheWrite5m * cacheWrite5mTokens * 100
    })()
    const cacheWrite1hCost = (() => {
      if (!cacheWrite1hTokens) return undefined
      if (!modelCost.cacheWrite1h) return undefined
      return modelCost.cacheWrite1h * cacheWrite1hTokens * 100
    })()
    const totalCostInCent =
      inputCost + outputCost + (cacheReadCost ?? 0) + (cacheWrite5mCost ?? 0) + (cacheWrite1hCost ?? 0)
    return {
      totalCostInCent,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheWrite5mCost,
      cacheWrite1hCost,
    }
  }

  function calculateOccurredCost(billingSource: BillingSource, costInfo: CostInfo) {
    return billingSource === "balance" ? (costInfo.totalCostInCent / 100).toFixed(8) : "0"
  }

  async function trackUsage(
    sessionId: string,
    billingSource: BillingSource,
    authInfo: AuthInfo,
    modelInfo: ModelInfo,
    providerInfo: ProviderInfo,
    usageInfo: UsageInfo,
    costInfo: CostInfo,
  ) {
    const { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens } =
      usageInfo
    const { totalCostInCent, inputCost, outputCost, cacheReadCost, cacheWrite5mCost, cacheWrite1hCost } = costInfo

    logger.metric({
      "tokens.input": inputTokens,
      "tokens.output": outputTokens,
      "tokens.reasoning": reasoningTokens,
      "tokens.cache_read": cacheReadTokens,
      "tokens.cache_write_5m": cacheWrite5mTokens,
      "tokens.cache_write_1h": cacheWrite1hTokens,
      "cost.input.microcents": centsToMicroCents(inputCost),
      "cost.output.microcents": centsToMicroCents(outputCost),
      "cost.cache_read.microcents": cacheReadCost ? centsToMicroCents(cacheReadCost) : undefined,
      "cost.cache_write.microcents": cacheWrite5mCost ? centsToMicroCents(cacheWrite5mCost) : undefined,
      "cost.total.microcents": centsToMicroCents(totalCostInCent),
      // deprecated - remove after May 20, 2026
      "cost.input": Math.round(inputCost),
      "cost.output": Math.round(outputCost),
      "cost.cache_read": cacheReadCost ? Math.round(cacheReadCost) : undefined,
      "cost.cache_write_5m": cacheWrite5mCost ? Math.round(cacheWrite5mCost) : undefined,
      "cost.cache_write_1h": cacheWrite1hCost ? Math.round(cacheWrite1hCost) : undefined,
      "cost.total": Math.round(totalCostInCent),
    })

    if (billingSource === "anonymous") return
    authInfo = authInfo!

    const cost = centsToMicroCents(totalCostInCent)
    // Keep period bounds and persisted timestamps on one snapshot when a queued write crosses a reset boundary.
    const trackedAt = new Date()

    // For hot workspaces, batch balance/usage updates through Redis to avoid
    // row-level lock contention on BillingTable/UserTable. Returns the amount
    // to flush this request, or null to skip the DB writes entirely.
    const balanceFlush = await (async () => {
      if (billingSource !== "subscription" && billingSource !== "lite" && HOT_WORKSPACES.has(authInfo.workspaceID)) {
        const workspaceCost = billingSource === "free" || billingSource === "byok" ? 0 : cost
        const flush = await accumulateUsage(authInfo.workspaceID, authInfo.user.id, workspaceCost, cost)
        return { batched: true as const, flush }
      }
      return { batched: false as const, flush: null }
    })()

    await Database.use((db) =>
      Promise.all([
        db.insert(UsageTable).values({
          workspaceID: authInfo.workspaceID,
          id: Identifier.create("usage"),
          model: modelInfo.id,
          provider: providerInfo.id,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cacheReadTokens,
          cacheWrite5mTokens,
          cacheWrite1hTokens,
          cost,
          keyID: authInfo.apiKeyId,
          sessionID: sessionId.substring(0, 30),
          enrichment: (() => {
            if (billingSource === "subscription") return { plan: "sub" }
            if (billingSource === "byok") return { plan: "byok" }
            if (billingSource === "lite") return { plan: "lite", costMultiplier: modelInfo.costMultiplier }
            return undefined
          })(),
        }),
        ...(() => {
          if (billingSource === "subscription") {
            const plan = authInfo.billing.subscription!.plan
            const black = BlackData.getLimits({ plan })
            const week = getWeekBounds(trackedAt)
            const rollingWindowSeconds = black.rollingWindow * 3600
            return [
              db
                .update(SubscriptionTable)
                .set({
                  fixedUsage: sql`
              CASE
                WHEN ${SubscriptionTable.timeFixedUpdated} >= ${week.end} THEN ${SubscriptionTable.fixedUsage}
                WHEN ${SubscriptionTable.timeFixedUpdated} >= ${week.start} THEN ${SubscriptionTable.fixedUsage} + ${cost}
                ELSE ${cost}
              END
            `,
                  timeFixedUpdated: sql`
              CASE
                WHEN ${SubscriptionTable.timeFixedUpdated} > ${trackedAt} THEN ${SubscriptionTable.timeFixedUpdated}
                ELSE ${trackedAt}
              END
            `,
                  rollingUsage: sql`
              CASE
                WHEN UNIX_TIMESTAMP(${SubscriptionTable.timeRollingUpdated}) >= UNIX_TIMESTAMP(now()) - ${rollingWindowSeconds} THEN ${SubscriptionTable.rollingUsage} + ${cost}
                ELSE ${cost}
              END
            `,
                  timeRollingUpdated: sql`
              CASE
                WHEN UNIX_TIMESTAMP(${SubscriptionTable.timeRollingUpdated}) >= UNIX_TIMESTAMP(now()) - ${rollingWindowSeconds} THEN ${SubscriptionTable.timeRollingUpdated}
                ELSE now()
              END
            `,
                })
                .where(
                  and(
                    eq(SubscriptionTable.workspaceID, authInfo.workspaceID),
                    eq(SubscriptionTable.userID, authInfo.user.id),
                  ),
                ),
            ]
          }
          if (billingSource === "lite") {
            const lite = LiteData.getLimits()
            const week = getWeekBounds(trackedAt)
            const month = getMonthlyBounds(trackedAt, authInfo.lite!.timeCreated)
            const rollingWindowSeconds = lite.rollingWindow * 3600
            const quotaCost = Math.round(cost * modelInfo.costMultiplier)
            return [
              db
                .update(LiteTable)
                .set({
                  monthlyUsage: sql`
              CASE
                WHEN ${LiteTable.timeMonthlyUpdated} >= ${month.end} THEN ${LiteTable.monthlyUsage}
                WHEN ${LiteTable.timeMonthlyUpdated} >= ${month.start} THEN ${LiteTable.monthlyUsage} + ${quotaCost}
                ELSE ${quotaCost}
              END
            `,
                  timeMonthlyUpdated: sql`
              CASE
                WHEN ${LiteTable.timeMonthlyUpdated} > ${trackedAt} THEN ${LiteTable.timeMonthlyUpdated}
                ELSE ${trackedAt}
              END
            `,
                  weeklyUsage: sql`
              CASE
                WHEN ${LiteTable.timeWeeklyUpdated} >= ${week.end} THEN ${LiteTable.weeklyUsage}
                WHEN ${LiteTable.timeWeeklyUpdated} >= ${week.start} THEN ${LiteTable.weeklyUsage} + ${quotaCost}
                ELSE ${quotaCost}
              END
            `,
                  timeWeeklyUpdated: sql`
              CASE
                WHEN ${LiteTable.timeWeeklyUpdated} > ${trackedAt} THEN ${LiteTable.timeWeeklyUpdated}
                ELSE ${trackedAt}
              END
            `,
                  rollingUsage: sql`
              CASE
                WHEN UNIX_TIMESTAMP(${LiteTable.timeRollingUpdated}) >= UNIX_TIMESTAMP(now()) - ${rollingWindowSeconds} THEN ${LiteTable.rollingUsage} + ${quotaCost}
                ELSE ${quotaCost}
              END
            `,
                  timeRollingUpdated: sql`
              CASE
                WHEN UNIX_TIMESTAMP(${LiteTable.timeRollingUpdated}) >= UNIX_TIMESTAMP(now()) - ${rollingWindowSeconds} THEN ${LiteTable.timeRollingUpdated}
                ELSE now()
              END
            `,
                })
                .where(and(eq(LiteTable.workspaceID, authInfo.workspaceID), eq(LiteTable.userID, authInfo.user.id))),
            ]
          }

          // Batched hot workspace: skip DB writes unless this request is the flush.
          if (balanceFlush.batched && !balanceFlush.flush) return []

          const workspaceDelta = balanceFlush.flush?.workspaceCost ?? cost
          const userDelta = balanceFlush.flush?.userCost ?? cost
          const balanceDelta = billingSource === "free" || billingSource === "byok" ? 0 : workspaceDelta

          return [
            db
              .update(BillingTable)
              .set({
                balance: sql`${BillingTable.balance} - ${balanceDelta}`,
                monthlyUsage: sql`
              CASE
                WHEN MONTH(${BillingTable.timeMonthlyUsageUpdated}) = MONTH(now()) AND YEAR(${BillingTable.timeMonthlyUsageUpdated}) = YEAR(now()) THEN ${BillingTable.monthlyUsage} + ${workspaceDelta}
                ELSE ${workspaceDelta}
              END
            `,
                timeMonthlyUsageUpdated: sql`now()`,
              })
              .where(eq(BillingTable.workspaceID, authInfo.workspaceID)),
            db
              .update(UserTable)
              .set({
                monthlyUsage: sql`
              CASE
                WHEN MONTH(${UserTable.timeMonthlyUsageUpdated}) = MONTH(now()) AND YEAR(${UserTable.timeMonthlyUsageUpdated}) = YEAR(now()) THEN ${UserTable.monthlyUsage} + ${userDelta}
                ELSE ${userDelta}
              END
            `,
                timeMonthlyUsageUpdated: sql`now()`,
              })
              .where(and(eq(UserTable.workspaceID, authInfo.workspaceID), eq(UserTable.id, authInfo.user.id))),
          ]
        })(),
      ]),
    )

    return { costInMicroCents: cost }
  }

  async function reload(billingSource: BillingSource, authInfo: AuthInfo, costInfo: CostInfo) {
    if (billingSource !== "balance") return
    authInfo = authInfo!

    const reloadTrigger = centsToMicroCents((authInfo.billing.reloadTrigger ?? Billing.RELOAD_TRIGGER) * 100)
    if (authInfo.billing.balance - costInfo.totalCostInCent >= reloadTrigger) return
    if (authInfo.billing.timeReloadLockedTill && authInfo.billing.timeReloadLockedTill > new Date()) return

    const lock = await Database.use((tx) =>
      tx
        .update(BillingTable)
        .set({
          timeReloadLockedTill: sql`now() + interval 1 minute`,
        })
        .where(
          and(
            eq(BillingTable.workspaceID, authInfo.workspaceID),
            eq(BillingTable.reload, true),
            lt(BillingTable.balance, reloadTrigger),
            or(isNull(BillingTable.timeReloadLockedTill), lt(BillingTable.timeReloadLockedTill, sql`now()`)),
          ),
        ),
    )
    if (lock.rowsAffected === 0) return

    await Actor.provide("system", { workspaceID: authInfo.workspaceID }, async () => {
      await Billing.reload()
    })
  }
}
