import type { DataProvider } from "@opencode-ai/session-ui/context"
import type { Message, Model, Part, Session, SessionStatus, SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { Share } from "~/core/share"

type Data = Parameters<typeof DataProvider>[0]["data"]
type MessageDiffStatus = NonNullable<Data["message_diff_status"]>

function dictionary<Value>() {
  return Object.create(null) as Record<string, Value>
}

export function hydrateShareData(share: { sessionID: string; shareID: string }, data: Share.Data[]) {
  const result = {
    sessionID: share.sessionID,
    shareID: share.shareID,
    session: [] as Session[],
    session_diff: dictionary<Data["session_diff"][string]>(),
    session_status: dictionary<Data["session_status"][string]>(),
    message_diff: dictionary<Data["message_diff"][string]>(),
    message_diff_status: dictionary<MessageDiffStatus[string]>(),
    message: dictionary<Data["message"][string]>(),
    part: dictionary<Data["part"][string]>(),
    model: dictionary<Model[]>(),
  }
  result.session_diff[share.sessionID] = [] as SnapshotFileDiff[]
  result.session_status[share.sessionID] = {
    type: "idle",
  } satisfies SessionStatus
  for (const item of data) {
    switch (item.type) {
      case "session":
        result.session.push(item.data)
        break
      case "session_diff":
        result.session_diff[share.sessionID] = item.data
        break
      case "message":
        if (item.data.role !== "user") {
          result.message[item.data.sessionID] = result.message[item.data.sessionID] ?? []
          result.message[item.data.sessionID].push(item.data)
          break
        }
        const summary = item.data.summary
        const safeSummary = summary && typeof summary === "object" ? summary : undefined
        const source = safeSummary?.diffs
        if (!Array.isArray(source)) {
          const message = source === undefined ? item.data : { ...item.data, summary: undefined }
          result.message[message.sessionID] = result.message[message.sessionID] ?? []
          result.message[message.sessionID].push(message)
          break
        }
        const diffs = source.filter((diff) => diff !== null && typeof diff === "object")
        const message =
          diffs.length === source.length ? item.data : { ...item.data, summary: { ...safeSummary, diffs } }
        result.message[message.sessionID] = result.message[message.sessionID] ?? []
        result.message[message.sessionID].push(message)
        // Legacy snapshots can retain patches; current producer snapshots intentionally omit them.
        const cache = diffs.flatMap((diff) => {
          if (typeof diff.file !== "string" || typeof diff.patch !== "string") return []
          return [
            {
              file: diff.file,
              patch: diff.patch,
              additions: diff.additions,
              deletions: diff.deletions,
              status: diff.status ?? "modified",
            },
          ]
        })
        result.message_diff[message.id] = cache
        if (source.length > 0 && cache.length === 0) {
          result.message_diff_status[message.id] = "absent"
        }
        break
      case "part":
        result.part[item.data.messageID] = result.part[item.data.messageID] ?? []
        result.part[item.data.messageID].push(item.data)
        break
      case "model":
        result.model[share.sessionID] = item.data
        break
    }
  }
  return result
}
