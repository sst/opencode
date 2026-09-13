import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { base64Encode } from "@opencode/util/encode"
import { timelineCategories, timelinePresets } from "@opencode/session-ui/timeline/detail"
import { mockOpenCodeServer } from "../../utils/mock-server"
import { expectSessionTitle } from "../../utils/waits"
import { benchmark, expect } from "../benchmark"
import { measureSessionSwitch, waitForStableTimeline } from "./session-tab-switch-probe"
import { stressSessionHref } from "./timeline-test-helpers"
import { startChromeTrace } from "../chrome-trace"

const file = process.env.LAGGY_SESSION_FILE
const session = file
  ? (JSON.parse(readFileSync(file, "utf8")) as {
      info: {
        id: string
        projectID: string
        title: string
        model?: { id: string; providerID: string }
        location: { directory: string }
        time: { created: number; updated: number }
      }
      messages: SessionMessageInfo[]
    })
  : undefined
const sourceID = "ses_laggy_benchmark_source"
const sourceMessageID = "msg_laggy_benchmark_source"
const history = process.env.LAGGY_SESSION_HISTORY ?? "full"
const viewport = { width: 1440, height: 900 }

benchmark.use({ viewport, video: "off", trace: "off", serviceWorkers: "block", traceScope: "interaction" })

