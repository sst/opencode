import { expect, test, type Page } from "@playwright/test"
import en from "../../src/runtime/i18n/en"
import { clientSettings } from "../../src/settings/search-catalog"
import { createMockServerHandler, mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"

const directory = "/projects/opencode"
const config = {
  directory,
  project: {
    id: "proj_search",
    canonical: directory,
    name: "OpenCode",
    icon: { color: "orange" },
    vcs: "git",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  },
  provider: { all: [], connected: [], default: {} },
  sessions: [],
  pageMessages: () => ({ items: [] }),
}

function projectList(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...config.project,
    id: `proj_search_${index}`,
    canonical: `${directory}-${index}`,
    name: `OpenCode ${String(index).padStart(2, "0")}`,
  }))
}

function ui(page: Page) {
  const settings = page.getByTestId("settings-screen")
  return {
    settings,
    search: settings.getByRole("combobox", { name: "Search", exact: true }),
    results: settings.getByRole("listbox", { name: "Settings results", exact: true }),
    viewport: settings.locator(".settings-search-scroll > .scroll-view__viewport"),
  }
}

async function findShortcut(page: Page) {
  // Browser emulation can report a different OS than the machine running Playwright.
  const key = await page.evaluate(() => (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta+f" : "Control+f"))
  await page.keyboard.press(key)
}

test.use({ viewport: { width: 1280, height: 900 } })
test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, config)
  await page.route("https://api.github.com/**", (route) => route.fulfill({ json: [] }))
  await page.goto("/")
  if ((page.viewportSize()?.width ?? 1280) < 800) await page.getByRole("button", { name: "Tabs", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const view = ui(page)
  await expect(view.settings).toBeFocused()
  // Readiness includes the server-backed project inventory, not just the settings shell.
  await view.search.fill("OpenCode")
  await expect(view.results.getByRole("option")).toHaveCount(1)
  await view.search.clear()
})

test("pointer selection, keyboard navigation, and local find shortcut", async ({ page }) => {
  const view = ui(page)
  await view.search.fill("font")
  const code = view.results.getByRole("option", { name: "Code Font, Appearance", exact: true })
  const terminal = view.results.getByRole("option", { name: "Terminal Font, Appearance", exact: true })
  const font = view.results.getByRole("option", { name: "UI Font, Appearance", exact: true })
  await expect(view.results.getByRole("option")).toHaveText([
    "Code FontAppearance",
    "Terminal FontAppearance",
    "UI FontAppearance",
  ])
  await code.click()
  await expect(code).toBeFocused()
  await expect(view.settings.getByRole("textbox", { name: "Code Font", exact: true })).toBeInViewport()
  await code.press("ArrowDown")
  await expect(terminal).toBeFocused()
  await expect(terminal).toHaveAttribute("aria-selected", "true")
  await terminal.press("Enter")
  await expect(terminal).toBeFocused()
  await expect(view.settings.getByRole("textbox", { name: "Terminal Font", exact: true })).toBeInViewport()
  await terminal.press("End")
  await expect(font).toBeFocused()
  await font.press("Home")
  await expect(code).toBeFocused()
  await terminal.focus()
  await expect(terminal).toHaveAttribute("aria-selected", "true")
  await terminal.press("Enter")
  await expect(view.settings.locator('[data-search-target="row"]')).toContainText("Terminal Font")
  await findShortcut(page)
  await expect(view.search).toBeFocused()
  expect(await view.search.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([
    0, 4,
  ])
  await view.settings.getByRole("button", { name: "Back to app", exact: true }).click()
  await expect(view.settings).toBeHidden()
  await findShortcut(page)
  await expect(page.getByRole("textbox", { name: /Search sessions/ })).toBeFocused()
})

test("page priority, compact icons, section context, and the minimal empty state", async ({ page }) => {
  const view = ui(page)
  await view.search.fill("work")
  await expect(view.results.getByRole("option")).toHaveText(["Worktrees", "Default environmentPreferences / General"])
  const pageResult = view.results.getByRole("option", { name: /^Worktrees,/ })
  await expect(pageResult).toHaveCSS("height", "28px")
  await expect(pageResult.locator("svg")).toHaveCount(1)
  await expect(view.settings.getByText("App settings", { exact: true })).toHaveCount(0)
  await view.search.fill("Agent")
  await expect(view.results.getByRole("option", { name: "Agent, Desktop notifications", exact: true })).toHaveText(
    "AgentDesktop notifications",
  )
  await expect(view.results.getByRole("option", { name: "Agent, Sound effects", exact: true })).toHaveText(
    "AgentSound effects",
  )
  await view.search.fill("zzzzzzzzzz")
  await expect(view.results.getByRole("option")).toHaveCount(0)
  await expect(view.settings.getByRole("status")).toHaveText('No results for "zzzzzzzzzz"')
  await expect(view.settings.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible()
  await view.search.press("Escape")
  await expect(view.search).toHaveValue("")
  await expect(view.settings.getByRole("tab", { name: "Preferences", exact: true })).toBeVisible()
})

test("empty queries keep the closing quote beside the ellipsis while typing and resizing", async ({ page }) => {
  const view = ui(page)
  const query = "zzzz 🧑🏽‍💻 ".repeat(40)
  await view.search.fill(query)
  const status = view.settings.getByRole("status")
  const quoted = status.locator("bdi")
  await expect(status).toHaveAccessibleName(`No results for "${query}"`)
  await expect(quoted).toHaveText(/^".+…"$/)
  await expect(status).toHaveCSS("height", "28px")
  await expect
    .poll(() =>
      quoted.evaluate((element) => element.getBoundingClientRect().width <= element.parentElement!.clientWidth),
    )
    .toBe(true)

  const text = await quoted.textContent()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(quoted).toHaveText(/^".+…"$/)
  await expect(quoted).not.toHaveText(text!)
  await expect
    .poll(() =>
      quoted.evaluate((element) => element.getBoundingClientRect().width <= element.parentElement!.clientWidth),
    )
    .toBe(true)
  expect(await view.settings.evaluate((root) => root.scrollWidth <= root.clientWidth)).toBe(true)

  await view.search.fill("zzzzzzzzzz")
  await expect(status).toHaveText('No results for "zzzzzzzzzz"')
  await view.search.pressSequentially("x")
  await expect(status).toHaveText('No results for "zzzzzzzzzzx"')
})

test("Models and Shortcuts autofocus their filters on normal navigation", async ({ page }) => {
  const view = ui(page)
  for (const entry of [
    { tab: "Models", search: "Search models" },
    { tab: "Shortcuts", search: "Search shortcuts" },
    { tab: "Models", search: "Search models" },
  ]) {
    await view.settings.getByRole("tab", { name: entry.tab, exact: true }).click()
    await expect(view.settings.getByRole("searchbox", { name: entry.search, exact: true })).toBeFocused()
  }
  await view.search.fill("shortcuts")
  const result = view.results.getByRole("option", { name: "Keyboard shortcuts", exact: true })
  await result.click()
  await expect(result).toBeFocused()
})

for (const count of [7, 8]) {
  test(`Projects search uses the full list threshold with ${count} projects`, async ({ page }) => {
    await page.route("**/api/project", (route) => route.fulfill({ json: projectList(count) }))
    await page.reload()
    const view = ui(page)
    await view.search.fill("OpenCode")
    await expect(view.results.getByRole("option")).toHaveCount(count)
    await view.search.clear()
    await view.settings.getByRole("tab", { name: "Projects", exact: true }).click()
    const search = view.settings.getByRole("searchbox", { name: "Search projects", exact: true })
    const projects = view.settings.getByRole("button", { name: /^OpenCode / })
    await expect(projects).toHaveCount(count)
    if (count === 7) {
      await expect(search).toHaveCount(0)
      return
    }
    await expect(search).toBeFocused()
    await search.fill("  CODE 06  ")
    await expect(projects).toHaveCount(1)
    await expect(projects).toHaveAccessibleName("OpenCode 06")
    await expect(search).toBeVisible()
    await search.fill("missing-project")
    await expect(projects).toHaveCount(0)
    await expect(view.settings.getByText("No projects found", { exact: true })).toBeVisible()
    await view.settings.getByRole("button", { name: "Clear", exact: true }).click()
    await expect(search).toBeFocused()
    await expect(projects).toHaveCount(count)
    await view.settings.getByRole("tab", { name: "Models", exact: true }).click()
    await view.settings.getByRole("tab", { name: "Projects", exact: true }).click()
    await expect(search).toBeFocused()
    await search.fill("OpenCode 06")
    await projects.click()
    await expect(view.settings.getByRole("heading", { name: "OpenCode 06", exact: true })).toBeVisible()
  })
}

test("Projects search focuses when the qualifying inventory arrives after opening", async ({ page }) => {
  const inventory = Promise.withResolvers<void>()
  await page.route("**/api/project", async (route) => {
    await inventory.promise
    await route.fulfill({ json: projectList(8) })
  })
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/project")
  await page.reload()
  await requested
  const view = ui(page)
  const search = view.settings.getByRole("searchbox", { name: "Search projects", exact: true })
  try {
    await view.settings.getByRole("tab", { name: "Projects", exact: true }).click()
    await expect(view.settings.getByRole("heading", { name: "Projects", exact: true })).toBeVisible()
    await expect(search).toHaveCount(0)
  } finally {
    inventory.resolve()
  }
  await expect(search).toBeFocused()
  await expect(view.settings.getByRole("button", { name: /^OpenCode / })).toHaveCount(8)
})

test("all indexed client controls resolve to visible production controls", async ({ page }) => {
  const view = ui(page)
  for (const entry of clientSettings.filter((entry) => entry.target && !entry.available)) {
    await view.search.fill(en[entry.label as keyof typeof en])
    const result = view.results.locator(`[data-setting-target="${entry.target}"]`)
    await expect(result).toHaveCount(1)
    await result.click()
    await expect(view.settings.locator(`[data-action="${entry.target}"]`)).toBeInViewport()
  }
})

test("qualified project results preserve query and selection on return", async ({ page }) => {
  const view = ui(page)
  await view.search.fill("project name")
  await expect(view.results.locator('[data-setting-target="settings-project-name"]')).toHaveCount(0)
  await view.search.fill("OpenCode")
  const project = view.results.getByRole("option")
  await expect(project).toHaveText("OOpenCode")
  await expect(project.locator('[data-component="project-avatar-v2"]')).toHaveCSS("width", "16px")
  await expect(view.settings.locator(".settings-search-group")).toHaveCount(0)
  await view.search.fill("OpenCode name")
  const name = view.results.getByRole("option")
  await expect(name).toHaveText("Project nameGeneral")
  await name.click()
  await expect(view.search).toHaveCount(0)
  await expect(view.settings.getByRole("button", { name: "Back to settings", exact: true })).toBeVisible()
  await expect(view.settings.getByRole("heading", { name: "OpenCode", exact: true })).toHaveCSS("line-height", "20px")
  await expect(view.settings.getByRole("textbox", { name: "Project name", exact: true })).toHaveValue("OpenCode")
  await page.keyboard.press("Escape")
  await expect(view.search).toBeFocused()
  await expect(view.search).toHaveValue("OpenCode name")
  await expect(name).toHaveAttribute("aria-selected", "true")
})

test("returning from a project restores a scrolled result list", async ({ page }) => {
  await page.route("**/api/project", (route) =>
    route.fulfill({
      json: projectList(30),
    }),
  )
  await page.reload()
  const view = ui(page)
  await view.search.fill("OpenCode")
  await expect(view.results.getByRole("option")).toHaveCount(30)
  const scrollbar = view.settings.locator('.settings-search-scroll > .scroll-view__thumb[data-orientation="vertical"]')
  await view.viewport.hover()
  await expect(scrollbar).toHaveAttribute("data-visible", "true")
  const bounds = (await scrollbar.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await expect(scrollbar).toHaveAttribute("data-dragging", "true")
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 80, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => view.viewport.evaluate((list) => list.scrollTop)).toBeGreaterThan(0)
  const project = view.results.getByRole("option", { name: /^OpenCode 25,/ })
  await project.scrollIntoViewIfNeeded()
  await expect.poll(() => view.viewport.evaluate((list) => list.scrollTop)).toBeGreaterThan(0)
  const scroll = await view.viewport.evaluate((list) => list.scrollTop)
  await project.click()
  await expect(view.settings.getByRole("heading", { name: "OpenCode 25", exact: true })).toBeVisible()
  await view.settings.getByRole("button", { name: "Back to settings", exact: true }).click()
  await expect(view.search).toBeFocused()
  await expect(project).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => view.viewport.evaluate((list) => list.scrollTop)).toBe(scroll)
  await view.search.fill("about")
  await expect(view.results.getByRole("option", { name: "About", exact: true })).toBeVisible()
  await expect(scrollbar).toHaveCount(0)
})

test("IME confirmation does not activate a search result", async ({ page }) => {
  const view = ui(page)
  await view.search.fill("font")
  await expect(view.results.getByRole("option")).toHaveCount(3)
  await view.search.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })
  await expect(view.settings.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible()
  await view.search.press("Enter")
  await expect(view.settings.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible()
})

test("header highlight runs once per search activation and finishes cleanly", async ({ page }) => {
  const view = ui(page)
  await view.settings.evaluate((root) => {
    root.setAttribute("data-search-flashes", "0")
    root.addEventListener("animationstart", (event) => {
      if (!(event instanceof AnimationEvent) || event.animationName !== "settings-search-reveal") return
      root.setAttribute("data-search-flashes", String(Number(root.getAttribute("data-search-flashes")) + 1))
    })
  })
  await view.search.fill("skills")
  await view.results.getByRole("option").click()
  await expect(view.settings.getByRole("tab", { name: "Skills", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(view.settings).toHaveAttribute("data-search-flashes", "1")
  await view.settings.evaluate(async (root) => {
    await Promise.all(
      root
        .getAnimations({ subtree: true })
        .filter(
          (animation) => animation instanceof CSSAnimation && animation.animationName === "settings-search-reveal",
        )
        .map((animation) => animation.finished),
    )
  })
  await expect(view.settings.locator("[data-search-target]")).toHaveCount(0)
  for (const tab of ["MCPs", "Plugins", "Skills"]) {
    await view.settings.getByRole("tab", { name: tab, exact: true }).click()
    await expect(view.settings.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("aria-selected", "true")
    await expect(view.settings.locator("[data-search-target]")).toHaveCount(0)
  }
  await expect(view.settings).toHaveAttribute("data-search-flashes", "1")
  await view.results.getByRole("option").click()
  await expect(view.settings).toHaveAttribute("data-search-flashes", "2")
  await view.search.fill("about")
  await view.results.getByRole("option", { name: "About", exact: true }).click()
  await expect(view.settings.getByText("Released under the MIT License", { exact: true })).toBeVisible()
  await expect(view.settings).toHaveAttribute("data-search-flashes", "3")
})

test("multi-server results navigate to the named server and hide search in nested views", async ({ page }) => {
  const server = "http://127.0.0.1:4097"
  const remote = createMockServerHandler({
    ...config,
    directory: "/remote/opencode",
    project: { ...config.project, canonical: "/remote/opencode" },
  })
  page.on("close", () => void remote.dispose())
  await installSseTransport(page, { server })
  await page.route(`${server}/api/**`, async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" },
      })
    const response = await remote.handler(
      new Request(route.request().url(), { method: route.request().method(), headers: route.request().headers() }),
    )
    await route.fulfill({
      status: response.status,
      headers: { ...Object.fromEntries(response.headers), "access-control-allow-origin": "*" },
      body: Buffer.from(await response.arrayBuffer()),
    })
  })
  await page.addInitScript(
    (server) =>
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ list: [{ type: "http", displayName: "Build server", http: { url: server } }] }),
      ),
    server,
  )
  await page.reload()
  const view = ui(page)
  await view.search.fill("MCPs")
  await expect(view.results.getByRole("option")).toHaveCount(2)
  await view.results.getByRole("option", { name: "MCPs, Build server, Extensions", exact: true }).click()
  await expect(view.search).toHaveCount(0)
  await expect(view.settings.getByRole("tab", { name: "Build server", exact: true })).toBeVisible()
  await expect(view.settings.getByRole("tab", { name: "MCPs", exact: true })).toHaveAttribute("aria-selected", "true")
  await view.settings.getByRole("button", { name: "Back to settings", exact: true }).click()
  await expect(view.search).toHaveValue("MCPs")
  await view.search.fill("Build server models")
  await view.results.getByRole("option").click()
  await expect(view.settings.getByRole("searchbox", { name: "Search models", exact: true })).toBeFocused()
  await view.settings.getByRole("button", { name: "Back to settings", exact: true }).click()
  await view.search.fill("Build server OpenCode name")
  await expect(view.results.getByRole("option")).toHaveCount(1)
  await view.results.getByRole("option").click()
  await expect(view.settings.getByRole("button", { name: "Build server", exact: true })).toBeVisible()
  await expect(view.settings.getByRole("textbox", { name: "Project name", exact: true })).toHaveValue("OpenCode")
})

