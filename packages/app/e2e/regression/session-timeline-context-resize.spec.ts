import { expect, test, type Page } from "@playwright/test"
import type { JsonValue, OpenCodeEvent, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client/promise"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"
import {
  analyzeVisualObservations,
  defineVisualRegions,
  startVisualProbe,
  stopVisualProbe,
  visualPlan,
} from "../utils/visual-stability"

const directory = "C:/OpenCode/ContextResizeRegression"
const projectID = "proj_context_resize_regression"
const sessionID = "ses_context_resize_regression"
const title = "Context resize regression"
const model = { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" }
const contextIDs = ["ctx_0100_read", "ctx_0101_glob", "ctx_0102_grep", "ctx_0103_list"]
const followingTextID = `${id("msg_assistant", 10)}:text:0`

const messages = [...Array.from({ length: 8 }, (_, index) => turn(index, false)).flat(), ...turn(10, true)]

test.describe("regression: session timeline context group resize", () => {
  test("remeasures a recent explored context group before the next paint", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await mockServer(page)
    await configurePage(page)

    await page.goto(sessionHref())
    await expectSessionTitle(page, title)
    await expectAppVisible(page.locator(`[data-timeline-part-ids="${contextIDs.join(",")}"]`).first())
    await expectAppVisible(page.locator(`[data-timeline-part-id="${followingTextID}"]`).first())
    await settle(page)

    const samples = await sampleExpansion(page)
    const visibleOverlap = samples.filter((sample) => sample.frame >= 1 && sample.overlap > 0.5)

    expect(samples[0]?.overlap).toBe(0)
    expect(visibleOverlap).toEqual([])
    expect(samples.at(-1)?.expanded).toBe("true")
  })

  test("keeps a grouped tool summary stable as its calls complete", async ({ page }) => {
    const events: OpenCodeEvent[] = []
    await page.setViewportSize({ width: 1400, height: 900 })
    await mockServer(page, events, [
      ...Array.from({ length: 8 }, (_, index) => turn(index, false)).flat(),
      ...turn(10, true, "running"),
    ])
    await configurePage(page)

    await page.goto(sessionHref())
    await expectSessionTitle(page, title)
    const devtools = await page.context().newCDPSession(page)
    await devtools.send("Emulation.setCPUThrottlingRate", { rate: 4 })
    const context = page.locator(`[data-timeline-part-ids="${contextIDs.join(",")}"]`).first()
    await expectAppVisible(context)
    await expect(context.getByRole("button")).toHaveAccessibleName("Used 4 Read, Glob, Grep, List")

    const contextSelector = `[data-timeline-part-ids="${contextIDs.join(",")}"]`
    const regions = defineVisualRegions({
      status: {
        selector: `${contextSelector} [data-component="context-tool-group-trigger"]`,
      },
      context: { selector: contextSelector, closest: '[data-timeline-row="AssistantPart"]' },
      following: {
        selector: `[data-timeline-part-id="${followingTextID}"]`,
        closest: '[data-timeline-row="AssistantPart"]',
      },
    })
    await startVisualProbe(page, regions)
    for (const [index, delay] of [120, 350, 80, 500].entries()) {
      events.push(
        ...toolEvents(
          contextTool(
            contextIDs[index]!,
            id("msg_assistant", 10),
            ["read", "glob", "grep", "list"][index]!,
            [
              { path: "src/recent-a.ts" },
              { path: directory, pattern: "**/*.ts" },
              { path: directory, pattern: "Explored" },
              { path: "src" },
            ][index]!,
          ),
        ),
      )
      await page.waitForTimeout(delay)
    }

    await expect(context.getByRole("button")).toHaveAccessibleName("Used 4 Read, Glob, Grep, List")
    await page.waitForTimeout(700)
    const trace = await stopVisualProbe<keyof typeof regions>(page)
    const labels = trace.samples
      .map((sample) => sample.regions.status?.label)
      .filter((value): value is string => !!value)
      .filter((value, index, all) => value !== all[index - 1])
    const issues = analyzeVisualObservations(
      trace.samples,
      visualPlan(regions, [
        { type: "required", regions: ["context", "following"] },
        { type: "opacity", regions: "all" },
        { type: "continuity", regions: "all" },
        { type: "motion", regions: "all" },
        { type: "label-stability", regions: "all" },
        { type: "flow", regions: ["context", "following"] },
      ]),
    )

    expect(labels).toEqual(["Used 4 Read, Glob, Grep, List"])
    expect(issues, JSON.stringify(trace.samples, null, 2)).toEqual([])
  })
})

async function configurePage(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: {
          editToolPartsExpanded: true,
          shellToolPartsExpanded: true,
          showReasoningSummaries: true,
        },
      }),
    )
  })
}

