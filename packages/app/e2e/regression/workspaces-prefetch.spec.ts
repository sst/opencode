import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "/repo/workspaces-prefetch"
const sandboxes = [`${directory}/first`, `${directory}/second`]
const project = {
  id: "proj_workspaces_prefetch",
  canonical: directory,
  name: "Prefetch project",
  sandboxes,
  time: { created: 1, updated: 1 },
}
const other = { ...project, id: "proj_other", name: "Other project", canonical: "/repo/other", sandboxes: [] }
const storedInventory = [project, other].map((project) => ({
  project,
  worktrees: [
    { directory: project.canonical },
    ...project.sandboxes.map((directory) => ({ directory, strategy: "git" })),
  ],
}))

test.use({ viewport: { width: 1280, height: 900 } })

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: "ses_workspaces_cached",
        title: "Cached worktree session",
        projectID: project.id,
        directory: sandboxes[0],
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] } }),
    )
  }, directory)
  await page.goto("/")
  await expect(page.getByText("Cached worktree session", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByTestId("settings-screen").getByRole("tab", { name: "Preferences" })).toBeVisible()
})

for (const interaction of ["hover", "focus"] as const) {
  test(`project Worktrees ${interaction} reuses the global inventory and filters the selected project`, async ({
    page,
  }) => {
    const inventory = Promise.withResolvers<void>()
    const calls: string[] = []
    const sessions: string[] = []
    await page.route(
      (url) => url.pathname === "/api/worktree/inventory",
      async (route) => {
        calls.push(new URL(route.request().url()).search)
        await inventory.promise
        await route.fulfill({ json: storedInventory })
      },
    )
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.pathname === "/api/session" && url.searchParams.has("directory"))
        sessions.push(url.searchParams.get("directory")!)
    })

    const settings = page.getByTestId("settings-screen")
    await settings.getByRole("tab", { name: "Projects", exact: true }).click()
    await settings.getByRole("button", { name: project.name, exact: true }).click()
    const worktrees = settings.getByRole("tab", { name: "Worktrees", exact: true })
    await expect(worktrees).toBeEnabled()
    const requested = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/worktree/inventory")
    await worktrees[interaction]()
    await requested
    await expect(worktrees).toHaveAttribute("aria-selected", "false")
    expect(calls).toEqual([""])
    expect(sessions).toEqual([])

    if (interaction === "hover") {
      const finished = page.waitForEvent(
        "requestfinished",
        (request) => new URL(request.url()).pathname === "/api/worktree/inventory",
      )
      inventory.resolve()
      await finished
    }
    await worktrees.click()
    await expect(worktrees).toHaveAttribute("aria-selected", "true")
    inventory.resolve()
    await expect(settings.getByText("2 worktrees", { exact: true })).toBeVisible()
    await expect(settings.getByText("Cached worktree session", { exact: true })).toBeVisible()
    expect(calls).toEqual([""])
    await expect.poll(() => sessions.toSorted()).toEqual(sandboxes.toSorted())
  })
}

for (const nested of [false, true]) {
  test(`${nested ? "nested" : "root"} server Worktrees hover only prefetches metadata`, async ({ page }) => {
    if (nested) {
      const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
      await page.addInitScript((server) => {
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            list: [
              { type: "http", displayName: "Settings server", http: { url: server } },
              { type: "http", displayName: "Other server", http: { url: "http://127.0.0.1:4097" } },
            ],
          }),
        )
      }, server)
      await page.reload()
      await page.getByTestId("settings-screen").getByRole("tab", { name: "Settings server", exact: true }).click()
    }
    const calls = { inventory: 0, projects: 0, worktrees: [] as string[] }
    await page.route(
      (url) => url.pathname === "/api/worktree/inventory",
      (route) => {
        calls.inventory += 1
        return route.fulfill({ json: storedInventory })
      },
    )
    await page.route(
      (url) => url.pathname === "/api/project",
      async (route) => {
        calls.projects += 1
        await route.fulfill({ json: [project, other] })
      },
    )
    await page.route(
      (url) => url.pathname === "/api/worktree",
      async (route) => {
        const requested = new URL(route.request().url()).searchParams.get("location[directory]") ?? ""
        calls.worktrees.push(requested)
        if (requested === other.canonical) return route.fulfill({ json: [{ directory: other.canonical }] })
        await route.fallback()
      },
    )
    const settings = page.getByTestId("settings-screen")
    const worktrees = settings.getByRole("tab", { name: "Worktrees", exact: true })
    await expect(worktrees).toBeEnabled()
    const fetched = page.waitForEvent(
      "requestfinished",
      (request) => new URL(request.url()).pathname === "/api/worktree/inventory",
    )
    await worktrees.hover()
    await fetched
    await worktrees.focus()
    await expect(worktrees).toHaveAttribute("aria-selected", "false")
    expect(calls).toEqual({ inventory: 1, projects: 0, worktrees: [] })

    await worktrees.click()
    await expect(settings.getByText("2 worktrees", { exact: true })).toBeVisible()
    expect(calls).toEqual({ inventory: 1, projects: 0, worktrees: [] })
  })
}

