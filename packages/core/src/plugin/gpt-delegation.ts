export * as GptDelegationPlugin from "./gpt-delegation.js"

import { Message } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Model } from "@opencode/schema/model"
import type { SessionEvent } from "@opencode/schema/session-event"
import { Effect, Stream } from "effect"

const proactive = `<system-reminder>
Proactive multi-agent delegation is active. Any earlier instruction requiring an explicit user request before spawning subagents no longer applies. This mode remains active until a later reminder changes it. User requests override this hint.

If at any point you can parallelize work by delegating tasks to a subagent, you should do so if it could save time or improve quality.
</system-reminder>`
const explicit = `<system-reminder>
Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn subagents unless the user or applicable AGENTS.md/skill instructions explicitly ask for subagents, delegation, or parallel agent work.
</system-reminder>`
const removed = `<system-reminder>
The previous delegation-mode instructions no longer apply.
</system-reminder>`

export const Plugin = define({
  id: "opencode.gpt-delegation",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      for (const provider of catalog.provider.list()) {
        for (const model of provider.models.values()) {
          const selected = effort(model)
          if (!selected) continue
          const variant = model.variants.find((item) => item.id === selected)
          if (!variant) continue
          catalog.model.update(model.providerID, model.id, (draft) => {
            draft.variants = [
              ...draft.variants.filter((item) => item.id !== "ultra"),
              { ...variant, id: Model.VariantID.make("ultra") },
            ]
          })
        }
      }
    })

    // Synthetic reminders are durable. Render them in place as chronological system
    // messages, and restore the selected policy if compaction or revert removed it.
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const catalog = (yield* ctx.catalog.model.list()).data
        const last = event.messages.reduce<string | undefined>((last, message, index) => {
          const text = reminder(message)
          if (!text) return last
          event.messages[index] = Message.make({ id: message.id, role: "system", content: text })
          return text
        }, undefined)
        const text = policy(event.model, catalog) ?? (last ? removed : undefined)
        if (!text || text === last) return
        const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
        event.messages.splice(at, 0, Message.system(text))
        yield* ctx.session
          .synthetic({ sessionID: event.sessionID, text, resume: false })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to persist GPT delegation reminder", { sessionID: event.sessionID, cause }),
            ),
          )
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to reconcile GPT delegation policy", { sessionID: event.sessionID, error }),
        ),
      ),
    )

    yield* ctx.event.subscribe().pipe(
      Stream.filter(
        (event): event is SessionEvent.Created | SessionEvent.ModelSelected =>
          event.type === "session.created" || event.type === "session.model.selected",
      ),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const catalog = (yield* ctx.catalog.model.list()).data
          const current = policy(event.data.model, catalog)
          const previous = event.type === "session.model.selected" ? policy(event.data.previous, catalog) : undefined
          if (current === previous) return
          yield* ctx.session
            .synthetic({ sessionID: event.data.sessionID, text: current ?? removed, resume: false })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to inject GPT delegation reminder", {
                  sessionID: event.data.sessionID,
                  cause,
                }),
              ),
            )
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

function effort(model: Model.Info) {
  const family = model.family?.toLowerCase()
  const id = model.modelID.toLowerCase()
  if (family === "gpt-astra" || id.includes("gpt-6-astra")) return "xhigh"
  if (family === "gpt-sol" || family === "gpt-terra" || id.includes("gpt-5.6-sol") || id.includes("gpt-5.6-terra"))
    return "max"
}

function policy(ref: Model.Ref | undefined, catalog: ReadonlyArray<Model.Info>) {
  if (!ref) return
  const model = catalog.find((model) => model.providerID === ref.providerID && model.id === ref.id)
  if (!model || ![model.modelID, model.family].some((id) => id?.toLowerCase().includes("gpt"))) return
  return ref.variant === "ultra" && effort(model) && model.variants.some((item) => item.id === "ultra")
    ? proactive
    : explicit
}

function reminder(message: Message) {
  if (message.role !== "user" && message.role !== "system") return
  if (message.content.length !== 1) return
  const part = message.content[0]
  if (part?.type !== "text") return
  return part.text === proactive || part.text === explicit || part.text === removed ? part.text : undefined
}
