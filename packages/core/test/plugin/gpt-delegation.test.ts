import { describe, expect } from "bun:test"
import { Message, SystemPart } from "@opencode/ai"
import { Catalog } from "@opencode/core/catalog"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { GptDelegationPlugin } from "@opencode/core/plugin/gpt-delegation"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Agent } from "@opencode/schema/agent"
import { Event } from "@opencode/schema/event"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionEvent } from "@opencode/schema/session-event"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Deferred, Effect, Stream } from "effect"
import { tempLocationLayer } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host } from "./host"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Catalog.node, PluginHooks.node]), [
    Config.node.replace(Config.testLayer()),
    Location.node.replace(tempLocationLayer),
  ]),
)
const provider = Provider.ID.make("test")
const sessionID = Session.ID.make("ses_gpt_delegation")
const max = { id: Model.VariantID.make("max"), settings: { reasoningEffort: "max" } }
const xhigh = { id: Model.VariantID.make("xhigh"), settings: { reasoningEffort: "xhigh" } }
const model = (id: string, variant: string | undefined) =>
  Model.Ref.make({
    providerID: provider,
    id: Model.ID.make(id),
    ...(variant ? { variant: Model.VariantID.make(variant) } : {}),
  })

const selected = (current: Model.Ref, previous: Model.Ref): SessionEvent.ModelSelected => ({
  id: Event.ID.create(),
  created: 0,
  durable: { aggregateID: sessionID, seq: Event.Seq.make(0), version: Event.Version.make(1) },
  type: "session.model.selected",
  data: { sessionID, model: current, previous },
})

const setup = Effect.gen(function* () {
  const catalog = yield* Catalog.Service
  const hooks = yield* PluginHooks.Service
  const persisted: SessionInbox.Synthetic[] = []
  const completed = yield* Deferred.make<void>()
  yield* catalog.transform((editor) => {
    editor.model.update(provider, Model.ID.make("sol"), (item) => {
      item.modelID = Model.ID.make("gpt-5.6-sol")
      item.family = Model.Family.make("custom-family")
      item.variants = [
        { ...max, headers: { "x-reasoning": "max" }, body: { include: ["reasoning.encrypted_content"] } },
        { id: Model.VariantID.make("ultra"), settings: { reasoningEffort: "stale" } },
      ]
    })
    editor.model.update(provider, Model.ID.make("terra"), (item) => {
      item.family = Model.Family.make("gpt-terra")
      item.variants = [max]
    })
    editor.model.update(provider, Model.ID.make("astra"), (item) => {
      item.modelID = Model.ID.make("gpt-6-astra")
      item.variants = [max, { ...xhigh, headers: { "x-reasoning": "xhigh" } }]
    })
    editor.model.update(provider, Model.ID.make("no-xhigh"), (item) => {
      item.family = Model.Family.make("gpt-astra")
      item.variants = [max]
    })
    editor.model.update(provider, Model.ID.make("claude"), (item) => {
      item.variants = [{ id: Model.VariantID.make("ultra") }]
    })
  })
  return {
    catalog,
    persisted,
    completed: Deferred.await(completed),
    activate: (events: ReadonlyArray<SessionEvent.Created | SessionEvent.ModelSelected>) =>
      GptDelegationPlugin.Plugin.effect(
        host({
          catalog: catalogHost(catalog),
          event: {
            subscribe: () => Stream.fromIterable(events).pipe(Stream.ensuring(Deferred.succeed(completed, undefined))),
          },
          session: {
            hook: (name, callback, options) => hooks.register("session", name, callback, options),
            synthetic: (input) =>
              Effect.sync(() => {
                expect(input.resume).toBe(false)
                const item = SessionInbox.Synthetic.make({
                  id: SessionMessage.ID.create(),
                  sessionID: input.sessionID,
                  timeCreated: DateTime.makeUnsafe(0),
                  type: "synthetic",
                  payload: { text: input.text },
                  delivery: "steer",
                })
                persisted.push(item)
                return item
              }),
          },
        }),
      ),
    prepare: (ref: Model.Ref, messages: Message[]) => {
      const event: SessionContext = {
        sessionID,
        agent: Agent.ID.make("build"),
        model: ref,
        system: [SystemPart.make("baseline")],
        messages,
        tools: {},
        options: {},
      }
      return hooks.trigger("session", "context", event)
    },
  }
})

