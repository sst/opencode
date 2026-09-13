import { afterEach, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { Agent } from "@/runtime/server/types"
import type { ModelKey } from "@/providers/models/selection"
import { ServerScope } from "@/runtime/server/scope"

// Bun does not compile Solid JSX. Compile the real context provider with the
// same presets as Vite instead of replacing LocalProvider's implementation.
const require = createRequire(import.meta.url)
const solid = createRequire(require.resolve("vite-plugin-solid"))
const { transformSync } = solid("@babel/core")
Bun.plugin({
  name: "selection-solid-context",
  setup(build) {
    build.onLoad({ filter: /[\\/]ui[\\/]src[\\/]context[\\/]helper\.tsx$/ }, async (args) => ({
      contents: transformSync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [solid.resolve("babel-preset-solid"), solid.resolve("@babel/preset-typescript")],
      }).code,
      loader: "js",
    }))
  },
})

type Commit = { agent?: string; model?: { providerID: string; id: string; variant?: string } }
type Event = { data: { sessionID: string } }
type ConfigModel = string | { providerID: string; model: string; variant?: string }
const key = (modelID: string): ModelKey => ({ providerID: "provider", modelID })
const durable = (modelID: string, variant?: string, agent = "build"): Commit => ({
  agent,
  model: { providerID: "provider", id: modelID, variant },
})
const agent = (name: string, model?: ModelKey, variant?: string): Agent => ({
  name,
  mode: "primary",
  permission: [],
  options: {},
  model,
  variant,
})

let active: ReturnType<typeof fixture>
mock.module("@solidjs/router", () => ({ useParams: () => active.state.route }))
mock.module("@/runtime/server/current", () => ({ useData: () => active.data }))
mock.module("@/runtime/server/client", () => ({ useServerSDK: () => active.sdk }))
mock.module("@/runtime/server/runtime", () => ({ useGlobal: () => ({ models: active.preferences }) }))
mock.module("@/workspaces/location", () => ({ useWorkspaceLocation: () => () => ({ directory: active.directory }) }))
mock.module("@/settings/model", () => ({
  useSettings: () => ({ visibility: { customAgents: () => active.state.visible } }),
}))
mock.module("@/composer/persistence", () => ({ useComposerState: () => active.prompt }))
mock.module("@/shell/state/layout", () => ({ useLayout: () => undefined }))
mock.module("@/runtime/platform/platform", () => ({
  usePlatform: () => ({
    platform: "web",
    openExternal() {},
    restart: async () => {},
    notify: async () => {},
  }),
}))

const { LocalProvider, useLocal } = await import("@/providers/models/selection")
const { ModelsProvider } = await import("@/providers/models/models")
const { Persist } = await import("@/runtime/persistence/storage")
const { createMemoryComposerState } = await import("@/composer/state")
const { createComposerModelSelection } = await import("@/composer/selection")

const cleanups: Array<() => void> = []
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)

function fixture(input: { session?: Commit; agents?: Agent[]; config?: ConfigModel; preferred?: string } = {}) {
  const directory = `/selection-test/${crypto.randomUUID()}`
  const [state, set] = createStore({
    visible: true,
    configLoaded: true,
    connection: "connected",
    route: { id: "ses_a" as string | undefined },
    agents: input.agents ?? [agent("build"), agent("plan")],
    config: input.config as ConfigModel | undefined,
    sessions: { ses_a: input.session } as Record<string, Commit | undefined>,
    providers: [{ id: "provider", name: "Provider", package: "@ai-sdk/test", activation: "enabled" }],
    models: ["a", "b", "c"].map((id) => ({
      id,
      modelID: id,
      providerID: "provider",
      name: `Model ${id}`,
      settings: {},
      headers: {},
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: ["low", "high"].map((id) => ({ id, settings: {} })),
      time: { released: 1 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 128_000, output: 8192 },
    })),
  })
  const [preferences, setPreferences] = createStore({
    user: [] as Array<ModelKey & { visibility: "show" | "hide" }>,
    recent: [] as ModelKey[],
    variant: (input.preferred ? { "provider/a": input.preferred } : {}) as Record<string, string>,
  })
  const events = new Map<string, Set<(event: Event) => void>>()
  const configLoads: string[] = []
  const result = {
    prompt: createMemoryComposerState(),
    directory,
    state,
    set,
    setPreferences,
    preferences: { store: preferences, set: setPreferences, ready: () => true, recent: () => preferences.recent },
    data: {
      session: { get: (id: string) => state.sessions[id] },
      location: {
        agent: { list: () => state.agents },
        config: {
          list: () => (state.configLoaded ? [{ type: "document", info: { model: state.config } }] : undefined),
          sync: async () => {
            configLoads.push(state.connection)
          },
        },
        provider: { list: () => state.providers },
        model: { list: () => state.models },
        integration: { list: () => [] },
      },
    },
    sdk: {
      scope: ServerScope.local,
      connection: { status: () => state.connection },
      event: {
        on(type: string, handler: (event: Event) => void) {
          const handlers = events.get(type) ?? new Set()
          events.set(type, handlers)
          handlers.add(handler)
          return () => handlers.delete(handler)
        },
      },
    },
    emit(type: string, sessionID = "ses_a") {
      events.get(type)?.forEach((handler) => handler({ data: { sessionID } }))
    },
    configLoads,
    mount(draft = false) {
      active = result
      let local!: ReturnType<typeof useLocal>
      let composer: ReturnType<typeof createComposerModelSelection> | undefined
      const dispose = createRoot((dispose) => {
        createComponent(ModelsProvider, {
          directory,
          get children() {
            return createComponent(LocalProvider, {
              get children() {
                local = useLocal()
                if (draft) composer = createComposerModelSelection({ agent: local.agent.current })
                return null
              },
            })
          },
        })
        return dispose
      })
      cleanups.push(dispose)
      return { local, composer, dispose }
    },
  }
  const target = Persist.serverWorkspace(ServerScope.local, directory, "model-selection")
  cleanups.push(() => localStorage.removeItem(`${target.storage}:${target.key}`))
  return result
}

