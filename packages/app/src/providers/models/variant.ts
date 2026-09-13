type AgentModel = {
  providerID: string
  modelID: string
}

type Agent = {
  model?: AgentModel
  variant?: string
}

type Model = AgentModel & {
  variants?: Record<string, unknown>
}

type VariantInput = {
  variants: string[]
  selected: string | null | undefined
  configured: string | undefined
  preferred?: string
}

export function getConfiguredAgentVariant(input: { agent: Agent | undefined; model: Model | undefined }) {
  if (!input.agent?.variant) return undefined
  if (!input.agent.model) return undefined
  if (!input.model?.variants) return undefined
  if (input.agent.model.providerID !== input.model.providerID) return undefined
  if (input.agent.model.modelID !== input.model.modelID) return undefined
  return input.agent.variant
}

export function resolveModelVariant(input: VariantInput) {
  if (input.selected === null) return undefined
  const value = input.selected ?? input.preferred ?? input.configured
  return value && value !== "default" && input.variants.includes(value) ? value : undefined
}

export function cycleModelVariant(input: VariantInput) {
  const current = resolveModelVariant(input)
  return input.variants[current ? input.variants.indexOf(current) + 1 : 0]
}
