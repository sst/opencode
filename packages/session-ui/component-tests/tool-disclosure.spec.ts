import { expect, story } from "../../storybook/playwright/story"

for (const open of [true, false]) {
  story(
    `preserves ${open ? "expanded" : "collapsed"} tool choices when calls join the group`,
    async ({ mount }, info) => {
      const root = await mount("current-session-file-changes--appending-tool-calls")
      const group = root.locator('[data-component="collapsed-tool-group"]')
      const trigger = group.getByRole("button", { name: /^Used \d+ Shell, Patch$/ })
      await expect(trigger).toHaveAccessibleName("Used 2 Shell, Patch")
      await trigger.click()
      const shell = group.locator('[data-timeline-part-id="tool_shell_existing"] [data-slot="collapsible-trigger"]')
      await group.locator('[data-timeline-part-id="tool_patch_existing"]').evaluate((element) => {
        element.setAttribute("data-disclosure-probe", "existing")
      })
      const patch = group.locator('[data-disclosure-probe="existing"]')
      const first = patch.locator('[data-scope="apply-patch"] button').filter({ hasText: "a.ts" })
      const second = patch.locator('[data-scope="apply-patch"] button').filter({ hasText: "b.ts" })
      const diff = patch.locator('[data-type="update"]').filter({ hasText: "b.ts" }).locator('[data-component="file"]')
      await shell.click()
      await first.click()
      await second.click()
      if (!open) {
        await shell.click()
        await first.click()
      }
      await expect(shell).toHaveAttribute("aria-expanded", String(open))
      await expect(first).toHaveAttribute("aria-expanded", String(open))
      await expect(second).toHaveAttribute("aria-expanded", "true")
      await expect(diff).toBeVisible()
      const original = await patch.elementHandle()
      for (const count of [3, 4]) {
        await root.getByRole("button", { name: "Append tool call", exact: true }).click()
        await expect(
          group.locator('[data-component="context-tool-group-trigger"] [data-slot="basic-tool-tool-title"]'),
        ).toHaveText("Shell, Patch")
        await expect(trigger).toHaveAccessibleName(`Used ${count} Shell, Patch`)
        await expect(diff).toBeVisible()
        await root
          .locator('[data-component="session-timeline"]')
          .screenshot({ path: info.outputPath(`append-${count}.png`) })
        await expect(shell).toHaveAttribute("aria-expanded", String(open))
        await expect(first).toHaveAttribute("aria-expanded", String(open))
        await expect(second).toHaveAttribute("aria-expanded", "true")
        expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
        await expect(trigger).toHaveAttribute("aria-expanded", "true")
      }
    },
  )
}
