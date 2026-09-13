import type { ModelMessage, ToolResultPart } from "ai"
import { mergeDeep, unique } from "remeda"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type * as Provider from "./provider"
import type * as ModelsDev from "@opencode-ai/core/models-dev"
import { iife } from "@/util/iife"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export const OUTPUT_TOKEN_MAX = 32_000

// OpenAI Responses `include` value that returns the encrypted reasoning state
// needed for stateless multi-turn reasoning (store: false). Hoisted so every
// branch that requests it stays in lockstep.
const INCLUDE_ENCRYPTED_REASONING = ["reasoning.encrypted_content"] as const

export function sanitizeSurrogates(content: string) {
  return content.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
}

function isKimiFamily(model: Provider.Model) {
  if (
    [model.providerID, model.api.id].some((id) => {
      const value = id.toLowerCase()
      return value.includes("kimi") || value.includes("moonshot")
    })
  )
    return true
  const url = model.api.url.toLowerCase()
  return ["api.kimi.com", "api.moonshot.ai", "api.moonshot.cn", "api.moonshotai.cn"].some((host) => url.includes(host))
}

// Maps npm package to the key the AI SDK expects for providerOptions
function sdkKey(npm: string): string | undefined {
  switch (npm) {
    case "@ai-sdk/github-copilot":
      return "copilot"
    case "@ai-sdk/azure":
      return "azure"
    case "@ai-sdk/openai":
      return "openai"
    case "@ai-sdk/amazon-bedrock/mantle":
      return "openai"
    case "@ai-sdk/amazon-bedrock":
      return "bedrock"
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic":
      return "anthropic"
    case "@ai-sdk/google-vertex":
      return "vertex"
    case "@ai-sdk/google":
      return "google"
    case "@ai-sdk/alibaba":
      return "alibaba"
    case "@ai-sdk/cerebras":
      return "cerebras"
    case "@ai-sdk/cohere":
      return "cohere"
    case "@ai-sdk/deepinfra":
      return "deepinfra"
    case "@ai-sdk/groq":
      return "groq"
    case "@ai-sdk/mistral":
      return "mistral"
    case "@ai-sdk/perplexity":
      return "perplexity"
    case "@ai-sdk/togetherai":
      return "togetherai"
    case "@ai-sdk/vercel":
      return "vercel"
    case "@ai-sdk/xai":
      return "xai"
    case "venice-ai-sdk-provider":
      return "venice"
    case "@ai-sdk/gateway":
      return "gateway"
    case "@openrouter/ai-sdk-provider":
      return "openrouter"
    case "merge-gateway-ai-sdk-provider":
      return "mergeGateway"
    case "ai-gateway-provider":
      // ai-gateway-provider/unified wraps createOpenAICompatible({ name: "Unified" }),
      // and @ai-sdk/openai-compatible parses compatibleOptions from one of
      // "openai-compatible" / "openaiCompatible" / "Unified" / "unified". The
      // "openai-compatible" key emits a deprecation warning at runtime, so we
      // pick the camelCase form the SDK now treats as canonical.
      return "openaiCompatible"
  }
  return undefined
}

// TODO: fix this stupid inefficient dogshit function
function normalizeMessages(
  msgs: ModelMessage[],
  model: Provider.Model,
  _options: Record<string, unknown>,
): ModelMessage[] {
  const sanitizeToolResultOutput = (content: ToolResultPart) => {
    if (content.output.type === "text" || content.output.type === "error-text") {
      content.output.value = sanitizeSurrogates(content.output.value)
    }
    if (content.output.type === "content") {
      content.output.value = content.output.value.map((item) => {
        if (item.type === "text") {
          item.text = sanitizeSurrogates(item.text)
        }
        return item
      })
    }
    return content
  }

  msgs = msgs.map((msg) => {
    switch (msg.role) {
      case "tool":
        if (!Array.isArray(msg.content)) return msg
        msg.content = msg.content.map((content) => {
          if (content.type === "tool-result") {
            return sanitizeToolResultOutput(content)
          }
          return content
        })
        return msg

      case "system":
        msg.content = sanitizeSurrogates(msg.content)
        return msg

      case "user":
        if (typeof msg.content === "string") {
          msg.content = sanitizeSurrogates(msg.content)
        } else {
          msg.content = msg.content.map((content) => {
            if (content.type === "text") {
              content.text = sanitizeSurrogates(content.text)
            }
            return content
          })
        }
        return msg

      case "assistant":
        if (typeof msg.content === "string") {
          msg.content = sanitizeSurrogates(msg.content)
        } else {
          msg.content = msg.content.map((content) => {
            if (content.type === "text" || content.type === "reasoning") {
              content.text = sanitizeSurrogates(content.text)
            }
            if (content.type === "tool-result") {
              return sanitizeToolResultOutput(content)
            }
            return content
          })
        }
        return msg
    }
  })

  // Anthropic rejects messages with empty content - filter out empty string messages
  // and remove empty text/reasoning parts from array content
  if (model.api.npm === "@ai-sdk/anthropic") {
    msgs = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined
          return msg
        }
        if (!Array.isArray(msg.content)) return msg
        const filtered = msg.content.filter((part) => {
          if (part.type === "text") {
            return part.text !== ""
          }
          if (part.type === "reasoning") {
            return (
              part.text.trim().length > 0 ||
              part.providerOptions?.anthropic?.signature != null ||
              part.providerOptions?.anthropic?.redactedData != null
            )
          }
          return true
        })
        if (filtered.length === 0) return undefined
        return { ...msg, content: filtered }
      })
      .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
  }

  // Bedrock specific transforms
  if (model.api.npm === "@ai-sdk/amazon-bedrock") {
    msgs = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined
          return msg
        }
        if (!Array.isArray(msg.content)) return msg
        const filtered = msg.content.filter((part) => {
          if (part.type === "text") {
            return part.text !== ""
          }
          if (part.type === "reasoning") {
            // Match what the SDK can replay before assigning cache points. Otherwise
            // unsigned reasoning can leave an empty or cache-point-only message.
            const metadata = part.providerOptions?.[model.providerID] ?? part.providerOptions?.bedrock
            return metadata?.signature != null || metadata?.redactedContent != null || metadata?.redactedData != null
          }
          return true
        })
        if (filtered.length === 0) return undefined
        return { ...msg, content: filtered }
      })
      .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
  }

  if (model.api.id.includes("claude")) {
    const scrub = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")
    msgs = msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-call" || part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      return msg
    })
  }

  const modelID = model.api.id.toLowerCase()
  if (
    model.providerID === "mistral" ||
    ["mistral", "devstral", "codestral", "pixtral", "mixtral"].some((family) => modelID.includes(family))
  ) {
    const scrub = (id: string) => {
      return id
        .replace(/[^a-zA-Z0-9]/g, "") // Remove non-alphanumeric characters
        .substring(0, 9) // Take first 9 characters
        .padEnd(9, "0") // Pad with zeros if less than 9 characters
    }
    const result: ModelMessage[] = []
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      const nextMsg = msgs[i + 1]

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        msg.content = msg.content.map((part) => {
          if (part.type === "tool-call" || part.type === "tool-result") {
            return { ...part, toolCallId: scrub(part.toolCallId) }
          }
          return part
        })
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        msg.content = msg.content.map((part) => {
          if (part.type === "tool-result") {
            return { ...part, toolCallId: scrub(part.toolCallId) }
          }
          return part
        })
      }
      result.push(msg)

      // Fix message sequence: tool messages cannot be followed by user messages
      if (msg.role === "tool" && nextMsg?.role === "user") {
        result.push({
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Done.",
            },
          ],
        })
      }
    }
    return result
  }

  // Deepseek requires all assistant messages to have reasoning on them
  if (model.api.id.toLowerCase().includes("deepseek")) {
    msgs = msgs.map((msg) => {
      if (msg.role !== "assistant") return msg
      if (Array.isArray(msg.content)) {
        if (msg.content.some((part) => part.type === "reasoning")) return msg
        return { ...msg, content: [...msg.content, { type: "reasoning", text: "" }] }
      }
      return {
        ...msg,
        content: [
          ...(msg.content ? [{ type: "text" as const, text: msg.content }] : []),
          { type: "reasoning" as const, text: "" },
        ],
      }
    })
  }

  if (
    typeof model.capabilities.interleaved === "object" &&
    model.capabilities.interleaved.field &&
    model.api.npm !== "@openrouter/ai-sdk-provider"
  ) {
    const field = model.capabilities.interleaved.field
    return msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
        const reasoningText = reasoningParts.map((part: any) => part.text).join("")

        // Filter out reasoning parts from content
        const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

        // Include reasoning_content | reasoning_details directly on the message for all assistant messages.
        // Always set the field even when empty — some providers (e.g. DeepSeek) may return empty
        // reasoning_content which still needs to be sent back in subsequent requests.
        return {
          ...msg,
          content: filteredContent,
          providerOptions: {
            ...msg.providerOptions,
            openaiCompatible: {
              ...msg.providerOptions?.openaiCompatible,
              [field]: reasoningText,
            },
          },
        }
      }

      return msg
    })
  }

  return msgs
}

