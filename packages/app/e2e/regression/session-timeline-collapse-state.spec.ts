import { expect, test, type Locator, type Page } from "@playwright/test"
import type { JsonValue, OpenCodeEvent, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client/promise"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"
import { createTwoFilesPatch } from "diff"

const directory = "C:/OpenCode/TimelineStateRegression"
const projectID = "proj_timeline_state_regression"
const sessionID = "ses_timeline_state_regression"
const userMessageID = "msg_user_regression"
const assistantMessageID = "msg_assistant_regression"
const editPartID = "prt_0001_edit"
const textPartID = `${assistantMessageID}:text:0`
const title = "Timeline collapse state regression"
const model = { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" }

type EventPayload = OpenCodeEvent

declare global {
  interface Window {
    __timelineDiffProbe: {
      reset: () => void
      shadowRoots: () => number
    }
  }
}

const userMessage = {
  id: userMessageID,
  type: "user",
  time: { created: 1700000000000 },
  text: "Please edit the file.",
} satisfies SessionMessageInfo

const editPart = {
  id: editPartID,
  sessionID,
  messageID: assistantMessageID,
  type: "tool",
  callID: editPartID,
  tool: "edit",
  state: {
    status: "completed",
    input: {
      path: "src/regression.ts",
      oldString: "export const value = 'before'",
      newString: "export const value = 'after'",
    },
    output: "Edited src/regression.ts",
    title: "src/regression.ts",
    metadata: {
      files: [
        {
          file: "src/regression.ts",
          patch: createTwoFilesPatch(
            "a/src/regression.ts",
            "b/src/regression.ts",
            "export const value = 'before'\n",
            "export const value = 'after'\n",
          ),
          additions: 1,
          deletions: 1,
          status: "modified",
        },
      ],
    },
    time: { start: 1700000001000, end: 1700000002000 },
  },
}

const streamedTextPart = {
  text: "Streaming added a later assistant text part.",
}

const assistantMessage = {
  id: assistantMessageID,
  type: "assistant",
  time: { created: 1700000001000 },
  model: { id: model.modelID, providerID: model.providerID, variant: model.variant },
  agent: "build",
  cost: 0.01,
  tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
  content: [toolContent(editPart)],
} satisfies SessionMessageInfo

test.describe("regression: session timeline local row state", () => {
  test("preserves a patch file choice as new calls join its Used group", async ({ page }) => {
    const events: EventPayload[] = []
    const part = { ...editPart, tool: "patch" }
    await mockServer(page, events, [userMessage, { ...assistantMessage, content: [toolContent(part)] }])
    await configurePage(page, false)
    await page.goto(sessionHref())
    await expectSessionTitle(page, title)

    const group = page.locator('[data-component="collapsed-tool-group"]')
    const summary = group.getByRole("button", { name: /^Used \d+ Patch$/ })
    await expect(summary).toHaveAccessibleName("Used 1 Patch")
    await summary.click()
    await group.locator(`[data-timeline-part-id="${editPartID}"]`).evaluate((element) => {
      element.setAttribute("data-disclosure-probe", "existing")
    })
    const wrapper = group.locator('[data-disclosure-probe="existing"]')
    const trigger = wrapper.locator('[data-scope="apply-patch"] button')
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
    await trigger.click()
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    const original = await wrapper.elementHandle()

    for (const count of [2, 3]) {
      if (count === 3) await trigger.click()
      const id = `prt_patch_${count}`
      events.push(...toolEvents({ ...part, id, callID: id }))
      await expect(summary).toHaveAccessibleName(`Used ${count} Patch`)
      await expect(summary.locator('[data-slot="basic-tool-tool-title"]')).toHaveText("Patch")
      await expect(group).toHaveAttribute("data-timeline-part-ids", new RegExp(`${id}$`))
      await expect(trigger).toHaveAttribute("aria-expanded", String(count === 2))
      await expect(summary).toHaveAttribute("aria-expanded", "true")
      expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
    }
  })

  test("keeps a manually collapsed tool collapsed when later assistant content streams", async ({ page }) => {
    const events: EventPayload[] = []
    await mockServer(page, events)
    await configurePage(page)

    await page.goto(sessionHref())
    await expectSessionTitle(page, title)

    const wrapper = page.locator(`[data-timeline-part-id="${editPartID}"]`).first()
    await expectAppVisible(wrapper)
    await expectExpanded(wrapper, true)

    await wrapper.evaluate((element) => {
      ;(element as HTMLElement).dataset.regressionMarker = "before-stream"
    })
    await wrapper.locator('[data-scope="apply-patch"] button').click()
    await expectExpanded(wrapper, false)

    events.push(...textEvents())

    await expect(page.locator(`[data-timeline-part-id="${assistantMessageID}:text:0"]`).first()).toBeVisible({
      timeout: 10_000,
    })

    expect(await readToolState(page)).toEqual({
      expanded: false,
      row: "AssistantPart",
      streamedTextVisible: true,
    })
  })

  test("does not remount an edit diff when a sibling part arrives", async ({ page }) => {
    const events: EventPayload[] = []
    await installDiffProbe(page)
    await mockServer(page, events)
    await configurePage(page)

    await page.goto(sessionHref())
    await expectSessionTitle(page, title)

    const wrapper = page.locator(`[data-timeline-part-id="${editPartID}"]`).first()
    await expectAppVisible(wrapper)
    const file = wrapper.locator('[data-component="file"][data-mode="diff"]').first()
    await expectAppVisible(file)
    await markDiffProbe(page)

    events.push(...textEvents())

    await expect(page.locator(`[data-timeline-part-id="${assistantMessageID}:text:0"]`).first()).toBeVisible({
      timeout: 10_000,
    })
    const siblingProbe = await readDiffProbe(page)
    expect(siblingProbe).toEqual({
      fileMarker: "before",
      frameMarker: "before",
      rowKey: `assistant-part:file:part:${assistantMessageID}:${editPartID}`,
      rowMarker: "before",
      shadowRoots: 0,
      toolMarker: "before",
    })
  })

  test("keeps a sticky edit header aligned with a multi-hunk diff", async ({ page }) => {
    const events: EventPayload[] = []
    const lines = Array.from({ length: 1_000 }, (_, index) => `export const value${index} = ${index}\n`).join("")
    const after = [100, 300, 500, 700, 900].reduce(
      (result, index) =>
        result.replace(`export const value${index} = ${index}`, `export const value${index} = compute(${index})`),
      lines,
    )
    const part = {
      ...editPart,
      state: {
        ...editPart.state,
        metadata: {
          ...editPart.state.metadata,
          files: [
            {
              file: "src/regression.ts",
              patch: createTwoFilesPatch("a/src/regression.ts", "b/src/regression.ts", lines, after),
              additions: 5,
              deletions: 5,
              status: "modified",
            },
          ],
        },
      },
    }
    await mockServer(page, events, [userMessage, { ...assistantMessage, content: [toolContent(part)] }])
    await configurePage(page)

    await page.goto(sessionHref())
    await expectSessionTitle(page, title)

    const wrapper = page.locator(`[data-timeline-part-id="${editPartID}"]`).first()
    const trigger = wrapper.locator('[data-component="sticky-accordion-header"]')
    const diff = wrapper.locator('[data-component="apply-patch-file-diff"]').first()
    await expectAppVisible(diff)
    await expect.poll(() => wrapper.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(500)
    const samples = await wrapper.evaluate(async (element) => {
      const root = element.closest<HTMLElement>(".scroll-view__viewport")!
      element.scrollIntoView({ block: "start" })
      const result = []
      for (const offset of [0, 120, 240, 360, 480]) {
        root.scrollBy(0, offset - (result.at(-1)?.offset ?? 0))
        await new Promise(requestAnimationFrame)
        const trigger = element.querySelector<HTMLElement>('[data-component="sticky-accordion-header"]')!
        const diff = element.querySelector<HTMLElement>('[data-component="apply-patch-file-diff"]')!
        result.push({
          offset,
          trigger: trigger.getBoundingClientRect().y,
          diff: diff.getBoundingClientRect().y,
          bottom: element.getBoundingClientRect().bottom,
        })
      }
      return result
    })

    expect(samples[0]!.trigger).toBeGreaterThanOrEqual(samples[0]!.diff)
    expect(samples.every((sample) => Math.abs(sample.trigger - samples[0]!.trigger) <= 1)).toBe(true)
    expect(samples.every((sample) => sample.trigger < sample.bottom)).toBe(true)
  })
})

async function configurePage(page: Page, expanded = true) {
  await page.addInitScript((expanded) => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: {
          editToolPartsExpanded: expanded,
          shellToolPartsExpanded: expanded,
          showReasoningSummaries: true,
        },
      }),
    )
  }, expanded)
}

