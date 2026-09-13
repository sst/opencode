import { createContext, createEffect, createMemo, createSignal, on, Show, useContext, type Accessor } from "solid-js"
import { useRenderer, type JSX } from "@opentui/solid"
import { TextAttributes, type RGBA } from "@opentui/core"
import type { SessionMessageAssistantTool } from "@opencode/client"
import { useConfig } from "../../config"
import { useData } from "../../context/data"
import { useLocal } from "../../context/local"
import { useTheme } from "../../context/theme"
import { Spinner } from "../../component/spinner"
import { canonicalToolName, toolDisplayMetadata, toolPresentationStatus } from "../../util/tool-display"

const detailsContext = createContext<Accessor<boolean>>(() => false)

export function useToolDetails() {
  return useContext(detailsContext)
}

// A tool result can finish while its background work continues. All layouts use
// the same live status instead of treating the result status as work status.
export function useToolStatus(part: Accessor<SessionMessageAssistantTool | undefined>) {
  const data = useData()
  return createMemo(() => {
    const value = part()
    const metadata = value ? toolDisplayMetadata(value.state) : {}
    const name = value ? canonicalToolName(value.name) : undefined
    const sessionID = metadata.sessionID ?? metadata.sessionId
    const backgroundRunning =
      (name === "shell" && typeof metadata.shellID === "string" && Boolean(data.shell.get(metadata.shellID))) ||
      (name === "subagent" && typeof sessionID === "string" && data.session.status(sessionID) === "running")
    return toolPresentationStatus(value, backgroundRunning)
  })
}

export function ToolPresentation(props: {
  part: SessionMessageAssistantTool
  sessionID: string
  children: JSX.Element
}) {
  const config = useConfig()
  const data = useData()
  const local = useLocal()
  const theme = useTheme()
  const renderer = useRenderer()
  const minimal = () => config.data.session?.tool_calls === "minimal"
  const [expanded, setExpanded] = createSignal(false)
  createEffect(on(minimal, () => setExpanded(false), { defer: true }))
  const [hover, setHover] = createSignal(false)
  const status = useToolStatus(() => props.part)
  const permission = () => {
    if (local.permission.mode === "auto") return false
    const source = data.session.permission.list(props.sessionID)?.[0]?.source
    return source?.type === "tool" && source.id === props.part.id
  }
  const color = () => {
    if (permission()) return theme.text.feedback.warning.default
    if (status().failed) return theme.text.feedback.error.default
    return hover() ? theme.text.default : theme.text.subdued
  }
  const summary = createMemo(() => {
    const input = props.part.state.input
    const label = minimalToolSummary(props.part.name, typeof input === "string" ? {} : input)
    const suffix = status().denied
      ? " — dismissed"
      : status().failed
        ? " — failed"
        : status().background
          ? " — background"
          : ""
    return label + suffix
  })

  return (
    <detailsContext.Provider value={minimal}>
      <Show when={minimal()}>
        <ToolSummaryRow
          id={`minimal-tool:${props.part.name}:${props.part.id}`}
          summary={summary()}
          status={status()}
          expanded={expanded()}
          color={color()}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={() => {
            if (renderer.getSelection()?.getSelectedText()) return
            setExpanded((value) => !value)
          }}
        />
      </Show>
      <Show when={!minimal() || expanded()}>
        {props.children}
        <Show when={minimal() && status().error}>
          <text paddingLeft={3} fg={status().denied ? theme.text.subdued : theme.text.feedback.error.default}>
            {status().error}
          </text>
        </Show>
      </Show>
    </detailsContext.Provider>
  )
}

export function ToolSummaryRow(props: {
  id?: string
  summary: string
  status: ReturnType<typeof toolPresentationStatus>
  expanded?: boolean
  color?: RGBA
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: () => void
}) {
  return (
    <box
      id={props.id}
      paddingLeft={3}
      flexDirection="row"
      height={1}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseUp={props.onMouseUp}
    >
      <box width={2} flexShrink={0}>
        <Show
          when={props.status.running}
          fallback={<text fg={props.color}>{props.status.failed ? "✗" : props.expanded ? "▾" : "▸"}</text>}
        >
          <Spinner color={props.color} />
        </Show>
      </box>
      <text
        flexGrow={1}
        minWidth={0}
        height={1}
        wrapMode="none"
        truncate
        fg={props.color}
        attributes={props.status.denied ? TextAttributes.STRIKETHROUGH : undefined}
      >
        {props.summary}
      </text>
    </box>
  )
}

export function minimalToolSummary(tool: string, input: Record<string, unknown>) {
  const patch = input.patchText
  const primary =
    typeof patch === "string" && patch
      ? [...patch.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\r\n]+)/g)].map((match) => match[1].trim()).join(", ")
      : ["description", "path", "filePath", "command", "pattern", "url", "query"]
          .map((key) => input[key])
          .find((value): value is string => typeof value === "string" && Boolean(value.trim()))
  return `${tool}${primary ? ` ${primary}` : ""}`.replace(/\s+/g, " ")
}
