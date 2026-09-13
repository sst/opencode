import { render } from "solid-js/web"
import { MemoryRouter } from "@solidjs/router"
import { AppBaseProviders, AppInterface } from "@/app"
import { PlatformProvider } from "@/runtime/platform/platform"
import { createBrowserDraftStore } from "@/runtime/persistence/drafts"
import { ServerConnection } from "@/runtime/server/registry"

// Exercise the real Desktop renderer with local browser/clipboard adapters and
// an HTTP fixture. No Electron service or account credentials are touched.
const params = new URLSearchParams(window.location.search)
const remote = params.get("server")
const local: ServerConnection.Any = {
  type: "sidecar",
  variant: "base",
  http: { url: "http://127.0.0.1:4096" },
}
const server: ServerConnection.Any = remote
  ? { type: "http", displayName: "Production server", http: { url: remote } }
  : local
const root = document.getElementById("root")
if (!root) throw new Error("Missing fixture root")
render(
  () => (
    <PlatformProvider
      value={{
        platform: "desktop",
        windowID: "console-auth-fixture",
        os: "linux",
        draftStore: createBrowserDraftStore(),
        openExternal: () => {},
        restart: async () => {},
        notify: async () => {},
        openDirectoryPickerDialog: async () => null,
        writeClipboardText: (text) => navigator.clipboard.writeText(text),
        openBrowser: async (url) => {
          if (params.has("browserFailed")) return false
          const browser = window.open("about:blank", "_blank")
          if (!browser) return false
          browser.opener = null
          browser.location.replace(url)
          return true
        },
      }}
    >
      <AppBaseProviders locale="en">
        <AppInterface
          servers={params.has("multipleServers") ? [local, server] : [server]}
          defaultServer={ServerConnection.key(server)}
          router={MemoryRouter}
        />
      </AppBaseProviders>
    </PlatformProvider>
  ),
  root,
)
