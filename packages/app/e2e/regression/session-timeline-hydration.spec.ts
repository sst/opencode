import type { SessionMessageInfo } from "@opencode/client/promise"
import { expect, test } from "@playwright/test"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import { stressSessionHref } from "../performance/timeline/timeline-test-helpers"
import { mockOpenCodeServer } from "../utils/mock-server"

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" })

for (const window of ["assistant-only", "mixed"] as const) {
  test(`renders the ${window} latest page before parent hydration and preserves it afterward`, async ({ page }) => {
    const session = { ...fixture.sessions[0]!, id: `ses_hydration_${window}` }
    // Compact's initial 40 and the next 20 begin with an assistant; page three supplies its parent.
    const messages = Array.from({ length: 61 }, (_, index): SessionMessageInfo => {
      const id = `msg_hydration_${index}`
      const time = { created: 1700000000000 + index * 1_000 }
      if (index === 0 || (window === "mixed" && index === 59))
        return { id, type: "user", time, text: `Prompt ${index}` }
      return {
        id,
        type: "assistant",
        time: { ...time, completed: time.created + 500 },
        model: { id: "claude-opus-4-6", providerID: "opencode" },
        agent: "build",
        content: [{ type: "text", text: index === 60 ? "## Hydrated tail\n\n**Ready.**" : `Answer ${index}` }],
      }
    })
    const gates = [21, 1].map((index) => ({
      before: messages[index]!.id,
      parent: messages[index === 21 ? 1 : 0]!.id,
      requested: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    }))
    const requests: (string | undefined)[] = []
    await mockOpenCodeServer(page, {
      ...fixture,
      sessions: [session],
      beforeMessagesResponse: async ({ before }) => {
        requests.push(before)
        if (!before) return
        const gate = gates.find((gate) => gate.before === before)
        if (!gate) throw new Error(`Unexpected older-page boundary: ${before}`)
        gate.requested.resolve()
        await gate.release.promise
      },
      pageMessages: (_, limit, before) => {
        expect(limit).toBe(before ? 20 : 40)
        const end = before ? messages.findIndex((message) => message.id === before) : messages.length
        const start = Math.max(0, end - limit)
        return { items: messages.slice(start, end), cursor: start > 0 ? messages[start]!.id : undefined }
      },
    })
    const tail = page.locator('[data-timeline-part-id="msg_hydration_60:text:0"]')
    const markdown = tail.locator('[data-component="markdown"]')
    const content = page.locator("[data-timeline-virtual-content]", { has: tail })
    const viewport = page.locator(".scroll-view__viewport", { has: tail })
    const orphan = page.locator('[data-timeline-row="AssistantPart"]', {
      has: page.locator('[data-timeline-part-id="msg_hydration_58:text:0"]'),
    })
    const expectReadyTail = async () => {
      await expect(content).toHaveCSS("visibility", "visible")
      await expect(markdown).toHaveAttribute("data-markdown-ready", "")
      await expect(markdown.getByRole("heading", { name: "Hydrated tail", exact: true })).toBeInViewport({ ratio: 1 })
      await expect
        .poll(() =>
          viewport.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop)),
        )
        .toBeLessThanOrEqual(1)
    }

    try {
      await page.goto(stressSessionHref(session.id))
      await gates[0]!.requested.promise
      // This must pass while the first older response is still held.
      await expectReadyTail()
      await expect(orphan).toHaveAttribute("data-message-id", "msg_hydration_21")
      if (window === "mixed")
        await expect(
          page.locator('[data-timeline-row="UserMessage"][data-message-id="msg_hydration_59"]'),
        ).toBeInViewport()
      const original = await markdown.elementHandle()

      for (const gate of gates) {
        await gate.requested.promise
        gate.release.resolve()
        // Parent ownership proves the page reached the projection, not just the network.
        await expect(orphan).toHaveAttribute("data-message-id", gate.parent)
        await expectReadyTail()
        expect(await markdown.evaluate((element, original) => element === original, original)).toBe(true)
      }
      expect(requests).toEqual([undefined, ...gates.map((gate) => gate.before)])
      const ids = await content
        .locator("[data-timeline-part-id]")
        .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-timeline-part-id")))
      expect(new Set(ids).size).toBe(ids.length)
    } finally {
      gates.forEach((gate) => gate.release.resolve())
    }
  })
}
