import { base64Encode } from "@opencode/util/encode"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/ReviewTogglePosition"
const sessionID = "ses_review_toggle_position"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_review_toggle_position",
      worktree: directory,
      vcs: "git",
      name: "review-toggle-position",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        slug: "review-toggle-position",
        projectID: "proj_review_toggle_position",
        directory,
        title: "Review toggle position",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
})

for (const width of [1000, 1440]) {
  for (const direction of ["ltr", "rtl"] as const) {
    test(`keeps the review toggle at the outer header edge (${width}px, ${direction})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
      await expectSessionTitle(page, "Review toggle position")
      await page.locator("html").evaluate((element, dir) => element.setAttribute("dir", dir), direction)

      const toggle = page.getByRole("button", { name: "Toggle review", exact: true })
      const header = page.locator("[data-session-title]")
      const panel = page.locator("#review-panel")
      await expect(toggle).toHaveAttribute("aria-expanded", "false")
      const closed = await toggle.boundingBox()
      if (!closed) throw new Error("Review toggle bounds are unavailable")
      const headerBox = await header.boundingBox()
      if (!headerBox) throw new Error("Session header bounds are unavailable")
      expect(closed.y).toBeGreaterThanOrEqual(headerBox.y)
      expect(closed.y + closed.height).toBeLessThanOrEqual(headerBox.y + headerBox.height)

      await toggle.click()
      await expect(toggle).toHaveAttribute("aria-expanded", "true")
      await expect(panel).toHaveAttribute("aria-hidden", "false")
      await expect(toggle).toHaveCount(1)
      await expect.poll(() => toggle.boundingBox()).toEqual(closed)
      await expect
        .poll(async () => {
          const box = await panel.boundingBox()
          if (!box) return false
          return (
            closed.x >= box.x &&
            closed.x + closed.width <= box.x + box.width &&
            closed.y >= box.y &&
            closed.y + closed.height <= box.y + 52
          )
        })
        .toBe(true)

      await expect
        .poll(async () => {
          const box = await panel.locator('[data-slot="session-side-panel-actions"]').boundingBox()
          return box ? box.y + box.height / 2 : undefined
        })
        .toBe(closed.y + closed.height / 2)

      await toggle.press("Enter")
      await expect(toggle).toHaveAttribute("aria-expanded", "false")
      await expect(toggle).toBeFocused()
      await expect(toggle).toHaveCount(1)
      await expect.poll(() => toggle.boundingBox()).toEqual(closed)
    })

    test(`keeps moving header content out of the toggle area (${width}px, ${direction})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
      await expectSessionTitle(page, "Review toggle position")
      await page.locator("html").evaluate((element, dir) => element.setAttribute("dir", dir), direction)

      const toggle = page.getByRole("button", { name: "Toggle review", exact: true })
      await expect(toggle).toHaveAttribute("aria-expanded", "false")
      for (const opened of [true, false]) {
        // Pause in the same task as the click so even the first painted state can be inspected.
        await toggle.evaluate((element) => {
          ;(element as HTMLButtonElement).click()
          document
            .getAnimations()
            .filter((animation) => animation.timeline instanceof DocumentTimeline)
            .forEach((animation) => animation.pause())
        })
        await expect(toggle).toHaveAttribute("aria-expanded", String(opened))
        await expect(page.locator("#review-panel")).toHaveAttribute("aria-hidden", String(!opened))
        for (const progress of [0.08, 0.16, 0.25, 0.5, 0.8, 0.96]) {
          await expectHeaderClearOfToggle(page, toggle, progress)
        }
        await page.evaluate(() => {
          document
            .getAnimations()
            .filter((animation) => animation.timeline instanceof DocumentTimeline)
            .forEach((animation) => animation.finish())
        })
      }
      await expect(page.locator("#review-panel")).toBeHidden()
    })

    test(`keeps terminal controls clear of the review toggle (${width}px, ${direction})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      const ptys: { id: string; title: string }[] = []
      const removed: string[] = []
      await page.route("**/api/pty**", async (route) => {
        const path = new URL(route.request().url()).pathname
        const location = { directory, project: { id: "proj_review_toggle_position", directory } }
        if (route.request().method() === "DELETE") {
          removed.push(path.split("/").at(-1)!)
          return route.fulfill({ status: 204 })
        }
        if (path.endsWith("/connect-token")) {
          return route.fulfill({ json: { location, data: { ticket: "e2e-ticket", expires_in: 60 } } })
        }
        if (path === "/api/pty" && route.request().method() === "POST") {
          const pty = { id: `pty_review_${ptys.length + 1}`, title: `Terminal ${ptys.length + 1}` }
          ptys.push(pty)
          return route.fulfill({ json: { location, data: pty } })
        }
        return route.fulfill({ json: { location, data: ptys.find((pty) => path.endsWith(pty.id)) ?? ptys } })
      })
      await page.routeWebSocket(/\/api\/pty\/pty_review_\d+\/connect/, () => undefined)
      await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
      await expectSessionTitle(page, "Review toggle position")
      await page.locator("html").evaluate((element, dir) => element.setAttribute("dir", dir), direction)

      const toggle = page.getByRole("button", { name: "Toggle review", exact: true })
      await expect(toggle).toHaveAttribute("aria-expanded", "false")
      await page.keyboard.press("Control+Backquote")
      const terminal = page.getByRole("region", { name: "Terminal", exact: true })
      await expect(terminal.getByRole("tab", { name: "Terminal 1", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      )
      for (const number of [2, 3, 4]) {
        await terminal.getByRole("button", { name: "New terminal", exact: true }).click()
        await expect(terminal.getByRole("tab", { name: `Terminal ${number}`, exact: true })).toHaveAttribute(
          "aria-selected",
          "true",
        )
      }

      await expect
        .poll(async () => {
          const tabs = await terminal.getByRole("tablist").boundingBox()
          const button = await toggle.boundingBox()
          if (!tabs || !button) return false
          return direction === "rtl" ? tabs.x >= button.x + button.width : tabs.x + tabs.width <= button.x
        })
        .toBe(true)
      await expectTerminalControlsAligned(terminal, toggle)
      const fourth = terminal.locator('[data-slot="tabs-trigger-wrapper"][data-value="pty_review_4"]')
      await fourth.getByRole("button", { name: "Close terminal", exact: true }).click()
      await expect(terminal.getByRole("tab")).toHaveText(["Terminal 1", "Terminal 2", "Terminal 3"])
      expect(removed).toEqual(["pty_review_4"])
      await expect(toggle).toHaveAttribute("aria-expanded", "false")

      await terminal.getByRole("button", { name: "New terminal", exact: true }).click()
      await expect(terminal.getByRole("tab", { name: "Terminal 5", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      )
      await expect(toggle).toHaveAttribute("aria-expanded", "false")
      const position = await toggle.boundingBox()
      await toggle.click()
      await expect(toggle).toHaveAttribute("aria-expanded", "true")
      await expect(page.locator("#review-panel")).toHaveAttribute("aria-hidden", "false")
      await expect.poll(() => toggle.boundingBox()).toEqual(position)
      await expect
        .poll(async () => {
          const actions = await page.locator('[data-slot="session-side-panel-actions"]').boundingBox()
          const button = await toggle.boundingBox()
          if (!actions || !button) return undefined
          return actions.y + actions.height / 2 - (button.y + button.height / 2)
        })
        .toBe(0)
      await toggle.press("Enter")
      await expect(toggle).toHaveAttribute("aria-expanded", "false")
      await expect(toggle).toBeFocused()
      await expect.poll(() => toggle.boundingBox()).toEqual(position)
      await expectTerminalControlsAligned(terminal, toggle)

      // Closing the terminal clears the region's animation flag while retaining the review contents.
      await page.keyboard.press("Control+Backquote")
      await expect(terminal).toBeHidden()
      await expect
        .poll(() =>
          page
            .locator('[data-slot="session-chat-panel"]')
            .evaluate((element) => element.getAnimations().every((animation) => animation.playState === "finished")),
        )
        .toBe(true)
      await expect(page.locator('[data-slot="session-review-content"]')).toHaveCSS("opacity", "0")
      await toggle.evaluate((element) => {
        ;(element as HTMLButtonElement).click()
        document
          .getAnimations()
          .filter((animation) => animation.timeline instanceof DocumentTimeline)
          .forEach((animation) => animation.pause())
      })
      await expect(toggle).toHaveAttribute("aria-expanded", "true")
      await expectHeaderClearOfToggle(page, toggle, 0.25)
    })
  }
}

async function expectHeaderClearOfToggle(page: Page, toggle: Locator, progress: number) {
  const geometry = await page.locator('[data-slot="session-chat-panel"]').evaluate((chat, progress) => {
    const row = chat.parentElement!
    const animations = row
      .getAnimations({ subtree: true })
      .filter((animation) => animation.timeline instanceof DocumentTimeline)
    const width = animations.find(
      (animation) => animation instanceof CSSTransition && animation.transitionProperty === "width",
    )!
    animations.forEach((animation) => {
      animation.pause()
      animation.currentTime = Number(width.effect!.getTiming().duration) * progress
    })
    const chatBounds = chat.getBoundingClientRect()
    const panelBounds = document.querySelector("#review-panel")!.getBoundingClientRect()
    return {
      row: row.getBoundingClientRect().width,
      panelWidth: panelBounds.width,
      gap:
        getComputedStyle(row).direction === "rtl"
          ? chatBounds.left - panelBounds.right
          : panelBounds.left - chatBounds.right,
      contentOpacity: Number(getComputedStyle(document.querySelector('[data-slot="session-review-content"]')!).opacity),
      panels: chatBounds.width + panelBounds.width + parseFloat(getComputedStyle(row).columnGap),
    }
  }, progress)
  expect(geometry.gap).toBeCloseTo(8, 1)
  if (geometry.panelWidth > 0) expect(Math.abs(geometry.row - geometry.panels)).toBeLessThanOrEqual(1)
  if (progress === 0.25) {
    expect(geometry.contentOpacity).toBeGreaterThan(0)
    expect(geometry.contentOpacity).toBeLessThan(1)
  }

  const clip = await toggle.boundingBox()
  if (!clip) throw new Error("Review toggle bounds are unavailable")
  // Header contents must make no difference to the pixels behind the fixed toggle.
  expect(await page.screenshot({ clip })).toEqual(
    await page.screenshot({
      clip,
      style: ".session-review-v2-tabs-bar { visibility: hidden !important; }",
    }),
  )
}

async function expectTerminalControlsAligned(terminal: Locator, toggle: Locator) {
  await expect
    .poll(async () => {
      const centers = await Promise.all(
        [terminal.getByRole("button", { name: "New terminal", exact: true }), toggle].map((button) =>
          button.locator("svg").evaluate((element) => {
            const svg = element as SVGSVGElement
            const path = svg.getBBox()
            return new DOMPoint(path.x + path.width / 2, path.y + path.height / 2).matrixTransform(svg.getScreenCTM()!)
              .y
          }),
        ),
      )
      return centers[0]! - centers[1]!
    })
    .toBeCloseTo(0, 1)
}
