import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/Projects/settings-demo"
const sandboxes = Array.from({ length: 12 }, (_, index) => `${directory}/workspace-${index + 1}`)

test.use({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" })

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_settings_demo",
      canonical: directory,
      name: "Settings demo",
      icon: {
        color: "orange",
        override:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='red'/%3E%3C/svg%3E",
      },
      commands: { start: "echo setup" },
      vcs: "git",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes,
    },
    provider: { all: [], connected: [], default: {} },
    preferences: { shell: "zsh", websearch: { provider: "exa" } },
    shells: [{ path: "/bin/zsh", name: "zsh", acceptable: true }],
    websearchProviders: [{ id: "exa", name: "Exa" }],
    sessions: sandboxes.map((directory, index) => ({
      id: `ses_settings_${index + 1}`,
      title: `Workspace ${index + 1} session`,
      directory,
      projectID: "proj_settings_demo",
      time: { created: 1700000000000, updated: 1700000000000 },
    })),
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] } }),
    )
  }, directory)
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByTestId("settings-screen").getByRole("tab", { name: "Preferences" })).toBeVisible()
})

test("settings has its own route and returns through app history", async ({ page }) => {
  const settings = page.getByTestId("settings-screen")
  const home = page.getByRole("button", { name: "Home", exact: true })
  await expect(page).toHaveURL("/settings")
  await expect(home).toHaveAttribute("aria-pressed", "false")
  await settings.getByRole("button", { name: "Back to app", exact: true }).click()
  await expect(page).toHaveURL("/")
  await expect(home).toHaveAttribute("aria-pressed", "true")
  await page.keyboard.press("Control+]")
  await expect(page).toHaveURL("/settings")
  await expect(settings.getByRole("tab", { name: "Preferences", exact: true })).toBeVisible()
  await expect(home).toHaveAttribute("aria-pressed", "false")
  await home.click()
  await expect(page).toHaveURL("/")
  await expect(settings).toBeHidden()
  await expect(home).toHaveAttribute("aria-pressed", "true")
})

