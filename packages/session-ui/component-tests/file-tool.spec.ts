import { expect, story } from "../../storybook/playwright/story"

for (const theme of ["light", "dark"]) {
  story(`file tools share Patch's upfront file list in ${theme}`, async ({ mount }, info) => {
    const root = await mount("current-session-research-agents--agent-research", {
      args: { scenario: "workflow" },
      globals: { theme },
    })
    const group = root.locator('[data-component="collapsed-tool-group"]').filter({ hasText: "Patch" })
    const disclosure = group.getByRole("button", { name: /^Used \d+ .*Edit.*Write.*Patch$/ })
    await disclosure.click()
    for (const name of ["edit", "write", "patch"]) {
      const tool = group.locator(`[data-timeline-part-id="tool_family_${name}"]`)
      const file = tool.locator('[data-slot="accordion-trigger"]')
      await expect(file).toHaveAttribute("aria-expanded", "false")
      await expect(tool.locator('[data-component="file"]')).toHaveCount(0)
      await file.click()
      await expect(file).toHaveAttribute("aria-expanded", "true")
      await expect(tool.locator('[data-component="file"]')).toBeVisible()
      await expect(file).toBeFocused()
      await file.press("Space")
      await expect(file).toHaveAttribute("aria-expanded", "false")
      await file.press("Enter")
      await expect(file).toHaveAttribute("aria-expanded", "true")
    }
    await disclosure.click()
    await disclosure.click()
    for (const name of ["edit", "write", "patch"]) {
      const tool = group.locator(`[data-timeline-part-id="tool_family_${name}"]`)
      await expect(tool.locator('[data-slot="accordion-trigger"]')).toHaveAttribute("aria-expanded", "true")
      await expect(tool.locator('[data-component="file"]')).toBeVisible()
    }
    await root.screenshot({ path: info.outputPath(`file-tools-${theme}.png`) })
  })
}

for (const tool of ["edit", "write"]) {
  for (const controlled of [false, true]) {
    story(`${tool} supports forceOpen with ${controlled ? "controlled" : "local"} disclosure`, async ({ mount }) => {
      const root = await mount("current-session-file-changes--file-tool-fallbacks", {
        args: { tool, controlled, forceOpen: true },
      })
      await expect(root.getByRole("button", { name: /example\.ts/ })).toHaveAttribute("aria-expanded", "true")
      await expect(root.locator('[data-component="file"]')).toBeVisible()
    })
  }

  story(`${tool} preserves input fallback and disclosure through completion`, async ({ mount }) => {
    const root = await mount("current-session-file-changes--file-tool-fallbacks", { args: { tool } })
    const file = root.getByRole("button", { name: /example\.ts/ })
    await expect(file).toBeVisible()
    await expect(file).toHaveAttribute("aria-expanded", "false")
    await expect(root.getByText("1 file", { exact: true })).toBeVisible()
    await file.click()
    await expect(root.locator('[data-component="file"]')).toContainText(tool === "edit" ? "after" : "written")
    await root.getByRole("button", { name: "Complete file tool" }).click()
    await expect(root.getByText("Example diagnostic")).toBeVisible()
    await expect(file).toHaveAttribute("aria-expanded", "true")
    await file.click()
    await expect(file).toHaveAttribute("aria-expanded", "false")
    await expect(root.getByText("Example diagnostic")).toBeVisible()
  })
}

story("empty writes still show a file row", async ({ mount }) => {
  const root = await mount("current-session-file-changes--file-tool-fallbacks", {
    args: { tool: "write", empty: true },
  })
  await root.getByRole("button", { name: "Complete file tool" }).click()
  const file = root.getByRole("button", { name: /example\.ts/ })
  await expect(file).toHaveAttribute("aria-expanded", "false")
  await file.click()
  await expect(file).toHaveAttribute("aria-expanded", "true")
  await expect(root.locator('[data-component="file"]')).toBeAttached()
  await expect(file).toBeVisible()
})
