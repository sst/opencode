import { markdown } from "@opencode/ui/storybook/fixtures"
import { createSignal, onCleanup } from "solid-js"
import { Markdown } from "./markdown"

export default {
  title: "OpenCode/Conversation/Markdown response",
  id: "components-markdown",
  component: Markdown,
  parameters: {
    docs: {
      description: {
        component:
          "Production assistant Markdown with headings, lists, links, inline code, and fenced code. The preview uses the same sanitizer, worker, and copy actions as a Session response.",
      },
    },
  },
}

export const CompleteResponse = {
  render: () => (
    <div class="mx-auto max-w-[760px] rounded-lg border border-border-weak-base bg-background-base px-5 py-4">
      <Markdown text={markdown} />
    </div>
  ),
}

export const CompactResult = {
  render: () => (
    <div class="mx-auto max-w-[560px] rounded-lg border border-border-weak-base bg-background-base px-5 py-4">
      <Markdown
        text={"Updated the Session status and verified it.\n\n- **12 tests passed**\n- `bun typecheck` passed"}
      />
    </div>
  ),
}

const streamed =
  "Streaming Markdown now keeps existing elements alive while each newly arriving word fades into the response."

function StreamingMarkdown() {
  const words = streamed.match(/\S+\s*/g) ?? []
  const [count, setCount] = createSignal(1)
  const timer = setInterval(() => setCount((value) => Math.min(value + 1, words.length)), 180)
  onCleanup(() => clearInterval(timer))
  return <Markdown text={words.slice(0, count()).join("")} streaming={count() < words.length} />
}

export const StreamingResponse = {
  render: () => (
    <div class="mx-auto max-w-[760px] rounded-lg border border-border-weak-base bg-background-base px-5 py-4">
      <StreamingMarkdown />
    </div>
  ),
}

function StreamingInlineCodeMarkdown() {
  const chunks = [
    "Updated ",
    "`apps/cloud",
    "flare/src/",
    "editor/Cloud",
    "Auth.ts:29",
    "-43` and ",
    "`packages/",
    "session-ui/src/",
    "components/markdown",
    "-solid.tsx`, ",
    "then verified ",
    "the changes with ",
    "`bun type",
    "check` and ",
    "`bun te",
    "st`.",
  ]
  const [count, setCount] = createSignal(1)
  const timer = setInterval(() => setCount((value) => (value >= chunks.length ? 1 : value + 1)), 220)
  onCleanup(() => clearInterval(timer))
  return <Markdown text={chunks.slice(0, count()).join("")} streaming />
}

export const StreamingInlineCode = {
  render: () => (
    <div class="mx-auto max-w-[760px] rounded-lg border border-border-weak-base bg-background-base px-5 py-4">
      <StreamingInlineCodeMarkdown />
    </div>
  ),
}
