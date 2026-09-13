import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "/console-auth-project"
const location = { directory, project: { id: "proj_console", directory, canonical: directory } }
const provider = {
  id: "opencode",
  integrationID: "opencode",
  name: "Anomaly / OpenCode",
  activation: "enabled",
  package: "@ai-sdk/openai-compatible",
}
const secondProvider = {
  ...provider,
  id: "console-google",
  name: "Anomaly / Google",
  package: "@ai-sdk/google",
}
const model = {
  id: "sonnet",
  modelID: "sonnet",
  providerID: provider.id,
  name: "Console Sonnet",
  enabled: true,
  status: "active",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }],
  time: { released: 1700000000000 },
  limit: { context: 200000, output: 32000 },
}
const models = [
  model,
  ...Array.from({ length: 18 }, (_, index) => ({
    ...model,
    id: `model-${index + 2}`,
    modelID: `model-${index + 2}`,
    name: `Console Model ${index + 2}`,
  })),
  { ...model, id: "gemini", modelID: "gemini", providerID: secondProvider.id, name: "Console Gemini" },
]
const integration = {
  id: "opencode",
  name: "OpenCode",
  connections: [],
  methods: [
    { id: "device", type: "oauth", label: "OpenCode Console account" },
    { type: "key", label: "API key (service account)" },
  ],
}

async function fixture(
  page: Page,
  remote = false,
  options: {
    draft?: boolean | "tip" | "model picker" | "model command" | "manage models"
    browserFailed?: boolean
    slowStart?: Promise<void>
    existingConnection?: boolean
    singleProvider?: boolean
    multipleServers?: boolean
  } = {},
) {
  const state = {
    status: "pending",
    starts: 0,
    cancelled: [] as string[],
    models: true,
    modelError: false,
    statusError: false,
  }
  const server = remote ? "http://production.example:4096" : undefined
  const currentIntegration = {
    ...integration,
    connections: options.existingConnection ? [{ type: "env", name: "OPENCODE_API_KEY" }] : [],
  }
  await mockOpenCodeServer(page, {
    server,
    directory,
    provider: [],
    sessions: [],
    project: {
      id: "proj_console",
      canonical: directory,
      name: "Console test",
      time: { created: 1700000000000, updated: 1700000000000 },
    },
    pageMessages: () => ({ items: [] }),
  })
  await page
    .context()
    .route("https://console.example/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>Console fixture</title><p>Authorize access</p>" }),
    )
  await page.route("**/api/integration**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === "OPTIONS") return route.fallback()
    const headers = { "access-control-allow-origin": "*" }
    const json = (data: unknown) => route.fulfill({ headers, json: { location, data } })
    if (path === "/api/integration") return json([currentIntegration])
    if (path === "/api/integration/opencode") return json(currentIntegration)
    if (path === "/api/integration/opencode/connect/oauth") {
      expect(request.postDataJSON()).toEqual({ methodID: "device" })
      state.starts++
      if (options.slowStart) await options.slowStart
      return json({
        attemptID: `con_${state.starts}`,
        mode: "auto",
        instructions: "Confirmation code: TFXS-STXG",
        url: "https://console.example/device?user_code=TFXS-STXG&client_id=opencode-cli",
        time: { created: Date.now(), expires: Date.now() + 60000 },
      })
    }
    if (path.includes("/connect/oauth/con_")) {
      if (request.method() === "DELETE") {
        state.cancelled.push(path.split("/").pop()!)
        return route.fulfill({ status: 204, headers })
      }
      if (state.statusError) return route.fulfill({ status: 503, headers })
      return json({
        status: state.status,
        ...(state.status === "failed" ? { message: "Device authorization failed: access_denied" } : {}),
        time: { created: 0, expires: Date.now() + 60000 },
      })
    }
    return route.fallback()
  })
  await page.route("**/api/provider**", (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback()
    return route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: {
        location,
        data: state.status === "complete" ? [provider, ...(options.singleProvider ? [] : [secondProvider])] : [],
      },
    })
  })
  await page.route("**/api/model**", (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback()
    if (state.modelError) return route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" } })
    const available = state.status === "complete" && state.models
    return route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: {
        location,
        data: new URL(route.request().url()).pathname.endsWith("/default")
          ? available
            ? model
            : null
          : available
            ? options.singleProvider
              ? models.filter((model) => model.providerID === provider.id)
              : models
            : [],
      },
    })
  })
  await page.addInitScript(
    ({ directory, server }) => {
      if (server) localStorage.setItem("opencode.settings.dat:defaultServerUrl", server)
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: server ? [{ type: "http", displayName: "Production server", http: { url: server } }] : [],
          projects: { [server ?? "local"]: [{ worktree: directory, expanded: true }] },
        }),
      )
    },
    { directory, server },
  )
  const params = new URLSearchParams()
  if (server) params.set("server", server)
  if (options.browserFailed) params.set("browserFailed", "1")
  if (options.multipleServers) params.set("multipleServers", "1")
  await page.goto(`/e2e/desktop/index.html?${params}`)
  const dialog = page.locator('[data-component="dialog-v2"]').getByRole("dialog")
  if (options.draft) {
    await page.keyboard.press("Control+t")
    const composer = page.locator('[data-component="composer-editor"]')
    await expect(composer).toBeEditable()
    await composer.fill("Keep this draft throughout sign-in")
    await expect(page.locator('[data-component="provider-setup"]')).toBeVisible()
    await expect(page.locator('[data-component="new-session-tip"]')).toContainText("Connect to 75+ providers")
    if (options.draft === "tip") {
      await page
        .locator('[data-component="new-session-tip"]')
        .getByRole("button", { name: "Connect to 75+ providers" })
        .click()
    }
    if (options.draft === "model picker") await page.locator('[data-action="composer-model"]').click()
    if (options.draft === "model command" || options.draft === "manage models") {
      await page.keyboard.press("Control+'")
      if (options.draft === "manage models") {
        await dialog.getByRole("button", { name: "Manage models", exact: true }).click()
        await expect(dialog.getByRole("heading", { name: "Manage models", exact: true })).toBeVisible()
      }
      await dialog.getByRole("button", { name: "Connect provider", exact: true }).click()
    }
    if (options.draft !== true) await dialog.getByRole("button", { name: /^OpenCode / }).click()
    await page.getByRole("button", { name: "Continue with OpenCode Console" }).click()
    await expect(dialog.getByRole("group", { name: "Device code: TFXS-STXG" })).toBeVisible()
    return { state, dialog }
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  if (options.multipleServers) await page.getByRole("tab", { name: "Production server", exact: true }).click()
  await page.getByRole("tab", { name: "Providers", exact: true }).click()
  // Use the picker so this also exercises the existing Settings entry point.
  await page.getByRole("button", { name: "Show more providers", exact: true }).click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^OpenCode / })
    .click()
  await expect(dialog.getByRole("button", { name: "Continue with OpenCode Console" })).toBeEnabled()
  return { state, dialog }
}

