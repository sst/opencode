import { describe, expect, test } from "bun:test"
import { dict } from "@opencode/ui/i18n/en"
import en from "@/runtime/i18n/en"
import { settingsSearchIndex, type SettingsSearchServer } from "./search-index"
import { rankSettings } from "./search-results"
import type { SettingsView } from "./surface"

const strings: Record<string, string> = { ...dict, ...en }
const project = { id: "proj_opencode", name: "OpenCode", worktree: "/projects/opencode", expanded: false }
const servers: SettingsSearchServer[] = [
  { key: "local", name: "Local server", connected: true, projects: [project] },
  { key: "remote", name: "Build server", connected: true, projects: [project] },
]
const root: SettingsView = { type: "root", tab: "general" }

function index(input: Partial<Parameters<typeof settingsSearchIndex>[0]> = {}) {
  return settingsSearchIndex({
    servers,
    desktop: false,
    browser: false,
    dev: false,
    mobile: false,
    translate: (key) => strings[key],
    ...input,
  })
}

describe("settings search index", () => {
  test("uses concrete server identity and adapts single-server destinations", () => {
    const multi = rankSettings("models", index(), root).filter((item) => item.topLevel)
    expect(multi.map((item) => item.view)).toEqual([
      { type: "server", server: "local", tab: "models", target: undefined, subtab: undefined },
      { type: "server", server: "remote", tab: "models", target: undefined, subtab: undefined },
    ])
    const single = rankSettings("models", index({ servers: [servers[0]] }), root).find((item) => item.topLevel)!
    expect(single.server).toBe("local")
    expect(single.view).toEqual({ type: "root", tab: "models", target: undefined, subtab: undefined })
  })

  test("keeps unavailable servers discoverable without advertising unloaded settings", () => {
    const items = index({ servers: [{ ...servers[0], connected: false }] })
    expect(items.filter((item) => item.server).map((item) => item.id)).toEqual(["server:local"])
    expect(rankSettings("Local server", items, root)[0].view).toEqual({
      type: "root",
      tab: "servers",
      target: undefined,
      subtab: undefined,
    })
    expect(rankSettings("font", items, root)).toHaveLength(3)
  })

  test("only advertises settings supported by this platform and channel", () => {
    const targets = (input: Parameters<typeof index>[0]) => index(input).map((item) => item.view.target)
    expect(targets({})).not.toContain("settings-pinch-zoom")
    expect(targets({})).not.toContain("settings-experimental-browser")
    expect(targets({})).not.toContain("settings-show-project-icon")
    expect(targets({ desktop: true })).toContain("settings-pinch-zoom")
    expect(targets({ browser: true })).toContain("settings-experimental-browser")
    expect(targets({ dev: true })).toContain("settings-show-project-icon")
    expect(targets({ dev: true })).not.toContain("settings-mobile-titlebar-bottom")
    expect(targets({ dev: true, mobile: true })).toContain("settings-mobile-titlebar-bottom")
  })

  test("uses section labels and stable identities independent of translated text", () => {
    const items = index()
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length)
    expect(index({ translate: (key) => `translated ${strings[key]}` }).map((item) => item.id)).toEqual(
      items.map((item) => item.id),
    )
    expect(
      rankSettings("agent", items, root)
        .filter((item) => item.title === "Agent")
        .map((item) => item.page),
    ).toEqual(["Desktop notifications", "Sound effects"])
    expect(rankSettings("terminal placement", items, root)[0].page).toBe("Preferences / General")
    expect(items.some((item) => item.view.target === "settings-project-startup")).toBe(false)
  })

  test("retains project avatars and excludes color when a custom icon owns its appearance", () => {
    const withIcon = { ...project, icon: { color: "orange", override: "data:image/png;base64,example" } }
    const items = index({ servers: [{ ...servers[0], projects: [withIcon] }] })
    expect(rankSettings("opencode", items, root)[0].projectInfo).toEqual(withIcon)
    expect(rankSettings("opencode color", items, root)).toEqual([])
  })
})

describe("settings search ranking", () => {
  test("prioritizes top-level pages and omits generic project-setting copies", () => {
    expect(rankSettings("work", index({ servers: [servers[0]] }), root).map((item) => item.title)).toEqual([
      "Worktrees",
      "Default environment",
    ])
    expect(rankSettings("mcps", index(), root).map((item) => item.view.type)).toEqual(["server", "server"])
    expect(rankSettings("project name", index(), root).map((item) => item.title)).toEqual(["Show project names"])
    expect(rankSettings("startup", index(), root)).toEqual([])
  })

  test("qualifies project settings by project name and supports explicit server names", () => {
    const matches = rankSettings("opencode name", index(), root)
    expect(matches.map((item) => item.view.target)).toEqual(["settings-project-name", "settings-project-name"])
    expect(rankSettings("Build server opencode name", index(), root).map((item) => item.server)).toEqual(["remote"])
    expect(rankSettings("opencode skills", index(), root).map((item) => item.view.subtab)).toEqual(["skills", "skills"])
  })

  test("project names alone find projects, including names that are setting labels", () => {
    const items = index({ servers: [{ ...servers[0], projects: [{ ...project, name: "Skills" }] }] })
    expect(
      rankSettings("skills", items, root)
        .filter((item) => item.project)
        .map((item) => item.entity),
    ).toEqual([true])
    expect(rankSettings("opencode", index(), root).map((item) => item.entity)).toEqual([true, true])
  })

  test("normalizes whitespace, case, and Unicode in qualified names", () => {
    const items = index({ servers: [{ ...servers[0], projects: [{ ...project, name: "Open Code" }] }] })
    expect(rankSettings("  ＯＰＥＮ   ＣＯＤＥ   name  ", items, root).map((item) => item.view.target)).toEqual([
      "settings-project-name",
    ])
  })

  test("does not search paths or use the Projects category to match unrelated names", () => {
    const items = index({ servers: [{ ...servers[0], projects: [{ ...project, name: "codename" }] }] })
    expect(rankSettings("project name", items, root).some((item) => item.project)).toBe(false)
    expect(rankSettings("/projects/opencode", items, root)).toEqual([])
  })

  test("ranks equivalent matches by origin without merging different servers", () => {
    const origin: SettingsView = {
      type: "project",
      server: "remote",
      project: project.worktree,
      tab: "general",
      parent: "server",
    }
    expect(rankSettings("opencode name", index(), origin).map((item) => item.server)).toEqual(["remote", "local"])
  })

  test("supports synonyms and fuzzy title matches while rejecting unrelated queries", () => {
    expect(rankSettings("dark mode", index(), root)[0].view.target).toBe("settings-color-scheme")
    expect(rankSettings("termfont", index(), root)[0].title).toBe("Terminal Font")
    expect(rankSettings("  ", index(), root)).toEqual([])
    expect(rankSettings("zzzzzzzzz", index(), root)).toEqual([])
  })
})