function applyCaching(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
  const final = msgs.filter((msg) => msg.role !== "system").slice(-2)

  const providerOptions = {
    anthropic: {
      cacheControl: { type: "ephemeral" },
    },
    openrouter: {
      cacheControl: { type: "ephemeral" },
    },
    bedrock: {
      cachePoint: { type: "default" },
    },
    openaiCompatible: {
      cache_control: { type: "ephemeral" },
    },
    copilot: {
      copilot_cache_control: { type: "ephemeral" },
    },
    alibaba: {
      cacheControl: { type: "ephemeral" },
    },
  }

  for (const msg of unique([...system, ...final])) {
    const useMessageLevelOptions =
      model.providerID === "anthropic" ||
      model.providerID.includes("bedrock") ||
      model.api.npm === "@ai-sdk/amazon-bedrock"
    const shouldUseContentOptions = !useMessageLevelOptions && Array.isArray(msg.content) && msg.content.length > 0

    if (shouldUseContentOptions) {
      const lastContent = msg.content[msg.content.length - 1]
      if (
        lastContent &&
        typeof lastContent === "object" &&
        lastContent.type !== "tool-approval-request" &&
        lastContent.type !== "tool-approval-response"
      ) {
        lastContent.providerOptions = mergeDeep(lastContent.providerOptions ?? {}, providerOptions)
        continue
      }
    }

    msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, providerOptions)
  }

  return msgs
}

function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    const filtered = msg.content.map((part) => {
      if (part.type !== "file" && part.type !== "image") return part

      // Check for empty base64 image data
      if (part.type === "image") {
        const imageStr = String(part.image)
        if (imageStr.startsWith("data:")) {
          const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
          if (match && (!match[2] || match[2].length === 0)) {
            return {
              type: "text" as const,
              text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
            }
          }
        }
      }

      const mime = part.type === "image" ? String(part.image).split(";")[0].replace("data:", "") : part.mediaType
      const filename = part.type === "file" ? part.filename : undefined
      const modality = mimeToModality(mime)
      if (!modality) return part
      if (model.capabilities.input[modality]) return part

      const name = filename ? `"${filename}"` : modality
      return {
        type: "text" as const,
        text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
      }
    })

    return { ...msg, content: filtered }
  })
}

function mapProviderOptions(
  msgs: ModelMessage[],
  transform: (options: Record<string, any> | undefined) => Record<string, any> | undefined,
) {
  return msgs.map((msg) => {
    if (!Array.isArray(msg.content)) return { ...msg, providerOptions: transform(msg.providerOptions) }
    return {
      ...msg,
      providerOptions: transform(msg.providerOptions),
      content: msg.content.map((part) =>
        part.type === "tool-approval-request" || part.type === "tool-approval-response"
          ? part
          : { ...part, providerOptions: transform(part.providerOptions) },
      ),
    } as typeof msg
  })
}

