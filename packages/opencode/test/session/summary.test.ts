import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MessageDiffTable } from "@opencode-ai/core/database/message-diff.sql"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageDiff } from "@opencode-ai/core/session/message-diff"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Snapshot } from "@/snapshot"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const distinctivePatch = "distinctive patch text that must not reach message.updated.1"

const sideTableDiffs: ReadonlyArray<FileDiff.Info> = [
  {
    file: "side.ts",
    additions: 3,
    deletions: 2,
    patch: distinctivePatch,
    status: "modified",
  },
]
const legacyDiffs: ReadonlyArray<FileDiff.Info> = [
  { file: "legacy.ts", additions: 1, deletions: 4, patch: "legacy", status: "deleted" },
]

const snapshot = Layer.succeed(Snapshot.Service, {
  init: () => Effect.void,
  cleanup: () => Effect.void,
  track: () => Effect.succeed(undefined),
  patch: () => Effect.succeed({ hash: "", files: [] }),
  restore: () => Effect.void,
  revert: () => Effect.void,
  diff: () => Effect.succeed(""),
  diffFull: () => Effect.succeed([...sideTableDiffs]),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      MessageDiff.node,
      SessionNs.node,
      SessionProjector.node,
      EventV2Bridge.node,
      SessionSummary.node,
    ]),
    [[Snapshot.node, snapshot]],
  ),
)

const withSession = <A, E, R>(
  fn: (input: { session: SessionNs.Interface; sessionID: SessionID }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )

const addUser = Effect.fn("Test.addUser")(function* (input: {
  sessionID: SessionID
  diffs: ReadonlyArray<FileDiff.Info>
}) {
  const session = yield* SessionNs.Service
  const messageID = MessageID.ascending()
  yield* session.updateMessage({
    id: messageID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    summary: { diffs: [...input.diffs] },
    tools: {},
    mode: "",
  } as unknown as SessionV1.Info)
  return messageID
})

const addSnapshots = Effect.fn("Test.addSnapshots")(function* (input: { sessionID: SessionID; messageID: MessageID }) {
  const session = yield* SessionNs.Service
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "step-start",
    snapshot: "before",
  })
  const assistantID = MessageID.ascending()
  yield* session.updateMessage({
    id: assistantID,
    sessionID: input.sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: input.messageID,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "",
    agent: "test",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Info)
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID: input.sessionID,
    messageID: assistantID,
    type: "step-finish",
    snapshot: "after",
    reason: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
})

describe("SessionSummary", () => {
  it.instance("returns the stored side-table row", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const messageID = yield* addUser({ sessionID, diffs: [] })
        const diffs = yield* MessageDiff.Service
        yield* diffs.put({ messageID, diffs: sideTableDiffs })
        const summary = yield* SessionSummary.Service
        expect(yield* summary.diff({ sessionID, messageID })).toEqual([...sideTableDiffs])
      }),
    ),
  )

  it.instance("ignores conflicting inline diffs when the side-table row exists", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const messageID = yield* addUser({ sessionID, diffs: legacyDiffs })
        const diffs = yield* MessageDiff.Service
        yield* diffs.put({ messageID, diffs: sideTableDiffs })
        const summary = yield* SessionSummary.Service
        expect(yield* summary.diff({ sessionID, messageID })).toEqual([...sideTableDiffs])
      }),
    ),
  )

  it.instance("falls back to inline diffs after the side-table row is deleted", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const messageID = yield* addUser({ sessionID, diffs: legacyDiffs })
        const diffs = yield* MessageDiff.Service
        yield* diffs.put({ messageID, diffs: sideTableDiffs })
        const { db } = yield* Database.Service
        yield* db.delete(MessageDiffTable).where(eq(MessageDiffTable.message_id, messageID)).run()
        const summary = yield* SessionSummary.Service
        expect(yield* summary.diff({ sessionID, messageID })).toEqual([...legacyDiffs])
      }),
    ),
  )

  it.instance("keeps a diff skeleton inline and full diffs in the side table while dual-writing", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const messageID = yield* addUser({ sessionID, diffs: [] })
        yield* addSnapshots({ sessionID, messageID })
        const sessionSummary = yield* SessionSummary.Service
        yield* sessionSummary.summarize({ sessionID, messageID })
        const session = yield* SessionNs.Service
        const updated = (yield* session.messages({ sessionID })).find((item) => item.info.id === messageID)
        expect(updated?.info.summary).toMatchObject({
          additions: 3,
          deletions: 2,
          files: 1,
        })
        expect(updated?.info.summary?.diffs).toEqual([
          { file: "side.ts", additions: 3, deletions: 2, status: "modified" },
        ])
        const diffs = yield* MessageDiff.Service
        expect(yield* diffs.get(messageID)).toEqual([...sideTableDiffs])
      }),
    ),
  )

  it.instance("publishes a patch-free summary while retaining diff metadata", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const messageID = yield* addUser({ sessionID, diffs: legacyDiffs })
        yield* addSnapshots({ sessionID, messageID })
        const received = yield* Deferred.make<{
          type: "message.updated.1"
          data: typeof MessageV2.Event.Updated.data.Type
        }>()
        const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
          const syncEvent = event.payload.syncEvent
          if (event.payload.type !== "sync") return
          if (syncEvent?.type !== EventV2.versionedType(MessageV2.Event.Updated.type, 1)) return
          const messageUpdated = syncEvent as unknown as {
            type: "message.updated.1"
            data: typeof MessageV2.Event.Updated.data.Type
          }
          if (messageUpdated.data.sessionID !== sessionID) return
          Deferred.doneUnsafe(received, Effect.succeed(messageUpdated))
        }
        GlobalBus.on("event", listener)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

        const sessionSummary = yield* SessionSummary.Service
        yield* sessionSummary.summarize({ sessionID, messageID })
        const messageUpdated = yield* Effect.race(
          Deferred.await(received),
          Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error("message.updated.1 was not published")))),
        )

        const messageSummary: unknown = messageUpdated.data.info.summary
        expect(typeof messageSummary).toBe("object")
        expect(messageSummary).not.toBe(true)
        expect(messageSummary).not.toBe(1)
        expect(JSON.stringify(messageUpdated)).not.toContain(distinctivePatch)
        const messageSummaryInfo = messageUpdated.data.info.summary
        if (!messageSummaryInfo || typeof messageSummaryInfo === "boolean")
          throw new Error("message summary must be an object")
        expect(messageSummaryInfo.diffs[0]).toEqual({
          file: "side.ts",
          additions: 3,
          deletions: 2,
          status: "modified",
        })
      }),
    ),
  )
})
