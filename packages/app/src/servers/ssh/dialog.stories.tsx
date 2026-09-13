import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { onCleanup, onMount, Show } from "solid-js"
import { PlatformProvider } from "@/runtime/platform/platform"
import { SshProvider, useSsh } from "./context"
import { useSshAuthenticate } from "./authenticate"
import { HomeProjectsView } from "@/home/projects/view"
import { ServerConnection } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { DialogSsh } from "./dialog"
import type { SshItem, SshPlatform, SshState } from "./types"
import { SshConnectionPanel } from "./connection-panel"
import { SshServerSettings } from "./settings"

function Fixture(props: {
  session?: boolean
  settings?: boolean
  incompatible?: boolean
  keyOnly?: boolean
  connectionDelay?: number
  initial?: "connecting" | "password" | "confirmation" | "failure" | "required"
  responseDelay?: number
}) {
  const state: { item?: SshItem; before?: SshItem; step: number; timer?: ReturnType<typeof setTimeout> } = {
    step: 0,
    item:
      props.initial === "required"
        ? {
            config: { id: "story", target: "ssh linuxbook", name: "" },
            stage: props.session || props.settings ? "disconnected" : "authentication",
            saved: true,
            detail: "",
          }
        : undefined,
  }
  onCleanup(() => clearTimeout(state.timer))
  const listeners = new Set<(state: SshState) => void>()
  const snapshot = (): SshState => ({ servers: state.item ? [state.item] : [] })
  const update = (changes: Partial<SshItem>) => {
    if (!state.item) return
    state.item = { ...state.item, ...changes }
    listeners.forEach((listener) => listener(snapshot()))
  }
  const prompts = [
    {
      id: "host-key",
      text: "The authenticity of host 'dev.example.com' can't be established.\nED25519 key fingerprint is SHA256:EXAMPLE-FINGERPRINT-FOR-STORY-ONLY.\nAre you sure you want to continue connecting?",
      confirm: true,
    },
    { id: "password", text: "brendon@dev.example.com's password:", confirm: false },
    { id: "otp", text: "Verification code:", confirm: false },
  ]
  const api: SshPlatform = {
    getState: async () => snapshot(),
    subscribe(callback) {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    hosts: async () => ["devbox", "staging", "build-host"],
    start: async (input) => {
      clearTimeout(state.timer)
      state.before = state.item
      state.step = props.initial === "password" || props.initial === "required" ? 1 : 0
      state.item = {
        config: input,
        saved: props.initial === "required",
        stage: "connecting",
        detail: "",
        destination: "brendon@dev.example.com:22",
      }
      if (props.initial === "connecting") return
      if (props.incompatible && !input.replace) {
        update({ stage: "incompatible", error: "version" })
        return
      }
      if (props.connectionDelay) {
        update({ stage: "connecting" })
        state.timer = setTimeout(
          () => update(props.keyOnly ? { stage: "ready" } : { stage: "authentication", prompt: prompts[state.step] }),
          props.connectionDelay,
        )
        return
      }
      update(
        props.initial === "failure"
          ? {
              stage: "failed",
              error: "connection",
              detail: "ssh: connect to host dev.example.com port 22: Connection refused",
            }
          : { stage: "authentication", prompt: prompts[state.step] },
      )
    },
    respond: async () => {
      const next = () => {
        state.step += 1
        update(
          state.step < prompts.length
            ? { stage: "authentication", prompt: prompts[state.step] }
            : { stage: "ready", prompt: undefined },
        )
      }
      if (!props.responseDelay) return next()
      update({ stage: "connecting", prompt: undefined })
      state.timer = setTimeout(next, props.responseDelay)
    },
    resolve: async () => null,
    disconnect: async () => {
      clearTimeout(state.timer)
      update({ stage: "disconnected", prompt: undefined })
    },
    cancel: async () => {
      if (state.item?.stage === "incompatible") return
      clearTimeout(state.timer)
      update({ ...state.before, stage: state.before?.stage ?? "disconnected", prompt: undefined })
    },
    forget: async () => {
      state.item = undefined
      listeners.forEach((listener) => listener(snapshot()))
    },
    openConfig: async () => {},
  }
  return (
    <PlatformProvider
      value={{
        platform: "desktop",
        windowID: "ssh-story",
        sshServers: api,
        openExternal() {},
        restart: async () => {},
        notify: async () => {},
        openDirectoryPickerDialog: async () => null,
      }}
    >
      <QueryClientProvider client={new QueryClient()}>
        <SshProvider>
          {props.settings ? (
            <AuthenticationSettings />
          ) : props.session ? (
            <AuthenticationSession />
          ) : props.initial === "required" ? (
            <AuthenticationHome />
          ) : (
            <Open initial={props.initial} />
          )}
        </SshProvider>
      </QueryClientProvider>
    </PlatformProvider>
  )
}

function AuthenticationSettings() {
  return (
    <div class="settings-servers" style={{ width: "min(100%, 480px)" }}>
      <SshServerSettings
        filter=""
        domain={{
          collection: { items: () => [], health: () => ({}) },
          defaults: { available: () => false, key: () => null, set: async () => {} },
          connection: {
            canRemove: () => false,
            remove: async () => {},
            canHide: () => false,
            isHidden: () => false,
            setHidden: () => {},
          },
        }}
      />
    </div>
  )
}

function AuthenticationSession() {
  const ssh = useSsh()
  return (
    <div style={{ height: "70vh" }}>
      <Show when={ssh.servers[0]}>
        {(item) => (
          <Show when={item().stage !== "ready"} fallback={<div>Session connected</div>}>
            <SshConnectionPanel
              item={item()}
              pending={ssh.pending(item().config.id)}
              onReconnect={() => ssh.connect(item().config)}
            />
          </Show>
        )}
      </Show>
    </div>
  )
}

function AuthenticationHome() {
  const language = useLanguage()
  const ssh = useSsh()
  const authenticate = useSshAuthenticate()
  const server: ServerConnection.Ssh = {
    type: "ssh",
    id: "story",
    host: "linuxbook",
    displayName: "linuxbook",
    label: "SSH",
    http: { url: "http://127.0.0.1:0" },
    get authenticationRequired() {
      return ssh.servers[0]?.stage === "authentication"
    },
    get connecting() {
      return ssh.servers[0]?.stage === "connecting"
    },
  }
  const projects = [{ worktree: "/home/user/project", expanded: true }]
  return (
    <div style={{ width: "min(100%, 340px)" }}>
      <HomeProjectsView
        dropdown
        language={language}
        servers={[server]}
        projects={projects}
        recentlyClosed={[]}
        selection={{ server: ServerConnection.key(server) }}
        homedir="/home/user"
        serverHealth={() => ({ healthy: ssh.servers[0]?.stage === "ready" })}
        projectsForServer={() => projects}
        collapsed={() => false}
        canDefaultServer={false}
        defaultServerKey={null}
        canRevealProject={() => false}
        unseenCount={() => 0}
        onWheel={() => {}}
        onChooseProject={(server) => {
          authenticate(server)
        }}
        onFocusServer={(server) => {
          authenticate(server)
        }}
        onAuthenticateServer={(server) => {
          authenticate(server)
        }}
        onToggleCollapsed={() => {}}
        onEditServer={() => {}}
        onSetDefaultServer={() => {}}
        canRemoveServer={() => false}
        onRemoveServer={() => {}}
        canHideServer={() => false}
        onHideServer={() => {}}
        onMoveProject={() => {}}
        onSelectProject={() => {}}
        onAddProjects={() => {}}
        onOpenProjectNewSession={() => {}}
        canImportSession={false}
        onImportSession={() => {}}
        onEditProject={() => {}}
        onRevealProject={() => {}}
        onClearNotifications={() => {}}
        onCloseProject={() => {}}
        onOpenSettings={() => {}}
        onOpenHelp={() => {}}
      />
    </div>
  )
}

function Open(props: { initial?: string }) {
  const dialog = useDialog()
  const open = () =>
    dialog.show(() => (
      <DialogSsh
        config={props.initial ? { id: "story", target: "devbox", name: "Development" } : undefined}
        connect={!!props.initial}
      />
    ))
  onMount(open)
  return <Button onClick={open}>Open SSH connection</Button>
}

export default { title: "App/Dialogs/SSH", id: "app-dialog-ssh" }
export const AuthenticationRequired = { render: () => <Fixture initial="required" /> }
export const SettingsReconnect = { render: () => <Fixture initial="required" settings connectionDelay={200} /> }
export const IncompatibleHost = { render: () => <Fixture incompatible /> }
export const IncompatibleSession = { render: () => <Fixture initial="required" session incompatible /> }
export const InactiveSession = { render: () => <Fixture initial="required" session connectionDelay={3000} /> }
export const KeyReconnect = { render: () => <Fixture initial="required" session keyOnly connectionDelay={3000} /> }
export const Host = { render: () => <Fixture /> }
export const Connecting = { render: () => <Fixture initial="connecting" /> }
export const Password = { render: () => <Fixture initial="password" /> }
export const SlowPassword = { render: () => <Fixture initial="password" responseDelay={5000} /> }
export const Confirmation = { render: () => <Fixture initial="confirmation" /> }
export const Failure = { render: () => <Fixture initial="failure" /> }