test("cached sessions render while directory sessions load without treating unknown rows as empty", async ({
  page,
}) => {
  const ready = Promise.withResolvers<void>()
  await page.route(
    (url) => url.pathname === "/api/session" && url.searchParams.has("directory"),
    async (route) => {
      await ready.promise
      await route.fallback()
    },
  )
  const settings = page.getByTestId("settings-screen")
  const requested = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname === "/api/session" && url.searchParams.has("directory")
  })
  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await requested
  await expect(settings.getByText("Cached worktree session", { exact: true })).toBeVisible()
  const empty = settings
    .locator(".settings-workspaces-row")
    .filter({ has: page.getByLabel(sandboxes[1], { exact: true }) })
  await expect(empty).toContainText("Loading messages")
  await settings.getByRole("button", { name: "More options", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Delete worktrees without sessions", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  ready.resolve()
  await expect(empty).toContainText("0 sessions")
  await expect(settings.getByText("Cached worktree session", { exact: true })).toBeVisible()
})

test("project deletion updates the cached server-wide inventory", async ({ page }) => {
  const removed = new Set<string>()
  await page.route(
    (url) => url.pathname === "/api/worktree",
    (route) => {
      if (route.request().method() === "DELETE") {
        removed.add(route.request().postDataJSON().directory)
        return route.fulfill({ status: 204 })
      }
      return route.fallback()
    },
  )
  await page.route(
    (url) => url.pathname === "/api/worktree/inventory",
    (route) =>
      route.fulfill({
        json: storedInventory.map((entry) => ({
          ...entry,
          worktrees: entry.worktrees.filter((worktree) => !removed.has(worktree.directory)),
        })),
      }),
  )
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await expect(settings.getByText("2 worktrees", { exact: true })).toBeVisible()
  await settings.getByRole("tab", { name: "Projects", exact: true }).click()
  await settings.getByRole("button", { name: project.name, exact: true }).click()
  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await settings.getByRole("button", { name: "Delete “second”?", exact: true }).click()
  await page
    .getByRole("dialog", { name: "Delete “second”?", exact: true })
    .getByRole("button", { name: "Delete worktree", exact: true })
    .click()
  await expect(settings.getByText("1 worktree", { exact: true })).toBeVisible()
  await settings.getByRole("button", { name: "Back to projects", exact: true }).click()
  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await expect(settings.getByText("1 worktree", { exact: true })).toBeVisible()
  await expect(settings.getByLabel(sandboxes[1], { exact: true })).toHaveCount(0)
})

test("View all reads 336 historical projects in one metadata request without Location discovery", async ({
  page,
}, testInfo) => {
  const inventory = Array.from({ length: 336 }, (_, index) => ({
    project: {
      ...project,
      id: `historical-${index}`,
      name: `Historical ${index}`,
      canonical: `/missing/historical-${index}`,
      sandboxes: [],
    },
    worktrees: [{ directory: `/missing/historical-${index}/feature`, strategy: "git" }],
  }))
  const reads: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (["/api/project", "/api/worktree", "/api/worktree/inventory"].includes(url.pathname)) reads.push(url.pathname)
  })
  await page.route(
    (url) => url.pathname === "/api/project",
    (route) => route.fulfill({ json: inventory.map((entry) => entry.project) }),
  )
  await page.route(
    (url) => url.pathname === "/api/worktree",
    (route) =>
      route.fulfill({
        json:
          inventory.find(
            (entry) =>
              entry.project.canonical === new URL(route.request().url()).searchParams.get("location[directory]"),
          )?.worktrees ?? [],
      }),
  )
  await page.route(
    (url) => url.pathname === "/api/worktree/inventory",
    (route) => route.fulfill({ json: inventory }),
  )
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await expect(settings.getByText("336 worktrees", { exact: true })).toBeVisible()
  await expect(settings.getByLabel("/missing/historical-335/feature", { exact: true })).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath("inventory.png") })
  await testInfo.attach("inventory-requests", { body: JSON.stringify(reads), contentType: "application/json" })
  expect(reads).toEqual(["/api/worktree/inventory"])
})
