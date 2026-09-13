import { Show, type Component, type JSX } from "solid-js"
import { isOrganizationRouteProvider } from "@opencode/util/organization-routes"
import { useLanguage } from "@/runtime/i18n/language"

type InputKey = "text" | "image" | "audio" | "video" | "pdf"
type InputMap = Record<InputKey, boolean>

type ModelInfo = {
  id: string
  name: string
  provider: {
    id?: string
    name: string
  }
  capabilities?: {
    reasoning: boolean
    input: InputMap
  }
  modalities?: {
    input: Array<string>
  }
  reasoning?: boolean
  limit: {
    context: number
  }
}

function ModelTooltipRow(props: { name: JSX.Element; value: JSX.Element }) {
  return (
    <div class="flex min-w-0 items-center gap-4">
      <span class="shrink-0 text-v2-text-text-muted">{props.name}</span>
      <span class="ml-auto min-w-0 truncate text-right text-v2-text-text-base">{props.value}</span>
    </div>
  )
}

export const ModelTooltip: Component<{ model: ModelInfo; latest?: boolean; free?: boolean; v2?: boolean }> = (
  props,
) => {
  const language = useLanguage()
  const route = () => isOrganizationRouteProvider(props.model.provider.id ?? "")
  const sourceName = (model: ModelInfo) => {
    if (route()) return model.provider.name
    const value = `${model.id} ${model.name}`.toLowerCase()

    if (/claude|anthropic/.test(value)) return language.t("model.provider.anthropic")
    if (/gpt|o[1-4]|codex|openai/.test(value)) return language.t("model.provider.openai")
    if (/gemini|palm|bard|google/.test(value)) return language.t("model.provider.google")
    if (/grok|xai/.test(value)) return language.t("model.provider.xai")
    if (/llama|meta/.test(value)) return language.t("model.provider.meta")

    return model.provider.name
  }
  const inputLabel = (value: string) => {
    if (value === "text") return language.t("model.input.text")
    if (value === "image") return language.t("model.input.image")
    if (value === "audio") return language.t("model.input.audio")
    if (value === "video") return language.t("model.input.video")
    if (value === "pdf") return language.t("model.input.pdf")
    return value
  }
  const title = () => {
    const tags: Array<string> = []
    if (props.latest) tags.push(language.t("model.tag.latest"))
    if (route()) tags.push(language.t("model.tag.variable"))
    if (!route() && props.free) tags.push(language.t("model.tag.free"))
    const suffix = tags.length ? ` (${tags.join(", ")})` : ""
    return `${sourceName(props.model)} ${props.model.name}${suffix}`
  }
  const name = () => {
    const tags: Array<string> = []
    if (props.latest) tags.push(language.t("model.tag.latest"))
    if (route()) tags.push(language.t("model.tag.variable"))
    if (!route() && props.free) tags.push(language.t("model.tag.free"))
    const suffix = tags.length ? ` (${tags.join(", ")})` : ""
    return `${props.model.name}${suffix}`
  }
  const inputs = () => {
    if (props.model.capabilities) {
      const input = props.model.capabilities.input
      const order: Array<InputKey> = ["text", "image", "audio", "video", "pdf"]
      const entries = order.filter((key) => input[key]).map((key) => inputLabel(key))
      return entries.length ? entries.join(", ") : undefined
    }
    const raw = props.model.modalities?.input
    if (!raw) return
    const entries = raw.map((value) => inputLabel(value))
    return entries.length ? entries.join(", ") : undefined
  }
  const reasoning = () => {
    if (props.model.capabilities)
      return props.model.capabilities.reasoning
        ? language.t("model.tooltip.reasoning.allowed")
        : language.t("model.tooltip.reasoning.none")
    return props.model.reasoning
      ? language.t("model.tooltip.reasoning.allowed")
      : language.t("model.tooltip.reasoning.none")
  }
  const context = () => language.t("model.tooltip.context", { limit: props.model.limit.context.toLocaleString() })
  const contextLimit = () => props.model.limit.context.toLocaleString(language.intl())

  if (props.v2) {
    return (
      <div class="flex w-[180px] flex-col gap-2">
        <ModelTooltipRow name={language.t("model.tooltip.model")} value={name()} />
        <ModelTooltipRow name={language.t("model.tooltip.provider")} value={props.model.provider.name} />
        <Show when={!route()}>
          <Show when={inputs()}>
            {(value) => <ModelTooltipRow name={language.t("model.tooltip.inputs")} value={value()} />}
          </Show>
          <ModelTooltipRow name={language.t("model.tooltip.reasoning")} value={reasoning()} />
          <ModelTooltipRow name={language.t("model.tooltip.context.label")} value={contextLimit()} />
        </Show>
      </div>
    )
  }

  return (
    <div class="flex flex-col gap-1 py-1">
      <div class="text-13-medium">{title()}</div>
      <Show when={!route()}>
        <Show when={inputs()}>
          {(value) => (
            <div class="text-12-regular text-text-invert-base">
              {language.t("model.tooltip.allows", { inputs: value() })}
            </div>
          )}
        </Show>
        <div class="text-12-regular text-text-invert-base">{reasoning()}</div>
        <div class="text-12-regular text-text-invert-base">{context()}</div>
      </Show>
    </div>
  )
}