function selection(local: ReturnType<typeof useLocal>) {
  return {
    agent: local.agent.current()?.name,
    model: local.model.current()?.id,
    variant: local.model.variant.current(),
  }
}

test("restores durable agents even when the agent selector is hidden", () => {
  const f = fixture({ session: durable("b", "high", "plan") })
  f.set("visible", false)
  const { local } = f.mount()
  expect(local.agent.visible()).toBe(false)
  expect(selection(local)).toEqual({ agent: "plan", model: "b", variant: "high" })
})

test("waits for initial configuration and reloads it after reconnecting", () => {
  const f = fixture({ config: "provider/b" })
  f.set("configLoaded", false)
  const { local } = f.mount()
  expect(local.model.ready()).toBe(false)
  expect(local.model.current()).toBeUndefined()
  f.set("connection", "reconnecting")
  f.set("connection", "connected")
  expect(f.configLoads).toEqual(["connected", "reconnecting", "connected"])
  f.set("configLoaded", true)
  expect(local.model.ready()).toBe(true)
  expect(local.model.current()?.id).toBe("b")
})

test("new-session promotion does not mask a command's durable overrides", () => {
  const f = fixture({ session: durable("a", "low") })
  const { local } = f.mount()
  local.session.promote(f.directory, "ses_a", { agent: "build", model: key("a"), variant: "low" })
  f.set("sessions", "ses_a", durable("b", "high", "plan"))
  expect(selection(local)).toEqual({ agent: "plan", model: "b", variant: "high" })
})

test("new-session drafts remember each agent's model and hand off inactive choices", () => {
  const f = fixture({ agents: [agent("build", key("a")), agent("plan", key("b"))] })
  f.set("route", "id", undefined)
  const { local, composer } = f.mount(true)
  if (!composer) throw new Error("missing draft composer")
  composer.set(key("c"))
  composer.variant.set("high")
  local.agent.set("plan")
  expect(composer.current()?.id).toBe("b")
  expect(composer.variant.current()).toBeUndefined()
  local.agent.set("build")
  expect(composer.current()?.id).toBe("c")
  expect(composer.variant.current()).toBe("high")
  local.agent.set("plan")
  const choices = composer.remembered()
  f.set("sessions", "ses_a", durable("b", undefined, "plan"))
  local.session.promote(f.directory, "ses_a", { agent: "plan", model: key("b"), choices })
  f.set("route", "id", "ses_a")
  local.agent.set("build")
  expect(local.model.current()?.id).toBe("c")
})

test("session model picks snapshot the variant rather than following another session's preferences", () => {
  const f = fixture({ session: durable("a") })
  const { local } = f.mount()
  f.setPreferences("variant", "provider/b", "low")
  local.model.set(key("b"))
  f.setPreferences("variant", "provider/b", "high")
  expect(local.model.variant.current()).toBe("low")
})

test("remembers distinct variants for agents using the same model, scoped to the session", () => {
  const f = fixture({ session: durable("a", "low"), agents: [agent("build", key("a")), agent("plan", key("a"))] })
  const { local } = f.mount()
  local.model.variant.set("high")
  local.agent.set("plan")
  local.model.variant.set("low")
  local.agent.set("build")
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "high" })
  local.agent.set("plan")
  expect(selection(local)).toEqual({ agent: "plan", model: "a", variant: "low" })

  f.set("sessions", "ses_b", durable("b", "high"))
  f.set("route", "id", "ses_b")
  expect(selection(local)).toEqual({ agent: "build", model: "b", variant: "high" })
  f.set("route", "id", "ses_a")
  expect(selection(local)).toEqual({ agent: "plan", model: "a", variant: "low" })
})

