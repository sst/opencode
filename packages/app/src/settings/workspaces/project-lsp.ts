import type { ConfigEntry } from "@opencode/client/promise"

type ConfiguredServer = { name: string; disabled: boolean; extensions: readonly string[] }

export function configuredLanguageServers(entries: readonly ConfigEntry[]) {
  const state = entries.reduce(
    (state, entry) => {
      if (entry.type !== "document" || entry.info.lsp === undefined) return state
      const config = entry.info.lsp
      // A boolean replaces the object form, so earlier named entries no longer apply.
      if (typeof config === "boolean") return { disabled: !config, servers: new Map<string, ConfiguredServer>() }
      Object.entries(config).forEach(([name, server]) => {
        const previous = state.servers.get(name)
        state.servers.set(name, {
          name,
          disabled: server.disabled ?? previous?.disabled ?? false,
          extensions: ("extensions" in server ? server.extensions : undefined) ?? previous?.extensions ?? [],
        })
      })
      return { disabled: false, servers: state.servers }
    },
    { disabled: false, servers: new Map<string, ConfiguredServer>() },
  )
  return {
    disabled: state.disabled,
    servers: [...state.servers.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }
}
