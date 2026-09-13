import { type Accessor, createMemo } from "solid-js"
import { DateTime } from "luxon"
import { isOrganizationRouteProvider } from "@opencode/util/organization-routes"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@opencode/ui/context"
import { useProviders } from "@/providers/catalog/providers"
import { useGlobal } from "@/runtime/server/runtime"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

const createModelsController = (directory: Accessor<string | undefined>) => {
  const providers = useProviders(() => directory())
  const models = useGlobal().models
  const store = models.store
  const setStore = models.set

  const available = createMemo(() =>
    providers.connected().flatMap((p) =>
      Object.values(p.models).map((m) => ({
        ...m,
        provider: p,
      })),
    ),
  )

  const release = createMemo(
    () =>
      new Map(
        available().map((model) => {
          const parsed = DateTime.fromISO(model.release_date)
          return [modelKey({ providerID: model.provider.id, modelID: model.id }), parsed] as const
        }),
      ),
  )

  const latest = createMemo(() =>
    pipe(
      available(),
      filter(
        (x) =>
          Math.abs(
            (release().get(modelKey({ providerID: x.provider.id, modelID: x.id })) ?? DateTime.invalid("invalid"))
              .diffNow()
              .as("months"),
          ) < 6,
      ),
      groupBy((x) => x.provider.id),
      mapValues((models) =>
        pipe(
          models,
          groupBy((x) => x.family),
          values(),
          (groups) =>
            groups.flatMap((g) => {
              const first = firstBy(g, [(x) => x.release_date, "desc"])
              return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
            }),
        ),
      ),
      values(),
      flat(),
    ),
  )

  const latestSet = createMemo(() => new Set(latest().map((x) => modelKey(x))))

  const visibility = createMemo(() => {
    const map = new Map<string, Visibility>()
    for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
    return map
  })

  const list = createMemo(() =>
    available().map((m) => ({
      ...m,
      name: isOrganizationRouteProvider(m.provider.id) ? m.name : m.name.replace("(latest)", "").trim(),
      latest: !isOrganizationRouteProvider(m.provider.id) && m.name.includes("(latest)"),
    })),
  )

  const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

  function update(model: ModelKey, state: Visibility) {
    const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
    if (index >= 0) {
      setStore("user", index, (current) => ({ ...current, visibility: state }))
      return
    }
    setStore("user", store.user.length, { ...model, visibility: state })
  }

  const visible = (model: ModelKey) => {
    const key = modelKey(model)
    const state = visibility().get(key)
    if (state === "hide") return false
    if (state === "show") return true
    if (isOrganizationRouteProvider(model.providerID)) return true
    if (latestSet().has(key)) return true
    const date = release().get(key)
    if (!date?.isValid) return true
    return false
  }

  const setVisibility = (model: ModelKey, state: boolean) => {
    update(model, state ? "show" : "hide")
  }

  const push = (model: ModelKey) => {
    const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
    if (uniq.length > RECENT_LIMIT) uniq.pop()
    setStore("recent", uniq)
  }

  const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
  const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

  const setVariant = (model: ModelKey, value: string | undefined) => {
    const key = variantKey(model)
    if (!store.variant) {
      setStore("variant", { [key]: value ?? "default" })
      return
    }
    setStore("variant", key, value ?? "default")
  }

  return {
    ready: models.ready,
    list,
    find,
    visible,
    setVisibility,
    recent: {
      list: models.recent,
      push,
    },
    variant: {
      get: getVariant,
      set: setVariant,
    },
  }
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  init: (props: { directory?: string | Accessor<string | undefined> } = {}) => {
    return createModelsController(() => (typeof props.directory === "function" ? props.directory() : props.directory))
  },
})
