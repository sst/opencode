import { expect, test } from "@playwright/test"
import { dict } from "../../src/runtime/i18n/ar"
import en from "../../src/runtime/i18n/en"
import { fixture, pageMessages } from "../performance/timeline/session-timeline-stress.fixture"
import { installStressSessionTabs, stressSessionHref } from "../performance/timeline/timeline-test-helpers"
import { mockOpenCodeServer } from "../utils/mock-server"

test.use({ serviceWorkers: "block" })

for (const direction of ["ltr", "rtl"] as const) {
  for (const workspace of [false, true]) {
    test(`session project menu for ${workspace ? "worktree" : "local"} in ${direction}`, async ({ page }) => {
      const copy = direction === "rtl" ? dict : en
      const directory = workspace
        ? "C:/OpenCode/Worktrees/مشروع-42/long-folder-name-for-checking-wrapped-worktree-paths/another-long-folder-name-to-exercise-the-full-path-tooltip"
        : fixture.directory
      const project = {
        ...fixture.project,
        name: workspace
          ? "مشروع Timeline 42 with a long project name that needs truncation and enough additional text to wrap inside the tooltip"
          : "Timeline project",
        sandboxes: workspace ? [directory] : [],
        icon: {
          url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="blue"/></svg>')}`,
        },
      }
      await mockOpenCodeServer(page, {
        directory,
        project,
        sessions: fixture.sessions.map((session) => ({ ...session, directory })),
        provider: fixture.provider,
        pageMessages,
      })
      await installStressSessionTabs(page)
      await page.addInitScript((direction) => {
        localStorage.setItem(
          "opencode.global.dat:language",
          JSON.stringify({ locale: direction === "rtl" ? "ar" : "en" }),
        )
        const settings = JSON.parse(localStorage.getItem("settings.v3") ?? "{}")
        localStorage.setItem(
          "settings.v3",
          JSON.stringify({ ...settings, general: { ...settings.general, showProjectIcon: false } }),
        )
      }, direction)
      await page.setViewportSize({ width: workspace ? 900 : 1440, height: 900 })
      await page.goto(stressSessionHref(fixture.targetID))
      const header = page.locator("[data-session-title]")
      await expect(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle)
      await expect(page.locator("html")).toHaveAttribute("dir", direction)

      const trigger = header.getByRole("button", { name: project.name, exact: true })
      await expect(trigger).toBeEnabled()
      await expect(trigger.locator("use")).toHaveAttribute(
        "href",
        `#opencode-v2-icon-${workspace ? "outline-worktree" : "monitor"}`,
      )
      // Initial layout scrolls this sticky header's ancestor and dismisses its tooltip.
      await expect(page.locator("[data-timeline-virtual-content]")).toHaveCSS("visibility", "visible")
      const background = await trigger.evaluate((element) => getComputedStyle(element).backgroundColor)
      await trigger.hover()
      await expect(trigger).not.toHaveCSS("background-color", background)
      await expect(page.getByRole("tooltip")).toHaveText(project.name)
      await trigger.click()

      const menu = page.getByRole("menu", { name: project.name, exact: true })
      const settings = menu.getByRole("menuitem", { name: "Edit project", exact: true })
      const projectItem = menu.getByRole("menuitem", { name: project.name, exact: true })
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      await expect(page.getByRole("tooltip")).toBeHidden()
      await expect(menu.getByText(project.name, { exact: true })).toBeVisible()
      await expect(menu.locator('[data-slot="project-avatar-image"]')).toHaveAttribute("src", project.icon.url)
      await expect(menu.getByText(directory, { exact: true })).toBeVisible()
      await expect(menu.getByText(directory, { exact: true })).toHaveAttribute("dir", "ltr")
      await expect(menu.locator('use[href="#opencode-v2-icon-folder"]')).toHaveCount(1)
      await expect(menu).toHaveCSS("direction", direction)
      await expect(menu.getByRole("menuitem")).toHaveText([project.name, directory, "Edit project"])
      await expect(menu.getByRole("menuitem", { name: directory, exact: true })).toBeDisabled()
      await expect(settings).toBeEnabled()
      await expect
        .poll(() => menu.evaluate((element) => element.getBoundingClientRect().width))
        .toBeLessThanOrEqual(320)
      for (const text of [project.name, directory]) {
        const label = menu.getByText(text, { exact: true })
        await expect(label).toHaveCSS("text-overflow", "ellipsis")
        await expect(label).toHaveCSS("white-space", "nowrap")
        if (workspace) {
          await expect.poll(() => label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
        }
      }
      await expect.poll(() => menu.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
      const icons = menu.locator(
        '[data-component="project-avatar-v2"], [data-slot="icon-svg"]:not([data-slot="session-project-open-icon"] *)',
      )
      await expect(icons).toHaveCount(3)
      await expect
        .poll(async () => {
          const [button, centers] = await Promise.all([
            trigger.boundingBox(),
            icons.evaluateAll((elements) =>
              elements.map((element) => {
                const box = element.getBoundingClientRect()
                return box.x + box.width / 2
              }),
            ),
          ])
          return !!button && centers.every((center) => Math.abs(center - button.x - button.width / 2) <= 1)
        })
        .toBe(true)

      if (!workspace) await page.clock.install()
      for (const text of [project.name, directory]) {
        const label = menu.getByText(text, { exact: true })
        const item = menu.getByRole("menuitem", { name: text, exact: true })
        const anchor = item.locator("..")
        const openIcon = item.locator('[data-slot="session-project-open-icon"]')
        const content = item.locator(".session-project-link-content")
        const width = await label.evaluate((element) => element.getBoundingClientRect().width)
        await expect(openIcon).toHaveCount(text === directory ? 1 : 0)
        await anchor.hover()
        await expect(content).toHaveCSS("mask-image", "none")
        await expect.poll(() => label.evaluate((element) => element.getBoundingClientRect().width)).toBe(width)
        if (text === directory) {
          await expect(openIcon).toHaveCSS("opacity", "0")
          await expect(openIcon.locator("use")).toHaveAttribute("href", "#opencode-v2-icon-arrow-up-right")
          await expect
            .poll(() => openIcon.locator("svg").evaluate((element: SVGSVGElement) => element.getBBox().width))
            .toBeGreaterThan(0)
          await expect
            .poll(async () => {
              const [row, icon] = await Promise.all([item.boundingBox(), openIcon.boundingBox()])
              if (!row || !icon) return false
              return (
                Math.abs(row.y + row.height / 2 - icon.y - icon.height / 2) <= 0.5 &&
                Math.abs((direction === "rtl" ? icon.x - row.x : row.x + row.width - icon.x - icon.width) - 12) <= 0.5
              )
            })
            .toBe(true)
        }
        await expect(label).toHaveCSS("cursor", "default")
        await expect(anchor).toHaveCSS("cursor", "default")
        const tooltip = page.getByRole("tooltip")
        if (workspace) {
          await expect(tooltip).toHaveText(text)
          await expect(tooltip).toHaveCSS("white-space", "normal")
          await expect
            .poll(() => tooltip.evaluate((element) => element.getBoundingClientRect().width))
            .toBeLessThanOrEqual(480)
          await expect
            .poll(() =>
              tooltip
                .getByText(text, { exact: true })
                .evaluate(
                  (element) =>
                    element.getBoundingClientRect().height > Number.parseFloat(getComputedStyle(element).lineHeight),
                ),
            )
            .toBe(true)
          await expect
            .poll(async () => {
              const [row, tip] = await Promise.all([anchor.boundingBox(), tooltip.boundingBox()])
              return !!row && !!tip && Math.abs(row.y - tip.y - tip.height - 2) <= 1
            })
            .toBe(true)
        }
        if (!workspace) {
          await page.clock.runFor(500)
          await expect(tooltip).toBeHidden()
        }
        await settings.hover()
        await expect(tooltip).toBeHidden()
        if (text === directory) await expect(openIcon).toHaveCSS("opacity", "0")
        await expect(content).toHaveCSS("mask-image", "none")
      }

      await page.keyboard.press("Escape")
      await expect(menu).toBeHidden()
      await expect(trigger).toBeFocused()
      await trigger.press("ArrowDown")
      await expect(projectItem).toBeFocused()
      await page.keyboard.press("ArrowDown")
      const pathItem = menu.getByRole("menuitem", { name: directory, exact: true })
      await expect(pathItem).toBeFocused()
      if (workspace) await expect(page.getByRole("tooltip")).toHaveText(directory)
      await page.keyboard.press("Enter")
      await expect(menu).toBeVisible()
      await expect(pathItem).toBeFocused()
      await page.keyboard.press("Space")
      await expect(menu).toBeVisible()
      await expect(pathItem).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(menu).toBeHidden()
      await expect(trigger).toBeFocused()
      await trigger.press("ArrowDown")
      await expect(projectItem).toBeFocused()
      await page.keyboard.press("ArrowDown")
      await expect(pathItem).toBeFocused()
      if (workspace) await expect(page.getByRole("tooltip")).toHaveText(directory)
      await page.keyboard.press("ArrowDown")
      await expect(settings).toBeFocused()
      await expect(page.getByRole("tooltip")).toBeHidden()
      await page.keyboard.press("Enter")
      const settingsScreen = page.getByTestId("settings-screen")
      await expect(settingsScreen.getByRole("heading", { name: project.name, exact: true })).toBeVisible()
      await expect(
        settingsScreen.getByRole("textbox", { name: en["project.settings.name.title"], exact: true }),
      ).toHaveValue(project.name)
      await expect(menu).toBeHidden()
      await settingsScreen.getByRole("button", { name: en["settings.backToProjects"], exact: true }).click()
      await settingsScreen.getByRole("button", { name: en["settings.backToApp"], exact: true }).click()
      await expect(settingsScreen).toBeHidden()
      await expect(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle)

      await page.setViewportSize({ width: 1440, height: 900 })
      for (const selected of [false, true]) {
        if (selected) {
          await page.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.targetID)}"]`).click()
          await expect(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle)
        }
        await trigger.click()
        await expect(projectItem).toBeEnabled()
        const background = await projectItem.evaluate((element) => getComputedStyle(element).backgroundColor)
        await projectItem.hover()
        await expect(projectItem).not.toHaveCSS("background-color", background)
        await projectItem.click()
        await expect(page).toHaveURL(new URL("/", page.url()).href)
        await expect(menu).toBeHidden()
        const projectRow = page.locator('[data-component="home-project-row"]').filter({ hasText: project.name })
        await expect(projectRow).toBeVisible()
        await expect(projectRow).toHaveAttribute("data-selected", "")
        await expect(
          page.locator(`[data-component="home-session-row-container"][data-session-id="${fixture.targetID}"]`),
        ).toBeVisible()
      }
    })
  }
}