async function expectExpanded(locator: Locator, expected: boolean) {
  await expect.poll(() => locator.evaluate(readExpanded)).toBe(expected)
}

async function readToolState(page: Page) {
  return page
    .locator(`[data-timeline-part-id="${editPartID}"]`)
    .first()
    .evaluate(
      (element, textPartID) => ({
        expanded: (() => {
          const trigger =
            element.querySelector('[data-scope="apply-patch"] button') ??
            element.querySelector('[data-slot="collapsible-trigger"]')
          const aria = trigger?.getAttribute("aria-expanded")
          if (aria === "true") return true
          if (aria === "false") return false

          const root = element.querySelector('[data-component="collapsible"]')
          if (root?.hasAttribute("data-expanded")) return true
          if (root?.hasAttribute("data-closed")) return false

          const content = element.querySelector<HTMLElement>('[data-slot="collapsible-content"]')
          return !!content && content.getBoundingClientRect().height > 0
        })(),
        row: element.closest("[data-timeline-row]")?.getAttribute("data-timeline-row"),
        streamedTextVisible: !!document.querySelector(`[data-timeline-part-id="${textPartID}"]`),
      }),
      `${assistantMessageID}:text:0`,
    )
}

async function installDiffProbe(page: Page) {
  await page.addInitScript(() => {
    let shadowRootCount = 0
    const attachShadow = Element.prototype.attachShadow
    Element.prototype.attachShadow = function (init) {
      shadowRootCount += 1
      return attachShadow.call(this, init)
    }
    window.__timelineDiffProbe = {
      reset: () => {
        shadowRootCount = 0
      },
      shadowRoots: () => shadowRootCount,
    }
  })
}

