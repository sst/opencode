import type {
  FileDiffInfo,
  FormInfo,
  JsonValue,
  ModelRef,
  PermissionRequest,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageUser,
  SessionStatus,
} from "@opencode/client/promise"
import type { SessionDocument } from "../document"
import type { SessionUserPresentation } from "../timeline/session-timeline"

export const CURRENT_SESSION_ID = "session_current_story"
export const STORY_TIME = 1_735_689_600_000

export const STORY_MODEL = {
  id: "claude-sonnet-4",
  providerID: "anthropic",
  variant: "balanced",
} satisfies ModelRef

function user(id: string, text: string, offset: number): SessionMessageUser {
  return {
    id,
    type: "user",
    text,
    time: { created: STORY_TIME + offset },
    metadata: { agent: "build", model: STORY_MODEL },
  }
}

function assistant(input: {
  id: string
  offset: number
  content: SessionMessageAssistant["content"]
  completed?: number
  error?: SessionMessageAssistant["error"]
  retry?: SessionMessageAssistant["retry"]
  agent?: string
}): SessionMessageAssistant {
  return {
    id: input.id,
    type: "assistant",
    agent: input.agent ?? "build",
    model: STORY_MODEL,
    content: input.content,
    error: input.error,
    retry: input.retry,
    time: {
      created: STORY_TIME + input.offset,
      completed: input.completed === undefined ? undefined : STORY_TIME + input.completed,
    },
  }
}

function completedTool(input: {
  id: string
  name: string
  offset: number
  args: Record<string, JsonValue>
  output: string
  metadata?: Record<string, JsonValue>
}): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: input.id,
    name: input.name,
    state: {
      status: "completed",
      input: input.args,
      content: [{ type: "text", text: input.output }],
      metadata: input.metadata,
    },
    time: {
      created: STORY_TIME + input.offset,
      ran: STORY_TIME + input.offset + 100,
      completed: STORY_TIME + input.offset + 900,
    },
  }
}

function runningTool(input: {
  id: string
  name: string
  offset: number
  args: Record<string, JsonValue>
  output?: string
  metadata?: Record<string, JsonValue>
}): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: input.id,
    name: input.name,
    state: {
      status: "running",
      input: input.args,
      metadata: {
        ...input.metadata,
        ...(input.output === undefined ? {} : { output: input.output }),
      },
    },
    time: { created: STORY_TIME + input.offset, ran: STORY_TIME + input.offset + 100 },
  }
}

function streamingTool(input: { id: string; name: string; offset: number; args: Record<string, JsonValue> }) {
  return {
    type: "tool",
    id: input.id,
    name: input.name,
    state: {
      status: "streaming",
      input: JSON.stringify(input.args),
    },
    time: { created: STORY_TIME + input.offset },
  } satisfies SessionMessageAssistantTool
}

function failedTool(input: {
  id: string
  name: string
  offset: number
  args: Record<string, JsonValue>
  message: string
  metadata?: Record<string, JsonValue>
}): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: input.id,
    name: input.name,
    state: {
      status: "error",
      input: input.args,
      error: { type: "ToolExecutionError", message: input.message },
      metadata: input.metadata,
    },
    time: {
      created: STORY_TIME + input.offset,
      ran: STORY_TIME + input.offset + 100,
      completed: STORY_TIME + input.offset + 700,
    },
  }
}

function document(messages: SessionMessageInfo[], status: SessionStatus = { type: "idle" }): SessionDocument {
  return {
    sessionID: CURRENT_SESSION_ID,
    messages,
    status,
    diffs: [],
  }
}

export const emptySessionDocument = {
  sessionID: CURRENT_SESSION_ID,
  messages: [],
  status: { type: "idle" },
  diffs: [],
} satisfies SessionDocument

export const pendingAndQueuedDocument = document(
  [
    user("msg_user_done", "Summarize the current timeline implementation.", 1_000),
    assistant({
      id: "msg_assistant_done",
      offset: 2_000,
      completed: 4_500,
      content: [{ type: "text", text: "The timeline projects current Session messages into stable typed rows." }],
    }),
    user("msg_user_pending", "Add deterministic stories for the current Session UI.", 5_000),
  ] satisfies SessionMessageInfo[],
  { type: "busy" },
)

export const queuedPrompts = [
  { id: "inbox_queue_1", text: "Cover the compact terminal width." },
  { id: "inbox_queue_2", text: "Then verify the full Storybook build." },
] satisfies { id: string; text: string }[]

