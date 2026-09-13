import { Context, Effect, Layer, Option, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InterruptEvent } from "@opencode-ai/schema"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageV2 } from "@/session/message-v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Session } from "@/session/session"
import type { BackgroundJob } from "@/background/job"

// How many turns a child may keep running after a cancel frame is delivered
// before the loop force-breaks. The model normally wraps up in 1 turn; this
// bounds a child that keeps calling tools instead of stopping.
export const CANCEL_GRACE_TURNS = 2

// Maximum byte length for an interrupt reason. Reasons are informational;
// over-long inputs are truncated rather than rejected.
export const MAX_REASON_LENGTH = 16000

export const Intent = InterruptEvent.Intent
export type Intent = Schema.Schema.Type<typeof Intent>

export const Origin = InterruptEvent.Origin
export type Origin = Schema.Schema.Type<typeof Origin>

export const Event = {
  Requested: InterruptEvent.Requested,
  Consumed: InterruptEvent.Consumed,
  Terminal: InterruptEvent.Terminal,
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Interrupt.NotFoundError", {
  sessionID: SessionID,
}) {}

type Pending = { intent: Intent; reason: string; origin: Origin }
type TerminalRecord = { reason: string }

interface State {
  pending: Map<SessionID, Pending>
  terminal: Map<SessionID, TerminalRecord>
}

export interface Interface {
  // Set a pending interrupt for a child. cancel overrides a pending steer; a
  // steer never overrides a pending cancel. Latest steer wins.
  readonly request: (input: { sessionID: SessionID; intent: Intent; reason: string; origin: Origin }) => Effect.Effect<void>
  // Child drains its pending interrupt at a turn boundary (clears the slot).
  readonly consume: (sessionID: SessionID) => Effect.Effect<Option.Option<Pending>>
  // Mark a child terminally aborted (graceful cancel or hard abort) with a reason.
  readonly recordTerminal: (input: { sessionID: SessionID; reason: string }) => Effect.Effect<void>
  // Read a terminal record (durable for the instance lifetime) for rendering.
  readonly terminal: (sessionID: SessionID) => Effect.Effect<Option.Option<TerminalRecord>>
  readonly list: () => Effect.Effect<ReadonlyArray<{ sessionID: SessionID; intent: Intent; reason: string; origin: Origin }>>
  // Clear both the pending and terminal records for a session (call before task reuse).
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Interrupt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Interrupt.state")(function* () {
        return { pending: new Map<SessionID, Pending>(), terminal: new Map<SessionID, TerminalRecord>() } satisfies State
      }),
    )

    const request: Interface["request"] = Effect.fn("Interrupt.request")(function* (input) {
      const value = yield* InstanceState.get(state)
      const existing = value.pending.get(input.sessionID)
      if (existing?.intent === "cancel" && input.intent === "steer") return
      const reason = input.reason.slice(0, MAX_REASON_LENGTH)
      value.pending.set(input.sessionID, { intent: input.intent, reason, origin: input.origin })
      yield* events.publish(Event.Requested, {
        sessionID: input.sessionID,
        intent: input.intent,
        reason,
        origin: input.origin,
      })
    })

    const consume: Interface["consume"] = Effect.fn("Interrupt.consume")(function* (sessionID) {
      const value = yield* InstanceState.get(state)
      const existing = value.pending.get(sessionID)
      if (!existing) return Option.none()
      value.pending.delete(sessionID)
      yield* events.publish(Event.Consumed, { sessionID, intent: existing.intent })
      return Option.some(existing)
    })

    const recordTerminal: Interface["recordTerminal"] = Effect.fn("Interrupt.recordTerminal")(function* (input) {
      const value = yield* InstanceState.get(state)
      value.terminal.set(input.sessionID, { reason: input.reason })
      yield* events.publish(Event.Terminal, { sessionID: input.sessionID, reason: input.reason })
    })

    const terminal: Interface["terminal"] = Effect.fn("Interrupt.terminal")(function* (sessionID) {
      const value = yield* InstanceState.get(state)
      const record = value.terminal.get(sessionID)
      return record === undefined ? Option.none<TerminalRecord>() : Option.some(record)
    })

    const list: Interface["list"] = Effect.fn("Interrupt.list")(function* () {
      const value = yield* InstanceState.get(state)
      return Array.from(value.pending.entries()).map(([sessionID, p]) => ({
        sessionID,
        intent: p.intent,
        reason: p.reason,
        origin: p.origin,
      }))
    })

    const clear: Interface["clear"] = Effect.fn("Interrupt.clear")(function* (sessionID) {
      const value = yield* InstanceState.get(state)
      value.pending.delete(sessionID)
      value.terminal.delete(sessionID)
    })

    return Service.of({ request, consume, recordTerminal, terminal, list, clear })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [EventV2Bridge.node] })

