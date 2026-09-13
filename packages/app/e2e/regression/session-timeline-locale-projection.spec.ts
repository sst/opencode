import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, toolPart, userMessage } from "../performance/timeline-stability/fixture"

for (const locale of ["de", "ar"] as const) {
  test(`projects localized tool names with an English fallback in ${locale}`, async ({ page }) => {
    const ids = [`prt_locale_${locale}_01_read`, `prt_locale_${locale}_02_glob`]
    await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage([
          toolPart(ids[0]!, "read", "completed", { path: "src/a.ts" }),
          toolPart(ids[1]!, "glob", "completed", { path: ".", pattern: "**/*.ts" }),
        ]),
      ],
      locale,
    })

    const group = page.locator(`[data-timeline-part-ids="${ids.join(",")}"]`)
    const names = locale === "de" ? "Lesen, Glob" : "\u0642\u0631\u0627\u0621\u0629, Glob"
    await expect(group.getByRole("button")).toHaveAccessibleName(`Used 2 ${names}`)
    await expect(group.locator('[data-slot="basic-tool-tool-title"]')).toHaveText(names)
    await expect(page.locator("html")).toHaveAttribute("lang", locale)
  })
}
