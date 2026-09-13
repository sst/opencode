import { expect, test, type Route } from "@playwright/test"

const server = "http://127.0.0.1:4097"

test("server dialog keeps focus above fullscreen settings", async ({ page }) => {
  await page.addInitScript((server) => {
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ list: [server] }))
  }, server)
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== server) return route.fallback()
    if (url.pathname === "/api/event") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'data: {"id":"evt_connected","type":"server.connected","data":{}}\n\n',
      })
    }
    if (url.pathname === "/api/global/health" || url.pathname === "/api/health") {
      return json(route, { healthy: true, version: "2.0.0" })
    }
    return json(route, {})
  })

  await page.goto("/")
  await page.keyboard.press("Control+,")
  const settings = page.getByTestId("settings-screen")
  await expect(settings).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  const add = settings.getByRole("button", { name: "Add server" })
  const group = settings.locator('[data-component="settings-nav-group-header"]').filter({ hasText: "Servers" })
  await expect(add).toHaveCSS("opacity", "0")
  await group.hover()
  await expect(add).toHaveCSS("opacity", "1")
  await add.click()

  const editor = page.getByRole("dialog", { name: "Add server" })
  await expect(editor.getByPlaceholder("http://localhost:4096")).toBeFocused()
  await expect(editor.getByPlaceholder("username")).toHaveCount(0)
  const name = editor.getByPlaceholder("Localhost", { exact: true })
  const password = editor.getByPlaceholder("password")
  await name.click()
  await expect(name).toBeFocused()
  await name.fill("Remote")
  await expect(name).toHaveValue("Remote")
  await page.keyboard.press("Tab")
  await expect(password).toBeFocused()
  await password.fill("secret")
  await expect(password).toHaveValue("secret")
  await page.keyboard.press("Escape")
  await expect(editor).toBeHidden()
  await expect(settings).toBeVisible()
})

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}