export const streamingDocument = document(
  [
    user("msg_user_stream", "Explain the projection while you implement it.", 10_000),
    assistant({
      id: "msg_assistant_stream",
      offset: 11_000,
      content: [
        {
          type: "reasoning",
          text: "## Checking the current contract\n\nThe assistant content is nested on each current Session message.",
          state: { phase: "streaming" },
          time: { created: STORY_TIME + 11_100 },
        },
        {
          type: "text",
          text: "I have the typed rows in place. Next I am checking the streaming presentation",
          state: { phase: "streaming" },
        },
      ],
    }),
  ] satisfies SessionMessageInfo[],
  { type: "busy" },
)

export const reviewDiffs = [
  {
    file: "packages/app/src/components/session-status.tsx",
    patch:
      "diff --git a/packages/app/src/components/session-status.tsx b/packages/app/src/components/session-status.tsx\nindex 8412c72..09d4938 100644\n--- a/packages/app/src/components/session-status.tsx\n+++ b/packages/app/src/components/session-status.tsx\n@@ -1,3 +1,3 @@\n export function SessionStatus() {\n-  return <span>Working</span>\n+  return <span>Running checks</span>\n }\n",
    additions: 1,
    deletions: 1,
    status: "modified",
  },
  {
    file: "packages/app/src/components/session-status.test.tsx",
    patch:
      'diff --git a/packages/app/src/components/session-status.test.tsx b/packages/app/src/components/session-status.test.tsx\nnew file mode 100644\nindex 0000000..0c19b30\n--- /dev/null\n+++ b/packages/app/src/components/session-status.test.tsx\n@@ -0,0 +1,5 @@\n+import { expect, test } from "bun:test"\n+\n+test("shows the active status", () => {\n+  expect("Running checks").toContain("checks")\n+})\n',
    additions: 5,
    deletions: 0,
    status: "added",
  },
] satisfies FileDiffInfo[]

export const editThenTestDocument = {
  ...document([
    user("msg_user_edit", "Change the active status label and run the focused component test.", 20_000),
    assistant({
      id: "msg_assistant_inspect_status",
      offset: 21_000,
      completed: 22_000,
      content: [
        {
          type: "reasoning",
          text: "## Finding the current label\n\nI will inspect the component and its focused test before changing it.",
          time: { created: STORY_TIME + 21_100, completed: STORY_TIME + 21_400 },
        },
        completedTool({
          id: "tool_grep_status",
          name: "grep",
          offset: 21_500,
          args: { pattern: "Working", path: "packages/app/src", include: "*.tsx" },
          output: "packages/app/src/components/session-status.tsx:4:  return <span>Working</span>",
          metadata: {},
        }),
        completedTool({
          id: "tool_read_status",
          name: "read",
          offset: 21_700,
          args: { path: "packages/app/src/components/session-status.tsx", offset: 1, limit: 80 },
          output: "export function SessionStatus() {\n  return <span>Working</span>\n}",
          metadata: { loaded: ["packages/app/src/components/session-status.tsx"] },
        }),
      ],
    }),
    assistant({
      id: "msg_assistant_edit",
      offset: 22_500,
      completed: 24_000,
      content: [
        completedTool({
          id: "tool_edit_status",
          name: "edit",
          offset: 22_600,
          args: {
            path: "packages/app/src/components/session-status.tsx",
            oldString: "  return <span>Working</span>",
            newString: "  return <span>Running checks</span>",
          },
          output: "Updated packages/app/src/components/session-status.tsx",
          metadata: {
            files: [
              {
                file: "packages/app/src/components/session-status.tsx",
                patch: reviewDiffs[0].patch,
                additions: 1,
                deletions: 1,
                status: "modified",
              },
            ],
          },
        }),
      ],
    }),
    assistant({
      id: "msg_assistant_test_status",
      offset: 24_500,
      completed: 26_500,
      content: [
        completedTool({
          id: "tool_test_status",
          name: "shell",
          offset: 24_600,
          args: { command: "bun test src/components/session-status.test.tsx" },
          output: "bun test v1.2.0\n\n1 pass\n0 fail\nRan 1 test across 1 file.",
          metadata: { exit: 0 },
        }),
      ],
    }),
    assistant({
      id: "msg_assistant_status_result",
      offset: 27_000,
      completed: 28_000,
      content: [
        {
          type: "text",
          text: "Updated the active label to **Running checks** and verified the focused component test.\n\n- 1 test passed\n- 0 tests failed",
        },
      ],
    }),
  ] satisfies SessionMessageInfo[]),
  diffs: reviewDiffs,
} satisfies SessionDocument

export const standaloneShellRunningDocument = document(
  [
    {
      id: "msg_shell_running",
      type: "shell",
      shellID: "shell_running",
      command: "bun run storybook --ci",
      status: "running",
      output: {
        output: "Starting Storybook manager...\nBuilding preview...",
        cursor: 49,
        size: 49,
        truncated: false,
      },
      time: { created: STORY_TIME + 30_000 },
    },
  ] satisfies SessionMessageInfo[],
  { type: "busy" },
)