test("restores each agent's model and variant after provider remount", () => {
  const f = fixture({ agents: [agent("build", key("a")), agent("plan", key("b"))] })
  const first = f.mount()
  first.local.model.variant.set("high")
  first.local.agent.set("plan")
  first.local.model.set(key("c"))
  first.local.model.variant.set("low")
  first.dispose()
  const { local } = f.mount()
  expect(selection(local)).toEqual({ agent: "plan", model: "c", variant: "low" })
  local.agent.set("build")
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "high" })
  local.agent.set("plan")
  expect(selection(local)).toEqual({ agent: "plan", model: "c", variant: "low" })
})

test("changing models drops the old variant even when both models support it", () => {
  const f = fixture({ session: durable("a", "high") })
  const { local } = f.mount()
  local.model.set(key("b"))
  expect(selection(local)).toEqual({ agent: "build", model: "b", variant: undefined })
  f.setPreferences("variant", "provider/c", "low")
  local.model.set(key("c"))
  expect(local.model.variant.current()).toBe("low")
})

test("restores durable selection ahead of agent, global, and saved variant defaults", () => {
  const f = fixture({
    session: durable("a", "low", "plan"),
    agents: [agent("build"), agent("plan", key("b"), "high")],
    config: { providerID: "provider", model: "c", variant: "high" },
    preferred: "high",
  })
  const { local } = f.mount()
  expect(selection(local)).toEqual({ agent: "plan", model: "a", variant: "low" })
  local.session.restore({ sessionID: "ses_a", agent: "build", model: key("c") })
  expect(selection(local)).toEqual({ agent: "plan", model: "a", variant: "low" })
})

test("uses historical message selection only when durable and local selection are absent", () => {
  const f = fixture()
  const { local } = f.mount()
  local.session.restore({ sessionID: "ses_b", agent: "plan", model: key("b") })
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: undefined })
  local.session.restore({ sessionID: "ses_a", agent: "plan", model: { ...key("b"), variant: "low" } })
  expect(selection(local)).toEqual({ agent: "plan", model: "b", variant: "low" })
  local.model.variant.set("high")
  local.session.restore({ sessionID: "ses_a", agent: "build", model: key("c") })
  expect(selection(local)).toEqual({ agent: "plan", model: "b", variant: "high" })
})

test("invalid durable models fall through agent, global, recent, and connected defaults", () => {
  const f = fixture({
    session: durable("removed", "high"),
    agents: [agent("build", key("b"), "low")],
    config: "provider/c",
  })
  const { local } = f.mount()
  expect(selection(local)).toEqual({ agent: "build", model: "b", variant: "low" })
  f.set("agents", [agent("build", key("removed"))])
  expect(local.model.current()?.id).toBe("c")
  f.setPreferences("recent", [key("removed"), key("b")])
  f.set("config", "provider/removed")
  expect(local.model.current()?.id).toBe("b")
  f.setPreferences("recent", [key("removed")])
  expect(local.model.current()?.id).toBe("a")
  f.set("providers", [])
  expect(local.model.current()).toBeUndefined()
})

test("global and agent model/variant defaults react to configuration replacement", () => {
  const f = fixture({ config: { providerID: "provider", model: "a", variant: "low" } })
  const { local } = f.mount()
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "low" })
  f.set("config", { providerID: "provider", model: "b", variant: "high" })
  expect(selection(local)).toEqual({ agent: "build", model: "b", variant: "high" })
  f.set("agents", [agent("build", key("a"), "low")])
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "low" })
  f.set("agents", [agent("build", key("c"), "high")])
  expect(selection(local)).toEqual({ agent: "build", model: "c", variant: "high" })
  f.set("agents", [agent("build")])
  f.set("config", "provider/b")
  expect(selection(local)).toEqual({ agent: "build", model: "b", variant: undefined })
})

test("durable and explicitly selected Default override a saved variant preference", () => {
  const f = fixture({
    session: durable("a"),
    preferred: "high",
    config: { providerID: "provider", model: "a", variant: "low" },
  })
  const { local } = f.mount()
  expect(local.model.variant.current()).toBeUndefined()
  local.model.variant.set(undefined)
  expect(f.preferences.store.variant["provider/a"]).toBe("default")
  f.set("route", "id", "ses_b")
  expect(local.model.variant.current()).toBeUndefined()
  f.set("route", "id", "ses_a")
  f.setPreferences("variant", "provider/a", "high")
  expect(local.model.variant.current()).toBeUndefined()
  f.set("route", "id", "ses_b")
  expect(local.model.variant.current()).toBe("high")
  f.set("route", "id", "ses_a")
  expect(local.model.variant.current()).toBeUndefined()
})

