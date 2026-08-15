export * as MessageDiff from "./message-diff"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { Database } from "../database/database"
import { MessageDiffTable } from "../database/message-diff.sql"
import { makeGlobalNode } from "../effect/app-node"
import { MessageID } from "../v1/session"

export interface Interface {
  readonly put: (input: {
    readonly messageID: MessageID
    readonly diffs: ReadonlyArray<FileDiff.Info>
  }) => Effect.Effect<void>
  readonly get: (messageID: MessageID) => Effect.Effect<ReadonlyArray<FileDiff.Info> | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/MessageDiff") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const put = Effect.fn("MessageDiff.put")(function* (input: {
      readonly messageID: MessageID
      readonly diffs: ReadonlyArray<FileDiff.Info>
    }) {
      const data = [...input.diffs]
      yield* db
        .insert(MessageDiffTable)
        .values({ message_id: input.messageID, data })
        .onConflictDoUpdate({ target: MessageDiffTable.message_id, set: { data } })
        .run()
        .pipe(Effect.orDie)
    })

    const get = Effect.fn("MessageDiff.get")(function* (messageID: MessageID) {
      const row = yield* db
        .select()
        .from(MessageDiffTable)
        .where(eq(MessageDiffTable.message_id, messageID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return [...row.data]
    })

    return Service.of({ put, get })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
