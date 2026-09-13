import { expect, test } from "@playwright/test"
import { sessionID, setupTimeline, userMessage } from "../performance/timeline-stability/fixture"

test("loads a patch only when an inline summary diff is expanded", async ({ page }) => {
  let requests = 0
  const diffRequests: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("diff")) diffRequests.push(request.url())
  })
  await setupTimeline(page, {
    messages: [
      userMessage(undefined, {
        summary: {
          additions: 1,
          deletions: 1,
          files: 1,
          diffs: [{ file: "src/changed.ts", additions: 1, deletions: 1, status: "modified" }],
        },
      }),
    ],
  })
  await page.route("**/*", async (route) => {
    if (!new URL(route.request().url()).pathname.endsWith(`/session/${sessionID}/diff`)) return route.fallback()
    requests++
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        {
          file: "src/changed.ts",
          patch: "@@ -1 +1 @@\n-before\n+from side table\n",
          additions: 1,
          deletions: 1,
          status: "modified",
        },
      ]),
    })
  })

  const trigger = page.locator('[data-slot="session-turn-diff-trigger"]').first()
  await expect(trigger).toBeVisible()
  expect(requests).toBe(0)

  await trigger.click()
  await expect.poll(() => ({ requests, diffRequests })).toEqual({ requests: 1, diffRequests: expect.any(Array) })
  await expect(page.getByText("from side table", { exact: true })).toBeVisible()
})
