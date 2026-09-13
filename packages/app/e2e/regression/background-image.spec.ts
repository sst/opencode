import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const draftID = "draft_background_image"
const directory = "/tmp/background-image"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_background_image",
      worktree: directory,
      vcs: "git",
      name: "background-image",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem("opencode-theme-id", "oc-2")
      localStorage.setItem("opencode-color-scheme", "dark")
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { directory, draftID, server },
  )
  await page.goto(`/new-session?draftId=${draftID}`)
  await expectAppVisible(page.locator('[data-component="composer-editor"]'))
})

test("selects, restores, and removes a background image", async ({ page }) => {
  const providerTip = page.locator('[data-component="new-session-tip"][data-kind="provider"]')
  await expect(providerTip).toBeVisible()
  await page.keyboard.press("Control+,")
  const settings = page.getByTestId("settings-screen")
  await expect(settings).toBeFocused()
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click()
  const chooser = page.waitForEvent("filechooser")
  await settings.getByRole("button", { name: "Choose image", exact: true }).click()
  await (await chooser).setFiles({ name: "background.png", mimeType: "image/png", buffer: image })
  await expect(settings.getByRole("button", { name: "Remove", exact: true })).toBeVisible()
  const shell = page.locator('[data-component="app-shell"]')
  await expect(shell).toHaveAttribute("data-background-image", "")
  await expect(shell).toHaveCSS("background-image", /blob:/)

  await settings.getByRole("button", { name: "Back to app", exact: true }).click()
  await expect(settings).toBeHidden()
  await expect(page.locator('[data-component="new-session"][data-background-surface="canvas"]')).toBeVisible()
  await expect(providerTip).toBeHidden()
  await page.reload()
  await expectAppVisible(page.locator('[data-component="composer-editor"]'))
  await expect(shell).toHaveAttribute("data-background-image", "")

  await page.keyboard.press("Control+,")
  await expect(settings).toBeFocused()
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click()
  await settings.getByRole("button", { name: "Remove", exact: true }).click()
  await expect(settings.getByRole("button", { name: "Remove", exact: true })).toBeHidden()
  await expect(shell).not.toHaveAttribute("data-background-image", "")
})