for (const direction of ["ltr", "rtl"] as const) {
  test.describe(`search layout ${direction}`, () => {
    test.use({
      viewport: { width: 390, height: 844 },
      colorScheme: direction === "rtl" ? "dark" : "light",
      contextOptions: { reducedMotion: "reduce" },
    })
    test("search input fades track typing, caret scrolling, resizing, and clearing", async ({ page }) => {
      const view = ui(page)
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.evaluate((direction) => {
        document.documentElement.dir = direction
      }, direction)
      await view.search.fill(direction === "rtl" ? "غيرموجود ".repeat(30) : "zzzz ".repeat(30))
      await view.search.press("End")
      await expect(view.search).toHaveAttribute("data-overflow-start", "true")
      await expect(view.search).toHaveAttribute("data-overflow-end", "false")
      await expect(view.search).not.toHaveCSS("mask-image", "none")

      await view.search.press("Home")
      await expect(view.search).toHaveAttribute("data-overflow-start", "false")
      await expect(view.search).toHaveAttribute("data-overflow-end", "true")
      await view.search.evaluate((input: HTMLInputElement, direction) => {
        input.scrollLeft = ((input.scrollWidth - input.clientWidth) / 2) * (direction === "rtl" ? -1 : 1)
      }, direction)
      await expect(view.search).toHaveAttribute("data-overflow-start", "true")
      await expect(view.search).toHaveAttribute("data-overflow-end", "true")

      await view.search.fill("z".repeat(50))
      await expect(view.search).not.toHaveCSS("mask-image", "none")
      await page.setViewportSize({ width: 600, height: 844 })
      await expect(view.search).toHaveAttribute("data-overflow-start", "false")
      await expect(view.search).toHaveAttribute("data-overflow-end", "false")
      await expect(view.search).toHaveCSS("mask-image", "none")

      await view.search.fill("zzzz ".repeat(30))
      await expect(view.search).not.toHaveCSS("mask-image", "none")
      await view.settings.getByRole("button", { name: "Clear", exact: true }).click()
      await expect(view.search).toHaveValue("")
      await expect(view.search).toBeFocused()
      await expect(view.search).toHaveAttribute("data-overflow-start", "false")
      await expect(view.search).toHaveAttribute("data-overflow-end", "false")
      await expect(view.search).toHaveCSS("mask-image", "none")
    })

    test("keeps input/content stable and hides the active descendant when results collapse", async ({ page }) => {
      const view = ui(page)
      await page.evaluate((direction) => {
        document.documentElement.dir = direction
      }, direction)
      const input = await view.search.boundingBox()
      const content = await view.settings.locator(".settings-content").boundingBox()
      await view.search.fill("e")
      await expect.poll(() => view.search.boundingBox()).toEqual(input)
      await expect.poll(() => view.settings.locator(".settings-content").boundingBox()).toEqual(content)
      await view.search.fill("terminal font")
      await view.results.getByRole("option").click()
      await expect(view.results).toBeHidden()
      await expect(view.search).toHaveAttribute("aria-expanded", "false")
      await expect(view.search).not.toHaveAttribute("aria-activedescendant", /.+/)
      await expect(view.settings.getByRole("textbox", { name: "Terminal Font", exact: true })).toBeInViewport()
      await findShortcut(page)
      await expect(view.search).toBeFocused()
      await expect(view.results).toBeVisible()
      await expect(view.search).toHaveAttribute("aria-activedescendant", /.+/)
      expect(await view.settings.evaluate((root) => root.scrollWidth <= root.clientWidth)).toBe(true)
    })
  })
}
