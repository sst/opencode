import type { Part, SessionStatus } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show } from "solid-js"

const id = "internal:sidebar-subagents"

export type SidebarSubagent = {
  description: string
  status: "pending" | "active" | "done" | "failed"
  session_id: string | undefined
}

export function deriveSubagents(
  messages: ReadonlyArray<{ id: string }>,
  getParts: (messageID: string) => ReadonlyArray<Part>,
): SidebarSubagent[] {
  const entries = messages.flatMap((message) =>
    getParts(message.id).flatMap((part) => {
      if (part.type !== "tool" || part.tool !== "task") return []

      const inputDescription = part.state.input.description
      const title = "title" in part.state ? part.state.title : undefined
      const description =
        typeof inputDescription === "string"
          ? inputDescription
          : typeof title === "string"
            ? title
            : "Subagent"
      const metadata = "metadata" in part.state ? part.state.metadata : undefined
      const sessionID =
        typeof metadata === "object" && metadata !== null && "sessionId" in metadata && typeof metadata.sessionId === "string"
          ? metadata.sessionId
          : undefined

      const status: SidebarSubagent["status"] =
        part.state.status === "running"
          ? "active"
          : part.state.status === "completed"
            ? "done"
            : part.state.status === "error"
              ? "failed"
              : "pending"

      return [{ description, status, session_id: sessionID }]
    }),
  )
  const latestBySession = new Map<string, SidebarSubagent>()
  const pending: SidebarSubagent[] = []
  for (const entry of entries) {
    if (entry.session_id) latestBySession.set(entry.session_id, entry)
    else pending.push(entry)
  }
  return [...latestBySession.values(), ...pending]
}

export function activeSubagents(
  messages: ReadonlyArray<{ id: string }>,
  getParts: (messageID: string) => ReadonlyArray<Part>,
  getStatus: (sessionID: string) => SessionStatus | undefined,
) {
  return deriveSubagents(messages, getParts).flatMap((entry) => {
    if (!entry.session_id) return entry.status === "active" || entry.status === "pending" ? [entry] : []

    const status = getStatus(entry.session_id)
    if (status?.type !== "busy" && status?.type !== "retry") return []
    return [{ ...entry, status: "active" as const }]
  })
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() =>
    activeSubagents(
      props.api.state.session.messages(props.session_id),
      (messageID) => props.api.state.part(messageID),
      props.api.state.session.status,
    ),
  )

  const statusColor = (status: SidebarSubagent["status"]) => {
    if (status === "active") return theme().success
    if (status === "failed") return theme().error
    if (status === "pending") return theme().warning
    return theme().textMuted
  }

  const statusLabel = (status: SidebarSubagent["status"]) => {
    if (status === "active") return "Active"
    if (status === "done") return "Done"
    if (status === "failed") return "Failed"
    return "Pending"
  }

  return (
    <Show when={list().length > 0}>
      <box>
        <text fg={theme().text}>
          <b>Subagents</b>
        </text>
        <For each={list()}>
          {(item) => {
            const navigate = item.session_id
              ? () => props.api.route.navigate("session", { sessionID: item.session_id })
              : undefined
            return (
              <box flexDirection="row" gap={1} onMouseUp={navigate}>
                <text flexShrink={0} style={{ fg: statusColor(item.status) }}>
                  •
                </text>
                <text fg={theme().text} wrapMode="word">
                  {item.description} <span style={{ fg: theme().textMuted }}>{statusLabel(item.status)}</span>
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 600,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