describe("GptDelegationPlugin", () => {
  it.effect("copies complete max or xhigh variants using either model identity signal", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.activate([])
      const sol = yield* fixture.catalog.model.get(provider, Model.ID.make("sol"))
      const terra = yield* fixture.catalog.model.get(provider, Model.ID.make("terra"))
      const astra = yield* fixture.catalog.model.get(provider, Model.ID.make("astra"))
      const noXhigh = yield* fixture.catalog.model.get(provider, Model.ID.make("no-xhigh"))
      expect(sol?.variants.filter((item) => item.id === "ultra")).toEqual([
        {
          ...max,
          headers: { "x-reasoning": "max" },
          body: { include: ["reasoning.encrypted_content"] },
          id: Model.VariantID.make("ultra"),
        },
      ])
      expect(terra?.variants.find((item) => item.id === "ultra")).toEqual({ ...max, id: Model.VariantID.make("ultra") })
      expect(astra?.variants.find((item) => item.id === "ultra")).toEqual({
        ...xhigh,
        headers: { "x-reasoning": "xhigh" },
        id: Model.VariantID.make("ultra"),
      })
      expect(noXhigh?.variants.some((item) => item.id === "ultra")).toBe(false)
    }),
  )

  it.effect("reconciles missing and stale policies as system messages without changing the baseline", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.activate([])
      expect((yield* fixture.prepare(model("claude", "ultra"), [Message.user("hello")])).messages).toEqual([
        Message.user("hello"),
      ])
      const normal = yield* fixture.prepare(model("sol", undefined), [Message.user("hello")])
      const explicit = fixture.persisted[0]
      if (!explicit) throw new Error("Missing explicit-only reminder")
      expect(normal.messages.map((message) => message.role)).toEqual(["system", "user"])
      expect(explicit.payload.text).toContain("Do not spawn subagents unless")

      const ultra = yield* fixture.prepare(model("sol", "ultra"), [
        Message.user(explicit.payload.text),
        Message.user("continue"),
      ])
      const proactive = fixture.persisted[1]
      if (!proactive) throw new Error("Missing proactive reminder")
      expect(ultra.system).toEqual(normal.system)
      expect(ultra.messages.map((message) => message.role)).toEqual(["system", "system", "user"])
      expect(proactive.payload.text).toContain("Proactive multi-agent delegation is active")
      expect((yield* fixture.prepare(model("astra", "ultra"), [...ultra.messages])).messages).toEqual(ultra.messages)
      expect(fixture.persisted).toHaveLength(2)

      const other = yield* fixture.prepare(model("claude", undefined), [...ultra.messages])
      expect(fixture.persisted[2]?.payload.text).toContain("previous delegation-mode instructions no longer apply")
      expect((yield* fixture.prepare(model("claude", undefined), [...other.messages])).messages).toEqual(other.messages)
      expect(fixture.persisted).toHaveLength(3)

      yield* fixture.prepare(model("sol", undefined), [Message.user(proactive.payload.text), Message.user("continue")])
      expect(fixture.persisted.at(-1)?.payload.text).toBe(explicit.payload.text)
      // A checkpoint quote is history, not a live mode reminder.
      const compacted = yield* fixture.prepare(model("sol", "ultra"), [
        Message.user(`<conversation-checkpoint>\n${proactive.payload.text}\n</conversation-checkpoint>`),
      ])
      expect(compacted.messages[0]).toEqual(Message.system(proactive.payload.text))
      expect(fixture.persisted).toHaveLength(5)
      yield* fixture.prepare(model("sol", undefined), [Message.user("reverted history")])
      expect(fixture.persisted.at(-1)?.payload.text).toBe(explicit.payload.text)
    }),
  )

  it.effect("persists model-switch reminders and renders them in place on later requests", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.activate([
        selected(model("sol", undefined), model("claude", undefined)),
        selected(model("sol", "ultra"), model("sol", undefined)),
        selected(model("astra", "ultra"), model("sol", "ultra")),
        selected(model("claude", undefined), model("astra", "ultra")),
      ])
      yield* fixture.completed
      expect(fixture.persisted.map((item) => item.payload.text)).toEqual([
        expect.stringContaining("Do not spawn subagents unless"),
        expect.stringContaining("Proactive multi-agent delegation is active"),
        expect.stringContaining("previous delegation-mode instructions no longer apply"),
      ])
      const request = yield* fixture.prepare(model("claude", undefined), [
        ...fixture.persisted.map((item) => Message.make({ id: item.id, role: "user", content: item.payload.text })),
        Message.user("continue"),
      ])
      expect(request.messages).toEqual([
        ...fixture.persisted.map((item) => Message.make({ id: item.id, role: "system", content: item.payload.text })),
        Message.user("continue"),
      ])
      expect(fixture.persisted).toHaveLength(3)
    }),
  )
})
