import type { SessionConfigOption } from "@agentclientprotocol/sdk"

export const DEFAULT_VARIANT_VALUE = "default"

export type ConfigOptionModel = {
  id: string
  name: string
  variants?: ReadonlyArray<string>
}

export type ConfigOptionProvider = {
  id: string
  name: string
  models: ReadonlyArray<ConfigOptionModel>
}

export type ConfigOptionMode = {
  id: string
  name: string
  description?: string
}

export type ModelSelection = {
  model: { providerID: string; modelID: string }
  variant?: string
}

export function buildConfigOptions(input: {
  providers: readonly ConfigOptionProvider[]
  currentModel: ModelSelection["model"]
  currentVariant?: string
  modes?: readonly ConfigOptionMode[]
  currentModeId?: string
}): SessionConfigOption[] {
  const variants =
    input.providers
      .find((provider) => provider.id === input.currentModel.providerID)
      ?.models.find((model) => model.id === input.currentModel.modelID)?.variants ?? []
  const effort =
    variants.length > 0 ? buildEffortSelectOption({ variants, currentVariant: input.currentVariant }) : undefined
  return [
    buildModelSelectOption({ providers: input.providers, currentModel: input.currentModel }),
    ...(effort ? [effort] : []),
    ...(input.modes && input.currentModeId
      ? [buildModeSelectOption({ modes: input.modes, currentModeId: input.currentModeId })]
      : []),
  ]
}

export function buildModelSelectOption(input: {
  providers: readonly ConfigOptionProvider[]
  currentModel: ModelSelection["model"]
}): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: `${input.currentModel.providerID}/${input.currentModel.modelID}`,
    options: input.providers.flatMap((provider) =>
      provider.models
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((model) => ({ value: `${provider.id}/${model.id}`, name: `${provider.name}/${model.name}` })),
    ),
  }
}

export function buildEffortSelectOption(input: {
  variants: readonly string[]
  currentVariant?: string
}): SessionConfigOption {
  return {
    id: "effort",
    name: "Effort",
    description: "Available effort levels for this model",
    category: "thought_level",
    type: "select",
    currentValue: selectVariant(input.currentVariant, input.variants),
    options: [...new Set([...input.variants, DEFAULT_VARIANT_VALUE])].map((variant) => ({
      value: variant,
      name: formatVariantName(variant),
    })),
  }
}

export function buildModeSelectOption(input: {
  modes: readonly ConfigOptionMode[]
  currentModeId: string
}): SessionConfigOption {
  return {
    id: "mode",
    name: "Session Mode",
    category: "mode",
    type: "select",
    currentValue: input.currentModeId,
    options: input.modes.map((mode) => ({
      value: mode.id,
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
    })),
  }
}

export function parseModelSelection(modelId: string, providers: readonly ConfigOptionProvider[]): ModelSelection {
  const provider = providers.find((item) => modelId.startsWith(`${item.id}/`))
  if (!provider) {
    const separator = modelId.indexOf("/")
    if (separator === -1) return { model: { providerID: modelId, modelID: "" } }
    return { model: { providerID: modelId.slice(0, separator), modelID: modelId.slice(separator + 1) } }
  }
  const modelID = modelId.slice(provider.id.length + 1)
  if (provider.models.some((model) => model.id === modelID)) return { model: { providerID: provider.id, modelID } }
  const separator = modelID.lastIndexOf("/")
  const baseModelID = separator === -1 ? modelID : modelID.slice(0, separator)
  const variant = separator === -1 ? undefined : modelID.slice(separator + 1)
  const model = provider.models.find((item) => item.id === baseModelID)
  if (model && variant && model.variants?.includes(variant)) {
    return { model: { providerID: provider.id, modelID: baseModelID }, variant }
  }
  return { model: { providerID: provider.id, modelID } }
}

export function formatVariantName(variant: string) {
  return variant
    .split(/[_-]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ")
}

function selectVariant(variant: string | undefined, variants: readonly string[]) {
  if (!variant || variant === DEFAULT_VARIANT_VALUE) return DEFAULT_VARIANT_VALUE
  if (variant && variants.includes(variant)) return variant
  if (variants.includes(DEFAULT_VARIANT_VALUE)) return DEFAULT_VARIANT_VALUE
  return variants[0] ?? DEFAULT_VARIANT_VALUE
}

export * as ACPConfigOption from "./config-option"