test("single-server settings expose scoped pages without a server picker", async ({ page }) => {
  const settings = page.getByTestId("settings-screen")
  await expect(settings.getByRole("tab", { name: "Server", exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Servers", exact: true })).toHaveCount(0)

  for (const name of ["Projects", "Worktrees", "Providers", "Models", "Extensions"]) {
    await settings.getByRole("tab", { name, exact: true }).click()
    await expect(settings.locator('[data-action="settings-server-select"]')).toHaveCount(0)
  }

  await settings.getByRole("tab", { name: "Server", exact: true }).click()
  await expect(settings.getByRole("button", { name: "Add server", exact: true })).toBeVisible()
  await expect(settings.getByRole("heading", { name: "Connection", exact: true })).toBeVisible()
  await expect(settings.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible()
  await expect(settings.getByText("Terminal shell", { exact: true })).toBeVisible()
  await expect(settings.getByText("Third-party search", { exact: true })).toBeVisible()
  await expect(settings.getByText("zsh", { exact: true })).toBeVisible()
  await expect(settings.getByText("Exa", { exact: true })).toBeVisible()

  await settings.getByText("Exa", { exact: true }).click()
  const updated = page.waitForRequest(
    (request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/api/config/preferences",
  )
  await page.getByRole("option", { name: "Any", exact: true }).click()
  expect((await updated).postDataJSON()).toEqual({ websearch: { provider: "random" } })
})

test("server details tolerate unavailable preference endpoints", async ({ page }) => {
  await page.route(
    (url) =>
      url.pathname === "/api/config/preferences" ||
      url.pathname === "/api/config/shell" ||
      url.pathname === "/api/websearch/provider",
    (route) => route.fulfill({ status: 404, json: {} }),
  )
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Server", exact: true }).click()

  const connection = settings.locator('[data-component="settings-server-connection"]')
  await expect(connection.getByRole("heading", { name: "Connection", exact: true })).toBeVisible()
  await expect(connection.locator('[data-component="settings-list"]')).toHaveCSS("padding-left", "16px")
  await expect(connection.locator(".settings-servers-row")).toHaveCSS("padding-top", "20px")
  await expect(connection.locator(".settings-servers-lead")).toHaveCSS("column-gap", "4px")
  await expect(connection.locator(".settings-servers-copy")).toHaveCSS("row-gap", "6px")
  await expect(page.getByText("Server request failed", { exact: true })).toHaveCount(0)
})

test("project settings open as a nested autosaving view", async ({ page }) => {
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Projects", exact: true }).click()
  await settings.getByRole("button", { name: "Settings demo", exact: true }).click()

  await expect(settings.getByRole("button", { name: "Back to projects", exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Settings demo", exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Worktrees", exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Extensions", exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Scripts", exact: true })).toHaveCount(0)

  const name = settings.getByRole("textbox", { name: "Project name", exact: true })
  const saved = page.waitForRequest(
    (request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/api/project/proj_settings_demo",
  )
  await name.fill("Renamed project")
  await name.blur()
  expect((await saved).postDataJSON()).toEqual({ name: "Renamed project" })
  await expect(settings.getByRole("tab", { name: "Renamed project", exact: true })).toBeVisible()

  const startup = settings.getByRole("textbox", { name: "Worktree startup script", exact: true })
  const scriptSaved = page.waitForRequest(
    (request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/api/project/proj_settings_demo",
  )
  await startup.fill("bun install")
  await startup.blur()
  expect((await scriptSaved).postDataJSON()).toEqual({ commands: { start: "bun install" } })

  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await expect(settings.getByRole("heading", { name: "Worktrees", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(settings.getByRole("heading", { name: "Projects", exact: true })).toBeVisible()
})

test("clearing project fields sends explicit removal values", async ({ page }) => {
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Projects", exact: true }).click()
  await settings.getByRole("button", { name: "Settings demo", exact: true }).click()
  const startup = settings.getByRole("textbox", { name: "Worktree startup script", exact: true })
  await expect(startup).toHaveValue("echo setup")

  const scriptSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/project/proj_settings_demo",
  )
  await startup.clear()
  await startup.blur()
  const scriptResponse = await scriptSaved
  expect(scriptResponse.ok()).toBe(true)
  expect(scriptResponse.request().postDataJSON()).toEqual({ commands: { start: "" } })
  await expect(settings.locator('[aria-busy="true"]')).toHaveCount(0)

  const icon = settings.getByRole("button", { name: "Project icon", exact: true })
  await expect(icon.locator("img")).toHaveCount(1)
  const iconSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/project/proj_settings_demo",
  )
  await icon.hover()
  await icon.click()
  const iconResponse = await iconSaved
  expect(iconResponse.ok()).toBe(true)
  expect(iconResponse.request().postDataJSON()).toEqual({ icon: { color: "orange", override: "" } })
  await expect(settings.locator('[aria-busy="true"]')).toHaveCount(0)

  const color = settings.getByRole("button", { name: "Select orange color", exact: true })
  await expect(color).toHaveAttribute("aria-pressed", "true")
  const colorSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/project/proj_settings_demo",
  )
  await color.click()
  const colorResponse = await colorSaved
  expect(colorResponse.ok()).toBe(true)
  expect(colorResponse.request().postDataJSON()).toEqual({ icon: { color: "", override: "" } })
  await expect(settings.locator('[aria-busy="true"]')).toHaveCount(0)
})

test("new session shortcut leaves settings and opens a new session screen", async ({ page }) => {
  const settings = page.getByTestId("settings-screen")
  await expect(settings).toBeFocused()
  await page.keyboard.press("Control+t")

  await expect(page).toHaveURL(/\/new-session\?draftId=.+$/)
  await expect(settings).toBeHidden()
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
  await expect(page.locator('[data-titlebar-tab][data-active="true"]')).toHaveCount(1)
})

test("recording a new session shortcut stays in settings until recording finishes", async ({ page }) => {
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Shortcuts", exact: true }).click()
  const binding = settings.locator('[data-keybind-id="tab.new"]')
  await binding.click()
  await expect(binding).toHaveText("Press keys")
  await page.keyboard.press("Control+t")

  await expect(binding).toHaveText("Ctrl+T")
  await expect(page).toHaveURL("/settings")
  await expect(page.locator("[data-titlebar-tab]")).toHaveCount(0)
  await page.keyboard.press("Control+t")
  await expect(page).toHaveURL(/\/new-session\?draftId=.+$/)
  await expect(settings).toBeHidden()
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
})

test("workspaces opens without waiting for inventory or sessions", async ({ page }) => {
  const inventory = Promise.withResolvers<void>()
  const sessions = Promise.withResolvers<void>()
  await page.route(
    (url) => url.pathname === "/api/worktree",
    async (route) => {
      await inventory.promise
      await route.fallback()
    },
  )
  await page.route("**/api/session?*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("directory")) await sessions.promise
    await route.fallback()
  })
  const settings = page.getByTestId("settings-screen")
  const requested = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/worktree" &&
      new URL(request.url()).searchParams.get("location[directory]") === directory &&
      request.method() === "GET",
  )
  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await requested
  await expect(settings.getByRole("heading", { name: "Worktrees", exact: true })).toBeVisible()
  await expect(settings.getByRole("button", { name: "Back to app" })).toBeVisible()
  await expect(settings.getByText("No worktrees", { exact: true })).toHaveCount(0)

  inventory.resolve()
  await expect(settings.getByText(sandboxes[0], { exact: true })).toBeVisible()
  await expect(settings.getByText("12 worktrees", { exact: true })).toBeVisible()
  sessions.resolve()
  await expect(settings.getByText("Workspace 1 session", { exact: true })).toBeVisible()

  const refresh = Promise.withResolvers<void>()
  await page.route(
    (url) => url.pathname === "/api/worktree",
    async (route) => {
      await refresh.promise
      await route.fallback()
    },
  )
  await settings.getByRole("tab", { name: "Preferences", exact: true }).click()
  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await expect(settings.getByText("Workspace 1 session", { exact: true })).toBeVisible()
  refresh.resolve()
})

test("worktree deletion sends the project location separately from the target", async ({ page }) => {
  const removed = new Set<string>()
  await page.route(
    (url) => url.pathname === "/api/worktree",
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          json: [
            { directory },
            ...sandboxes.filter((item) => !removed.has(item)).map((directory) => ({ directory, strategy: "git" })),
          ],
        })
      }
      if (route.request().method() === "DELETE") {
        removed.add(route.request().postDataJSON().directory)
        return route.fulfill({ status: 204 })
      }
      return route.fallback()
    },
  )
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await expect(settings.getByText(sandboxes[0], { exact: true })).toBeVisible()
  await settings.getByRole("button", { name: "Delete “workspace-1”?", exact: true }).click()
  const confirmation = page.getByRole("dialog", { name: "Delete “workspace-1”?", exact: true })
  const remove = confirmation.getByRole("button", { name: "Delete worktree", exact: true })
  await expect(remove).toBeEnabled()
  const deleting = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/worktree" && request.method() === "DELETE",
  )
  await remove.click()
  const request = await deleting
  expect(new URL(request.url()).searchParams.get("location[directory]")).toBe(directory)
  expect(request.postDataJSON()).toEqual({ directory: sandboxes[0], force: true })
  await expect(settings.getByText(sandboxes[0], { exact: true })).toHaveCount(0)
  await expect(settings.getByText("11 worktrees", { exact: true })).toBeVisible()
})

