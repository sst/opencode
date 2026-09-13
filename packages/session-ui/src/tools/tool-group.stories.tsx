import { createMemo, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createTwoFilesPatch } from "diff"
import { CurrentSessionProviders } from "../storybook/current-session-story"
import { storyDocument, storyTool } from "../storybook/current-session-scenarios"
import { type ContextGroupPart, CurrentContextToolGroup } from "./tool-renderer"

export default {
  title: "OpenCode/Work/Tool group",
  id: "current-tool-group",
  component: CurrentContextToolGroup,
}

export const MixedTools = {
  render: () => {
    const [open, setOpen] = createSignal(true)
    const tools = [
      storyTool(
        "group_shell",
        "shell",
        "completed",
        { command: "printf 'group geometry'" },
        { output: "group geometry" },
      ),
      storyTool("group_read", "read", "completed", { path: "src/group.ts" }),
      storyTool("group_general", "subagent", "completed", { agent: "general", description: "Inspect grouped tools" }),
      storyTool("group_explore", "subagent", "completed", { agent: "explore", description: "Check card geometry" }),
    ]
    return (
      <section style={{ width: "100%", "max-width": "720px", padding: "24px" }}>
        <CurrentSessionProviders document={storyDocument(tools)}>
          <CurrentContextToolGroup parts={tools} busy={false} open={open()} onOpenChange={setOpen} />
        </CurrentSessionProviders>
      </section>
    )
  },
}

export const MixedReasoning = {
  args: { reasoningDefaultOpen: false },
  render: (args: { reasoningDefaultOpen: boolean }) => {
    const [open, setOpen] = createSignal(true)
    const [appended, setAppended] = createSignal(false)
    const parts = createMemo<ContextGroupPart[]>(() => [
      storyTool("reasoning_read", "read", "completed", { path: "src/group.ts" }),
      {
        type: "reasoning",
        id: "reasoning_first",
        text: "The renderer groups adjacent tools. Check the relevant skills before changing it.",
      },
      storyTool("reasoning_skill_first", "skill", "completed", { id: "opencode" }),
      storyTool("reasoning_skill_second", "skill", "completed", { id: "frontend-design" }),
      {
        type: "reasoning",
        id: "reasoning_second",
        text: "Keep these skill groups separate so the reasoning stays in chronological order.",
      },
      storyTool("reasoning_skill_third", "skill", "completed", { id: "rtl-aware-development" }),
      ...(appended() ? [storyTool("reasoning_read_next", "read", "completed", { path: "src/group.test.ts" })] : []),
    ])
    return (
      <section class="mx-auto flex w-full max-w-[860px] flex-col gap-4 p-6">
        <button type="button" onClick={() => setAppended((value) => !value)}>
          {appended() ? "Remove follow-up read" : "Append follow-up read"}
        </button>
        <CurrentSessionProviders document={storyDocument(parts())}>
          <CurrentContextToolGroup
            parts={parts()}
            busy={false}
            open={open()}
            onOpenChange={setOpen}
            reasoningDefaultOpen={args.reasoningDefaultOpen}
          />
        </CurrentSessionProviders>
      </section>
    )
  },
}

export const PatchFollowUps = {
  args: { separator: "none" },
  argTypes: { separator: { control: "select", options: ["none", "shell", "error", "reasoning"] } },
  render: (args: { separator: string }) => {
    const [state, setState] = createStore({ phase: "initial", open: true, reasoning: true })
    const file = (path: string, before: number, after: number) => ({
      file: path,
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: createTwoFilesPatch(
        path,
        path,
        `export const value = ${before}\n`,
        `export const value = ${after}\n`,
        "",
        "",
        { context: Infinity },
      ),
    })
    const parts = createMemo<ContextGroupPart[]>(() => [
      storyTool("patch_shell", "shell", "completed", { command: "printf checked" }, { output: "checked" }),
      storyTool(
        "patch_first",
        "patch",
        "completed",
        {},
        {
          metadata: { files: [file("src/a.ts", 0, 1), file("src/b.ts", 0, 1)] },
        },
      ),
      ...(state.phase === "initial"
        ? []
        : [
            ...(args.separator === "shell"
              ? [storyTool("patch_separator", "shell", "completed", { command: "printf checked" })]
              : []),
            ...(args.separator === "error"
              ? [storyTool("patch_error", "patch", "error", {}, { error: "Patch failed" })]
              : []),
            ...(args.separator === "reasoning" && state.reasoning
              ? [
                  {
                    type: "reasoning" as const,
                    id: "patch_reasoning",
                    text: "The first patch is ready. Now update the remaining files.",
                  },
                ]
              : []),
            storyTool(
              "patch_next",
              "patch",
              state.phase === "running" ? "running" : "completed",
              {},
              {
                metadata:
                  state.phase === "running"
                    ? {}
                    : { files: [file("src/a.ts", 1, 2), file("src/c.ts", 0, 1), file("src/d.ts", 0, 1)] },
              },
            ),
          ]),
    ])
    return (
      <section class="mx-auto flex w-full max-w-[860px] flex-col gap-4 p-6">
        <div class="flex flex-wrap gap-3">
          <button type="button" onClick={() => setState("phase", "running")}>
            Start follow-up patch
          </button>
          <button type="button" onClick={() => setState("phase", "completed")}>
            Finish follow-up patch
          </button>
          <Show when={args.separator === "reasoning"}>
            <button type="button" onClick={() => setState("reasoning", (value) => !value)}>
              {state.reasoning ? "Hide thoughts" : "Show thoughts"}
            </button>
          </Show>
        </div>
        <CurrentSessionProviders document={storyDocument(parts())}>
          <CurrentContextToolGroup
            parts={parts()}
            busy={state.phase === "running"}
            open={state.open}
            onOpenChange={(open) => setState("open", open)}
          />
        </CurrentSessionProviders>
      </section>
    )
  },
}