export function message(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
  msgs = unsupportedParts(msgs, model)
  msgs = normalizeMessages(msgs, model, options)
  const usesAnthropicAutomaticCaching =
    options.cacheControl !== undefined &&
    (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/google-vertex/anthropic")
  if (
    (model.providerID === "anthropic" ||
      model.providerID === "google-vertex-anthropic" ||
      model.api.id.includes("anthropic") ||
      model.api.id.includes("claude") ||
      model.id.includes("anthropic") ||
      model.id.includes("claude") ||
      model.api.npm === "@ai-sdk/anthropic" ||
      model.api.npm === "@ai-sdk/alibaba") &&
    model.api.npm !== "@ai-sdk/gateway" &&
    !usesAnthropicAutomaticCaching
  ) {
    msgs = applyCaching(msgs, model)
  }

  // Remap providerOptions keys from stored providerID to expected SDK key
  const key = sdkKey(model.api.npm)
  if (key && key !== model.providerID) {
    const remap = (opts: Record<string, any> | undefined) => {
      if (!opts) return opts
      if (!(model.providerID in opts)) return opts
      const result = { ...opts }
      result[key] = result[model.providerID]
      delete result[model.providerID]
      return result
    }

    msgs = mapProviderOptions(msgs, remap)
  }

  // Strip Responses item IDs before serialization, following Codex and keeping signed request bodies immutable.
  if (
    options.store !== true &&
    key &&
    ["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/amazon-bedrock/mantle", "@ai-sdk/github-copilot"].includes(
      model.api.npm,
    )
  ) {
    msgs = mapProviderOptions(msgs, (options) => {
      if (!options?.[key] || !("itemId" in options[key])) return options
      const metadata = { ...options[key] }
      delete metadata.itemId
      return { ...options, [key]: metadata }
    })
  }

  return msgs
}

const GEMINI_MODELS_WITH_SAMPLING_DEFAULTS = [
  /gemini-2[.-]5(?:[.-]|$)/,
  /gemini-3-(?:flash|pro)(?:[.-]|$)/,
  /gemini-3[.-]1(?:[.-]|$)/,
  /gemini-3[.-]5-flash(?!-lite)(?:[.-]|$)/,
]

export function temperature(model: Provider.Model) {
  const id = model.api.id.toLowerCase()
  if (id.includes("north-mini-code")) return 1.0
  if (id.includes("claude")) return undefined
  if (id.includes("gemini"))
    return GEMINI_MODELS_WITH_SAMPLING_DEFAULTS.some((model) => model.test(id)) ? 1.0 : undefined
  if (id.includes("glm-4.6")) return 1.0
  if (id.includes("glm-4.7")) return 1.0
  if (id.includes("minimax-m2")) return 1.0
  if (id.includes("kimi-k2")) {
    // kimi-k2-thinking & kimi-k2.5 && kimi-k2p5 && kimi-k2-5
    if (["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s))) {
      return 1.0
    }
    return 0.6
  }
  return undefined
}

export function topP(model: Provider.Model) {
  const id = model.api.id.toLowerCase()
  if (id.includes("gemini"))
    return GEMINI_MODELS_WITH_SAMPLING_DEFAULTS.some((model) => model.test(id)) ? 0.95 : undefined
  if (["minimax-m2", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((s) => id.includes(s))) {
    return 0.95
  }
  if (
    ["deepseek-v4-flash-0731", "deepseek-v4-flash:0731"].some((name) => id.includes(name)) ||
    (id.includes("deepseek-v4-flash") && (model.providerID === "deepseek" || model.providerID.startsWith("opencode")))
  ) {
    return 0.95
  }
  return undefined
}

export function topK(model: Provider.Model) {
  const id = model.api.id.toLowerCase()
  if (id.includes("minimax-m2")) {
    if (["m2.", "m25", "m21"].some((s) => id.includes(s))) return 40
    return 20
  }
  if (id.includes("gemini"))
    return GEMINI_MODELS_WITH_SAMPLING_DEFAULTS.some((model) => model.test(id)) ? 64 : undefined
  return undefined
}

const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
const OPENAI_GPT5_1_EFFORTS = ["none", ...WIDELY_SUPPORTED_EFFORTS]
const OPENAI_GPT5_2_PLUS_EFFORTS = [...OPENAI_GPT5_1_EFFORTS, "xhigh"]
const OPENAI_GPT5_PRO_EFFORTS = ["high"]
const OPENAI_GPT5_PRO_2_PLUS_EFFORTS = ["medium", "high", "xhigh"]
const OPENAI_GPT5_CHAT_EFFORTS = ["medium"]
const OPENAI_GPT5_CODEX_XHIGH_EFFORTS = [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
const OPENAI_GPT5_CODEX_3_PLUS_EFFORTS = ["none", ...OPENAI_GPT5_CODEX_XHIGH_EFFORTS]

// OpenAI rolled out the `none` reasoning_effort tier on this date (Responses API).
// Models released before it 400 on `reasoning_effort: "none"`, so we only expose
// it as a variant for models new enough to accept it.
const OPENAI_NONE_EFFORT_RELEASE_DATE = "2025-11-13"

// OpenAI rolled out the `xhigh` reasoning_effort tier on this date. Same reasoning.
const OPENAI_XHIGH_EFFORT_RELEASE_DATE = "2025-12-04"

// Matches members of the gpt-5 family across the id formats we encounter:
//   "gpt-5", "gpt-5-nano", "gpt-5.4", "openai/gpt-5.4-codex".
// Anchored to start-of-string or "/" so it doesn't false-match "gpt-50" or "gpt-5o".
const GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/
const GPT5_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
const GPT5_PRO_RE = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/
const GPT5_VERSIONED_PRO_RE = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/

function gpt5Version(apiId: string) {
  return Number(GPT5_VERSION_RE.exec(apiId)?.[1]) || undefined
}

function versionedGpt5ReasoningEfforts(apiId: string) {
  if (GPT5_VERSIONED_PRO_RE.test(apiId)) return OPENAI_GPT5_PRO_2_PLUS_EFFORTS
  const version = gpt5Version(apiId)
  if (version === undefined) return undefined
  if (version === 1) return OPENAI_GPT5_1_EFFORTS
  return OPENAI_GPT5_2_PLUS_EFFORTS
}

function gpt5CodexReasoningEfforts(apiId: string) {
  if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes("codex")) return undefined
  const version = gpt5Version(apiId)
  if (version !== undefined && version >= 3) return OPENAI_GPT5_CODEX_3_PLUS_EFFORTS
  if (apiId.includes("codex-max") || (version !== undefined && version >= 2)) return OPENAI_GPT5_CODEX_XHIGH_EFFORTS
  return WIDELY_SUPPORTED_EFFORTS
}

function gpt5ChatReasoningEfforts(apiId: string) {
  if (!GPT5_FAMILY_RE.test(apiId) || !apiId.includes("-chat")) return undefined
  return gpt5Version(apiId) === undefined ? [] : OPENAI_GPT5_CHAT_EFFORTS
}

// Computes the reasoning_effort tiers an OpenAI (or OpenAI-compatible upstream
// routed through it, e.g. cf-ai-gateway) model exposes. Effort order: weakest
// to strongest.
function openaiReasoningEfforts(apiId: string, releaseDate: string) {
  const id = apiId.toLowerCase()
  if (id.includes("deep-research")) return ["medium"]
  const chatEfforts = gpt5ChatReasoningEfforts(id)
  if (chatEfforts) return chatEfforts
  if (GPT5_PRO_RE.test(id)) return OPENAI_GPT5_PRO_EFFORTS
  const codexEfforts = gpt5CodexReasoningEfforts(id)
  if (codexEfforts) return codexEfforts
  const versionedEfforts = versionedGpt5ReasoningEfforts(id)
  // GPT-5.1 replaced GPT-5's `minimal` effort with `none`; GPT-5.2+
  // additionally accepts `xhigh`. Model pages list the supported subset.
  if (versionedEfforts) return versionedEfforts
  const efforts = [...WIDELY_SUPPORTED_EFFORTS]
  if (GPT5_FAMILY_RE.test(id)) efforts.unshift("minimal")
  if (releaseDate >= OPENAI_NONE_EFFORT_RELEASE_DATE) efforts.unshift("none")
  if (releaseDate >= OPENAI_XHIGH_EFFORT_RELEASE_DATE) efforts.push("xhigh")
  return efforts
}

function openaiCompatibleReasoningEfforts(id: string) {
  const apiId = id.toLowerCase()
  const chatEfforts = gpt5ChatReasoningEfforts(apiId)
  if (chatEfforts) return chatEfforts
  if (GPT5_PRO_RE.test(apiId)) return OPENAI_GPT5_PRO_EFFORTS
  return gpt5CodexReasoningEfforts(apiId) ?? versionedGpt5ReasoningEfforts(apiId) ?? OPENAI_EFFORTS
}

function anthropicUsesModernAdaptiveThinking(apiId: string) {
  if (!apiId.toLowerCase().includes("claude-")) return false
  // Covers family-first IDs such as claude-opus-4.7 and version-first IDs such as claude-4.7-opus.
  // Limit minors to two digits so release dates in IDs such as claude-opus-4-20250514 are not versions.
  const version = /claude-(?:[a-z]+-)?(\d+)(?:[.-](\d{1,2}))?(?:[.@-]|$)/i.exec(apiId)
  if (!version) return true
  const major = Number(version[1])
  const minor = Number(version[2] ?? 0)
  return major > 4 || (major === 4 && minor >= 7)
}

function anthropicOpus45(apiId: string) {
  return ["opus-4-5", "opus-4.5"].some((value) => apiId.includes(value))
}

function anthropicAdaptiveEfforts(apiId: string): string[] | null {
  if (anthropicUsesModernAdaptiveThinking(apiId)) {
    return ["low", "medium", "high", "xhigh", "max"]
  }
  if (
    ["opus-4-6", "opus-4.6", "4-6-opus", "4.6-opus", "sonnet-4-6", "sonnet-4.6", "4-6-sonnet", "4.6-sonnet"].some((v) =>
      apiId.includes(v),
    )
  ) {
    return ["low", "medium", "high", "max"]
  }
  return null
}

function anthropicOmitsThinking(apiId: string) {
  return anthropicUsesModernAdaptiveThinking(apiId)
}

// Default to binding controls for Claude 5.1+ as enforcement expands to later models.
// Mythos 5.1 explicitly does not run the conversation-prefix check.
// https://platform.claude.com/docs/en/build-with-claude/thinking#preserved-in-conversation
function anthropicBindsThinking(apiId: string) {
  // Capture either family/version order, without reading release dates as minor versions.
  const version = /claude-(?:([a-z]+)-)?(\d+)(?:[.-](\d{1,2}))?(?:-([a-z]+))?(?:[.@-]|$)/i.exec(apiId)
  if (!version) return false
  const major = Number(version[2])
  const minor = Number(version[3] ?? 0)
  if (major === 5 && minor === 1 && (version[1] ?? version[4])?.toLowerCase() === "mythos") return false
  return major > 5 || (major === 5 && minor >= 1)
}

// Fable 5.1 binds each thinking signature to the system prompt, tool list, and
// messages above it, and rejects the request when any of that changes. opencode
// re-renders parts of that prefix between turns (system prompt, tools, compaction),
// so ask the API to drop the affected blocks instead of failing the request.
// Older model deployments may reject this field, even with thinking enabled.
// The patched AI SDK adds the thinking-binding-controls beta whenever it is set.
const ANTHROPIC_BLOCK_BINDING = { prefixMismatchBehavior: "drop_block" }

function anthropicBlockBinding(model: Provider.Model, options: { [x: string]: any }) {
  const sdk = sdkKey(model.api.npm)
  const key = sdk === "bedrock" ? "reasoningConfig" : sdk === "anthropic" ? "thinking" : undefined
  // Consume the OpenCode-only opt-out even on models outside the default scope.
  if (key && options[key]?.blockBinding === false) {
    const result = { ...options, [key]: { ...options[key] } }
    delete result[key].blockBinding
    if (Object.keys(result[key]).length === 0) delete result[key]
    return result
  }

  if (!anthropicBindsThinking(model.api.id)) return options
  switch (model.api.npm) {
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic": {
      const thinking = options.thinking ?? { type: "adaptive" }
      if (thinking.type !== "adaptive" && thinking.type !== "enabled") return options
      if (thinking.blockBinding !== undefined) return options
      return { ...options, thinking: { ...thinking, blockBinding: ANTHROPIC_BLOCK_BINDING } }
    }
    case "@ai-sdk/amazon-bedrock": {
      const reasoningConfig = options.reasoningConfig ?? { type: "adaptive" }
      if (reasoningConfig.type !== "adaptive" && reasoningConfig.type !== "enabled") return options
      if (reasoningConfig.blockBinding !== undefined) return options
      return { ...options, reasoningConfig: { ...reasoningConfig, blockBinding: ANTHROPIC_BLOCK_BINDING } }
    }
  }
  return options
}

function googleThinkingLevelEfforts(apiId: string) {
  const id = apiId.toLowerCase()
  if (!id.includes("gemini-3")) return ["low", "high"]
  if (id.includes("flash-image")) return ["minimal", "high"]
  if (id.includes("pro-image")) return ["high"]
  if (id.includes("flash")) return ["minimal", "low", "medium", "high"]
  return ["low", "medium", "high"]
}

function googleThinkingBudgetMax(apiId: string) {
  const id = apiId.toLowerCase()
  if (id.includes("2.5") && id.includes("pro") && !id.includes("flash")) return 32_768
  return 24_576
}

// SAP's Zod schema drops unknown top-level keys; reasoning controls survive
// only via `modelParams` (catchall), forwarded verbatim by the SAP SDKs.
function wrapInSapModelParams(variants: Record<string, Record<string, any>>): Record<string, Record<string, any>> {
  return Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, { modelParams: v }]))
}