for (const mode of ["compact", "ungrouped"] as const) {
  benchmark(`laggy session: ${mode}`, async ({ page, report }, testInfo) => {
    benchmark.skip(!session, "Set LAGGY_SESSION_FILE to a session export")
    if (!session) return
    const output = process.env.LAGGY_SESSION_OUTPUT ?? testInfo.outputPath("session-load")
    const model = session.info.model ?? { id: "benchmark-model", providerID: "benchmark" }
    const lastID = session.messages.findLast((message) => message.type === "user")!.id
    const lastText = session.messages.findLast(
      (message) =>
        message.type === "assistant" && message.content.some((part) => part.type === "text" && part.text.trim()),
    )!
    benchmark.setTimeout(Number(process.env.LAGGY_SESSION_TIMEOUT ?? 180_000))
    const requests: string[] = []
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    if (process.env.LAGGY_HTTP === "1")
      page.on("request", (request) => {
        const match = new URL(request.url()).pathname.match(/^\/api\/session\/([^/]+)\/message$/)
        if (request.method() === "GET" && match) requests.push(decodeURIComponent(match[1]))
      })
    const detail = Object.fromEntries(
      timelineCategories.map((category) => [
        category,
        {
          ...timelinePresets[2].value[category],
          placement: mode === "compact" ? "grouped" : "separate",
        },
      ]),
    )
    const directory = session.info.location.directory
    if (process.env.LAGGY_HTTP !== "1")
      await mockOpenCodeServer(page, {
        directory,
        project: {
          id: session.info.projectID,
          worktree: directory,
          vcs: "git",
          name: "session-benchmark",
          time: session.info.time,
          sandboxes: [],
        },
        provider: {
          all: [
            {
              id: model.providerID,
              name: model.providerID,
              models: { [model.id]: { id: model.id, name: model.id, limit: { context: 1_000_000 } } },
            },
          ],
          connected: [model.providerID],
          default: { providerID: model.providerID, modelID: model.id },
        },
        sessions: [session.info, { ...session.info, id: sourceID, title: "Benchmark source" }],
        pageMessages: (id, limit, before) => {
          if (id !== session.info.id)
            return {
              items: [
                {
                  id: sourceMessageID,
                  type: "user",
                  text: "Benchmark source",
                  time: { created: session.info.time.created },
                },
              ],
            }
          if (history === "full") return { items: session.messages }
          const end = before ? session.messages.findIndex((message) => message.id === before) : session.messages.length
          const start = Math.max(0, end - limit)
          return {
            items: session.messages.slice(start, end),
            cursor: start > 0 ? session.messages[start].id : undefined,
          }
        },
        onMessages: (request) => {
          if (request.phase === "start") requests.push(request.sessionID)
        },
      })
    await page.addInitScript(
      ({ detail, directory, server, sessionIDs, dirBase64 }) => {
        localStorage.setItem("settings.v3", JSON.stringify({ general: { timelineDetail: detail } }))
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            projects: { local: [{ worktree: directory, expanded: true }] },
            lastProject: { local: directory },
          }),
        )
        localStorage.setItem(
          "opencode.window.browser.dat:tabs",
          JSON.stringify(sessionIDs.map((sessionId) => ({ type: "session", server, dirBase64, sessionId }))),
        )
      },
      {
        detail,
        directory,
        server: process.env.PLAYWRIGHT_BASE_URL!,
        sessionIDs: [sourceID, session.info.id],
        dirBase64: base64Encode(directory),
      },
    )
    await page.goto(stressSessionHref(sourceID))
    await expectSessionTitle(page, "Benchmark source")
    await expect(page.locator('[data-slot="user-message-text"]')).toHaveText("Benchmark source")
    await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeEditable()
    await expect(page.getByRole("button", { name: model.id, exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    expect(requests).toEqual([sourceID])
    const startedAt = new Date().toISOString()
    const samples = []
    const phases = process.env.LAGGY_SESSION_COLD_ONLY === "1" ? (["cold"] as const) : (["cold", "warm"] as const)
    for (const [iteration, phase] of phases.entries()) {
      const before = requests.length
      const stopTrace =
        iteration === Number(process.env.LAGGY_TRACE_ITERATION ?? 1)
          ? await startChromeTrace(page, `laggy-${history}-${mode}`)
          : undefined
      const result = await measureSessionSwitch(page, {
        destinationIDs: session.messages.map((message) => message.id),
        sourceIDs: [sourceMessageID],
        lastID,
        requiredPartID: history === "paged" && mode === "compact" ? `${lastText.id}:text:0` : undefined,
        requireBottomAnchor: true,
        href: stressSessionHref(session.info.id),
        switch: async () => {
          await page.locator(`[data-slot="titlebar-tabs"] a[href="${stressSessionHref(session.info.id)}"]`).click()
        },
      })
      await stopTrace?.()
      await expectSessionTitle(page, session.info.title)
      if (history === "full" || mode === "ungrouped") await waitForStableTimeline(page, lastID)
      await expect(
        page.locator('[data-timeline-key] [data-component="markdown"]:not([data-markdown-ready])'),
      ).toHaveCount(0)
      expect(result.firstCorrectObservedMs).not.toBeNull()
      expect(result.stableObservedMs).not.toBeNull()
      if (phase === "warm") expect(requests.length - before).toBe(0)
      samples.push({
        iteration,
        phase,
        messageRequests: requests.length - before,
        messageResources: await page.evaluate((sessionID) => {
          const start = performance.getEntriesByName("session-switch:start").at(-1)!.startTime
          return (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
            .filter(
              (entry) =>
                entry.startTime >= start && new URL(entry.name).pathname === `/api/session/${sessionID}/message`,
            )
            .map((entry) => ({
              limit: Number(new URL(entry.name).searchParams.get("limit")),
              startMs: entry.startTime - start,
              durationMs: entry.duration,
              transferBytes: entry.transferSize,
            }))
        }, session.info.id),
        ...result,
      })
      if (iteration === phases.length - 1) {
        mkdirSync(output, { recursive: true })
        if (testInfo.repeatEachIndex === 0) await page.screenshot({ path: `${output}/${mode}.png` })
        break
      }
      await page.locator(`[data-slot="titlebar-tabs"] a[href="${stressSessionHref(sourceID)}"]`).click()
      await expectSessionTitle(page, "Benchmark source")
      await expect(page.locator('[data-slot="user-message-text"]')).toHaveText("Benchmark source")
      await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeEditable()
    }
    expect(errors).toEqual([])
    const result = {
      pair: testInfo.repeatEachIndex,
      startedAt,
      mode,
      history,
      file,
      messages: session.messages.length,
      viewport,
      browser: page.context().browser()!.version(),
      detail,
      samples,
    }
    writeFileSync(`${output}/${mode}-${testInfo.repeatEachIndex}.json`, JSON.stringify(result, null, 2))
    report(
      { samples },
      {
        mode,
        sampling: "cold/warm pair in one browser context",
        pair: testInfo.repeatEachIndex,
        messages: session.messages.length,
        viewport,
        data: history === "full" ? "full exported history" : "paginated exported history",
        transport: process.env.LAGGY_HTTP === "1" ? "http" : "playwright-route",
        inputEvent: "mousedown",
      },
    )
  })
}