export const standaloneShellCompletedDocument = document([
  {
    id: "msg_shell_completed",
    type: "shell",
    shellID: "shell_completed",
    command: "git status --short",
    status: "exited",
    exit: 0,
    output: {
      output: " M packages/session-ui/src/timeline/session-timeline.tsx",
      cursor: 59,
      size: 59,
      truncated: false,
    },
    time: { created: STORY_TIME + 31_000, completed: STORY_TIME + 31_800 },
  },
] satisfies SessionMessageInfo[])

export const thinkingDocument = document(
  [user("msg_user_thinking", "Find why the Session header shifts after the first streamed response.", 32_000)],
  { type: "busy" },
)

export const fileChangeLoadingDocument = document(
  [
    user("msg_user_edit_loading", "Update the empty-state copy to explain the next action.", 33_000),
    assistant({
      id: "msg_assistant_edit_loading",
      offset: 34_000,
      content: [
        streamingTool({
          id: "tool_edit_loading",
          name: "edit",
          offset: 34_100,
          args: {
            path: "packages/app/src/components/empty-session.tsx",
            oldString: "No messages yet",
            newString: "Ask OpenCode to start working",
          },
        }),
      ],
    }),
  ] satisfies SessionMessageInfo[],
  { type: "busy" },
)

export const fileChangeRunningDocument = document(
  [
    user("msg_user_edit_running", "Update the empty-state copy to explain the next action.", 35_000),
    assistant({
      id: "msg_assistant_edit_running",
      offset: 36_000,
      content: [
        runningTool({
          id: "tool_edit_running",
          name: "edit",
          offset: 36_100,
          args: {
            path: "packages/app/src/components/empty-session.tsx",
            oldString: "No messages yet",
            newString: "Ask OpenCode to start working",
          },
        }),
      ],
    }),
  ] satisfies SessionMessageInfo[],
  { type: "busy" },
)

export const multiFilePatchDocument = document([
  user("msg_user_patch", "Add a keyboard shortcut hint and cover it with a focused test.", 37_000),
  assistant({
    id: "msg_assistant_patch",
    offset: 38_000,
    completed: 41_000,
    content: [
      completedTool({
        id: "tool_patch_shortcut",
        name: "patch",
        offset: 38_100,
        args: { patchText: "Update the shortcut hint and add its focused test" },
        output: "Applied patch to 2 files",
        metadata: {
          files: [
            {
              file: "packages/app/src/components/session-hint.tsx",
              status: "modified",
              patch:
                'diff --git a/packages/app/src/components/session-hint.tsx b/packages/app/src/components/session-hint.tsx\nindex 414271a..114b7a2 100644\n--- a/packages/app/src/components/session-hint.tsx\n+++ b/packages/app/src/components/session-hint.tsx\n@@ -1 +1 @@\n-export const hint = "Open commands"\n+export const hint = "Open commands with Ctrl+P"\n',
              additions: 1,
              deletions: 1,
            },
            {
              file: "packages/app/src/components/session-hint.test.ts",
              status: "added",
              patch:
                'diff --git a/packages/app/src/components/session-hint.test.ts b/packages/app/src/components/session-hint.test.ts\nnew file mode 100644\nindex 0000000..d4fe351\n--- /dev/null\n+++ b/packages/app/src/components/session-hint.test.ts\n@@ -0,0 +1,5 @@\n+import { expect, test } from "bun:test"\n+\n+test("includes the shortcut", () => {\n+  expect("Open commands with Ctrl+P").toContain("Ctrl+P")\n+})\n',
              additions: 5,
              deletions: 0,
            },
          ],
        },
      }),
    ],
  }),
  assistant({
    id: "msg_assistant_patch_result",
    offset: 41_500,
    completed: 42_500,
    content: [{ type: "text", text: "Added the shortcut hint and its focused test in two files." }],
  }),
] satisfies SessionMessageInfo[])

export const writeFileDocument = document([
  user("msg_user_write", "Add a short contributor note for running the component stories.", 43_000),
  assistant({
    id: "msg_assistant_write",
    offset: 44_000,
    completed: 46_000,
    content: [
      completedTool({
        id: "tool_write_storybook_note",
        name: "write",
        offset: 44_100,
        args: {
          path: "docs/component-workbench.md",
          content:
            "# Component workbench\n\nRun `bun run storybook` from `packages/storybook` to inspect Session workflows without a server.\n",
        },
        output: "Created docs/component-workbench.md",
      }),
    ],
  }),
] satisfies SessionMessageInfo[])