async function markDiffProbe(page: Page) {
  await page
    .locator(`[data-timeline-part-id="${editPartID}"]`)
    .first()
    .evaluate((element) => {
      const tool = element as HTMLElement
      const file = tool.querySelector<HTMLElement>('[data-component="file"][data-mode="diff"]')
      const row = tool.closest<HTMLElement>("[data-timeline-key]")
      const frame = tool.closest<HTMLElement>("[data-timeline-row]")
      if (!file) throw new Error("missing edit diff file")
      if (!row) throw new Error("missing virtual timeline row")
      if (!frame) throw new Error("missing timeline row frame")

      tool.dataset.timelineProbe = "before"
      file.dataset.timelineProbe = "before"
      row.dataset.timelineProbe = "before"
      frame.dataset.timelineProbe = "before"
      window.__timelineDiffProbe.reset()
    })
}

async function readDiffProbe(page: Page) {
  return page
    .locator(`[data-timeline-part-id="${editPartID}"]`)
    .first()
    .evaluate((element) => {
      const tool = element as HTMLElement
      const file = tool.querySelector<HTMLElement>('[data-component="file"][data-mode="diff"]')
      const row = tool.closest<HTMLElement>("[data-timeline-key]")
      const frame = tool.closest<HTMLElement>("[data-timeline-row]")
      return {
        fileMarker: file?.dataset.timelineProbe,
        shadowRoots: window.__timelineDiffProbe.shadowRoots(),
        toolMarker: tool.dataset.timelineProbe,
        rowMarker: row?.dataset.timelineProbe,
        rowKey: row?.dataset.timelineKey,
        frameMarker: frame?.dataset.timelineProbe,
      }
    })
}

