import { expect, test } from "@playwright/test"
import type { ProjectUpdateInput } from "@opencode/client/promise"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "/repo/project-autosave"
const project = {
  id: "proj_autosave",
  canonical: directory,
  name: "Autosave project",
  icon: { color: "orange" },
  commands: { start: "echo setup" },
  sandboxes: [],
  time: { created: 1, updated: 1 },
}

test.use({ viewport: { width: 1280, height: 900 } })

for (const field of [
  {
    name: "color",
    label: "",
    initial: "orange",
    next: "blue",
    patches: [{ icon: { color: "blue", override: "" } }, { icon: { color: "orange", override: "" } }],
  },
  {
    name: "name",
    label: "Project name",
    initial: project.name,
    next: "Renamed project",
    patches: [{ name: "Renamed project" }, { name: project.name }],
  },
  {
    name: "startup script",
    label: "Worktree startup script",
    initial: project.commands.start,
    next: "bun install",
    patches: [{ commands: { start: "bun install" } }, { commands: { start: project.commands.start } }],
  },
]) {
  test(`keeps the final project ${field.name} when reverting during an autosave`, async ({ page }) => {
    await mockOpenCodeServer(page, {
      directory,
      project,
      provider: { all: [], connected: [], default: {} },
      sessions: [],
      pageMessages: () => ({ items: [] }),
    })
    const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
    await page.addInitScript(
      ({ directory, server }) => {
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            list: [{ type: "http", http: { url: server } }],
            projects: {
              local: [{ worktree: directory, expanded: true }],
              [server]: [{ worktree: directory, expanded: true }],
            },
          }),
        )
      },
      { directory, server },
    )
    const pending = Promise.withResolvers<void>()
    const patches: unknown[] = []
    await page.route(`**/api/project/${project.id}`, async (route) => {
      const patch: Pick<ProjectUpdateInput, "name" | "icon" | "commands"> = route.request().postDataJSON()
      patches.push(patch)
      if (patches.length === 1) await pending.promise
      await route.fulfill({ json: { ...project, ...patch } })
    })
    await page.goto("/settings")
    const settings = page.getByTestId("settings-screen")
    await settings.getByRole("tab", { name: "Projects", exact: true }).click()
    await settings.getByRole("button", { name: project.name, exact: true }).click()
    const edit = async (value: string) => {
      if (field.name === "color") {
        await settings.getByRole("button", { name: `Select ${value} color`, exact: true }).click()
        return
      }
      const input = settings.getByRole("textbox", { name: field.label, exact: true })
      await input.fill(value)
      await input.blur()
    }

    const first = page.waitForRequest(
      (request) => request.method() === "PATCH" && new URL(request.url()).pathname === `/api/project/${project.id}`,
    )
    await edit(field.next)
    await first
    await edit(field.initial)
    expect(patches).toEqual([field.patches[0]])
    pending.resolve()
    await expect(settings.locator('[aria-busy="true"]')).toHaveCount(0)
    expect(patches).toEqual(field.patches)

    await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
    await settings.getByRole("tab", { name: project.name, exact: true }).click()
    if (field.name === "color") {
      await expect(settings.getByRole("button", { name: "Select orange color", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      )
      return
    }
    await expect(settings.getByRole("textbox", { name: field.label, exact: true })).toHaveValue(field.initial)
  })
}
