import { Binary } from "@opencode-ai/core/util/binary"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { createMemo } from "solid-js"
import { produce, reconcile, type SetStoreFunction } from "solid-js/store"
import type { createServerSdkContext } from "./server-sdk"
import type { createServerSyncContextInner } from "./server-sync"
import type { State } from "./global-sync/types"
import { normalizeSessionInfo } from "@/utils/session"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const sessionFields = new Set([
  "session_status",
  "session_working",
  "session_diff",
  "message_diff",
  "todo",
  "permission",
  "question",
  "message",
  "session_message",
  "part",
  "part_text_accum_delta",
])

export const createDirSyncContext = (
  directory: string,
  serverSync: ReturnType<typeof createServerSyncContextInner>,
  serverSDK: ReturnType<typeof createServerSdkContext>,
) => {
  const client = serverSDK.createClient({ directory, throwOnError: true })
  const current = createMemo(() => serverSync.child(directory, { mcp: true }))
  const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
  const data = new Proxy({} as State, {
    get(_, property: keyof State) {
      if (property === "session_working") return serverSync.session.data.session_working.bind(serverSync.session.data)
      if (sessionFields.has(property)) return serverSync.session.data[property as keyof typeof serverSync.session.data]
      return current()[0][property]
    },
  })
  const set = ((...input: unknown[]) => {
    if (typeof input[0] === "string" && sessionFields.has(input[0])) {
      return (serverSync.session.set as (...args: unknown[]) => unknown)(...input)
    }
    const result = (current()[1] as (...args: unknown[]) => unknown)(...input)
    if (input[0] === "session") current()[0].session.forEach(serverSync.session.remember)
    return result
  }) as SetStoreFunction<State>

  const index = (sessionID: string) => {
    const session = serverSync.session.get(sessionID)
    if (!session || session.directory !== directory) return
    const [store, setStore] = current()
    const result = Binary.search(store.session, session.id, (item) => item.id)
    if (result.found) {
      setStore("session", result.index, reconcile(session))
      return
    }
    setStore(
      "session",
      produce((draft) => void draft.splice(result.index, 0, session)),
    )
  }

  return {
    data,
    set,
    get status() {
      return current()[0].status
    },
    get ready() {
      return current()[0].status !== "loading"
    },
    get project() {
      const store = current()[0]
      const match = Binary.search(serverSync.data.project, store.project, (project) => project.id)
      if (match.found) return serverSync.data.project[match.index]
    },
    session: {
      remember(session: Session) {
        serverSync.session.remember(session)
        index(session.id)
      },
      get(sessionID: string) {
        const session = serverSync.session.get(sessionID)
        if (session?.directory === directory) return session
      },
      optimistic: {
        add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
          serverSync.session.optimistic.add(input)
        },
        remove(input: { directory?: string; sessionID: string; messageID: string }) {
          serverSync.session.optimistic.remove(input)
        },
      },
      addOptimisticMessage(input: {
        sessionID: string
        messageID: string
        parts: Part[]
        agent: string
        model: { providerID: string; modelID: string }
        variant?: string
      }) {
        serverSync.session.optimistic.add({
          sessionID: input.sessionID,
          message: {
            id: input.messageID,
            sessionID: input.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: input.agent,
            model: { ...input.model, variant: input.variant },
          },
          parts: input.parts,
        })
      },
      async sync(sessionID: string, options?: { force?: boolean }) {
        await serverSync.session.sync(sessionID, options)
        index(sessionID)
      },
      todo: serverSync.session.todo,
      history: serverSync.session.history,
      fetchMessageDiff: serverSync.session.fetchMessageDiff,
      evict(sessionID: string) {
        serverSync.session.evict(sessionID)
      },
      fetch: async (count = 10) => {
        const [store, setStore] = current()
        setStore("limit", (value) => value + count)
        const response = await serverSDK.api.session.list({ directory, limit: store.limit, order: "desc" })
        const sessions = response.data
          .map(normalizeSessionInfo)
          .sort((a, b) => cmp(a.id, b.id))
          .slice(0, store.limit)
        sessions.forEach(serverSync.session.remember)
        setStore("session", reconcile(sessions, { key: "id" }))
      },
      more: createMemo(() => current()[0].session.length >= current()[0].limit),
      archive: async (sessionID: string) => {
        if ((await serverSDK.protocol) !== "v1") return
        await serverSDK.client.session.update({ sessionID, directory, time: { archived: Date.now() } })
        current()[1](
          "session",
          produce((draft) => {
            const match = Binary.search(draft, sessionID, (session) => session.id)
            if (match.found) draft.splice(match.index, 1)
          }),
        )
      },
    },
    mcp: {
      toggle: (name: string) => serverSync.mcp.toggle(directory, name),
    },
    absolute,
    get directory() {
      return current()[0].path.directory
    },
  }
}