export const terminalRunningDocument = document(
  [
    user("msg_user_terminal_running", "Run the focused Session UI tests.", 47_000),
    assistant({
      id: "msg_assistant_terminal_running",
      offset: 48_000,
      content: [
        runningTool({
          id: "tool_terminal_running",
          name: "shell",
          offset: 48_100,
          args: { command: "bun test src/timeline" },
          output: "bun test v1.2.0\nRunning timeline tests...",
        }),
      ],
    }),
  ] satisfies SessionMessageInfo[],
  { type: "busy" },
)

export const terminalPassedDocument = document([
  user("msg_user_terminal_passed", "Run the focused Session UI tests.", 49_000),
  assistant({
    id: "msg_assistant_terminal_passed",
    offset: 50_000,
    completed: 52_000,
    content: [
      completedTool({
        id: "tool_terminal_passed",
        name: "shell",
        offset: 50_100,
        args: { command: "bun test src/timeline" },
        output: "12 pass\n0 fail\nRan 12 tests across 3 files.",
        metadata: { exit: 0 },
      }),
    ],
  }),
] satisfies SessionMessageInfo[])

export const expandedShellDocument = document([
  user("msg_user_shell_expanded", "Inspect the active service and its available feature surface.", 52_100),
  assistant({
    id: "msg_assistant_shell_expanded",
    offset: 52_200,
    completed: 52_900,
    content: [
      completedTool({
        id: "tool_shell_expanded",
        name: "shell",
        offset: 52_300,
        args: {
          command:
            "opencode2 api get /openapi.json > /private/var/folders/j/gd69b2|16y91666jzf3p9g22asdasc0000gn/T/opencode/temp/tes",
        },
        output:
          '{"location":{"directory":"/Users/usrnk1","project":{"id":"global","directory":"/","canonical":"/"}},"data":[{"id":"opencode","name":"OpenCode","description":"Use this skill for any question about OpenCode itself, including how OpenCode works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the OpenCode SDK, clients, server, or API, and contributing to the OpenCode codebase."}]}',
        metadata: { exit: 0 },
      }),
    ],
  }),
] satisfies SessionMessageInfo[])

export const executeCodeDocument = document([
  user("msg_user_execute", "Verify the Code Mode runtime responds.", 52_100),
  assistant({
    id: "msg_assistant_execute",
    offset: 52_200,
    completed: 52_900,
    content: [
      completedTool({
        id: "tool_execute_code",
        name: "execute",
        offset: 52_300,
        args: {
          code: 'const greeting = "Code Mode execute completed"\nreturn { greeting, timestamp: new Date().toISOString() }',
        },
        output: '{\n  "greeting": "Code Mode execute completed",\n  "timestamp": "2026-08-17T09:01:43.590Z"\n}',
      }),
    ],
  }),
] satisfies SessionMessageInfo[])

export const terminalFailedDocument = document([
  user("msg_user_terminal_failed", "Run the focused Session UI tests.", 53_000),
  assistant({
    id: "msg_assistant_terminal_failed",
    offset: 54_000,
    completed: 56_000,
    content: [
      completedTool({
        id: "tool_terminal_failed",
        name: "shell",
        offset: 54_100,
        args: { command: "bun test src/timeline" },
        output: "1 pass\n1 fail\nFailed: keeps the active tool disclosure open",
        metadata: { exit: 1 },
      }),
    ],
  }),
] satisfies SessionMessageInfo[])

export const recoveryDocument = document([
  user("msg_user_recovery", "Fix the failing active-tool disclosure test and verify the timeline package.", 57_000),
  assistant({
    id: "msg_assistant_recovery_failure",
    offset: 58_000,
    completed: 60_000,
    content: [
      completedTool({
        id: "tool_recovery_failure",
        name: "shell",
        offset: 58_100,
        args: { command: "bun test src/timeline/rows-current.test.ts" },
        output: "1 pass\n1 fail\nExpected active disclosure to remain open.",
        metadata: { exit: 1 },
      }),
      {
        type: "text",
        text: "The focused test reproduces the issue. The row key changes when the running tool receives its result.",
      },
    ],
  }),
  assistant({
    id: "msg_assistant_recovery_edit",
    offset: 60_500,
    completed: 63_000,
    content: [
      completedTool({
        id: "tool_recovery_edit",
        name: "edit",
        offset: 60_600,
        args: {
          path: "packages/session-ui/src/timeline/timeline-row.ts",
          oldString: "return `${row.group.key}:${row.status}`",
          newString: "return row.group.key",
        },
        output: "Updated packages/session-ui/src/timeline/timeline-row.ts",
        metadata: {
          files: [
            {
              file: "packages/session-ui/src/timeline/timeline-row.ts",
              patch:
                "diff --git a/packages/session-ui/src/timeline/timeline-row.ts b/packages/session-ui/src/timeline/timeline-row.ts\nindex ac4ed80..4f0ecb1 100644\n--- a/packages/session-ui/src/timeline/timeline-row.ts\n+++ b/packages/session-ui/src/timeline/timeline-row.ts\n@@ -1 +1 @@\n-export const key = (row) => `${row.group.key}:${row.status}`\n+export const key = (row) => row.group.key\n",
              additions: 1,
              deletions: 1,
              status: "modified",
            },
          ],
        },
      }),
      completedTool({
        id: "tool_recovery_pass",
        name: "shell",
        offset: 62_000,
        args: { command: "bun test src/timeline" },
        output: "14 pass\n0 fail\nRan 14 tests across 3 files.",
        metadata: { exit: 0 },
      }),
    ],
  }),
  assistant({
    id: "msg_assistant_recovery_result",
    offset: 63_500,
    completed: 64_500,
    content: [
      {
        type: "text",
        text: "Kept the disclosure keyed to the stable tool group. The focused failure now passes, and all 14 timeline tests are green.",
      },
    ],
  }),
] satisfies SessionMessageInfo[])