function googleThinkingVariants(model: Provider.Model): Record<string, Record<string, any>> {
  const id = model.api.id.toLowerCase()
  if (id.includes("2.5")) {
    return {
      high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
      max: {
        thinkingConfig: { includeThoughts: true, thinkingBudget: googleThinkingBudgetMax(id) },
      },
    }
  }
  return Object.fromEntries(
    googleThinkingLevelEfforts(id).map((effort) => [
      effort,
      { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } },
    ]),
  )
}

export function variants(model: Provider.Model): Record<string, Record<string, any>> {
  if (!model.capabilities.reasoning) return {}

  const id = model.id.toLowerCase()
  const glm52 = ["glm-5.2", "glm-5-2", "glm-5p2"].some(
    (name) => id.includes(name) || model.api.id.toLowerCase().includes(name),
  )
  if (
    model.api.id.toLowerCase().includes("minimax-m3") &&
    ["@ai-sdk/anthropic", "@ai-sdk/openai-compatible"].includes(model.api.npm)
  ) {
    if (["nvidia", "lilac"].includes(model.providerID)) {
      return {
        none: { chat_template_kwargs: { thinking_mode: "disabled" } },
        thinking: { chat_template_kwargs: { thinking_mode: "enabled" } },
      }
    }
    return {
      none: { thinking: { type: "disabled" } },
      thinking: { thinking: { type: "adaptive" } },
    }
  }
  const adaptiveThinkingOmitted = anthropicOmitsThinking(model.api.id)
  const adaptiveEfforts = anthropicAdaptiveEfforts(model.api.id)
  if (glm52 && model.api.npm === "@openrouter/ai-sdk-provider") {
    // OpenRouter maps xhigh to GLM-5.2's native max effort.
    return {
      high: { reasoning: { effort: "high" } },
      xhigh: { reasoning: { effort: "xhigh" } },
    }
  }
  if (glm52 && model.api.npm === "@ai-sdk/openai-compatible") {
    return {
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    }
  }
  if (glm52 && model.api.npm === "@ai-sdk/anthropic") {
    return {
      high: { effort: "high" },
      max: { effort: "max" },
    }
  }
  // Kimi's Anthropic-compatible transports implement adaptive thinking effort.
  if (isKimiFamily(model) && ["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"].includes(model.api.npm)) {
    return Object.fromEntries(
      ["low", "medium", "high", "xhigh", "max"].map((effort) => [
        effort,
        { thinking: { type: "adaptive", display: "summarized" }, effort },
      ]),
    )
  }
  if (
    id.includes("deepseek-chat") ||
    id.includes("deepseek-reasoner") ||
    id.includes("deepseek-r1") ||
    id.includes("deepseek-v3") ||
    id.includes("minimax") ||
    (id.includes("glm") && !glm52) ||
    id.includes("kimi") ||
    id.includes("k2p") ||
    id.includes("qwen") ||
    id.includes("big-pickle")
  )
    return {}

  // see: https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
  if (id.includes("grok") && id.includes("grok-3-mini")) {
    if (model.api.npm === "@openrouter/ai-sdk-provider") {
      return {
        low: { reasoning: { effort: "low" } },
        high: { reasoning: { effort: "high" } },
      }
    }
    return {
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    }
  }

  switch (model.api.npm) {
    case "@openrouter/ai-sdk-provider":
      return Object.fromEntries(
        (model.api.id.startsWith("openai/") || id.includes("gpt")
          ? openaiCompatibleReasoningEfforts(model.api.id)
          : WIDELY_SUPPORTED_EFFORTS
        ).map((effort) => [effort, { reasoning: { effort } }]),
      )

    case "ai-gateway-provider": {
      // Cloudflare AI Gateway routes every upstream through its OpenAI-compatible
      // /v1/compat endpoint, so the body is always OAI-shaped. The gateway
      // translates `reasoning_effort` to the upstream provider's native control
      // (e.g. Anthropic thinking budgets) when needed. Variants therefore stay
      // OAI-style for all upstreams, with an extended effort set for OpenAI
      // models that support it.
      if (model.api.id.startsWith("openai/")) {
        const efforts = openaiReasoningEfforts(model.api.id, model.release_date)
        return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
    }

    case "@ai-sdk/gateway":
      if (model.api.id.includes("anthropic")) {
        if (adaptiveEfforts) {
          return Object.fromEntries(
            adaptiveEfforts.map((effort) => [
              effort,
              {
                thinking: {
                  type: "adaptive",
                  // Newer adaptive-only models default `display` to "omitted", which
                  // returns empty thinking blocks. Force "summarized" so summaries
                  // survive (4.6/Sonnet 4.6 already default to "summarized").
                  ...(adaptiveThinkingOmitted ? { display: "summarized" } : {}),
                },
                effort,
              },
            ]),
          )
        }
        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }
      if (model.api.id.includes("google")) {
        if (model.api.id.includes("2.5")) {
          return {
            high: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 16000,
              },
            },
            max: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: googleThinkingBudgetMax(model.api.id.toLowerCase()),
              },
            },
          }
        }
        return Object.fromEntries(
          ["low", "high"].map((effort) => [
            effort,
            {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          ]),
        )
      }
      return Object.fromEntries(
        openaiCompatibleReasoningEfforts(model.api.id).map((effort) => [effort, { reasoningEffort: effort }]),
      )

    case "@ai-sdk/github-copilot":
      if (model.id.includes("gemini")) {
        // currently github copilot only returns thinking
        return {}
      }
      if (model.id.includes("claude")) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      const copilotEfforts = iife(() => {
        if (id.includes("5.1-codex-max") || id.includes("5.2") || id.includes("5.3"))
          return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
        const arr = [...WIDELY_SUPPORTED_EFFORTS]
        if (id.includes("gpt-5") && model.release_date >= "2025-12-04") arr.push("xhigh")
        return arr
      })
      return Object.fromEntries(
        copilotEfforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: INCLUDE_ENCRYPTED_REASONING,
          },
        ]),
      )

    case "@ai-sdk/cerebras":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cerebras
    case "@ai-sdk/togetherai":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/togetherai
    case "@ai-sdk/xai":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/xai
    case "@ai-sdk/deepinfra":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/deepinfra
    case "venice-ai-sdk-provider":
    // https://docs.venice.ai/overview/guides/reasoning-models#reasoning-effort
    case "@ai-sdk/openai-compatible":
      if (model.api.id.toLowerCase().includes("north-mini-code")) {
        return Object.fromEntries(["none", "high"].map((effort) => [effort, { reasoningEffort: effort }]))
      }
      const efforts = [...WIDELY_SUPPORTED_EFFORTS]
      if (model.api.id.toLowerCase().includes("deepseek-v4")) {
        efforts.push("max")
      }
      return Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }]))

    case "@ai-sdk/azure":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/azure
      if (id === "o1-mini") return {}
      return Object.fromEntries(
        openaiReasoningEfforts(id, model.release_date).map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: INCLUDE_ENCRYPTED_REASONING,
          },
        ]),
      )
    case "@ai-sdk/amazon-bedrock/mantle":
    case "@ai-sdk/openai": {
      if (model.providerID === "meta") {
        return Object.fromEntries(
          OPENAI_EFFORTS.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: INCLUDE_ENCRYPTED_REASONING,
            },
          ]),
        )
      }
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/openai
      const efforts = openaiReasoningEfforts(model.api.id, model.release_date)
      return Object.fromEntries(
        efforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: INCLUDE_ENCRYPTED_REASONING,
          },
        ]),
      )
    }

    case "@ai-sdk/anthropic":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
    case "@ai-sdk/google-vertex/anthropic":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex#anthropic-provider
      if (adaptiveEfforts) {
        let efforts = [...adaptiveEfforts]
        if (model.providerID === "github-copilot") {
          if (model.api.id.includes("opus-4.7")) {
            efforts = ["medium"]
          }
          // Efforts currently supported are: low, medium, high
          efforts = efforts.filter((v) => v !== "max" && v !== "xhigh")
        }
        return Object.fromEntries(
          efforts.map((effort) => [
            effort,
            {
              thinking: {
                type: "adaptive",
                ...(adaptiveThinkingOmitted ? { display: "summarized" } : {}),
              },
              effort,
            },
          ]),
        )
      }

      if (anthropicOpus45(model.api.id)) {
        return Object.fromEntries(
          WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, anthropicOpus45Effort(model, effort)]),
        )
      }

      return {
        high: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
          },
        },
        max: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(31_999, model.limit.output - 1),
          },
        },
      }

    case "@ai-sdk/amazon-bedrock":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
      if (adaptiveEfforts) {
        return Object.fromEntries(
          adaptiveEfforts.map((effort) => [
            effort,
            {
              reasoningConfig: {
                type: "adaptive",
                maxReasoningEffort: effort,
                ...(adaptiveThinkingOmitted ? { display: "summarized" } : {}),
              },
            },
          ]),
        )
      }
      // For Anthropic models on Bedrock, use reasoningConfig with budgetTokens
      if (model.api.id.includes("anthropic")) {
        return {
          high: {
            reasoningConfig: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            reasoningConfig: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }

      // For Amazon Nova models, use reasoningConfig with maxReasoningEffort
      return Object.fromEntries(
        WIDELY_SUPPORTED_EFFORTS.map((effort) => [
          effort,
          {
            reasoningConfig: {
              type: "enabled",
              maxReasoningEffort: effort,
            },
          },
        ]),
      )

    case "@ai-sdk/google-vertex":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex
    case "@ai-sdk/google":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
      return googleThinkingVariants(model)

    case "@ai-sdk/mistral":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/mistral
      // https://docs.mistral.ai/capabilities/reasoning/adjustable
      if (!model.capabilities.reasoning) return {}
      // Only Mistral Small 4 and Medium 3.5 support reasoning
      const MISTRAL_REASONING_IDS = [
        "mistral-small-2603",
        "mistral-small-latest",
        "mistral-medium-3.5",
        "mistral-medium-2604",
      ]
      const mistralId = model.api.id.toLowerCase()
      if (!MISTRAL_REASONING_IDS.some((id) => mistralId.includes(id))) return {}
      return {
        high: { reasoningEffort: "high" },
      }

    case "@ai-sdk/cohere":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cohere
      return {}

    case "@ai-sdk/groq":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/groq
      const groqEffort = ["none", ...WIDELY_SUPPORTED_EFFORTS]
      return Object.fromEntries(
        groqEffort.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
          },
        ]),
      )

    case "@ai-sdk/perplexity":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/perplexity
      return {}

    case "@jerome-benoit/sap-ai-provider-v2": {
      if (id.includes("anthropic")) {
        if (adaptiveEfforts) {
          // Bedrock adaptive splits `effort` out into `output_config` (vs Anthropic
          // native which inlines it). Claude 4.7+ defaults `display` to "omitted".
          return wrapInSapModelParams(
            Object.fromEntries(
              adaptiveEfforts.map((effort) => [
                effort,
                {
                  thinking: { type: "adaptive", ...(adaptiveThinkingOmitted ? { display: "summarized" } : {}) },
                  output_config: { effort },
                },
              ]),
            ),
          )
        }
        return wrapInSapModelParams({
          high: { thinking: { type: "enabled", budget_tokens: 16000 } },
          max: { thinking: { type: "enabled", budget_tokens: 31999 } },
        })
      }
      if (id.includes("gemini") && id.includes("2.5")) {
        return wrapInSapModelParams(googleThinkingVariants(model))
      }
      if (id.includes("gpt") || /\bo[1-9]/.test(id)) {
        const efforts = openaiReasoningEfforts(id, model.release_date)
        return wrapInSapModelParams(Object.fromEntries(efforts.map((effort) => [effort, { reasoning_effort: effort }])))
      }
      return wrapInSapModelParams(
        Object.fromEntries(["low", "medium", "high"].map((effort) => [effort, { reasoning_effort: effort }])),
      )
    }
  }
  return {}
}

