import { afterEach, describe, expect, test } from "bun:test"
import { For } from "solid-js"
import { minimalToolSummary, ToolSummaryRow } from "../../../src/routes/session/tool-presentation"
import { toolPresentationStatus } from "../../../src/util/tool-display"
import { testRender, type JSX } from "@opentui/solid"
import {
  InlineToolRow,
  executeCallSummary,
  genericToolSummary,
  isBackgroundSubagent,
  parseApplyPatchFiles,
  parseDiagnostics,
  parseQuestionAnswers,
  parseQuestions,
  toolDisplay,
} from "../../../src/routes/session"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

type ToolFixture = { icon: string; label: string; error?: string }

const tools: readonly ToolFixture[] = [
  {
    icon: "✱",
    label:
      'Grep "OPENCODE.*DB|database|sqlite|drizzle|dev.*db|data.*dir|xdg|APPDATA" in packages/opencode/src (151 matches)',
  },
  {
    icon: "✱",
    label: 'Glob "**/*db*" in packages/opencode (6 matches)',
  },
  {
    icon: "→",
    label: "Read packages/opencode/src/storage/db.ts [offset=1, limit=130]",
  },
  {
    icon: "→",
    label: "Read packages/opencode/src/index.ts [offset=1, limit=100]",
    error: "No LSP server available for this file type.",
  },
  {
    icon: "✱",
    label:
      'Grep "export const OPENCODE_DB|OPENCODE_DB|OPENCODE_DEV|Global\\.Path\\.data|data =" in packages/opencode/src (115 matches)',
  },
] as const

function Fixture(props: { errorExpanded?: boolean }) {
  return (
    <box flexDirection="column" width={72}>
      <box flexDirection="column">
        <For each={tools}>
          {(item) => (
            <InlineToolRow
              icon={item.icon}
              complete={true}
              pending=""
              failed={Boolean(item.error)}
              error={item.error}
              errorExpanded={props.errorExpanded}
            >
              {item.label}
            </InlineToolRow>
          )}
        </For>
      </box>
    </box>
  )
}

function FailedPendingToolFixture() {
  return (
    <InlineToolRow icon="%" complete={false} pending="Preparing patch…" failed={true} failure="Patch failed">
      Patch
    </InlineToolRow>
  )
}

function FailedCompleteToolFixture() {
  return (
    <InlineToolRow icon="→" complete={true} pending="Reading file…" failed={true} failure="Read failed">
      Read src/index.ts
    </InlineToolRow>
  )
}

function ReminderAlignmentFixture() {
  return (
    <box flexDirection="column">
      <box paddingLeft={3}>
        <text>Switched variant to medium</text>
      </box>
      <InlineToolRow icon="◈" complete={true} pending="Notice">
        Instructions updated
      </InlineToolRow>
    </box>
  )
}

function TrailingStatusFixture() {
  return (
    <InlineToolRow icon=":" complete={true} pending="" status={<text flexShrink={0}> Background </text>}>
      Explore Subagent — Inspect renderer status styling
    </InlineToolRow>
  )
}