export const requestHistoryDocument = document([
  user("msg_user_requests", "Ask before changing the release target.", 40_000),
  assistant({
    id: "msg_assistant_requests",
    offset: 41_000,
    completed: 44_000,
    content: [
      completedTool({
        id: "tool_question_release",
        name: "question",
        offset: 41_500,
        args: {
          questions: [
            {
              question: "Which release target should I use?",
              header: "Target",
              options: [
                { label: "Canary", description: "Publish for internal validation" },
                { label: "Stable", description: "Publish to all users" },
              ],
            },
          ],
        },
        output: "Canary",
        metadata: { answers: [["Canary"]] },
      }),
      failedTool({
        id: "tool_permission_release",
        name: "shell",
        offset: 43_000,
        args: { command: "npm publish --tag canary" },
        message: "Permission was denied for npm publish --tag canary",
      }),
    ],
  }),
] satisfies SessionMessageInfo[])

export const inspectAndExplainDocument = document([
  user(
    "msg_user_research",
    "Review how the Session timeline keeps tool rows stable while streaming. Do not change code.",
    65_000,
  ),
  assistant({
    id: "msg_assistant_research_context",
    offset: 66_000,
    completed: 69_000,
    content: [
      {
        type: "reasoning",
        text: "## Tracing row identity\n\nI will follow the projection from current messages to rendered row keys.",
        time: { created: STORY_TIME + 66_100, completed: STORY_TIME + 66_400 },
      },
      completedTool({
        id: "tool_research_glob",
        name: "glob",
        offset: 66_500,
        args: { pattern: "src/timeline/**/*.{ts,tsx}", path: "packages/session-ui" },
        output:
          "packages/session-ui/src/timeline/projection.ts\npackages/session-ui/src/timeline/session-timeline.tsx\npackages/session-ui/src/timeline/timeline-row.ts",
        metadata: { count: 3 },
      }),
      completedTool({
        id: "tool_research_grep",
        name: "grep",
        offset: 67_000,
        args: { pattern: "TimelineRow.key", path: "packages/session-ui/src/timeline", include: "*.ts*" },
        output:
          "packages/session-ui/src/timeline/projection.ts:39\npackages/session-ui/src/timeline/session-timeline.tsx:332",
        metadata: { matches: 2 },
      }),
      completedTool({
        id: "tool_research_read",
        name: "read",
        offset: 67_500,
        args: { path: "packages/session-ui/src/timeline/projection.ts", offset: 309, limit: 125 },
        output:
          "export function reuseTimelineRows(previous, rows) {\n  // Preserve matching row objects and context keys.\n}",
        metadata: { loaded: ["packages/session-ui/src/timeline/projection.ts"] },
      }),
    ],
  }),
  assistant({
    id: "msg_assistant_research_result",
    offset: 69_500,
    completed: 71_000,
    content: [
      {
        type: "text",
        text: "The projection owns row identity in one pass. It reuses matching row objects, preserves context-group keys when older history attaches, and renders by those stable keys. Streaming updates therefore replace content without remounting unrelated rows.",
      },
    ],
  }),
] satisfies SessionMessageInfo[])