test("waits for both commit acknowledgments, then releases only the matching draft", () => {
  const f = fixture({ session: durable("b", "low") })
  const { local } = f.mount()
  local.agent.set("plan")
  local.model.set(key("a"))
  local.model.variant.set("high")
  local.model.trackSessionCommit("ses_a", { agent: "plan", model: key("a"), variant: "high" })
  f.set("sessions", "ses_a", durable("b", "low", "plan"))
  f.emit("session.agent.selected")
  expect(selection(local)).toEqual({ agent: "plan", model: "a", variant: "high" })
  f.set("sessions", "ses_a", durable("a", "high", "plan"))
  f.emit("session.model.selected")
  f.set("sessions", "ses_a", durable("c", "low", "plan"))
  expect(selection(local)).toEqual({ agent: "plan", model: "c", variant: "low" })
})

test.each(["a", "b"])("a delayed commit preserves the newer %s/low selection", (model) => {
  const f = fixture()
  const { local } = f.mount()
  local.model.set(key("a"))
  local.model.variant.set("high")
  local.model.trackSessionCommit("ses_a", { agent: "build", model: key("a"), variant: "high" })
  local.model.set(key(model))
  local.model.variant.set("low")
  f.set("sessions", "ses_a", durable("a", "high"))
  f.emit("session.model.selected")
  expect(selection(local)).toEqual({ agent: "build", model, variant: "low" })
})

test("a delayed commit preserves a newer agent even when model and variant match", () => {
  const f = fixture({ agents: [agent("build", key("a")), agent("plan", key("a"))] })
  const { local } = f.mount()
  local.model.variant.set("high")
  local.model.trackSessionCommit("ses_a", { agent: "build", model: key("a"), variant: "high" })
  local.agent.set("plan")
  f.set("sessions", "ses_a", durable("a", "high"))
  f.emit("session.model.selected")
  expect(selection(local)).toEqual({ agent: "plan", model: "a", variant: "high" })
})

test("a commit received while its session is inactive does not discard its local selection", () => {
  const f = fixture()
  const { local } = f.mount()
  local.model.set(key("a"))
  local.model.variant.set("high")
  local.model.trackSessionCommit("ses_a", { agent: "build", model: key("a"), variant: "high" })
  f.set("sessions", "ses_b", durable("b", "low"))
  f.set("route", "id", "ses_b")
  f.set("sessions", "ses_a", durable("a", "high"))
  f.emit("session.model.selected")
  expect(selection(local)).toEqual({ agent: "build", model: "b", variant: "low" })
  f.set("sessions", "ses_a", durable("c", "low"))
  f.set("route", "id", "ses_a")
  expect(selection(local)).toEqual({ agent: "build", model: "a", variant: "high" })
})

test("cancelling a failed commit retains the draft and does not cancel a newer commit", () => {
  const f = fixture()
  const { local } = f.mount()
  local.model.set(key("a"))
  local.model.variant.set("high")
  const cancel = local.model.trackSessionCommit("ses_a", { agent: "build", model: key("a"), variant: "high" })
  cancel()
  f.set("sessions", "ses_a", durable("a", "high"))
  f.emit("session.model.selected")
  f.set("sessions", "ses_a", durable("c", "low"))
  expect(local.model.current()?.id).toBe("a")

  local.model.set(key("b"))
  local.model.variant.set("low")
  local.model.trackSessionCommit("ses_a", { agent: "build", model: key("b"), variant: "low" })
  cancel()
  f.set("sessions", "ses_a", durable("b", "low"))
  f.emit("session.model.selected")
  f.set("sessions", "ses_a", durable("c", "high"))
  expect(selection(local)).toEqual({ agent: "build", model: "c", variant: "high" })
})

test.each([1, -1] as const)("cycles %p from outside recents to the correct end and wraps", (direction) => {
  const f = fixture({ session: durable("a") })
  f.setPreferences("recent", [key("removed"), key("b"), key("c")])
  const { local } = f.mount()
  local.model.cycle(direction)
  expect(local.model.current()?.id).toBe(direction === 1 ? "b" : "c")
  local.model.cycle(direction)
  expect(local.model.current()?.id).toBe(direction === 1 ? "c" : "b")
  local.model.cycle(direction)
  expect(local.model.current()?.id).toBe(direction === 1 ? "b" : "c")
})
