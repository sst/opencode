import type { IconProps } from "@opencode/ui/icon"
import type { useLanguage } from "@/runtime/i18n/language"
import type { SettingsRootTab } from "./surface"

export const pageIcons = {
  general: "sliders",
  appearance: "appearance",
  notifications: "notifications",
  shortcuts: "keyboard",
  projects: "folder",
  workspaces: "outline-worktree",
  providers: "providers",
  models: "models",
  extensions: "extensions",
  servers: "server",
  experimental: "flask",
  about: "info",
} as const satisfies Record<SettingsRootTab, IconProps["name"]>

export const pageLabels = {
  general: "settings.tab.preferences",
  appearance: "settings.general.section.appearance",
  notifications: "settings.tab.notifications",
  shortcuts: "settings.shortcuts.title",
  projects: "settings.tab.projects",
  workspaces: "settings.tab.workspaces",
  providers: "settings.providers.title",
  models: "settings.models.title",
  extensions: "settings.tab.extensions",
  servers: "settings.section.server",
  experimental: "settings.tab.experimental",
  about: "settings.tab.about",
} as const satisfies Record<SettingsRootTab, Parameters<ReturnType<typeof useLanguage>["t"]>[0]>