export const webResearchDocument = document([
  user("msg_user_web_research", "Check the current accessibility guidance for status updates in live regions.", 72_000),
  assistant({
    id: "msg_assistant_web_research",
    offset: 73_000,
    completed: 76_000,
    content: [
      completedTool({
        id: "tool_web_search",
        name: "websearch",
        offset: 73_100,
        args: { query: "figma mcp setup" },
        output: [
          "https://www.figma.com/community/file/1606560040358762787/figma-mcp-console-setup-guide",
          "https://designagentlab.com",
          "https://www.figma.com/community/whiteboarding?resource_type=widgets",
          "https://figma-console-mcp.southleft.com/mcp",
          "https://designagentlab.com/figma-console-mcp",
          "https://designagentlab.com/figma-tutorials",
          "https://github.com/southleft/figma-console-mcp/issues",
          "https://designagentlab.com/ui-kits",
          "https://designagentlab.com/prototyping-tools",
          "https://www.inthepocket.design/guidelines/figma-mcp/setup-figma-mcp",
          "https://www.figma.com/community/plugins",
          "https://figma-console-mcp.southleft.com/docs",
          "https://designagentlab.com/resources",
          "https://github.com/southleft/figma-console-mcp/releases",
          "https://www.inthepocket.design/blog/figma-mcp",
          "https://designagentlab.com/community",
        ].join("\n"),
        metadata: { provider: "firecrawl" },
      }),
      completedTool({
        id: "tool_web_fetch",
        name: "webfetch",
        offset: 74_000,
        args: { url: "https://www.figma.com" },
        output: "Status messages should be programmatically determinable without receiving focus.",
      }),
    ],
  }),
  assistant({
    id: "msg_assistant_web_result",
    offset: 76_500,
    completed: 77_500,
    content: [
      {
        type: "text",
        text: "Use a status role for concise progress updates that should be announced without moving focus. Avoid putting the complete streaming transcript in one assertive live region.",
      },
    ],
  }),
] satisfies SessionMessageInfo[])

export const loadedResourcesDocument = document([
  user("msg_user_skill", "Read the project instructions, load the RTL-aware skill, and review the file row.", 79_000),
  assistant({
    id: "msg_assistant_skill",
    offset: 80_000,
    completed: 82_000,
    content: [
      completedTool({
        id: "tool_loaded_file",
        name: "read",
        offset: 80_100,
        args: { path: "C:/workspaces/opencode/packages/cli/AGENTS.md" },
        output: "Project instructions loaded.",
        metadata: { loaded: ["C:/workspaces/opencode/packages/cli/AGENTS.md"] },
      }),
      completedTool({
        id: "tool_skill_rtl",
        name: "skill",
        offset: 80_200,
        args: { name: "rtl-aware-development" },
        output: "Loaded RTL-aware development guidance",
        metadata: { name: "rtl-aware-development" },
      }),
      {
        type: "text",
        text: "The row keeps the surrounding interface in RTL while isolating `packages/app/src/session.tsx` as LTR code. Focus order remains semantic.",
      },
    ],
  }),
] satisfies SessionMessageInfo[])

export const instructionsUpdatedSingleDocument = document([
  user("msg_user_instructions_single", "Check if beta service reports the shared session as running.", 85_000),
  assistant({
    id: "msg_assistant_instructions_single",
    offset: 86_000,
    completed: 88_000,
    content: [
      {
        type: "text",
        text: "The beta service is healthy and already reports this shared session as running. I found unrelated desktop changes in the worktree and will leave them untouched; next I'm narrowing the beta-only capabilities to features that can be demonstrated safely in this session rather than invoking every administrative API.",
      },
    ],
  }),
  {
    id: "msg_instructions_updated_single",
    type: "system",
    text: "Updated instructions for api/v2-demo",
    description: "Instructions updated: api/v2-demo",
    time: { created: STORY_TIME + 89_000 },
  },
] satisfies SessionMessageInfo[])

export const instructionsUpdatedMultipleDocument = document([
  user("msg_user_instructions_multi", "Check if beta service reports the shared session as running.", 85_000),
  assistant({
    id: "msg_assistant_instructions_multi",
    offset: 86_000,
    completed: 88_000,
    content: [
      {
        type: "text",
        text: "The beta service is healthy and already reports this shared session as running. I found unrelated desktop changes in the worktree and will leave them untouched; next I'm narrowing the beta-only capabilities to features that can be demonstrated safely in this session rather than invoking every administrative API.",
      },
    ],
  }),
  {
    id: "msg_instructions_updated_multi",
    type: "system",
    text: "Updated instructions for api/v2-demo and api/session",
    description: "Instructions updated: api/v2-demo, api/session",
    time: { created: STORY_TIME + 89_000 },
  },
] satisfies SessionMessageInfo[])

export const permissionPendingDocument = document(
  [
    user("msg_user_permission_pending", "Publish the verified preview build to the canary channel.", 83_000),
    assistant({
      id: "msg_assistant_permission_pending",
      offset: 84_000,
      content: [
        runningTool({
          id: "tool_permission_pending",
          name: "shell",
          offset: 84_100,
          args: { command: "npm publish --tag canary" },
        }),
      ],
    }),
  ] satisfies SessionMessageInfo[],
  { type: "busy" },
)

