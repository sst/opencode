import type { ConfigEntry } from "@opencode/client"

export function configuredLsps(entries: readonly ConfigEntry[]) {
  return entries
    .reduce<string[]>((names, entry) => {
      if (entry.type !== "document" || entry.info.lsp === undefined) return names
      const lsp = entry.info.lsp
      if (typeof lsp === "boolean") return []
      return [
        ...names.filter((name) => !Object.hasOwn(lsp, name)),
        ...Object.entries(lsp)
          .filter(([, server]) => !server.disabled)
          .map(([name]) => name),
      ]
    }, [])
    .toSorted((a, b) => a.localeCompare(b))
}