export function options(input: {
  model: Provider.Model
  sessionID: string
  providerOptions?: Record<string, any>
}): Record<string, any> {
  const result: Record<string, any> = {}

  if (
    input.model.api.npm === "@ai-sdk/google-vertex/anthropic" ||
    (!input.model.api.id.includes("claude") && input.model.api.npm === "@ai-sdk/anthropic")
  ) {
    result["toolStreaming"] = false
  }

  // openai and providers using openai package should set store to false by default.
  if (
    input.model.providerID === "openai" ||
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/github-copilot" ||
    input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle" ||
    input.model.api.npm === "@ai-sdk/xai"
  ) {
    result["store"] = false
  }

  if (input.model.api.npm === "@ai-sdk/azure") {
    result["store"] = false
  }

  if (input.model.api.npm === "@openrouter/ai-sdk-provider" || input.model.api.npm === "@llmgateway/ai-sdk-provider") {
    result["usage"] = {
      include: true,
    }
    if (input.model.api.id.includes("gemini-3")) {
      result["reasoning"] = { effort: "high" }
    }
  }

  if (
    input.model.providerID === "baseten" ||
    (input.model.providerID === "opencode" && ["kimi-k2-thinking", "glm-4.6"].includes(input.model.api.id))
  ) {
    result["chat_template_args"] = { enable_thinking: true }
  }

  if (
    ["zai", "zhipuai"].some((id) => input.model.providerID.includes(id)) &&
    input.model.api.npm === "@ai-sdk/openai-compatible"
  ) {
    result["thinking"] = {
      type: "enabled",
      clear_thinking: false,
    }
  }

  if (input.model.providerID === "meta" && input.model.api.npm === "@ai-sdk/openai") {
    result["reasoningSummary"] = "auto"
    result["include"] = INCLUDE_ENCRYPTED_REASONING
  }

  if (input.model.api.npm === "@ai-sdk/google" || input.model.api.npm === "@ai-sdk/google-vertex") {
    if (input.model.capabilities.reasoning) {
      result["thinkingConfig"] = {
        includeThoughts: true,
      }
      if (input.model.api.id.includes("gemini-3")) {
        result["thinkingConfig"]["thinkingLevel"] = "high"
      }
    }
  }

  const modelId = input.model.api.id.toLowerCase()

  // MiniMax's Anthropic interface defaults thinking off, unlike Chat Completions.
  if (modelId.includes("minimax-m3") && input.model.api.npm === "@ai-sdk/anthropic") {
    result["thinking"] = { type: "adaptive" }
  }

  // Moonshot's Anthropic-compatible API uses adaptive effort rather than token budgets.
  // Request summaries so thinking content survives replay on subsequent turns.
  if (
    ["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"].includes(input.model.api.npm) &&
    isKimiFamily(input.model) &&
    input.model.capabilities.reasoning
  ) {
    result["thinking"] = { type: "adaptive", display: "summarized" }
    result["effort"] = "high"
  }

  // Enable thinking for reasoning models on alibaba-cn (DashScope).
  // DashScope's OpenAI-compatible API requires `enable_thinking: true` in the request body
  // to return reasoning_content. Without it, models like kimi-k2.5, qwen-plus, qwen3, qwq,
  // deepseek-r1, etc. never output thinking/reasoning tokens.
  // Note: kimi-k2-thinking is excluded as it returns reasoning_content by default.
  if (
    input.model.providerID === "alibaba-cn" &&
    input.model.capabilities.reasoning &&
    input.model.api.npm === "@ai-sdk/openai-compatible" &&
    !modelId.includes("kimi-k2-thinking")
  ) {
    result["enable_thinking"] = true
  }

  if (input.providerOptions?.setCacheKey !== false) {
    if (input.model.api.npm === "@ai-sdk/deepinfra" || input.model.api.npm === "@ai-sdk/cerebras") {
      result["prompt_cache_key"] = input.sessionID
    } else if (
      input.model.api.npm === "@ai-sdk/openai" ||
      input.model.api.npm === "@ai-sdk/azure" ||
      input.model.api.npm === "@ai-sdk/xai" ||
      input.model.api.npm === "@ai-sdk/mistral" ||
      input.model.api.npm === "venice-ai-sdk-provider" ||
      input.providerOptions?.setCacheKey === true
    ) {
      result["promptCacheKey"] = input.sessionID
    }
  }

  if (input.model.api.npm === "@ai-sdk/gateway") {
    result["gateway"] = { caching: "auto" }
  }

  // Any gpt version above 5.4 in combination with azure does not support reasoningEffort
  // so we should return early here.
  const [, gptMajorVersion, gptMinorVersion] = input.model.api.id.match(/gpt-(\d+)\.(\d+)/) ?? []
  const isGpt55OrNewer = Number(gptMajorVersion) > 5 || (Number(gptMajorVersion) === 5 && Number(gptMinorVersion) >= 5)
  if (input.model.api.npm === "@ai-sdk/azure" && input.providerOptions?.useCompletionUrls) {
    if (!isGpt55OrNewer) {
      result["reasoningEffort"] = "medium"
    }
    return result
  }

  if (input.model.api.id.includes("gpt-5") && !input.model.api.id.includes("gpt-5-chat")) {
    if (!input.model.api.id.includes("gpt-5-pro")) {
      result["reasoningEffort"] = "medium"
      if (
        input.model.api.npm === "@ai-sdk/openai" ||
        input.model.api.npm === "@ai-sdk/azure" ||
        input.model.api.npm === "@ai-sdk/github-copilot" ||
        input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
      ) {
        result["reasoningSummary"] = "auto"
      }
      if (input.model.api.npm === "@ai-sdk/openai" || input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle") {
        result["include"] = INCLUDE_ENCRYPTED_REASONING
      }
    }

    // Generic OpenAI-compatible APIs do not necessarily support OpenAI's verbosity parameter.
    // Only enable the default for integrations known to implement it.
    if (
      input.model.api.id.includes("gpt-5.") &&
      !input.model.api.id.includes("codex") &&
      !input.model.api.id.includes("-chat") &&
      (input.model.api.npm === "@ai-sdk/openai" || input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle")
    ) {
      result["textVerbosity"] = "low"
    }

    if (input.model.providerID.startsWith("opencode") && input.providerOptions?.setCacheKey !== false) {
      result["promptCacheKey"] = input.sessionID
      result["include"] = INCLUDE_ENCRYPTED_REASONING
      result["reasoningSummary"] = "auto"
    }
  }

  return result
}

export function smallOptions(model: Provider.Model) {
  const small = Object.values(model.variants ?? {})[0] ?? {}
  if (
    model.providerID === "openai" ||
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/github-copilot" ||
    model.api.npm === "@ai-sdk/xai"
  ) {
    const base = { store: false }
    return mergeDeep(base, small)
  }
  if (model.providerID === "openrouter" || model.providerID === "llmgateway") {
    if (Object.keys(small).length === 0 && model.api.id.includes("google")) {
      return { reasoning: { enabled: false } }
    }
  }

  if (model.providerID === "venice") {
    if (Object.keys(small).length > 0) return small
    return { veniceParameters: { disableThinking: true } }
  }

  return small
}

// Maps model ID prefix to provider slug used in providerOptions.
// Example: "amazon/nova-2-lite" → "bedrock"
const SLUG_OVERRIDES: Record<string, string> = {
  amazon: "bedrock",
}

export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
  const usesOpenAIReasoningGate =
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/azure" ||
    model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
  const normalized =
    usesOpenAIReasoningGate &&
    (model.capabilities.reasoning || options.reasoningEffort !== undefined || options.reasoningSummary !== undefined)
      ? { ...options, forceReasoning: true }
      : anthropicBlockBinding(model, options)

  if (model.api.npm === "@ai-sdk/gateway") {
    // Gateway providerOptions are split across two namespaces:
    // - `gateway`: gateway-native routing/caching controls (order, only, byok, etc.)
    // - `<upstream slug>`: provider-specific model options (anthropic/openai/...)
    // We keep `gateway` as-is and route every other top-level option under the
    // model-derived upstream slug.
    const i = model.api.id.indexOf("/")
    const rawSlug = i > 0 ? model.api.id.slice(0, i) : undefined
    const slug = rawSlug ? (SLUG_OVERRIDES[rawSlug] ?? rawSlug) : undefined
    const gateway = normalized.gateway
    const rest = Object.fromEntries(Object.entries(normalized).filter(([k]) => k !== "gateway"))
    const has = Object.keys(rest).length > 0

    const result: Record<string, any> = {}
    if (gateway !== undefined) result.gateway = gateway

    if (has) {
      if (slug) {
        // Route model-specific options under the provider slug
        result[slug] = rest
      } else if (gateway && typeof gateway === "object" && !Array.isArray(gateway)) {
        result.gateway = { ...gateway, ...rest }
      } else {
        result.gateway = rest
      }
    }

    return result
  }

  // AI SDK packages that resolve providerOptionsName by splitting the
  // provider name on "." (e.g. "wafer.ai" -> "wafer") need the same
  // logic here so the key we write matches the key they read.
  // Other SDKs (xai, mistral, groq, cohere, etc.) use hardcoded keys
  // like "xai" or "cohere" - applying .split(".")[0] would break those.
  const usesDotSplitOptions =
    model.api.npm === "@ai-sdk/openai-compatible" ||
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/anthropic"
  const key = sdkKey(model.api.npm) ?? (usesDotSplitOptions ? model.providerID.split(".")[0] : model.providerID)
  // @ai-sdk/azure delegates to OpenAIChatLanguageModel which reads from
  // providerOptions["openai"], but OpenAIResponsesLanguageModel checks
  // "azure" first. Pass both so model options work on either code path.
  if (model.api.npm === "@ai-sdk/azure") {
    return { openai: normalized, azure: normalized }
  }
  return { [key]: normalized }
}

