import { MemoryRouter, createMemoryHistory } from "@solidjs/router"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "../../src/app"
import { useLanguage, type Direction } from "../../src/runtime/i18n/language"
import { PlatformProvider } from "../../src/runtime/platform/platform"
import { createWebPlatform } from "../../src/runtime/platform/web"
import { ServerConnection } from "../../src/runtime/server/registry"

export function mount(input: { server: string; route: string; direction: Direction }) {
  const root = document.getElementById("root")
  if (!root) throw new Error("Missing fixture root")
  const history = createMemoryHistory()
  history.set({ value: input.route, replace: true, scroll: false })
  const server: ServerConnection.Http = { type: "http", http: { url: input.server } }

  function DirectedApp() {
    const language = useLanguage()
    language.setDirection(input.direction)
    return (
      <AppInterface
        servers={[server]}
        defaultServer={ServerConnection.key(server)}
        canonicalLocalServer={ServerConnection.key(server)}
        router={(props) => <MemoryRouter {...props} history={history} />}
      />
    )
  }

  render(
    () => (
      <PlatformProvider value={createWebPlatform("test").platform}>
        <AppBaseProviders locale="en">
          <DirectedApp />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