function toolContent(part: typeof editPart): SessionMessageAssistant["content"][number] {
  return {
    type: "tool",
    id: part.callID,
    name: part.tool,
    time: { created: part.state.time.start, ran: part.state.time.start, completed: part.state.time.end },
    state: {
      status: "completed",
      input: part.state.input,
      content: [{ type: "text", text: part.state.output }],
      metadata: part.state.metadata as Record<string, JsonValue>,
    },
  }
}

let eventSequence = -1

function textEvents(): OpenCodeEvent[] {
  return [
    eventValue("session.text.started", { sessionID, assistantMessageID, ordinal: 0 }, 1),
    eventValue(
      "session.text.ended",
      {
        sessionID,
        assistantMessageID,
        ordinal: 0,
        text: streamedTextPart.text,
      },
      1,
    ),
  ]
}

function toolEvents(part: typeof editPart): OpenCodeEvent[] {
  return [
    eventValue(
      "session.tool.input.started",
      {
        sessionID,
        assistantMessageID,
        id: part.callID,
        name: part.tool,
      },
      1,
    ),
    eventValue(
      "session.tool.input.ended",
      {
        sessionID,
        assistantMessageID,
        id: part.callID,
        text: JSON.stringify(part.state.input),
      },
      1,
    ),
    eventValue(
      "session.tool.called",
      {
        sessionID,
        assistantMessageID,
        id: part.callID,
        input: part.state.input,
        executed: true,
      },
      1,
    ),
    eventValue(
      "session.tool.success",
      {
        sessionID,
        assistantMessageID,
        id: part.callID,
        content: [{ type: "text", text: part.state.output }],
        metadata: part.state.metadata as Record<string, JsonValue>,
        executed: true,
      },
      2,
    ),
  ]
}

function eventValue<Type extends OpenCodeEvent["type"]>(
  type: Type,
  data: Extract<OpenCodeEvent, { type: Type }>["data"],
  version: 1 | 2,
): Extract<OpenCodeEvent, { type: Type }> {
  eventSequence++
  return {
    id: `evt_collapse_${eventSequence}`,
    created: 1700000002000 + eventSequence,
    type,
    data,
    location: { directory },
    durable: { aggregateID: sessionID, seq: eventSequence, version },
  } as unknown as Extract<OpenCodeEvent, { type: Type }>
}

function readExpanded(element: Element) {
  const trigger =
    element.querySelector('[data-scope="apply-patch"] button') ??
    element.querySelector('[data-slot="collapsible-trigger"]')
  const aria = trigger?.getAttribute("aria-expanded")
  if (aria === "true") return true
  if (aria === "false") return false

  const root = element.querySelector('[data-component="collapsible"]')
  if (root?.hasAttribute("data-expanded")) return true
  if (root?.hasAttribute("data-closed")) return false

  const content = element.querySelector<HTMLElement>('[data-slot="collapsible-content"]')
  return !!content && content.getBoundingClientRect().height > 0
}

async function mockServer(
  page: Page,
  events: EventPayload[],
  messages: SessionMessageInfo[] = [userMessage, assistantMessage],
) {
  eventSequence = -1
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: messages }),
    events: () => events.splice(0, 1),
    eventRetry: 16,
  })
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "timeline-state-regression",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: "timeline-state-regression",
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function provider() {
  return {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function sessionHref() {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${sessionID}`
}
