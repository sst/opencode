import { fileURLToPath } from "node:url"
import { expect, story } from "../../storybook/playwright/story"

const fixture = `/@fs/${fileURLToPath(new URL("./browser-pane.fixture.tsx", import.meta.url)).replaceAll("\\", "/")}`

story.beforeEach(async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--mixed-attachments")
  await expect(component.getByRole("textbox", { name: "Prompt", exact: true })).toBeVisible()
  await page.evaluate(async (fixture) => {
    const { mountBrowserPane } = await import(fixture)
    mountBrowserPane()
  }, fixture)
  await expect(page.getByTestId("native-Alpha")).toHaveAttribute("data-visible", "true")
})

story("hides the previous registration when the mounted pane switches sessions", async ({ page }, testInfo) => {
  const root = page.getByTestId("browser-pane-fixture")
  await root.getByRole("button", { name: "Beta", exact: true }).click()
  await expect(root.getByTestId("native-Beta")).toHaveAttribute("data-visible", "true")
  await expect(root.getByTestId("native-Alpha")).toHaveAttribute("data-visible", "false")
  await page.screenshot({ path: testInfo.outputPath("session-switch.png") })
  await root.getByRole("button", { name: "Alpha", exact: true }).click()
  await expect(root.getByTestId("native-Alpha")).toHaveAttribute("data-visible", "true")
  await expect(root.getByTestId("native-Beta")).toHaveAttribute("data-visible", "false")
})

story("hides the outgoing browser when the destination has no browser pane", async ({ page }) => {
  const root = page.getByTestId("browser-pane-fixture")
  await root.getByRole("button", { name: "Empty", exact: true }).click()
  await expect(root.locator("#browser-panel")).toHaveCount(0)
  await expect(root.getByTestId("native-Alpha")).toHaveAttribute("data-visible", "false")
  await root.getByRole("button", { name: "Alpha", exact: true }).click()
  await expect(root.getByTestId("native-Alpha")).toHaveAttribute("data-visible", "true")
})

story("hides and restores the same registration for Review tabs and unmount", async ({ page }) => {
  const root = page.getByTestId("browser-pane-fixture")
  await root.getByRole("button", { name: "Toggle Review tab", exact: true }).click()
  await expect(root.getByTestId("native-Alpha")).toHaveAttribute("data-visible", "false")
  await root.getByRole("button", { name: "Toggle Review tab", exact: true }).click()
  await expect(root.getByTestId("native-Alpha")).toHaveAttribute("data-visible", "true")
  await root.getByRole("button", { name: "Unmount pane", exact: true }).click()
  await expect(root.getByTestId("native-Alpha")).toHaveAttribute("data-visible", "false")
})
