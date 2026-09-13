import { For } from "solid-js"
import { ServerHealthIndicator } from "./row"
import type { ServerHealth } from "@/runtime/server/health"

const states: { label: string; connecting?: boolean; authenticationRequired?: boolean; health?: ServerHealth }[] = [
  {
    label: "Authentication required (overrides failed health)",
    authenticationRequired: true,
    health: { healthy: false },
  },
  {
    label: "Authentication required (overrides pending health)",
    authenticationRequired: true,
    health: { healthy: false, checking: true },
  },
  { label: "Connecting (previous health check failed)", connecting: true, health: { healthy: false } },
  { label: "Tunnel ready, checking its new endpoint", health: { healthy: false, checking: true } },
  { label: "Connected", health: { healthy: true } },
  { label: "Failed", health: { healthy: false } },
  { label: "Incompatible", health: { healthy: false, incompatible: true } },
  { label: "Not checked" },
]

export default { title: "App/Servers/Health indicator", id: "app-server-health" }
export const States = {
  render: () => (
    <div class="flex flex-col gap-4">
      <For each={states}>
        {(state) => (
          <div class="flex items-center gap-2">
            <div class="flex size-4 shrink-0 items-center justify-center">
              <ServerHealthIndicator
                health={state.health}
                connecting={state.connecting}
                authenticationRequired={state.authenticationRequired}
              />
            </div>
            <span>{state.label}</span>
          </div>
        )}
      </For>
    </div>
  ),
}
