import { batch, type Accessor, createEffect, createMemo, on } from "solid-js"
import { createStore } from "solid-js/store"
import type { ComposerControls } from "./adapter"
import { useLayout } from "@/shell/state/layout"
import { useLocal, type ModelKey, type ModelSelection } from "@/providers/models/selection"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useProviders } from "@/providers/catalog/providers"
import { useData } from "@/runtime/server/current"
import { normalizeAgentList } from "@/runtime/server/global-sync/utils"
import { useModels } from "@/providers/models/models"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "@/providers/models/variant"
import { useComposerState } from "./persistence"
import { useConfiguredModel } from "@/providers/models/configured"

export function createComposerControls(input: { sessionKey: Accessor<string>; model?: ModelSelection }) {
  const layout = useLayout()
  const local = useLocal()
  const sdk = useWorkspaceLocation()
  const data = useData()
  const providers = useProviders(() => sdk().directory)
  const view = layout.view(input.sessionKey)

  return createMemo<ComposerControls>(() => {
    return {
      agents: {
        available: normalizeAgentList(data.location.agent.list({ directory: sdk().directory }) ?? []),
        options: local.agent.list().map((agent) => agent.name),
        current: local.agent.current()?.name ?? "",
        visible: local.agent.visible(),
        select: local.agent.set,
      },
      model: {
        selection: input.model ?? local.model,
        paid: providers.paid().length > 0,
        loading:
          !(input.model ?? local.model).ready() ||
          (local.agent.visible() && data.location.agent.list({ directory: sdk().directory }) === undefined) ||
          !providers.ready(),
      },
      session: {
        tabs: layout.tabs(input.sessionKey),
        reviewPanel: view.reviewPanel,
      },
    }
  })
}

export function createComposerModelSelection(input: {
  agent: () => { name: string; model?: ModelKey; variant?: string } | undefined
}) {
  const sdk = useWorkspaceLocation()
  const models = useModels()
  const local = useLocal()
  const prompt = useComposerState()
  const configuredModel = useConfiguredModel()
  const [remembered, setRemembered] = createStore<Record<string, ModelKey | undefined>>({})
  createEffect(
    on(
      () => input.agent()?.name,
      (name, previous) => {
        if (!name || !previous || name === previous) return
        batch(() => {
          const model = prompt.model.current()
          setRemembered(previous, model ? { providerID: model.providerID, modelID: model.modelID } : undefined)
          prompt.model.set(remembered[name] ? { ...remembered[name] } : undefined)
        })
      },
    ),
  )
  const providers = useProviders(() => sdk().directory)
  const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

  const valid = (model: Pick<ModelKey, "providerID" | "modelID">) => {
    const provider = providers.all().get(model.providerID)
    return !!provider?.models[model.modelID] && connected().has(model.providerID)
  }
  const recent = () => models.recent.list().find(valid)
  const fallback = () =>
    providers.connected().flatMap((provider) => {
      const modelID = Object.values(provider.models)[0]?.id
      return modelID ? [{ providerID: provider.id, modelID }] : []
    })[0]
  const current = () => {
    if (!configuredModel.ready()) return
    const key = [prompt.model.current(), input.agent()?.model, configuredModel(), recent(), fallback()].find(
      (item): item is ModelKey => !!item && valid(item),
    )
    return key ? models.find(key) : undefined
  }
  const recentModels = createMemo(() =>
    models.recent
      .list()
      .map(models.find)
      .filter((item): item is NonNullable<typeof item> => !!item),
  )
  const selection = {
    trackSessionCommit: local.model.trackSessionCommit,
    remembered: () => Object.fromEntries(Object.entries(remembered).map(([name, model]) => [name, { model }])),
    ready: Object.assign(() => models.ready() && configuredModel.ready(), { promise: models.ready.promise }),
    current,
    recent: recentModels,
    list: models.list,
    cycle(direction: 1 | -1) {
      const items = recentModels()
      const item = current()
      if (!item) return
      const index = items.findIndex((entry) => entry.provider.id === item.provider.id && entry.id === item.id)
      const next =
        items[
          index === -1 ? (direction === 1 ? 0 : items.length - 1) : (index + direction + items.length) % items.length
        ]
      if (next) selection.set({ providerID: next.provider.id, modelID: next.id })
    },
    set(item: ModelKey | undefined, options?: { recent?: boolean }) {
      batch(() => {
        if (item && !valid(item)) return
        const previous = current()
        const same = item && previous?.provider.id === item.providerID && previous.id === item.modelID
        prompt.model.set(
          item ? { ...item, variant: same ? (selection.variant.current() ?? null) : undefined } : undefined,
        )
        if (!item) return
        models.setVisibility(item, true)
        if (options?.recent) models.recent.push(item)
      })
    },
    visible: models.visible,
    setVisibility: models.setVisibility,
    variant: {
      configured() {
        const item = input.agent()
        const model = current()
        if (!item || !model) return
        const global = configuredModel()
        return (
          getConfiguredAgentVariant({
            agent: { model: item.model, variant: item.variant },
            model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
          }) ??
          getConfiguredAgentVariant({
            agent: { model: global, variant: global?.variant },
            model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
          })
        )
      },
      selected() {
        const model = prompt.model.current()
        return model && valid(model) ? model.variant : undefined
      },
      current() {
        const model = current()
        return resolveModelVariant({
          variants: this.list(),
          selected: this.selected(),
          configured: this.configured(),
          preferred: model ? models.variant.get({ providerID: model.provider.id, modelID: model.id }) : undefined,
        })
      },
      list() {
        return Object.keys(current()?.variants ?? {})
      },
      set(value: string | undefined) {
        batch(() => {
          const model = current()
          if (!model) return
          prompt.model.set({ providerID: model.provider.id, modelID: model.id, variant: value ?? null })
          models.variant.set({ providerID: model.provider.id, modelID: model.id }, value)
        })
      },
      cycle() {
        const variants = this.list()
        if (variants.length === 0) return
        this.set(
          cycleModelVariant({
            variants,
            selected: this.current() ?? null,
            configured: undefined,
          }),
        )
      },
    },
  }

  return selection satisfies ModelSelection
}