export function maxOutputTokens(model: Provider.Model, outputTokenMax = OUTPUT_TOKEN_MAX): number {
  return Math.min(model.limit.output, outputTokenMax) || outputTokenMax
}

type JsonRecord = Record<string, unknown>

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Mirrors Codex's Rust JSON schema compatibility lowering for OpenAI tool schemas.
function sanitizeOpenAISchema(value: unknown): unknown {
  const types = ["string", "number", "boolean", "integer", "object", "array", "null"]
  const compositionKeys = ["anyOf", "oneOf", "allOf"]

  // JSON Schema's boolean form (`true`/`false`) is unsupported by OpenAI tool schemas.
  if (typeof value === "boolean") return { type: "string" }
  if (Array.isArray(value)) return value.map(sanitizeOpenAISchema)
  if (!isPlainObject(value)) return value

  const result: JsonRecord = {}

  if (typeof value.$ref === "string") result.$ref = value.$ref
  if (typeof value.description === "string") result.description = value.description
  if ("const" in value) result.enum = [value.const]
  else if (Array.isArray(value.enum)) result.enum = value.enum

  if (isPlainObject(value.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(value.properties).map(([key, item]) => [key, sanitizeOpenAISchema(item)]),
    )
  }

  if (Array.isArray(value.required)) {
    result.required = value.required.filter((item) => typeof item === "string")
  }

  if ("items" in value) result.items = sanitizeOpenAISchema(value.items)

  if ("additionalProperties" in value) {
    result.additionalProperties =
      typeof value.additionalProperties === "boolean"
        ? value.additionalProperties
        : sanitizeOpenAISchema(value.additionalProperties)
  }

  for (const key of compositionKeys) {
    if (Array.isArray(value[key])) result[key] = value[key].map(sanitizeOpenAISchema)
  }

  for (const key of ["$defs", "definitions"]) {
    if (isPlainObject(value[key])) {
      result[key] = Object.fromEntries(
        Object.entries(value[key]).map(([name, item]) => [name, sanitizeOpenAISchema(item)]),
      )
    }
  }

  const schemaTypes =
    typeof value.type === "string"
      ? types.includes(value.type)
        ? [value.type]
        : []
      : Array.isArray(value.type)
        ? value.type.filter((item) => typeof item === "string" && types.includes(item))
        : []

  if (schemaTypes.length === 0 && (typeof result.$ref === "string" || compositionKeys.some((key) => key in result))) {
    return result
  }

  // MCP schemas may omit `type` while still using keywords that imply one.
  // Keep the schema usable after unsupported keywords are dropped.
  const inferredTypes =
    schemaTypes.length > 0
      ? schemaTypes
      : ["properties", "required", "additionalProperties"].some((key) => key in value)
        ? ["object"]
        : ["items", "prefixItems"].some((key) => key in value)
          ? ["array"]
          : "enum" in result || "format" in value
            ? ["string"]
            : ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((key) => key in value)
              ? ["number"]
              : []

  if (inferredTypes.length === 0) return {}

  result.type = inferredTypes.length === 1 ? inferredTypes[0] : inferredTypes
  if (inferredTypes.includes("object") && !("properties" in result)) result.properties = {}
  if (inferredTypes.includes("array") && !("items" in result)) result.items = { type: "string" }
  return result
}