async function sampleExpansion(page: Page) {
  return page.evaluate(
    ({ contextIDs, followingTextID }) =>
      new Promise<
        {
          frame: number
          label: string
          scrollTop: number
          scrollHeight: number
          contextBottom: number
          textTop: number
          overlap: number
          gap: number
          expanded: string | null
        }[]
      >((resolve) => {
        const context = document.querySelector<HTMLElement>(`[data-timeline-part-ids="${contextIDs.join(",")}"]`)
        const text = document.querySelector<HTMLElement>(`[data-timeline-part-id="${followingTextID}"]`)
        const scroller = context?.closest<HTMLElement>(".scroll-view__viewport")
        const trigger = context?.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
        const contextRow = context?.closest<HTMLElement>('[data-timeline-row="AssistantPart"]')
        const textRow = text?.closest<HTMLElement>('[data-timeline-row="AssistantPart"]')
        if (!context || !text || !scroller || !trigger || !contextRow || !textRow)
          throw new Error("missing regression nodes")

        scroller.scrollTop = scroller.scrollHeight
        const samples: {
          frame: number
          label: string
          scrollTop: number
          scrollHeight: number
          contextBottom: number
          textTop: number
          overlap: number
          gap: number
          expanded: string | null
        }[] = []
        const capture = (frame: number, label: string) => {
          const contextRect = contextRow.getBoundingClientRect()
          const textRect = textRow.getBoundingClientRect()
          samples.push({
            frame,
            label,
            scrollTop: Math.round(scroller.scrollTop * 10) / 10,
            scrollHeight: Math.round(scroller.scrollHeight * 10) / 10,
            contextBottom: Math.round(contextRect.bottom * 10) / 10,
            textTop: Math.round(textRect.top * 10) / 10,
            overlap: Math.max(0, Math.round((contextRect.bottom - textRect.top) * 10) / 10),
            gap: Math.max(0, Math.round((textRect.top - contextRect.bottom) * 10) / 10),
            expanded: trigger.getAttribute("aria-expanded"),
          })
        }

        capture(-1, "before")
        trigger.click()
        capture(0, "sync-after-click")

        let frame = 1
        const tick = () => {
          setTimeout(() => {
            capture(frame, "painted")
            frame += 1
            if (frame > 8) {
              resolve(samples)
              return
            }
            requestAnimationFrame(tick)
          }, 0)
        }
        requestAnimationFrame(tick)
      }),
    { contextIDs, followingTextID },
  )
}

function turn(index: number, target: boolean, status: "running" | "completed" = "completed"): SessionMessageInfo[] {
  const userID = id("msg_user", index)
  const assistantID = id("msg_assistant", index)
  const content: SessionMessageAssistant["content"] = target
    ? [
        toolContent(
          contextTool(contextIDs[0]!, assistantID, "read", { path: "src/recent-a.ts", offset: 0, limit: 120 }, status),
        ),
        toolContent(contextTool(contextIDs[1]!, assistantID, "glob", { path: directory, pattern: "**/*.ts" }, status)),
        toolContent(
          contextTool(
            contextIDs[2]!,
            assistantID,
            "grep",
            { path: directory, pattern: "Explored", include: "*.ts" },
            status,
          ),
        ),
        toolContent(contextTool(contextIDs[3]!, assistantID, "list", { path: "src" }, status)),
        { type: "text", text: "This assistant text is immediately after the explored context group." },
      ]
    : [{ type: "text", text: `Assistant filler ${index}. ${"filler ".repeat(60)}` }]
  return [
    {
      id: userID,
      type: "user",
      time: { created: 1700000000000 + index * 10_000 },
      text: `User message ${index}`,
    },
    {
      id: assistantID,
      type: "assistant",
      time: { created: 1700000000000 + index * 10_000 + 1_000, completed: 1700000000000 + index * 10_000 + 2_000 },
      model: { id: model.modelID, providerID: model.providerID, variant: model.variant },
      agent: "build",
      cost: 0.01,
      tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      content,
    },
  ]
}

function contextTool(
  partID: string,
  messageID: string,
  tool: string,
  input: Record<string, unknown>,
  status: "running" | "completed" = "completed",
) {
  return {
    id: partID,
    sessionID,
    messageID,
    type: "tool",
    callID: partID,
    tool,
    state: {
      status,
      input,
      output: `Completed ${tool}.\n${"detail line\n".repeat(8)}`,
      title: input.path || input.pattern || "completed",
      metadata: {},
      time: { start: 1700000000000, end: 1700000000100 },
    },
  }
}

type ContextTool = ReturnType<typeof contextTool>

function toolContent(part: ContextTool): SessionMessageAssistant["content"][number] {
  const base = {
    type: "tool" as const,
    id: part.callID,
    name: part.tool,
    time: {
      created: part.state.time.start,
      ran: part.state.time.start,
      ...(part.state.status === "completed" ? { completed: part.state.time.end } : {}),
    },
  }
  if (part.state.status === "running")
    return {
      ...base,
      state: {
        status: "running",
        input: part.state.input as Record<string, JsonValue>,
        metadata: part.state.metadata as Record<string, JsonValue>,
      },
    }
  return {
    ...base,
    state: {
      status: "completed",
      input: part.state.input as Record<string, JsonValue>,
      content: [{ type: "text", text: part.state.output }],
      metadata: part.state.metadata as Record<string, JsonValue>,
    },
  }
}

let eventSequence = -1

function toolEvents(part: ContextTool): OpenCodeEvent[] {
  return [
    eventValue(
      "session.tool.success",
      {
        sessionID,
        assistantMessageID: part.messageID,
        id: part.callID,
        content: [{ type: "text", text: part.state.output }],
        metadata: part.state.metadata,
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
    id: `evt_context_resize_${eventSequence}`,
    created: 1700000002000 + eventSequence,
    type,
    data,
    location: { directory },
    durable: { aggregateID: sessionID, seq: eventSequence, version },
  } as unknown as Extract<OpenCodeEvent, { type: Type }>
}

async function mockServer(page: Page, events: OpenCodeEvent[] = [], fixtureMessages = messages) {
  eventSequence = -1
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: fixtureMessages }),
    events: () => events.splice(0, 1),
    eventRetry: 50,
  })
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

function id(prefix: string, index: number) {
  return `${prefix}_${String(index).padStart(4, "0")}`
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "context-resize-regression",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: "context-resize-regression",
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