export const questionPendingDocument = document(
  [
    user("msg_user_question_pending", "Add the Session panel, but ask which layout to use first.", 85_000),
    assistant({
      id: "msg_assistant_question_pending",
      offset: 86_000,
      content: [
        runningTool({
          id: "tool_question_pending",
          name: "question",
          offset: 86_100,
          args: {
            questions: [
              {
                header: "Layout",
                question: "Which Session layout should I implement?",
                options: [
                  { label: "Focused", description: "Keep the conversation at a comfortable reading width" },
                  { label: "Wide", description: "Keep the review panel visible beside the conversation" },
                ],
              },
            ],
          },
        }),
      ],
    }),
  ] satisfies SessionMessageInfo[],
  { type: "busy" },
)

export const activeQuestionRequest = {
  id: "form_session_layout",
  sessionID: CURRENT_SESSION_ID,
  title: "Session layout",
  metadata: { kind: "question" },
  fields: [
    {
      key: "layout",
      type: "string",
      title: "Layout",
      description: "Which Session layout should I implement?",
      options: [
        { value: "focused", label: "Focused", description: "Keep the conversation at a comfortable reading width" },
        { value: "wide", label: "Wide", description: "Keep the review panel visible beside the conversation" },
      ],
      custom: true,
    },
    {
      key: "details",
      type: "multiselect",
      title: "Include",
      description: "Which supporting surfaces should remain visible?",
      options: [
        { value: "files", label: "Changed files" },
        { value: "terminal", label: "Terminal" },
        { value: "tasks", label: "Background tasks" },
      ],
    },
  ],
} satisfies FormInfo

export const retryDocument = document(
  [
    user("msg_user_retry", "Generate the migration notes.", 50_000),
    assistant({
      id: "msg_assistant_retry",
      offset: 51_000,
      content: [],
      retry: {
        attempt: 2,
        at: 1_900_000_000_000,
        error: { type: "ProviderRateLimitError", message: "Rate limit reached. Retrying with backoff." },
      },
    }),
  ] satisfies SessionMessageInfo[],
  { type: "busy" },
)

const compactionPrelude = [
  user("msg_user_compact", "Continue the implementation after compacting context.", 60_000),
  assistant({
    id: "msg_assistant_before_compact",
    offset: 61_000,
    completed: 62_500,
    content: [{ type: "text", text: "I inspected the timeline and identified the current message boundary." }],
    error: { type: "ExecutionInterrupted", message: "Context compaction started" },
  }),
] satisfies SessionMessageInfo[]

export const compactionRunningDocument = document(
  [
    ...compactionPrelude,
    {
      id: "msg_compaction_running",
      type: "compaction",
      status: "running",
      reason: "auto",
      summary: "## Goal\n\nRestore compaction output while preserving timeline notices.",
      recent: "",
      time: { created: STORY_TIME + 63_000 },
    },
  ] satisfies SessionMessageInfo[],
  { type: "busy" },
)

export const compactionDocument = document([
  ...compactionPrelude,
  {
    id: "msg_compaction_complete",
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "The Session timeline now consumes current nested assistant content.",
    recent: "Add deterministic stories and verify Storybook.",
    cost: 0.0142,
    tokens: { input: 3_180, output: 412, reasoning: 96, cache: { read: 8_704, write: 0 } },
    time: { created: STORY_TIME + 63_000 },
  },
  assistant({
    id: "msg_assistant_after_compact",
    offset: 64_000,
    completed: 66_000,
    content: [{ type: "text", text: "Context restored. I continued from the durable Session messages." }],
  }),
] satisfies SessionMessageInfo[])

export const compactionFailedDocument = document([
  ...compactionPrelude,
  {
    id: "msg_compaction_failed",
    type: "compaction",
    status: "failed",
    reason: "auto",
    error: { type: "compaction.failed", message: "The provider rejected the compaction request." },
    time: { created: STORY_TIME + 63_000 },
  },
] satisfies SessionMessageInfo[])

export const compactionCancelledDocument = document([
  ...compactionPrelude,
  {
    id: "msg_compaction_cancelled",
    type: "compaction",
    status: "failed",
    reason: "manual",
    error: { type: "aborted", message: "Compaction cancelled" },
    time: { created: STORY_TIME + 63_000 },
  },
] satisfies SessionMessageInfo[])

