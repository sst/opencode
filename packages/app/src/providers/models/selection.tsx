import { createSimpleContext } from "@opencode/ui/context"
import { base64Encode } from "@opencode/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Schema, SchemaGetter } from "effect"
import { useModels } from "@/providers/models/models"
import { useSettings } from "@/settings/model"
import { useProviders } from "@/providers/catalog/providers"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { hasCustomAgent, resolveAgent } from "./agent"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./variant"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useData } from "@/runtime/server/current"
import { normalizeAgentList } from "@/runtime/server/global-sync/utils"
import { useServerSDK } from "@/runtime/server/client"
import { ScopedKey, type ServerScope } from "@/runtime/server/scope"
import { useConfiguredModel } from "./configured"

const ModelKeySchema = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
})
export type ModelKey = typeof ModelKeySchema.Type

const ChoiceSchema = Schema.Struct({
  model: Persistence.optional(ModelKeySchema),
  variant: Persistence.optional(Schema.NullOr(Schema.String)),
})
const StateSchema = Schema.Struct({
  ...ChoiceSchema.fields,
  agent: Persistence.optional(Schema.String),
  choices: Persistence.optional(Schema.Record(Schema.String, ChoiceSchema)),
})
type State = typeof StateSchema.Type

const SessionsSchema = Schema.Record(
  Schema.String,
  Schema.mutableKey(Persistence.fallback(Schema.UndefinedOr(StateSchema), () => undefined)),
)

const Current = Persistence.struct({ session: SessionsSchema })

export const ModelSelectionSchema = Persistence.migrate(
  Current,
  Schema.Struct({
    session: Persistence.optional(Schema.Record(Schema.String, Schema.Unknown)),
    pick: Persistence.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }).pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) => ({
        session:
          value.session ??
          Object.fromEntries(Object.entries(value.pick ?? {}).filter(([key]) => key !== WORKSPACE_KEY)),
      })),
      encode: SchemaGetter.transform((value) => value),
    }),
  ),
)

const WORKSPACE_KEY = "__workspace__"
const handoff = new Map<string, State>()

const handoffKey = (scope: ServerScope, dir: string, id: string) => ScopedKey.from(scope, dir, id)