for (const state of ["closed", "unopened"] as const) {
  test(`session project menu restores ${state} projects before and after messages load`, async ({ page }) => {
    const directory = "C:/OpenCode/Worktrees/project-menu-recovery"
    const messages = Promise.withResolvers<void>()
    await mockOpenCodeServer(page, {
      directory,
      project: { ...fixture.project, sandboxes: [directory] },
      sessions: fixture.sessions.map((session) => ({ ...session, directory })),
      provider: fixture.provider,
      pageMessages,
      beforeMessagesResponse: (input) => (input.sessionID === fixture.targetID ? messages.promise : Promise.resolve()),
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    if (state === "closed") {
      await installStressSessionTabs(page)
      await page.goto("/")
      const projectRow = page.locator('[data-component="home-project-row"]').filter({ hasText: fixture.project.name })
      await expect(projectRow).toBeEnabled()
      await projectRow.locator("..").getByRole("button", { name: "More options", exact: true }).click()
      await page.getByRole("menuitem", { name: "Close", exact: true }).click()
      await expect(projectRow).toHaveCount(0)
      await page.locator(`[data-titlebar-tab-link][href="${stressSessionHref(fixture.targetID)}"]`).click()
    }
    if (state === "unopened") await page.goto(stressSessionHref(fixture.targetID))

    const header = page.locator("[data-session-title]")
    const trigger = header.getByRole("button", { name: fixture.project.name, exact: true })
    const menu = page.getByRole("menu", { name: fixture.project.name, exact: true })
    await expect(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle)
    for (const loaded of [false, true]) {
      if (loaded) {
        messages.resolve()
        await expect(header.getByRole("button", { name: "More options", exact: true })).toBeVisible()
      }
      await expect(trigger.locator("use")).toHaveAttribute("href", "#opencode-v2-icon-outline-worktree")
      await trigger.click()
      await expect(menu.getByRole("menuitem", { name: fixture.project.name, exact: true })).toBeEnabled()
      await expect(menu.getByRole("menuitem", { name: directory, exact: true })).toBeDisabled()
      await menu.getByRole("menuitem", { name: "Edit project", exact: true }).click()
      const settingsScreen = page.getByTestId("settings-screen")
      await expect(
        settingsScreen.getByRole("textbox", { name: en["project.settings.name.title"], exact: true }),
      ).toHaveValue(fixture.project.name)
      await settingsScreen.getByRole("button", { name: en["settings.backToProjects"], exact: true }).click()
      await settingsScreen.getByRole("button", { name: en["settings.backToApp"], exact: true }).click()
      await expect(settingsScreen).toBeHidden()
    }
    await trigger.click()
    await menu.getByRole("menuitem", { name: fixture.project.name, exact: true }).click()
    await expect(page).toHaveURL(new URL("/", page.url()).href)
    const projectRow = page.locator('[data-component="home-project-row"]').filter({ hasText: fixture.project.name })
    await expect(projectRow).toBeVisible()
    await expect(projectRow).toHaveAttribute("data-selected", "")
    await expect(
      page.locator(`[data-component="home-session-row-container"][data-session-id="${fixture.targetID}"]`),
    ).toBeVisible()
  })
}

test("path arrow has a glyph when the page has an older icon sprite", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    sessions: fixture.sessions,
    provider: fixture.provider,
    pageMessages,
  })
  await installStressSessionTabs(page)
  await page.route(
    (url) => url.pathname === stressSessionHref(fixture.targetID),
    async (route) => {
      const response = await route.fetch()
      await route.fulfill({
        response,
        body: (await response.text()).replace(
          '<div id="root"',
          '<svg id="opencode-v2-icon-sprite" width="0" height="0" aria-hidden="true"><symbol id="opencode-v2-icon-monitor" viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></symbol></svg><div id="root"',
        ),
      })
    },
  )
  await page.goto(stressSessionHref(fixture.targetID))
  const header = page.locator("[data-session-title]")
  await expect(header.getByRole("heading")).toHaveText(fixture.expected.targetTitle)
  await header.getByRole("button", { name: fixture.project.name, exact: true }).click()
  const path = page.getByRole("menu").getByRole("menuitem", { name: fixture.directory, exact: true })
  const arrow = path.locator('[data-slot="session-project-open-icon"]')
  await expect(arrow).toHaveCount(1)
  await expect
    .poll(() => arrow.locator("svg").evaluate((element: SVGSVGElement) => element.getBBox().width))
    .toBeGreaterThan(0)
  await expect(page.locator("#opencode-v2-icon-sprite")).toHaveCount(1)
})
