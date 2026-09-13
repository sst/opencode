import type { SshItem, SshPlatform, SshState } from "@opencode/app/ssh"
import { isSshConnecting, sshHostname, sshName } from "@opencode/app/ssh"
import { createStore } from "solid-js/store"
import { Effect, Schedule } from "effect"

// Routes key on the connection object. Preserve it across progress/endpoint
// changes so reconnecting never unmounts an open conversation or composer.
export function createSshConnections(api: Pick<SshPlatform, "resolve">, defaultLabel = "SSH") {
  const entries = new Map<string, ReturnType<typeof connection>>()
  return (state: SshState | undefined, label = defaultLabel) => {
    const saved = (state?.servers ?? []).filter((item) => item.saved)
    const ids = new Set(saved.map((item) => item.config.id))
    entries.forEach((_, id) => {
      if (!ids.has(id)) entries.delete(id)
    })
    return saved.map((item) => {
      const existing = entries.get(item.config.id)
      if (existing) {
        existing.update(item, label)
        return existing.server
      }
      const entry = connection(item, api, label)
      entries.set(item.config.id, entry)
      return entry.server
    })
  }
}

function connection(item: SshItem, api: Pick<SshPlatform, "resolve">, label: string) {
  const [state, setState] = createStore({ current: item, label })
  return {
    update: (item: SshItem, label: string) => {
      setState("current", item)
      if (label !== state.label) setState("label", label)
    },
    server: {
      type: "ssh" as const,
      id: item.config.id,
      get stage() {
        return state.current.stage
      },
      get connecting() {
        return isSshConnecting(state.current.stage) || !!state.current.authenticatingElsewhere
      },
      get authenticationRequired() {
        return state.current.stage === "authentication" && !state.current.authenticatingElsewhere
      },
      get label() {
        return state.label
      },
      get host() {
        return sshHostname(state.current.config.target)
      },
      get displayName() {
        return sshName(state.current.config)
      },
      get http() {
        return state.current.http ?? { url: "http://127.0.0.1:0" }
      },
      reconnect: (signal: AbortSignal) =>
        Effect.runPromise(
          Effect.tryPromise(() => api.resolve(item.config.id)).pipe(
            Effect.repeat({ until: (http) => http !== null, schedule: Schedule.spaced(3000) }),
            Effect.flatMap((http) => (http === null ? Effect.interrupt : Effect.succeed(http))),
          ),
          { signal },
        ),
    },
  }
}