test("extensions opens without waiting for MCPs", async ({ page }) => {
  const mcps = Promise.withResolvers<void>()
  await page.route("**/api/mcp", async (route) => {
    await mcps.promise
    await route.fulfill({
      json: { location: { directory }, data: [{ name: "demo-mcp", status: { status: "connected" } }] },
    })
  })
  const settings = page.getByTestId("settings-screen")
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/mcp")
  await settings.getByRole("tab", { name: "Extensions", exact: true }).click()
  await requested
  await expect(settings.getByRole("heading", { name: "Extensions", exact: true })).toBeVisible()
  await expect(settings.getByRole("button", { name: "Back to app" })).toBeVisible()
  mcps.resolve()
  await settings.getByRole("tab", { name: "MCPs", exact: true }).click()
  await expect(settings.getByRole("switch", { name: "demo-mcp" })).toBeChecked()
})

test("about opens without waiting for contributors", async ({ page }) => {
  const contributors = Promise.withResolvers<void>()
  const url = "https://api.github.com/repos/anomalyco/opencode/contributors?anon=1&per_page=1"
  await page.route(url, async (route) => {
    await contributors.promise
    await route.fulfill({
      json: [],
      headers: {
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "Link",
        Link: `<${url}&page=1004>; rel="last"`,
      },
    })
  })
  const settings = page.getByTestId("settings-screen")
  const requested = page.waitForRequest(url)
  await settings.getByRole("tab", { name: "About", exact: true }).click()
  await requested
  await expect(settings.getByRole("tab", { name: "About", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(settings.getByText("Released under the MIT License", { exact: true })).toBeVisible()
  await expect(settings.getByText(/^Version /)).toBeVisible()
  await expect(settings.getByText("OpenCode Desktop", { exact: true })).toHaveCount(0)
  await expect(settings.getByText(/^v\d+\./)).toHaveCount(0)
  await expect(settings.getByRole("link", { name: "935 others", exact: true })).toBeVisible()
  await expect(settings.getByRole("button", { name: "Back to app" })).toBeVisible()

  await settings.getByRole("tab", { name: "Preferences", exact: true }).click()
  await expect(settings.getByRole("tab", { name: "Preferences", exact: true })).toHaveAttribute("aria-selected", "true")
  await settings.getByRole("tab", { name: "About", exact: true }).click()
  await expect(settings.getByRole("link", { name: "935 others", exact: true })).toBeVisible()

  const website = settings.getByRole("link", { name: "www.opencode.ai", exact: true })
  await website.focus()
  contributors.resolve()
  await expect(settings.getByRole("link", { name: "988 others", exact: true })).toBeVisible()
  await expect(website).toBeFocused()
})

test("about is available in the mobile settings menu", async ({ page }) => {
  await page.route("https://api.github.com/repos/anomalyco/opencode/contributors?*", (route) => route.abort("failed"))
  await page.setViewportSize({ width: 390, height: 844 })
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("button", { name: "Preferences", exact: true }).click()
  await page.getByRole("menuitemradio", { name: "About", exact: true }).click()
  await expect(settings.getByRole("button", { name: "About", exact: true })).toBeVisible()
  await expect(settings.getByText("Released under the MIT License", { exact: true })).toBeVisible()
  await expect(settings.getByRole("link", { name: "935 others", exact: true })).toBeVisible()
  await expect(settings.getByText("OpenCode Desktop", { exact: true })).toHaveCount(0)
  await settings.getByRole("button", { name: "About", exact: true }).click()
  await expect(page.getByRole("menuitemradio", { name: "About", exact: true })).toBeChecked()
})

test("about keeps its fallback when the contributor request fails", async ({ page }) => {
  const contributors = Promise.withResolvers<void>()
  const url = "https://api.github.com/repos/anomalyco/opencode/contributors?anon=1&per_page=1"
  await page.route(url, async (route) => {
    await contributors.promise
    await route.abort("failed")
  })
  const settings = page.getByTestId("settings-screen")
  const requested = page.waitForRequest(url)
  await settings.getByRole("tab", { name: "About", exact: true }).click()
  await requested
  await expect(settings.getByRole("link", { name: "935 others", exact: true })).toBeVisible()

  const failed = page.waitForEvent("requestfailed", (request) => request.url() === url)
  contributors.resolve()
  await failed
  await expect(settings.getByRole("link", { name: "935 others", exact: true })).toBeVisible()
  await expect(settings.getByText("Released under the MIT License", { exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "About", exact: true })).toHaveAttribute("aria-selected", "true")
})

test("workspace inventory uses the settings panel scroll area", async ({ page }) => {
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await expect(settings.getByText("Workspace 1 session", { exact: true })).toBeVisible()
  const list = settings.locator('[data-component="settings-list"]')
  await expect(list).toHaveCSS("max-height", "none")
  await expect(list).toHaveCSS("overflow-y", "visible")
  await settings.getByText("Workspace 12 session", { exact: true }).scrollIntoViewIfNeeded()
  await expect(settings.getByText("Workspace 12 session", { exact: true })).toBeInViewport()
  await expect(settings.getByRole("button", { name: "Back to app" })).toBeInViewport()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(list).toHaveCSS("max-height", "none")
  await expect(list).toHaveCSS("overflow-y", "visible")
  await settings.getByText("Workspace 12 session", { exact: true }).scrollIntoViewIfNeeded()
  await expect(settings.getByText("Workspace 12 session", { exact: true })).toBeInViewport()
})
