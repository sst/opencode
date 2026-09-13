export interface DocsNavItem {
  title: string
  slug: string
}

export interface DocsNavGroup {
  title?: string
  items: DocsNavItem[]
}

export interface DocsSection {
  key: "docs" | "cli" | "build" | "api" | "console"
  title: string
  landingSlug: string
  groups: DocsNavGroup[]
}

export const docsSections: DocsSection[] = [
  {
    key: "docs",
    title: "Docs",
    landingSlug: "index",
    groups: [
      {
        items: [
          { title: "Intro", slug: "index" },
          { title: "Config", slug: "config" },
        ],
      },
      {
        title: "Configure",
        items: [
          { title: "Agents", slug: "agents" },
          { title: "Models", slug: "models" },
          { title: "Skills", slug: "skills" },
          { title: "Themes", slug: "themes" },
          { title: "Commands", slug: "commands" },
          { title: "Plugins", slug: "plugins" },
          { title: "Providers", slug: "providers" },
          { title: "Websearch", slug: "websearch" },
          { title: "Network", slug: "network" },
          { title: "Snapshots", slug: "snapshots" },
          { title: "Compaction", slug: "compaction" },
          { title: "Formatters", slug: "formatters" },
          { title: "References", slug: "references" },
          { title: "Attachments", slug: "attachments" },
          { title: "Tools", slug: "tools" },
          { title: "MCP servers", slug: "mcp-servers" },
          { title: "Permissions", slug: "permissions" },
          { title: "Instructions", slug: "instructions" },
          { title: "Sharing", slug: "sharing" },
          { title: "Warming", slug: "warming" },
        ],
      },
      {
        items: [
          { title: "Migrate from V1", slug: "migrate-v1" },
          { title: "Troubleshooting", slug: "troubleshooting" },
        ],
      },
    ],
  },
  {
    key: "cli",
    title: "CLI",
    landingSlug: "cli",
    groups: [
      {
        items: [
          { title: "Intro", slug: "cli" },
          { title: "TUI", slug: "cli/tui" },
          { title: "Config", slug: "cli/config" },
          { title: "Web", slug: "cli/web" },
          { title: "Providers", slug: "cli/providers" },
          { title: "Commands", slug: "cli/commands" },
          { title: "ACP", slug: "cli/acp" },
          { title: "Theme", slug: "cli/theme" },
          { title: "Plugins", slug: "cli/plugins" },
          { title: "Keybinds", slug: "cli/keybinds" },
        ],
      },
    ],
  },
  {
    key: "build",
    title: "Build",
    landingSlug: "build",
    groups: [
      {
        items: [{ title: "Intro", slug: "build" }],
      },
      {
        title: "Plugins",
        items: [
          { title: "Overview", slug: "build/plugins" },
          { title: "RPC", slug: "build/plugins/rpc" },
          { title: "CLI", slug: "build/plugins/cli" },
          { title: "Migrate from V1", slug: "build/plugins/migrate-v1" },
        ],
      },
      {
        title: "Client",
        items: [{ title: "JavaScript", slug: "build/client" }],
      },
      {
        title: "SDK",
        items: [
          { title: "Overview", slug: "build/sdk" },
          { title: "Cloudflare", slug: "build/sdk/cloudflare" },
        ],
      },
      {
        title: "Effect",
        items: [
          { title: "Plugins", slug: "build/plugins/effect" },
          { title: "RPC", slug: "build/plugins/effect/rpc" },
          { title: "Client", slug: "build/client/effect" },
          { title: "SDK", slug: "build/sdk/effect" },
        ],
      },
    ],
  },
  {
    key: "api",
    title: "API",
    landingSlug: "api",
    groups: [
      {
        title: "API",
        items: [{ title: "Overview", slug: "api" }],
      },
    ],
  },
  {
    key: "console",
    title: "Console",
    landingSlug: "console",
    groups: [
      {
        items: [
          { title: "Intro", slug: "console" },
          { title: "Models", slug: "console/models" },
          { title: "Websearch", slug: "console/websearch" },
          { title: "Go", slug: "console/go" },
        ],
      },
    ],
  },
]

export function docsHref(slug: string, anchor?: string) {
  const path = slug === "index" ? "" : `${slug.replace(/\/index$/, "")}/`
  return `${import.meta.env.BASE_URL}docs/${path}${anchor ? `#${anchor}` : ""}`
}

export function getDocsSection(slug: string) {
  return (
    docsSections.find((section) => section.groups.some((group) => group.items.some((item) => item.slug === slug))) ??
    docsSections[0]
  )
}