async function renderFrame(component: () => JSX.Element, options: { width: number; height: number }) {
  testSetup?.renderer.destroy()
  testSetup = await testRender(component, options)
  await testSetup.renderOnce()
  await testSetup.renderOnce()

  return testSetup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

describe("TUI inline tool wrapping", () => {
  test("minimal summaries describe targets without expanding input bodies", () => {
    expect(minimalToolSummary("write", { path: "src/index.ts", content: "SECRET_BODY" })).toBe("write src/index.ts")
    expect(
      minimalToolSummary("patch", {
        patchText:
          "*** Begin Patch\n*** Add File: a.ts\n+SECRET_BODY\n*** Update File: b.ts\n@@\n-old\n+new\n*** End Patch",
      }),
    ).toBe("patch a.ts, b.ts")
    expect(minimalToolSummary("shell", { command: "echo first\necho second" })).toBe("shell echo first echo second")
    expect(minimalToolSummary("custom.lookup", { query: "two\nwords" })).toBe("custom.lookup two words")
    expect(minimalToolSummary("execute", { code: "SECRET_BODY" })).toBe("execute")
    expect(minimalToolSummary("custom.lookup", {})).toBe("custom.lookup")
  })

  test.each([24, 112])("minimal tool rows stay one line at %s columns", async (width) => {
    const frame = await renderFrame(
      () => (
        <box width={width}>
          <ToolSummaryRow
            status={toolPresentationStatus(undefined)}
            summary={minimalToolSummary("shell", { command: `echo first\necho ${"long-argument-".repeat(30)}` })}
          />
          <ToolSummaryRow
            status={{ ...toolPresentationStatus(undefined), failed: true, error: "Hidden error details" }}
            summary={`read ${"long/path/".repeat(30)} — failed`}
          />
          <text>AFTER_TOOLS</text>
        </box>
      ),
      { width, height: 10 },
    )
    expect(frame.split("\n")).toHaveLength(3)
    expect(frame).toContain("▸ shell")
    expect(frame).toContain("✗ read")
    expect(frame).not.toContain("Hidden error details")
    expect(frame.split("\n")[2]).toBe("AFTER_TOOLS")
  })

  test("falls back for unknown tool names", () => {
    expect(toolDisplay("shell")).toBe("shell")
    expect(toolDisplay("subagent")).toBe("subagent")
    // Legacy tool names normalize to their renamed views.
    expect(toolDisplay("bash")).toBe("shell")
    expect(toolDisplay("task")).toBe("subagent")
    expect(toolDisplay("apply_patch")).toBe("patch")
    expect(toolDisplay("patch")).toBe("patch")
    expect(toolDisplay("plugin_tool")).toBe("generic")
  })

  test("replaces pending copy when a tool fails before completion", async () => {
    const frame = await renderFrame(() => <FailedPendingToolFixture />, { width: 72, height: 3 })
    expect(frame).toContain("Patch failed")
    expect(frame).not.toContain("Preparing patch")
  })

  test("preserves useful completed copy when a tool fails", async () => {
    const frame = await renderFrame(() => <FailedCompleteToolFixture />, { width: 72, height: 3 })
    expect(frame).toContain("Read src/index.ts")
    expect(frame).not.toContain("Read failed")
  })

  test("aligns switch reminders with instruction reminders", async () => {
    expect(await renderFrame(() => <ReminderAlignmentFixture />, { width: 35, height: 2 })).toBe(
      "   Switched variant to medium\n   ◈ Instructions updated",
    )
  })

  test("wraps a trailing status as one padded item", async () => {
    expect(await renderFrame(() => <TrailingStatusFixture />, { width: 70, height: 2 })).toBe(
      "   : Explore Subagent — Inspect renderer status styling  Background",
    )
    expect(await renderFrame(() => <TrailingStatusFixture />, { width: 62, height: 2 })).toBe(
      "   : Explore Subagent — Inspect renderer status styling\n      Background",
    )
  })

  test("filters malformed nested tool wire data", () => {
    expect(
      parseApplyPatchFiles([
        null,
        { type: "add" },
        { file: "a.ts", patch: "diff", additions: 1, deletions: 0, status: "added" },
      ]),
    ).toEqual([
      {
        type: "add",
        relativePath: "a.ts",
        filePath: "a.ts",
        patch: "diff",
        additions: 1,
        deletions: 0,
        movePath: undefined,
      },
    ])
    expect(parseQuestions([{}, { question: 1 }, { question: "Continue?" }])).toEqual([{ question: "Continue?" }])
    expect(parseQuestionAnswers([null, ["yes", 1], "no"])).toEqual([[], ["yes"], []])
    expect(parseQuestionAnswers({})).toBeUndefined()
  })

  test("summarizes execute calls on one line", () => {
    expect(
      executeCallSummary({
        tool: "session.prompt",
        status: "completed",
        input: { sessionID: "ses_example", notify: true },
      }),
    ).toBe("session.prompt [sessionID=ses_example, notify=true]")
    expect(executeCallSummary({ tool: "session.get", status: "error", input: { nested: { hidden: true } } })).toBe(
      "session.get",
    )
    expect(
      executeCallSummary({ tool: "session.prompt", status: "completed", input: { text: "first line\nsecond line" } }),
    ).toBe("session.prompt [text=first line second line]")
  })

  test("summarizes generic tool arguments on one line", () => {
    expect(
      genericToolSummary("demo_search_catalog", {
        query: "wireless keyboard",
        limit: 8,
        includeArchived: false,
        filters: { category: "accessories" },
      }),
    ).toBe("demo_search_catalog [query=wireless keyboard, limit=8, includeArchived=false]")
    expect(genericToolSummary("demo_get_weather", { city: "Tokyo", units: "celsius" })).toBe(
      "demo_get_weather [city=Tokyo, units=celsius]",
    )
    expect(genericToolSummary("demo_refresh", {})).toBe("demo_refresh")
  })

  test("ignores diagnostics with malformed nested ranges", () => {
    expect(
      parseDiagnostics(
        {
          "a.ts": [
            { severity: 1, message: "missing range" },
            { severity: 1, message: "bad line", range: { start: { line: "0", character: 1 } } },
            { severity: 1, message: "valid", range: { start: { line: 2, character: 3 } } },
          ],
        },
        "a.ts",
      ),
    ).toEqual([{ message: "valid", range: { start: { line: 2, character: 3 } } }])
  })

  test("labels only detached or async subagents as background", () => {
    expect(isBackgroundSubagent({ status: "running" }, "running")).toBeFalse()
    expect(isBackgroundSubagent({ status: "running" }, "completed")).toBeTrue()
    expect(isBackgroundSubagent({ status: "running" }, "error")).toBeFalse()
    expect(isBackgroundSubagent({ status: "completed" }, "completed")).toBeFalse()
  })

  test("snapshots consecutive grep, glob, and read rows at a narrow width", async () => {
    expect(await renderFrame(() => <Fixture />, { width: 72, height: 12 })).toMatchSnapshot()
  })

  test("snapshots expanded tool errors under the tool text", async () => {
    expect(await renderFrame(() => <Fixture errorExpanded />, { width: 72, height: 12 })).toMatchSnapshot()
  })
})