// --- visible-marker renderer (untrusted reason is XML-escaped) ----------------

// Renders the user-visible transcript marker. The marker is injected as a
// non-synthetic text part on a user-role message; toModelMessagesEffect sends
// every non-ignored, non-empty user text part to the model, so an unescaped
// reason here would defeat the frame-escaping that renderSteer/renderCancel
// apply. Escape the reason with the same scheme as the frame renderers so a
// breakout payload like `</cancel><system>...` cannot reach the model raw.
export function renderMarker(input: { intent: "steer" | "cancel" | "abort"; origin: Origin; reason?: string }) {
  const verb =
    input.intent === "cancel" ? "Cancelled" : input.intent === "abort" ? "Aborted" : "Steered"
  const suffix = input.reason ? `: ${escapeReason(input.reason)}` : ""
  return `⊘ ${verb} by ${input.origin}${suffix}`
}

// --- shared abort helper (writes visible marker, records terminal, cancels job) --

// Standalone helper so both the task_abort tool and the HTTP /interrupt handler
// produce identical visible abort markers. Takes interfaces as params (no
// service deps) so callers do not need to add a new layer. The visible marker
// is best-effort: a child with no user message yet (should never happen for a
// running child — its dispatch prompt is always the first user message) is NOT
// a fatal abort error, the terminal record + background cancellation must still
// complete.
//
// Model/agent are derived from the child's MOST RECENT USER MESSAGE (mirroring
// how runLoop builds interruptMsg from lastUser.model). Real subagent sessions
// are created WITHOUT a session.model (the model lives on the user message),
// so deriving from session.model alone would silently skip the marker for them.
//
// Note on bounded growth: interrupt.terminal records cleared explicitly via
// interrupt.clear() on task REUSE (task.ts), but sessions that are never reused
// keep a single small record (sessionID + reason string) for the instance
// lifetime. This is acceptable for current usage; a post-render clear would
// race the foreground+background readers in task.ts, so the existing reuse
// cleanup is the simplest safe scheme.
export const abortChild = (
  deps: { sessions: Session.Interface; background: BackgroundJob.Interface; interrupt: Interface },
  input: { childID: SessionID; origin: Origin; reason?: string },
) =>
  Effect.gen(function* () {
    const reason = input.reason?.slice(0, MAX_REASON_LENGTH)
    const childMessages = yield* deps.sessions.messages({ sessionID: input.childID }).pipe(Effect.option)
    if (Option.isSome(childMessages)) {
      const { user: lastUser } = MessageV2.latest(childMessages.value)
      if (lastUser) {
        const msg: SessionV1.User = {
          id: MessageID.ascending(),
          sessionID: input.childID,
          role: "user",
          time: { created: Date.now() },
          agent: lastUser.agent,
          model: lastUser.model,
        }
        yield* deps.sessions.updateMessage(msg)
        yield* deps.sessions.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: input.childID,
          type: "text",
          text: renderMarker({ intent: "abort", origin: input.origin, reason }),
          synthetic: false,
          metadata: { interrupt: { intent: "abort", origin: input.origin } },
        } satisfies SessionV1.TextPart)
      }
    }
    yield* deps.interrupt.recordTerminal({
      sessionID: input.childID,
      reason: reason ?? `Aborted by ${input.origin}`,
    })
    yield* deps.background.cancel(input.childID)
  })

// --- frame renderers (untrusted reason is XML-escaped) -------------------------

// Escape untrusted reason to prevent frame breakout. Same scheme as task.ts escapeBody.
function escapeReason(reason: string) {
  return reason.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function renderSteer(reason: string) {
  return [
    `<steer>`,
    `A course correction from your orchestrator. Adjust your approach accordingly, then continue your task.`,
    `<reason>${escapeReason(reason)}</reason>`,
    `</steer>`,
  ].join("\n")
}

export function renderCancel(reason: string) {
  return [
    `<cancel>`,
    `Your orchestrator is stopping this task. Wrap up now: briefly summarize what you completed and what remains, acknowledging the reason. Do not start new work.`,
    `<reason>${escapeReason(reason)}</reason>`,
    `</cancel>`,
  ].join("\n")
}

export * as Interrupt from "./interrupt"