export function schema(model: Provider.Model, schema: JSONSchema7): JSONSchema7 {
  /*
  if (["openai", "azure"].includes(providerID)) {
    if (schema.type === "object" && schema.properties) {
      for (const [key, value] of Object.entries(schema.properties)) {
        if (schema.required?.includes(key)) continue
        schema.properties[key] = {
          anyOf: [
            value as JSONSchema.JSONSchema,
            {
              type: "null",
            },
          ],
        }
      }
    }
  }
  */

  if (model.api.npm === "@ai-sdk/openai" || model.api.npm === "@ai-sdk/azure") {
    schema = sanitizeOpenAISchema(schema) as JSONSchema7
    // Codex also applies lossy compaction above 4 KB; defer that until OpenCode needs the same schema budget.
  }

  if (model.providerID === "moonshotai" || model.api.id.toLowerCase().includes("kimi")) {
    const sanitizeMoonshot = (obj: unknown): unknown => {
      if (obj === null || typeof obj !== "object") return obj
      if (Array.isArray(obj)) return obj.map(sanitizeMoonshot)
      // Moonshot expands $ref before validation and rejects sibling keywords like description on the same node.
      if ("$ref" in obj && typeof obj.$ref === "string") return { $ref: obj.$ref }
      const result = Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, sanitizeMoonshot(value)]))
      // MFJS does not support tuple-style `items` arrays; it requires one schema object for all array items.
      if (Array.isArray(result.items)) result.items = result.items[0] ?? {}
      return result
    }

    const sanitized = sanitizeMoonshot(schema)
    if (typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)) {
      schema = sanitized
    }
  }

  // Convert integer enums to string enums for Google/Gemini
  if (model.providerID === "google" || model.api.id.includes("gemini")) {
    const isPlainObject = (node: unknown): node is Record<string, any> =>
      typeof node === "object" && node !== null && !Array.isArray(node)
    const hasCombiner = (node: unknown) =>
      isPlainObject(node) && (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf))
    const hasSchemaIntent = (node: unknown) => {
      if (!isPlainObject(node)) return false
      if (hasCombiner(node)) return true
      return [
        "type",
        "properties",
        "items",
        "prefixItems",
        "enum",
        "const",
        "$ref",
        "additionalProperties",
        "patternProperties",
        "required",
        "not",
        "if",
        "then",
        "else",
      ].some((key) => key in node)
    }

    const sanitizeGemini = (obj: any): any => {
      if (obj === null || typeof obj !== "object") {
        return obj
      }

      if (Array.isArray(obj)) {
        return obj.map(sanitizeGemini)
      }

      const result: any = {}
      for (const [key, value] of Object.entries(obj)) {
        if (key === "enum" && Array.isArray(value)) {
          // Convert all enum values to strings
          result[key] = value.map((v) => String(v))
          // If we have integer type with enum, change type to string
          if (result.type === "integer" || result.type === "number") {
            result.type = "string"
          }
        } else if (typeof value === "object" && value !== null) {
          result[key] = sanitizeGemini(value)
        } else {
          result[key] = value
        }
      }

      // Gemini requires a single `type`, not a JSON Schema type array such as
      // `["number","string"]` (emitted by some MCP servers). Plain `@ai-sdk/google`
      // rewrites these into an `anyOf` of single-type schemas, but OpenAI-compatible
      // transports (e.g. GitHub Copilot proxying to Gemini) forward them verbatim
      // and the backend rejects the array form. Mirror the SDK: split non-null
      // types into `anyOf`, and lift `null` into `nullable`.
      if (Array.isArray(result.type)) {
        const hasNull = result.type.includes("null")
        const nonNull = result.type.filter((entry: unknown) => entry !== "null")
        if (nonNull.length === 0) {
          result.type = "null"
        } else {
          delete result.type
          result.anyOf = nonNull.map((entry: unknown) => ({ type: entry }))
          if (hasNull) result.nullable = true
        }
      }

      // Filter required array to only include fields that exist in properties
      if (result.type === "object" && result.properties && Array.isArray(result.required)) {
        result.required = result.required.filter((field: any) => field in result.properties)
      }

      if (result.type === "array" && !hasCombiner(result)) {
        if (result.items == null) {
          result.items = {}
        }
        // Ensure items has a type only when it's still schema-empty.
        if (isPlainObject(result.items) && !hasSchemaIntent(result.items)) {
          result.items.type = "string"
        }
      }

      // Remove properties/required from non-object types (Gemini rejects these)
      if (result.type && result.type !== "object" && !hasCombiner(result)) {
        delete result.properties
        delete result.required
      }

      return result
    }

    schema = sanitizeGemini(schema)
  }

  return schema
}

