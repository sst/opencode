import fuzzysort from "fuzzysort"
import type { SettingsView } from "./surface"
import type { LocalProject } from "@/shell/state/layout"

export type SettingsSearchResult = {
  id: string
  title: string
  keywords: string
  description: string
  owner: string
  page: string
  server?: string
  project?: string
  projectName?: string
  projectInfo?: LocalProject
  entity?: boolean
  topLevel?: boolean
  view: SettingsView
}

export function rankSettings(query: string, items: SettingsSearchResult[], origin: SettingsView) {
  const value = normalize(query)
  if (!value) return []
  return items
    .flatMap((item) => {
      const name = item.projectName ? normalize(item.projectName) : undefined
      if (name && !` ${value} `.includes(` ${name} `)) return []
      const query = name ? normalize(` ${value} `.replace(` ${name} `, " ")) : value
      if (!query) return []
      const tokens = query.split(" ")
      const title = normalize(item.title)
      const primary = normalize(`${title} ${item.keywords}`)
      const description = normalize(item.description)
      const context = normalize(`${item.owner} ${item.entity ? "" : item.page}`)
      const fuzzy = fuzzysort.single(query, title)?.score ?? 0
      // Context qualifies a setting match; a project name alone should not return all its controls.
      if (!tokens.some((token) => `${primary} ${description}`.includes(token)) && fuzzy < 0.6) return []
      const score =
        title === query
          ? 5
          : tokens.every((token) => title.includes(token))
            ? 4
            : tokens.every((token) => primary.includes(token))
              ? 3
              : tokens.every((token) => `${primary} ${description} ${context}`.includes(token))
                ? 2
                : fuzzy >= 0.6
                  ? 1
                  : 0
      if (!score) return []
      const proximity =
        origin.type === "project" && origin.server === item.server && origin.project === item.project
          ? 2
          : origin.type !== "root" && origin.server === item.server
            ? 1
            : 0
      return [{ item, score, proximity }]
    })
    .sort(
      (a, b) =>
        Number(!!b.item.topLevel) - Number(!!a.item.topLevel) ||
        b.score - a.score ||
        b.proximity - a.proximity ||
        a.item.title.localeCompare(b.item.title),
    )
    .map((result) => result.item)
}

function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ")
}