export const subagentDocument = document(
  [
    user("msg_user_subagent", "Delegate the fixture review and report the result.", 70_000),
    assistant({
      id: "msg_assistant_subagent",
      offset: 71_000,
      agent: "build",
      content: [
        completedTool({
          id: "tool_subagent_review",
          name: "subagent",
          offset: 71_500,
          args: {
            agent: "review",
            description: "Review current Session fixtures",
            prompt: "Check the current Session fixtures for protocol accuracy and report findings.",
          },
          output: "The fixtures use fixed current protocol messages and nested tool states.",
          metadata: { sessionID: "session_child_review", status: "completed" },
        }),
        runningTool({
          id: "tool_subagent_tests",
          name: "subagent",
          offset: 73_000,
          args: {
            agent: "test",
            description: "Check the Storybook scenarios",
            prompt: "Run the focused Storybook scenario checks and report any failures.",
          },
          metadata: { sessionId: "session_child_tests" },
        }),
      ],
    }),
  ] satisfies SessionMessageInfo[],
  { type: "busy" },
)

export const attachmentsAndCommentsDocument = document([
  {
    ...user("msg_user_attachments", "Use @review to check the attached layout and the selected lines.", 80_000),
    files: [
      {
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        mime: "image/png",
        name: "timeline-layout.png",
        source: { type: "inline" },
      },
      {
        data: "IyBTdG9yeWJvb2sgY2hlY2tsaXN0Cg==",
        mime: "text/markdown",
        name: "review-checklist.md",
        source: { type: "inline" },
        mention: { text: "@review-checklist.md", start: 32, end: 52 },
      },
    ],
    agents: [{ name: "review", mention: { text: "@review", start: 4, end: 11 } }],
  },
  assistant({
    id: "msg_assistant_attachments",
    offset: 81_000,
    completed: 83_000,
    content: [
      {
        type: "text",
        text: "The attachment and line comment both point to the narrow timeline spacing. I kept the correction local.",
      },
    ],
  }),
] satisfies SessionMessageInfo[])

export const attachmentsAndCommentsPresentation = {
  msg_user_attachments: {
    comments: [
      {
        path: "packages/session-ui/src/timeline/session-timeline.tsx",
        comment: "Keep the row readable at 360 px without changing the production component.",
        selection: { startLine: 238, endLine: 241 },
      },
    ],
  },
} satisfies Record<string, SessionUserPresentation>

export const revertDocument = document([
  user("msg_user_revert_base", "Add a compact Session summary.", 90_000),
  assistant({
    id: "msg_assistant_revert_base",
    offset: 91_000,
    completed: 93_000,
    content: [{ type: "text", text: "Added a compact summary with the current Session status." }],
  }),
  user("msg_user_revert_boundary", "Replace the summary with an animated dashboard.", 94_000),
  assistant({
    id: "msg_assistant_revert_boundary",
    offset: 95_000,
    completed: 98_000,
    content: [{ type: "text", text: "Created the dashboard draft. Use the user action menu to revert this boundary." }],
  }),
] satisfies SessionMessageInfo[])

const largeMessages = Array.from({ length: 16 }, (_, index) => {
  const offset = 110_000 + index * 5_000
  const userID = `msg_user_large_${String(index + 1).padStart(2, "0")}`
  const assistantID = `msg_assistant_large_${String(index + 1).padStart(2, "0")}`
  const context =
    index % 4 === 0
      ? [
          completedTool({
            id: `tool_read_large_${String(index + 1).padStart(2, "0")}`,
            name: "read",
            offset: offset + 1_500,
            args: { path: `src/feature-${index + 1}.ts`, offset: 1, limit: 80 },
            output: `export const feature${index + 1} = true`,
            metadata: { loaded: [`src/feature-${index + 1}.ts`] },
          }),
        ]
      : []
  return [
    user(userID, `Complete deterministic Session UI checkpoint ${index + 1}.`, offset),
    assistant({
      id: assistantID,
      offset: offset + 1_000,
      completed: offset + 3_500,
      content: [
        ...context,
        {
          type: "text",
          text: `Checkpoint ${index + 1} is complete. The message uses fixed protocol data and stable content.`,
        },
      ],
    }),
  ] satisfies SessionMessageInfo[]
}).flat()

export const largeCompletedDocument = {
  sessionID: CURRENT_SESSION_ID,
  messages: largeMessages,
  status: { type: "idle" },
  diffs: [
    {
      file: "packages/session-ui/src/timeline/session-timeline.stories.tsx",
      patch: "@@ -0,0 +1,16 @@",
      additions: 16,
      deletions: 0,
      status: "added",
    },
  ],
} satisfies SessionDocument

export const activePermissionRequest = {
  id: "permission_publish_canary",
  sessionID: CURRENT_SESSION_ID,
  action: "shell",
  resources: ["npm publish --tag canary"],
  save: ["npm publish *"],
  source: { type: "tool", messageID: "msg_assistant_permission_pending", id: "tool_permission_pending" },
} satisfies PermissionRequest