export function reasoningVariants(model: ModelsDev.Model, target: Provider.Model): Provider.Model["variants"] {
  const options = model.reasoning_options
  if (options === undefined) return
  if (options.length === 0) return {}

  const effort = options.find((option) => option.type === "effort")
  if (effort) return effortVariants(target, effort.values)

  const toggle = options.some((option) => option.type === "toggle")
  const budget = options.find((option) => option.type === "budget_tokens")
  if (!budget) return toggle ? nonEmptyVariants(reasoningToggle(target)) : undefined

  return nonEmptyVariants({
    ...(toggle ? reasoningToggle(target) : {}),
    ...budgetVariants(target, budget.min, budget.max),
  })
}

function effortVariants(model: Provider.Model, values: readonly unknown[]) {
  return Object.fromEntries(
    values.flatMap((value) => {
      const id = (() => {
        if (value === null) return "none"
        if (typeof value === "string") return value
      })()
      if (id === undefined) return []
      const settings = reasoningEffort(model, id)
      return settings ? [[id, settings]] : []
    }),
  )
}

function budgetVariants(model: Provider.Model, min?: number, max?: number) {
  const maximum = Math.min(max ?? OUTPUT_TOKEN_MAX - 1, model.limit.output - 1, OUTPUT_TOKEN_MAX - 1)
  if (maximum <= 0) return {}
  const high = Math.min(Math.max(min ?? 0, Math.floor((maximum + 1) / 2)), maximum)
  return Object.fromEntries(
    [
      { id: "high", budget: high },
      { id: "max", budget: maximum },
    ].flatMap((item) => {
      const settings = reasoningBudget(model, item.budget)
      return settings ? [[item.id, settings]] : []
    }),
  )
}

function nonEmptyVariants(variants: NonNullable<Provider.Model["variants"]>): Provider.Model["variants"] {
  return Object.keys(variants).length > 0 ? variants : undefined
}

function reasoningToggle(model: Provider.Model): NonNullable<Provider.Model["variants"]> {
  if (model.api.npm === "@ai-sdk/alibaba")
    return {
      none: { enableThinking: false },
      high: { enableThinking: true },
    }
  if (model.api.npm === "@ai-sdk/cohere")
    return {
      none: { thinking: { type: "disabled" } },
      high: { thinking: { type: "enabled" } },
    }
  return {}
}

function reasoningEffort(model: Provider.Model, effort: string) {
  switch (model.api.npm) {
    case "@openrouter/ai-sdk-provider":
      return { reasoning: { effort } }
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic":
      return anthropicEffort(model, effort) ?? { effort }
    case "@ai-sdk/google":
    case "@ai-sdk/google-vertex":
      return { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }
    case "@ai-sdk/amazon-bedrock":
      if (anthropicAdaptiveEfforts(model.api.id))
        return {
          reasoningConfig: {
            type: "adaptive",
            maxReasoningEffort: effort,
            ...(anthropicOmitsThinking(model.api.id) ? { display: "summarized" } : {}),
          },
        }
      if (anthropicOpus45(model.api.id))
        return {
          reasoningConfig: {
            type: "enabled",
            budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
            maxReasoningEffort: effort,
          },
        }
      if (model.api.id.includes("anthropic")) return
      return { reasoningConfig: { type: "enabled", maxReasoningEffort: effort } }
    case "@ai-sdk/gateway":
      if (model.id.includes("anthropic")) return { thinking: { type: "adaptive", display: "summarized" }, effort }
      if (model.id.includes("google")) return { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }
      return { reasoningEffort: effort }
    case "@ai-sdk/github-copilot":
      // OAuth discovery replaces these with variants from Copilot's /models capabilities.
      if (model.id.includes("gemini")) return
      if (model.id.includes("claude")) return { reasoningEffort: effort }
      return { reasoningEffort: effort, reasoningSummary: "auto", include: INCLUDE_ENCRYPTED_REASONING }
    case "@ai-sdk/openai":
    case "@ai-sdk/amazon-bedrock/mantle":
      return { reasoningEffort: effort, reasoningSummary: "auto", include: INCLUDE_ENCRYPTED_REASONING }
    case "@ai-sdk/azure":
      return { reasoningEffort: effort, reasoningSummary: "auto", include: INCLUDE_ENCRYPTED_REASONING }
    case "@jerome-benoit/sap-ai-provider-v2":
      if (model.id.includes("anthropic"))
        return { modelParams: { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort } } }
      return { modelParams: { reasoning_effort: effort } }
    case "@ai-sdk/openai-compatible":
    case "@ai-sdk/xai":
    case "@ai-sdk/mistral":
    case "@ai-sdk/groq":
    case "@ai-sdk/cerebras":
    case "@ai-sdk/deepinfra":
    case "@ai-sdk/togetherai":
    case "venice-ai-sdk-provider":
    case "ai-gateway-provider":
    case "merge-gateway-ai-sdk-provider":
      return { reasoningEffort: effort }
    case "gitlab-ai-provider":
      if (model.family?.startsWith("gpt")) return { reasoningEffort: effort }
      if (model.family?.startsWith("claude")) return { thinking: { type: "adaptive", effort } }
      return
    case "@ai-sdk/cohere":
    case "@ai-sdk/perplexity":
    case "@ai-sdk/vercel":
    case "@ai-sdk/alibaba":
      return
  }
}

function anthropicEffort(model: Provider.Model, effort: string) {
  if (anthropicOpus45(model.api.id)) return anthropicOpus45Effort(model, effort)
  // Kimi defaults to omitting adaptive thinking text unless summarized display is requested.
  if (isKimiFamily(model)) return { thinking: { type: "adaptive", display: "summarized" }, effort }
  if (!anthropicAdaptiveEfforts(model.api.id)) return
  return {
    thinking: {
      type: "adaptive",
      ...(anthropicOmitsThinking(model.api.id) ? { display: "summarized" } : {}),
    },
    effort,
  }
}

function anthropicOpus45Effort(model: Provider.Model, effort: string) {
  return {
    thinking: {
      type: "enabled",
      budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
    },
    effort,
  }
}

function reasoningBudget(model: Provider.Model, budget: number) {
  switch (model.api.npm) {
    case "@openrouter/ai-sdk-provider":
      return { reasoning: { max_tokens: budget } }
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic":
      return { thinking: { type: "enabled", budgetTokens: budget } }
    case "@ai-sdk/google":
    case "@ai-sdk/google-vertex":
      return { thinkingConfig: { includeThoughts: true, thinkingBudget: budget } }
    case "@ai-sdk/amazon-bedrock":
      return { reasoningConfig: { type: "enabled", budgetTokens: budget } }
    case "@ai-sdk/gateway":
      if (model.id.includes("anthropic")) return { thinking: { type: "enabled", budgetTokens: budget } }
      if (model.id.includes("google")) return { thinkingConfig: { includeThoughts: true, thinkingBudget: budget } }
      return
    case "@ai-sdk/cohere":
      return { thinking: { type: "enabled", tokenBudget: budget } }
    case "@ai-sdk/alibaba":
      return { enableThinking: true, thinkingBudget: budget }
    case "@jerome-benoit/sap-ai-provider-v2":
      if (model.id.includes("anthropic"))
        return { modelParams: { thinking: { type: "enabled", budget_tokens: budget } } }
      if (model.id.includes("gemini"))
        return { modelParams: { thinkingConfig: { includeThoughts: true, thinkingBudget: budget } } }
      return
    case "@ai-sdk/amazon-bedrock/mantle":
    case "@ai-sdk/azure":
    case "@ai-sdk/cerebras":
    case "@ai-sdk/deepinfra":
    case "@ai-sdk/github-copilot":
    case "@ai-sdk/groq":
    case "@ai-sdk/mistral":
    case "@ai-sdk/openai":
    case "@ai-sdk/openai-compatible":
    case "@ai-sdk/perplexity":
    case "@ai-sdk/togetherai":
    case "@ai-sdk/vercel":
    case "@ai-sdk/xai":
    case "ai-gateway-provider":
    case "gitlab-ai-provider":
    case "venice-ai-sdk-provider":
      return
  }
}

export * as ProviderTransform from "./transform"