test("Console account is primary and the code is displayed without a copy-code step", async ({ page }) => {
  const { state, dialog } = await fixture(page)
  await expect(dialog.getByRole("heading", { name: "Connect OpenCode Console", exact: true })).toBeVisible()
  await expect(dialog.getByText("Service account?", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Use API key", exact: true })).toBeVisible()
  const shell = await dialog.boundingBox()
  const back = await dialog.getByRole("button", { name: "Navigate back" }).boundingBox()
  const heading = await dialog.getByRole("heading", { name: "Connect OpenCode Console" }).boundingBox()
  const logo = await dialog.locator('[data-component="opencode-logo"]').boundingBox()
  const description = await dialog
    .getByText("Sign in once to use the models available through your OpenCode account.")
    .boundingBox()
  const primary = await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).boundingBox()
  const service = await dialog.locator('[data-component="console-service-account"]').boundingBox()
  if (!shell || !back || !heading || !logo || !description || !primary || !service)
    throw new Error("Missing dialog layout")
  expect(shell.height).toBe(512)
  expect(back.x - shell.x).toBe(20)
  expect(back.y - shell.y).toBe(16)
  expect(heading.y - (back.y + back.height)).toBe(12)
  expect(logo.y + logo.height / 2).toBe(heading.y + heading.height / 2)
  expect(description.y - (heading.y + heading.height)).toBe(24)
  expect(primary.y - (description.y + description.height)).toBe(20)
  expect(service.y - (primary.y + primary.height)).toBe(20)
  await page.screenshot({ path: test.info().outputPath("connect-console-light.png") })
  const popup = page.waitForEvent("popup")
  await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).click()
  const consolePage = await popup
  await expect(consolePage).toHaveURL(/user_code=TFXS-STXG/)
  await expect(consolePage).toHaveURL(/client_id=opencode-desktop/)
  await expect(consolePage).toHaveURL(/return_window=console-auth-fixture/)
  await expect(
    dialog.getByText("Continue in your browser. Confirm the code shown there matches the one below."),
  ).toBeVisible()
  await expect(dialog.getByRole("group", { name: "Device code: TFXS-STXG" })).toBeVisible()
  await expect(dialog.getByRole("textbox")).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Copy sign-in link" })).toBeVisible()
  const authHeading = await dialog.getByRole("heading", { name: "Connect OpenCode Console account" }).boundingBox()
  const authDescription = await dialog
    .getByText("Continue in your browser. Confirm the code shown there matches the one below.")
    .boundingBox()
  const label = await dialog.getByText("Device code", { exact: true }).boundingBox()
  const code = await dialog.getByRole("group", { name: "Device code: TFXS-STXG" }).boundingBox()
  const waiting = await dialog.getByRole("status").boundingBox()
  const fallback = await dialog.locator('[data-component="console-browser-fallback"]').boundingBox()
  const authShell = await dialog.boundingBox()
  if (!authHeading || !authDescription || !label || !code || !waiting || !fallback || !authShell)
    throw new Error("Missing authorization layout")
  expect(authDescription.y - (authHeading.y + authHeading.height)).toBe(24)
  expect(label.y - (authDescription.y + authDescription.height)).toBe(20)
  expect(code.y - (label.y + label.height)).toBe(8)
  expect(code.height).toBe(48)
  expect(waiting.y - (code.y + code.height)).toBe(8)
  expect(fallback.y - (waiting.y + waiting.height)).toBe(20)
  expect(authShell.height).toBeLessThan(512)
  expect(authShell.y + authShell.height - (fallback.y + fallback.height)).toBe(16)
  await page.screenshot({ path: test.info().outputPath("console-auth-light.png") })
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
  await page.screenshot({ path: test.info().outputPath("console-auth-dark.png") })
  state.status = "complete"
  await expect(dialog.getByRole("heading", { name: "Connected to OpenCode" })).toBeVisible()
  const list = dialog.getByRole("radiogroup", { name: "Models available from OpenCode" })
  await expect(dialog.getByRole("button", { name: "Anomaly / OpenCode", exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Anomaly / Google", exact: true })).toBeVisible()
  await expect(list.getByRole("radio")).toHaveCount(models.length)
  await page.mouse.move(0, 0)
  const first = list.getByRole("radio", { name: "Console Sonnet" })
  await expect(first).toBeChecked()
  await expect(first).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(dialog.locator('[data-component="settings-list"]')).toHaveCount(2)
  await expect(first.locator('[data-slot="settings-row-title"]')).toHaveCSS("font-weight", "440")
  await expect(first).toHaveCSS("border-radius", "0px")
  const providerHeading = dialog.locator(".settings-models-group-header").filter({ hasText: "Anomaly / OpenCode" })
  await expect(providerHeading).toHaveCSS("position", "sticky")
  await expect(providerHeading).toHaveCSS("padding-bottom", "0px")
  const google = dialog.getByRole("button", { name: "Anomaly / Google", exact: true })
  const googleHeading = dialog.locator(".settings-models-group-header").filter({ hasText: "Anomaly / Google" })
  await google.click()
  await expect(googleHeading).toHaveCSS("padding-bottom", "8px")
  await google.click()
  await expect(googleHeading).toHaveCSS("padding-bottom", "0px")
  await expect(dialog.locator('[data-slot="dialog-header"]')).toHaveCSS("padding-top", "20px")
  const hovered = list.getByRole("radio", { name: "Console Model 3" })
  await hovered.hover()
  await expect(hovered).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)")
  await expect(list.getByRole("radio", { name: "Console Model 2" })).toHaveCSS(
    "border-bottom-color",
    "rgba(0, 0, 0, 0)",
  )
  await page.screenshot({ path: test.info().outputPath("first-provider-models-dark.png") })
  await list.getByRole("radio", { name: "Console Model 2" }).click()
  await expect(list.getByRole("radio", { name: "Console Model 2" })).toBeChecked()
  const scroll = dialog.locator('[data-component="first-provider-model-scroll"]')
  const footer = dialog.locator('[data-component="first-provider-model-footer"]')
  const footerBefore = await footer.boundingBox()
  expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await scroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect(list.getByRole("radio", { name: models.at(-1)!.name })).toBeInViewport()
  expect(await footer.boundingBox()).toEqual(footerBefore)
  await dialog.getByRole("button", { name: "Continue", exact: true }).click()
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
  await expect(page.locator('[data-action="composer-model"]')).toContainText("Console Model 2")
  expect(state.starts).toBe(1)
  expect(state.cancelled).toEqual([])
})

test("Manage models opens the Models settings page", async ({ page }) => {
  const { state, dialog } = await fixture(page)
  await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).click()
  await expect(dialog.getByRole("group", { name: "Device code: TFXS-STXG" })).toBeVisible()
  state.status = "complete"
  await expect(dialog.getByRole("heading", { name: "Connected to OpenCode" })).toBeVisible()
  await dialog.getByRole("button", { name: "Manage models", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("tab", { name: "Models", exact: true })).toHaveAttribute("aria-selected", "true")
})

test("Manage models keeps the connected server in multi-server settings", async ({ page }) => {
  const { state, dialog } = await fixture(page, true, { multipleServers: true })
  await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).click()
  await expect(dialog.getByRole("group", { name: "Device code: TFXS-STXG" })).toBeVisible()
  state.status = "complete"
  await expect(dialog.getByRole("heading", { name: "Connected to OpenCode" })).toBeVisible()
  await dialog.getByRole("button", { name: "Manage models", exact: true }).click()
  await expect(dialog).toBeHidden()
  const settings = page.getByTestId("settings-screen")
  await expect(settings.getByRole("tab", { name: "Production server", exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Models", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(settings.getByRole("switch", { name: "Console Gemini", exact: true })).toBeEnabled()
})

for (const multipleServers of [false, true]) {
  test(`Console provider links reveal their models with ${multipleServers ? "multiple servers" : "one server"}`, async ({
    page,
  }) => {
    const { state, dialog } = await fixture(page, multipleServers, { existingConnection: true, multipleServers })
    await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).click()
    await expect(dialog.getByRole("group", { name: "Device code: TFXS-STXG" })).toBeVisible()
    state.status = "complete"
    await expect(dialog).toBeHidden()
    const settings = page.getByTestId("settings-screen")
    await expect(settings.getByRole("tab", { name: "Providers", exact: true })).toHaveAttribute("aria-selected", "true")
    await settings.locator(".settings-provider-console-toggle").click()
    await settings.getByRole("button", { name: "Google", exact: true }).click()
    await expect(settings.getByRole("tab", { name: "Models", exact: true })).toHaveAttribute("aria-selected", "true")
    const google = settings.getByRole("button", { name: "Anomaly / Google", exact: true })
    await expect(google).toHaveAttribute("aria-expanded", "true")
    await expect(google).toBeFocused()
    await expect(settings.getByRole("switch", { name: "Console Gemini", exact: true })).toBeEnabled()
    await expect(settings.getByRole("button", { name: "Anomaly / OpenCode", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    )
  })
}

test("a single connected provider has a non-collapsible heading", async ({ page }) => {
  const { state, dialog } = await fixture(page, false, { singleProvider: true })
  await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).click()
  await expect(dialog.getByRole("group", { name: "Device code: TFXS-STXG" })).toBeVisible()
  state.status = "complete"
  await expect(dialog.getByRole("heading", { name: "Connected to OpenCode" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Anomaly / OpenCode", exact: true })).toHaveCount(0)
  await expect(dialog.getByText("Anomaly / OpenCode", { exact: true })).toBeVisible()
})

test("model choice is skipped after a provider has already been connected", async ({ page }) => {
  const { state, dialog } = await fixture(page, false, { existingConnection: true })
  await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).click()
  await expect(dialog.getByRole("group", { name: "Device code: TFXS-STXG" })).toBeVisible()
  state.status = "complete"
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("tab", { name: "Providers", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByText("OpenCode Console connected", { exact: true })).toBeVisible()
})

test("service-account API key form matches the Console dialog layout", async ({ page }) => {
  const { dialog } = await fixture(page)
  const initialShell = await dialog.boundingBox()
  await dialog.getByRole("button", { name: "Use API key", exact: true }).click()
  await expect(dialog.getByRole("heading", { name: "Connect OpenCode Console", exact: true })).toBeVisible()
  const description = dialog.getByText("Connect using a service-account API key from OpenCode Console.")
  const label = dialog.locator('[data-component="provider-api-key-label"]')
  const input = dialog.getByLabel("OpenCode Console API key", { exact: true })
  const button = dialog.getByRole("button", { name: "Continue", exact: true })
  await expect(input).toBeFocused()
  const shell = await dialog.boundingBox()
  const heading = await dialog.getByRole("heading", { name: "Connect OpenCode Console" }).boundingBox()
  const descriptionBox = await description.boundingBox()
  const labelBox = await label.boundingBox()
  const fieldBox = await input.locator("..").locator("..").boundingBox()
  const buttonBox = await button.boundingBox()
  if (!shell || !heading || !descriptionBox || !labelBox || !fieldBox || !buttonBox)
    throw new Error("Missing API key dialog layout")
  if (!initialShell) throw new Error("Missing initial Console dialog layout")
  expect(shell.height).toBe(512)
  expect(shell.height).toBe(initialShell.height)
  expect(descriptionBox.y - (heading.y + heading.height)).toBe(24)
  expect(labelBox.y - (descriptionBox.y + descriptionBox.height)).toBe(20)
  expect(fieldBox.y - (labelBox.y + labelBox.height)).toBe(8)
  expect(buttonBox.y - (fieldBox.y + fieldBox.height)).toBe(20)
  await page.screenshot({ path: test.info().outputPath("console-api-key-light.png") })
})

test("setup preserves the draft and Continue restores composer focus", async ({ page }) => {
  const { state, dialog } = await fixture(page, false, { draft: true })
  state.status = "complete"
  await expect(dialog.getByRole("heading", { name: "Connected to OpenCode" })).toBeVisible()
  await dialog.getByRole("button", { name: "Continue", exact: true }).click()
  const composer = page.locator('[data-component="composer-editor"]')
  await expect(composer).toHaveText("Keep this draft throughout sign-in")
  await expect(composer).toBeFocused()
  await expect(page.locator('[data-action="composer-model"]')).toContainText("Console Sonnet")
  await expect(page.locator('[data-component="provider-setup"]')).toBeHidden()
})

for (const entry of ["tip", "model picker", "model command", "manage models"] as const) {
  test(`connecting from the ${entry} preserves the existing draft and selected model`, async ({ page }) => {
    const { state, dialog } = await fixture(page, false, { draft: entry })
    await expect(page.locator("[data-titlebar-tab]")).toHaveCount(1)
    state.status = "complete"
    await expect(dialog.getByRole("heading", { name: "Connected to OpenCode" })).toBeVisible()
    const selected = dialog.getByRole("radio", { name: "Console Model 2", exact: true })
    await selected.click()
    await expect(selected).toBeChecked()
    await dialog.getByRole("button", { name: "Continue", exact: true }).click()
    await expect(dialog).toBeHidden()
    const composer = page.locator('[data-component="composer-editor"]')
    await expect(composer).toHaveText("Keep this draft throughout sign-in")
    await expect(composer).toBeFocused()
    await expect(page.locator("[data-titlebar-tab]")).toHaveCount(1)
    await expect(page.locator('[data-action="composer-model"]')).toContainText("Console Model 2")
  })
}

test("catalog refresh failure retries without asking for authorization again", async ({ page }) => {
  const { state, dialog } = await fixture(page)
  await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).click()
  await expect(dialog.getByRole("group", { name: "Device code: TFXS-STXG" })).toBeVisible()
  state.modelError = true
  state.status = "complete"
  await expect(dialog.getByRole("alert")).toContainText("Your account is connected, but we couldn't load your models")
  state.modelError = false
  await dialog.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(dialog.getByRole("heading", { name: "Connected to OpenCode" })).toBeVisible()
  expect(state.starts).toBe(1)
})

test("status request failure resumes the existing attempt", async ({ page }) => {
  const { state, dialog } = await fixture(page)
  state.statusError = true
  await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  state.statusError = false
  state.status = "complete"
  await dialog.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(dialog.getByRole("heading", { name: "Connected to OpenCode" })).toBeVisible()
  expect(state.starts).toBe(1)
  expect(state.cancelled).toEqual([])
})

test("closing during authorization startup cancels the late server attempt", async ({ page }) => {
  const start = Promise.withResolvers<void>()
  const { state, dialog } = await fixture(page, false, { slowStart: start.promise })
  await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).click()
  await expect.poll(() => state.starts).toBe(1)
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(dialog).toBeHidden()
  start.resolve()
  await expect.poll(() => state.cancelled).toEqual(["con_1"])
})

test("authorization startup stays on the Continue button until the device code is ready", async ({ page }) => {
  const start = Promise.withResolvers<void>()
  const { dialog } = await fixture(page, false, { slowStart: start.promise })
  const button = dialog.getByRole("button", { name: "Continue with OpenCode Console" })
  await button.click()
  await expect(dialog.getByRole("button", { name: "Opening browser…" })).toHaveAttribute("aria-busy", "true")
  await expect(dialog.getByRole("heading", { name: "Connect OpenCode Console" })).toBeVisible()
  await expect(dialog.getByRole("group", { name: /Device code/ })).toHaveCount(0)
  start.resolve()
  await expect(dialog.getByRole("group", { name: "Device code: TFXS-STXG" })).toBeVisible()
})

test("browser failure offers a copyable sign-in link in a narrow RTL window", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  const { dialog } = await fixture(page, false, { browserFailed: true })
  await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).click()
  await expect(dialog.getByText(/We couldn't open your browser/)).toBeVisible()
  await page.setViewportSize({ width: 380, height: 650 })
  await page.evaluate(() => {
    document.documentElement.dir = "rtl"
  })
  const code = dialog.getByRole("group", { name: "Device code: TFXS-STXG" })
  await expect(code).toHaveCSS("direction", "ltr")
  await expect(code).toBeInViewport()
  await dialog.getByRole("button", { name: "Copy sign-in link" }).click()
  await expect(dialog.getByRole("button", { name: "Sign-in link copied" })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "https://console.example/device?user_code=TFXS-STXG&client_id=opencode-desktop&return_window=console-auth-fixture",
  )
  await expect(dialog.getByRole("button", { name: "Open Console again" })).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath("console-auth-narrow-rtl.png") })
})

test("cancel releases the server attempt and retrying expiration creates a new attempt", async ({ page }) => {
  const { state, dialog } = await fixture(page)
  await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).click()
  await expect(dialog.getByRole("group", { name: "Device code: TFXS-STXG" })).toBeVisible()
  state.status = "expired"
  await expect(dialog.getByRole("alert")).toContainText("has expired")
  state.status = "pending"
  await dialog.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(dialog.getByRole("group", { name: "Device code: TFXS-STXG" })).toBeVisible()
  await expect.poll(() => state.starts).toBe(2)
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect.poll(() => state.cancelled).toEqual(["con_1", "con_2"])
})

test("an authorized workspace without models stays connected and can refresh", async ({ page }) => {
  const { state, dialog } = await fixture(page)
  state.models = false
  await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).click()
  await expect(dialog.getByRole("group", { name: "Device code: TFXS-STXG" })).toBeVisible()
  state.status = "complete"
  await expect(dialog.getByText(/this Console workspace has no available models/)).toBeVisible()
  state.models = true
  await dialog.getByRole("button", { name: "Refresh models" }).click()
  await expect(dialog.getByRole("heading", { name: "Connected to OpenCode" })).toBeVisible()
  expect(state.starts).toBe(1)
})

test("remote disclosure precedes authorization and all auth requests target that server", async ({ page }) => {
  const { state, dialog } = await fixture(page, true)
  await expect(dialog.getByRole("note")).toContainText("Connecting on “Production server”")
  await expect(dialog.getByRole("note")).toContainText("credentials will be stored on this server")
  expect(state.starts).toBe(0)
  const request = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().includes("/connect/oauth"),
  )
  await dialog.getByRole("button", { name: "Continue with OpenCode Console" }).click()
  expect(new URL((await request).url()).origin).toBe("http://production.example:4096")
  await expect(dialog.getByRole("group", { name: "Device code: TFXS-STXG" })).toBeVisible()
  const cancelled = page.waitForRequest(
    (request) => request.method() === "DELETE" && request.url().includes("/connect/oauth"),
  )
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  expect(new URL((await cancelled).url()).origin).toBe("http://production.example:4096")
})
