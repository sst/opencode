import type { Message, Model, Part, Session, SessionStatus, SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { Share } from "~/core/share"

export function hydrateShareData(share: { sessionID: string; shareID: string }, data: Share.Data[]) {
  const result = {
    sessionID: share.sessionID,
    shareID: share.shareID,
    session: [] as Session[],
    session_diff: {
      [share.sessionID]: [] as SnapshotFileDiff[],
    },
    session_status: {
      [share.sessionID]: {
        type: "idle" as const,
      } satisfies SessionStatus,
    },
    message_diff: {} as Record<
      string,
      | Array<{
          file: string
          patch: string
          additions: number
          deletions: number
          status: "added" | "deleted" | "modified"
        }>
      | undefined
    >,
    message_diff_status: {} as Record<string, "pending" | "failed" | "absent" | undefined>,
    message: {} as Record<string, Message[]>,
    part: {} as Record<string, Part[]>,
    model: {} as Record<string, Model[]>,
  }
  for (const item of data) {
    switch (item.type) {
      case "session":
        result.session.push(item.data)
        break
      case "session_diff":
        result.session_diff[share.sessionID] = item.data
        break
      case "message":
        result.message[item.data.sessionID] = result.message[item.data.sessionID] ?? []
        result.message[item.data.sessionID].push(item.data)
        if (item.data.role === "user" && item.data.summary?.diffs) {
          const diffs = item.data.summary.diffs.flatMap((diff) => {
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
          result.message_diff[item.data.id] = diffs
          if (item.data.summary.diffs.length > 0 && diffs.length === 0) {
            result.message_diff_status[item.data.id] = "absent"
          }
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
