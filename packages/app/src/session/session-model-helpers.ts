type Local = {
  session: {
    reset(): void
    restore(msg: {
      sessionID: string
      agent: string
      model: { providerID: string; modelID: string; variant?: string }
    }): void
  }
}

type ModelSelection = {
  model: {
    current(): { id: string; provider: { id: string } } | undefined
    variant: {
      current(): string | undefined
    }
  }
}

type PromptState = {
  model: {
    current(): { providerID: string; modelID: string; variant?: string | null } | undefined
    set(model: { providerID: string; modelID: string; variant?: string | null }): void
  }
}

export const resetSessionModel = (local: Local) => {
  local.session.reset()
}

export const syncSessionModel = (
  local: Local,
  msg: { sessionID: string; agent: string; model: { providerID: string; modelID: string; variant?: string } },
) => {
  local.session.restore(msg)
}

export const syncPromptModel = (local: ModelSelection, prompt: PromptState) => {
  const model = local.model.current()
  if (!model) return
  const next = {
    providerID: model.provider.id,
    modelID: model.id,
    variant: local.model.variant.current(),
  }
  const current = prompt.model.current()
  if (current?.providerID === next.providerID && current.modelID === next.modelID && current.variant === next.variant)
    return
  prompt.model.set(next)
}
