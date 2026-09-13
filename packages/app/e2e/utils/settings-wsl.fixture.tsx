import { MemoryRouter, createMemoryHistory } from "@solidjs/router"
import { createMemo, Show } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "../../src/app"
import { PlatformProvider, type Platform } from "../../src/runtime/platform/platform"
import { ServerConnection } from "../../src/runtime/server/registry"
import { useWslServers } from "../../src/servers/wsl/context"
import type { WslServersEvent, WslServersPlatform, WslServersState } from "../../src/servers/wsl/types"

export function mount(input: { server: string; mode: "failed" | "stopped" | "ready" }) {
  const root = document.getElementById("root")
  if (!root) throw new Error("Missing fixture root")
  const history = createMemoryHistory()
  history.set({ value: "/settings", replace: true, scroll: false })
  render(() => {
    const [store, setStore] = createStore<{ calls: string[]; state: WslServersState }>({
      calls: [],
      state: {
        runtime: { available: true, version: "2", error: null },
        installed: [],
        online: [],
        distroProbes: {},
        pendingRestart: false,
        job: null,
        servers: [
          {
            config: { id: "wsl:Ubuntu", distro: "Ubuntu" },
            runtime:
              input.mode === "ready"
                ? { kind: "ready", url: input.server, password: null }
                : input.mode === "failed"
                  ? { kind: "failed", message: "WSL failed to start" }
                  : { kind: "stopped" },
          },
        ],
        opencodeChecks: {
          Ubuntu: {
            distro: "Ubuntu",
            resolvedPath: "/usr/bin/opencode",
            version: "old",
            expectedVersion: "current",
            matchesDesktop: false,
            error: null,
          },
        },
      },
    })
    const listeners = new Set<(event: WslServersEvent) => void>()
    const publish = () =>
      listeners.forEach((listener) => listener({ type: "state", state: structuredClone(unwrap(store.state)) }))
    const unused = async () => {
      throw new Error("Unexpected fixture action")
    }
    const wsl: WslServersPlatform = {
      getState: async () => structuredClone(unwrap(store.state)),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      probeRuntime: unused,
      refreshDistros: unused,
      installWsl: unused,
      installDistro: unused,
      probeAddable: unused,
      openTerminal: unused,
      addServer: unused,
      async installOpencode(distro) {
        setStore("calls", (calls) => [...calls, `update:${distro}`])
        setStore("state", "opencodeChecks", distro, { version: "current", matchesDesktop: true })
        publish()
      },
      async startServer(id) {
        setStore("calls", (calls) => [...calls, `start:${id}`])
        setStore("state", "servers", (server) => server.config.id === id, "runtime", {
          kind: "ready",
          url: input.server,
          password: null,
        })
        publish()
      },
      async removeServer(id) {
        setStore("calls", (calls) => [...calls, `remove:${id}`])
        setStore("state", "servers", (servers) => servers.filter((server) => server.config.id !== id))
        publish()
      },
    }
    const platform: Platform = {
      platform: "desktop",
      os: "windows",
      windowID: "settings-wsl-test",
      openExternal: () => undefined,
      openDirectoryPickerDialog: async () => null,
      notify: async () => undefined,
      restart: unused,
      wslServers: wsl,
    }
    function Interface() {
      const wsl = useWslServers()
      const servers = createMemo<ServerConnection.Any[]>(() => [
        { type: "sidecar", variant: "base", displayName: "Local Server", http: { url: input.server } },
        ...(wsl.data?.servers ?? []).flatMap((item): ServerConnection.Any[] =>
          item.runtime.kind === "ready"
            ? [
                {
                  type: "sidecar",
                  variant: "wsl",
                  distro: item.config.distro,
                  displayName: item.config.distro,
                  http: { url: item.runtime.url },
                },
              ]
            : [],
        ),
      ])
      return (
        <Show when={wsl.data}>
          <AppInterface
            servers={servers()}
            defaultServer={ServerConnection.Key.make("sidecar")}
            router={(props) => <MemoryRouter {...props} history={history} />}
          />
        </Show>
      )
    }
    return (
      <PlatformProvider value={platform}>
        <AppBaseProviders locale="en">
          <output aria-label="WSL actions">{store.calls.join(",")}</output>
          <Interface />
        </AppBaseProviders>
      </PlatformProvider>
    )
  }, root)
}
