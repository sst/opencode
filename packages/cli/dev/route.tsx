import { createEffect, on, type ComponentProps } from "solid-js"
import { unwrap } from "solid-js/store"
import { host } from "@opencode/cli/vite-host"
import { RouteProvider, useRoute } from "../../tui/src/context/route"

export {
  useRoute,
  useRouteData,
  type Route,
  type HomeRoute,
  type SessionRoute,
  type PluginRoute,
} from "../../tui/src/context/route"
export { ReloadableRouteProvider as RouteProvider }

function ReloadableRouteProvider(props: ComponentProps<typeof RouteProvider>) {
  return (
    <RouteProvider {...props} initialRoute={host.route ?? props.initialRoute}>
      <RememberRoute />
      {props.children}
    </RouteProvider>
  )
}

function RememberRoute() {
  const route = useRoute()
  createEffect(
    on(
      () => JSON.stringify(route.data),
      () => {
        // A route's prompt is a one-shot handoff, not a composer draft.
        const value = structuredClone(unwrap({ ...route.data }))
        host.route =
          value.type === "home"
            ? { type: "home", location: value.location }
            : value.type === "session"
              ? { type: "session", sessionID: value.sessionID }
              : value
      },
    ),
  )
  return null
}