const clone = (value: State | undefined) => {
  if (!value) return
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
  } satisfies State
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const params = useParams()
    const sdk = useWorkspaceLocation()
    const data = useData()
    const serverSDK = useServerSDK()
    const providers = useProviders(() => sdk().directory)
    const models = useModels()
    const settings = useSettings()
    const configuredModel = useConfiguredModel()

    const id = createMemo(() => params.id || undefined)
    const list = createMemo(() =>
      normalizeAgentList(data.location.agent.list({ directory: sdk().directory }) ?? []).filter(
        (item) => item.mode !== "subagent" && !item.hidden,
      ),
    )
    const agentsVisible = createMemo(() => settings.visibility.customAgents() || hasCustomAgent(list()))
    const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

    const [saved, setSaved, , savedReady] = persisted(
      Persist.serverWorkspace(serverSDK.scope, sdk().directory, "model-selection"),
      ModelSelectionSchema,
      { session: {} },
    )

    const [store, setStore] = createStore<{
      current?: string
      draft?: State
      promoting?: State
    }>({
      current: list()[0]?.name,
      draft: undefined,
    })

    const validModel = (model: ModelKey) => {
      const provider = providers.all().get(model.providerID)
      return !!provider?.models[model.modelID] && connected().has(model.providerID)
    }

    const firstModel = (...items: Array<() => ModelKey | undefined>) => {
      for (const item of items) {
        const model = item()
        if (!model) continue
        if (validModel(model)) return model
      }
    }

    const pickAgent = (name: string | undefined) => {
      return resolveAgent(list(), name)
    }

    createEffect(() => {
      const items = list()
      if (items.length === 0) {
        if (store.current !== undefined) setStore("current", undefined)
        return
      }
      if (items.some((item) => item.name === store.current)) return
      setStore("current", items[0]?.name)
    })

    const scope = createMemo<State | undefined>(() => {
      const session = id()
      if (!session) return store.draft ?? store.promoting
      return saved.session[session] ?? handoff.get(handoffKey(serverSDK.scope, sdk().directory, session))
    })

    createEffect(() => {
      const session = id()
      if (!session) return

      const key = handoffKey(serverSDK.scope, sdk().directory, session)
      const next = handoff.get(key)
      if (!next) return
      if (saved.session[session] !== undefined) {
        handoff.delete(key)
        setStore("promoting", undefined)
        return
      }

      setSaved("session", session, clone(next))
      handoff.delete(key)
      setStore("promoting", undefined)
    })

    const recentModel = () => {
      for (const item of models.recent.list()) {
        if (validModel(item)) return item
      }
    }

    const defaultModel = () => {
      for (const provider of providers.connected()) {
        const first = Object.values(provider.models)[0]
        if (!first) continue
        const model = { providerID: provider.id, modelID: first.id }
        if (validModel(model)) return model
      }
    }

    const fallback = createMemo(() => firstModel(configuredModel, recentModel, defaultModel))
    const durable = () => {
      const session = id()
      return session ? data.session.get(session) : undefined
    }

    const agent = {
      list,
      visible: agentsVisible,
      current() {
        return pickAgent(scope()?.agent ?? durable()?.agent ?? (agentsVisible() ? store.current : "build"))
      },
      set(name: string | undefined) {
        const item = pickAgent(name)
        if (!item) {
          setStore("current", undefined)
          return
        }

        batch(() => {
          const previous = snapshot()
          if (previous.agent === item.name) return
          const prev = scope()
          const choices = {
            ...prev?.choices,
            ...(previous.agent ? { [previous.agent]: { model: previous.model, variant: previous.variant } } : {}),
          }
          setStore("current", item.name)
          const next = {
            agent: item.name,
            model: choices[item.name]?.model,
            variant: choices[item.name]?.variant,
            choices,
          } satisfies State
          write(next)
          // Pin both choices while the agent and model acknowledgments arrive separately.
          const selected = current()
          if (selected) model.set({ providerID: selected.provider.id, modelID: selected.id })
        })
      },
      move(direction: 1 | -1) {
        const items = list()
        if (items.length === 0) {
          setStore("current", undefined)
          return
        }

        let next = items.findIndex((item) => item.name === agent.current()?.name) + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0
        const item = items[next]
        if (!item) return
        agent.set(item.name)
      },
    }

    const current = createMemo(() => {
      if (!configuredModel.ready()) return
      const item = firstModel(
        () => scope()?.model,
        () => {
          const session = durable()
          if (session?.agent && session.agent !== agent.current()?.name) return
          const model = session?.model
          return model && { providerID: model.providerID, modelID: model.id }
        },
        () => agent.current()?.model,
        fallback,
      )
      if (!item) return
      return models.find(item)
    })

    const configured = () => {
      const item = agent.current()
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
    }

    const selected = () => {
      const draft = scope()
      if (draft?.model && validModel(draft.model)) return draft.variant
      const session = durable()
      if (session?.agent && session.agent !== agent.current()?.name) return
      const value = session?.model
      if (value && validModel({ providerID: value.providerID, modelID: value.id })) return value.variant ?? null
    }

    const snapshot = () => {
      const selected = current()
      return {
        agent: agent.current()?.name,
        model: selected ? { providerID: selected.provider.id, modelID: selected.id } : undefined,
        variant: selected ? (model.variant.current() ?? null) : undefined,
      } satisfies State
    }

    const write = (next: Partial<State>) => {
      const state = {
        ...scope(),
        agent: agent.current()?.name,
        ...next,
      } satisfies State

      const session = id()
      if (session) {
        setSaved("session", session, state)
        return
      }
      setStore("draft", state)
    }

    const recent = createMemo(() => models.recent.list().filter(validModel).map(models.find).filter(Boolean))
    const pending = new Map<string, State>()
    const sameSelection = (a: State, b: State) =>
      a.agent === b.agent &&
      a.model?.providerID === b.model?.providerID &&
      a.model?.modelID === b.model?.modelID &&
      (a.variant ?? "default") === (b.variant ?? "default")

    const reconcile = (sessionID: string) => {
      const expected = pending.get(sessionID)
      const session = data.session.get(sessionID)
      if (!expected || !session?.model) return
      if (
        !sameSelection(expected, {
          agent: session.agent,
          model: { providerID: session.model.providerID, modelID: session.model.id },
          variant: session.model.variant,
        })
      )
        return
      pending.delete(sessionID)
      const draft = saved.session[sessionID]
      if (id() !== sessionID || !draft || !sameSelection(draft, expected)) return
      setSaved("session", sessionID, { agent: undefined, model: undefined, variant: undefined })
    }
    onCleanup(serverSDK.event.on("session.model.selected", (event) => reconcile(event.data.sessionID)))
    onCleanup(serverSDK.event.on("session.agent.selected", (event) => reconcile(event.data.sessionID)))
    onCleanup(
      serverSDK.event.on("session.deleted", (event) => {
        pending.delete(event.data.sessionID)
        setSaved("session", event.data.sessionID, undefined)
      }),
    )

    const model = {
      ready: Object.assign(() => models.ready() && configuredModel.ready(), { promise: models.ready.promise }),
      current,
      recent,
      list: models.list,
      trackSessionCommit(sessionID: string, selection: { agent: string; model: ModelKey; variant?: string }) {
        pending.set(sessionID, selection)
        reconcile(sessionID)
        return () => {
          if (pending.get(sessionID) === selection) pending.delete(sessionID)
        }
      },
      cycle(direction: 1 | -1) {
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        let next = index === -1 ? (direction === 1 ? 0 : items.length - 1) : index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean }) {
        batch(() => {
          if (item && !validModel(item)) return
          const previous = current()
          const same = item && previous?.provider.id === item.providerID && previous.id === item.modelID
          write({ model: item, variant: same ? (model.variant.current() ?? null) : undefined })
          if (!item) return
          // A session draft owns its variant even when preferences change in another session.
          if (id() && !same) write({ variant: model.variant.current() ?? null })
          models.setVisibility(item, true)
          if (!options?.recent) return
          models.recent.push(item)
        })
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
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
          const item = current()
          if (!item?.variants) return []
          return Object.keys(item.variants)
        },
        set(value: string | undefined) {
          batch(() => {
            const model = current()
            if (!model) return
            write({ model: { providerID: model.provider.id, modelID: model.id }, variant: value ?? null })
            models.variant.set({ providerID: model.provider.id, modelID: model.id }, value)
          })
        },
        cycle() {
          const items = this.list()
          if (items.length === 0) return
          this.set(
            cycleModelVariant({
              variants: items,
              selected: this.current() ?? null,
              configured: undefined,
            }),
          )
        },
      },
    }

    const result = {
      slug: createMemo(() => base64Encode(sdk().directory)),
      model,
      agent,
      session: {
        ready: savedReady,
        reset() {
          setStore({ draft: undefined, promoting: undefined })
        },
        promote(dir: string, session: string, state?: State) {
          const next = clone(state ?? snapshot())
          if (!next) return
          // Creation already owns the active selection; keep only agent memory once it is in the read model.
          // Otherwise a first-message command's configured overrides would stay hidden behind this handoff.
          const created = data.session.get(session)
          const selection = created?.model
          const committed =
            selection &&
            sameSelection(next, {
              agent: created.agent,
              model: { providerID: selection.providerID, modelID: selection.id },
              variant: selection.variant,
            })
              ? { choices: next.choices }
              : next
          const key = handoffKey(serverSDK.scope, dir, session)
          handoff.set(key, committed)

          if (dir === sdk().directory) {
            setSaved("session", session, committed)
          }

          setStore("promoting", committed)
          setStore("draft", undefined)
        },
        restore(msg: { sessionID: string; agent: string; model: ModelKey }) {
          const session = id()
          if (!session) return
          if (msg.sessionID !== session) return
          if (durable()?.model) return
          if (saved.session[session] !== undefined) return
          if (handoff.has(handoffKey(serverSDK.scope, sdk().directory, session))) return

          setSaved("session", session, {
            agent: msg.agent,
            model: msg.model,
            variant: msg.model?.variant ?? null,
          })
        },
      },
    }
    return result
  },
})

export type ModelSelection = Omit<ReturnType<typeof useLocal>["model"], "trackSessionCommit"> &
  Partial<Pick<ReturnType<typeof useLocal>["model"], "trackSessionCommit">>
