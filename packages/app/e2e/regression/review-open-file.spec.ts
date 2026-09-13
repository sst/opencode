import { base64Encode } from "@opencode/util/encode"
import type { OpenCodeEvent } from "@opencode/client/promise"
import { expect, test, type Route } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/ReviewOpenFile"
const projectID = "proj_review_open_file"
const sessionID = "ses_review_open_file"
const title = "Review open file"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test.use({ viewport: { width: 1440, height: 900 } })

test("opens and searches project files inline", async ({ page }) => {
  const searches: { query: string; dirs?: string; limit?: number }[] = []
  const events: OpenCodeEvent[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "open-file-project",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    vcsDiff: [fileDiff("src/changed.ts")],
    fileList: (path) => {
      if (path) return []
      return [
        fileNode("README.md"),
        { name: "src", path: "src", absolute: `${directory}/src`, type: "directory", ignored: false },
      ]
    },
    fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
    findFiles: (input) => {
      searches.push(input)
      return input.query === "nested" ? ["src/nested.ts"] : []
    },
    events: () => events.splice(0),
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, server, sessionID, tabKey }) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem("opencode.global.dat:layout", JSON.stringify({ review: { diffStyle: "split" } }))
      localStorage.setItem("opencode.window.browser.dat:tabs.panes", JSON.stringify({ [tabKey]: { review: true } }))
      localStorage.setItem(
        "opencode.global.dat:review-panel-v2",
        JSON.stringify({ sidebarOpened: false, sidebarWidth: 240, expandMode: "collapse" }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, sessionId: sessionID }]),
      )
    },
    { directory, server, sessionID, tabKey: `${server}\n/server/${base64Encode(server)}/session/${sessionID}` },
  )

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const panel = page.locator("#review-panel")
  const sidebar = panel.locator('[data-slot="session-review-v2-sidebar"]')
  const sidebarToggle = panel.getByRole("button", { name: "Toggle file tree" })
  const contextButton = page.getByRole("button", { name: "View context usage" })
  await contextButton.click()
  await expect(panel.getByRole("tab", { name: "Context", selected: true })).toBeVisible()
  await expect(panel.getByRole("button", { name: "Open file" }).locator("use")).toHaveAttribute(
    "href",
    "#opencode-v2-icon-plus",
  )
  await panel.getByRole("button", { name: "Open file" }).click()
  const openFileTab = panel.getByRole("tab", { name: "Open file" })
  const openFileTabClose = openFileTab.locator("..").getByRole("button", { name: "Close tab" })
  await expect(openFileTab).toHaveAttribute("data-selected", "")
  await expect(openFileTab.locator("..")).toHaveCSS("padding-inline-end", "4px")
  await expect(openFileTab.locator("..")).toHaveCSS("gap", "8px")
  await expect(openFileTab.locator("use")).toHaveAttribute("href", "#opencode-v2-icon-file-tree")
  await expect(openFileTab.getByText("Open file", { exact: true }).locator("..")).not.toHaveClass(/italic/)
  await expect(openFileTabClose).toHaveAttribute("data-variant", "ghost-muted")
  await expect(openFileTabClose).toHaveCSS("opacity", "1")
  await expect(sidebarToggle).toBeDisabled()
  await expect(sidebar).toBeVisible()
  await contextButton.click()
  await expect(panel.getByRole("tab", { name: "Context", selected: true })).toBeVisible()
  await expect(openFileTabClose).toHaveCSS("opacity", "0")
  await expect(sidebar).toBeHidden()
  await panel.getByRole("button", { name: "Open file" }).click()
  const filter = panel.getByRole("combobox", { name: "Filter files" })
  await expect(filter).toBeFocused()
  await expect(panel.getByRole("tab", { name: "Open file", selected: true })).toBeVisible()
  await expect(panel.getByText("open-file-project", { exact: true })).toBeVisible()

  await panel.getByRole("button", { name: "README.md" }).click()
  await expect(panel.getByRole("tab", { name: "README.md", selected: true })).toBeVisible()
  await expect(panel.getByRole("tab", { name: "README.md" }).locator("..")).toHaveCSS("padding-inline-end", "4px")
  await expect(panel.getByRole("tab", { name: "README.md" }).locator("..")).toHaveCSS("gap", "8px")
  await expect(sidebarToggle).toBeEnabled()
  await expect(panel.getByText("contents:README.md", { exact: true })).toBeVisible()
  await expect(sidebar).toHaveCount(0)

  const missingReadPattern = "**/api/fs/read/README.md*"
  const missingRead = (route: Route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        _tag: "FileNotFoundError",
        path: "README.md",
        message: "File not found: README.md",
      }),
    })
  await page.route(missingReadPattern, missingRead)
  const missingResponse = page.waitForResponse((response) => response.url().includes("/api/fs/read/README.md"))
  events.push(filesystemEvent("README.md", "unlink"))
  await missingResponse
  await expect(page.getByText("Failed to load file", { exact: true })).toBeVisible()

  const missingTab = panel.getByRole("tab", { name: "File not found: README.md", selected: true })
  await expect(missingTab).toBeVisible()
  await expect(missingTab.locator("[data-file-not-found]")).toHaveCSS("text-decoration-line", "line-through")
  await expect(panel.getByText("File not found: README.md", { exact: true })).toBeVisible()

  await page.unroute(missingReadPattern, missingRead)
  events.push(filesystemEvent("README.md", "add"))
  const restoredTab = panel.getByRole("tab", { name: "README.md", selected: true })
  await expect(restoredTab).toBeVisible()
  await expect(restoredTab.locator("[data-file-not-found]")).toHaveCount(0)
  await expect(panel.getByText("contents:README.md", { exact: true })).toBeVisible()

  await panel.getByRole("button", { name: "Open file" }).click()
  await expect(panel.getByRole("tab", { name: "README.md" })).toHaveCount(0)
  await expect(sidebar).toBeVisible()
  await filter.fill("nested")
  const result = panel.getByRole("option", { name: /nested\.ts/ })
  await expect(result).toBeVisible()
  const resultID = await result.getAttribute("id")
  expect(resultID).toBeTruthy()
  await expect(filter).toHaveAttribute("aria-activedescendant", resultID!)
  await filter.press("Enter")
  await expect(panel.getByRole("tab", { name: "nested.ts", selected: true })).toBeVisible()
  await expect(panel.getByRole("tab", { name: "nested.ts" }).locator("..")).toHaveCSS("padding-inline-end", "4px")
  await expect(panel.getByRole("tab", { name: "nested.ts" }).locator("..")).toHaveCSS("gap", "8px")
  await expect(sidebarToggle).toBeEnabled()
  await expect(panel.getByText("contents:src/nested.ts", { exact: true })).toBeVisible()
  expect(searches).toContainEqual({ query: "nested", dirs: "file", limit: 200 })

  await panel.getByRole("button", { name: "Open file" }).click()
  await expect(panel.getByRole("tab", { name: "nested.ts" })).toHaveCount(1)
  await expect(panel.getByRole("tab", { name: "Open file", selected: true })).toBeVisible()
  await expect(sidebarToggle).toBeDisabled()
  await panel.locator("#session-side-panel-review-tab").click()
  await expect(sidebarToggle).toBeEnabled()
  await panel.getByRole("tab", { name: "Open file" }).click()
  await page.keyboard.press("Control+w")
  await expect(panel.getByRole("tab", { name: "Open file" })).toHaveCount(0)
  await expect(panel.getByRole("tab", { name: "nested.ts", selected: true })).toBeVisible()
})

function filesystemEvent(file: string, event: "add" | "change" | "unlink"): OpenCodeEvent {
  return {
    id: `evt_${file}_${event}`,
    created: 1,
    type: "filesystem.changed",
    location: { directory },
    data: { file, event },
  }
}

function fileNode(path: string) {
  return {
    name: path,
    path,
    absolute: `${directory}/${path}`,
    type: "file",
    ignored: false,
  }
}

function fileDiff(file: string) {
  return {
    file,
    before: "before\n",
    after: "after\n",
    additions: 1,
    deletions: 1,
    status: "modified",
  }
}
