// Current Session tool presentation grouped by visual family.
import {
  Component,
  batch,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  Index,
  type JSX,
} from "solid-js"
import stripAnsi from "strip-ansi"
import { createTwoFilesPatch } from "diff"
import { Dynamic } from "solid-js/web"
import { type SessionSummary, useData } from "../context"
import { useFileComponent } from "@opencode/ui/context/file"
import { type UiI18n, useI18n } from "@opencode/ui/context/i18n"
import { BasicTool, GenericTool } from "../components/basic-tool"
import { FileIcon } from "@opencode/ui/file-icon"
import { Icon, type IconProps } from "@opencode/ui/icon"
import { ToolErrorCard } from "../components/tool-error-card"
import { DiffChanges } from "@opencode/ui/diff-changes"
import { Markdown } from "../components/markdown"
import { createMarkdownImages } from "../components/markdown-image"
import { useMarkdown } from "../context/markdown"
import { getDirectory, getFilename } from "@opencode/util/path"
import { checksum } from "@opencode/util/encode"
import { Tooltip } from "@opencode/ui/tooltip"
import { IconButton } from "@opencode/ui/icon-button"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { changedFileDiff, patchFileGroups } from "../components/apply-patch-file"
import { animate } from "motion"
import { SessionProgressIndicatorV2 } from "../v2/components/session-progress-indicator-v2"
import type {
  SessionMessageAssistantReasoning,
  SessionMessageAssistantTool,
  SessionMessageShell,
} from "@opencode/client/promise"
import {
  currentToolError,
  currentToolHasLoadedFiles,
  currentToolInput,
  currentToolMetadata,
  currentToolOutput,
  executeToolFailed,
} from "../message/current-tool-state"
import { AssistantReasoningContent, writeClipboard } from "../message/message-content"
import { followShellOutput } from "./shell-output"

function ShellSubmessage(props: { text: string; animate?: boolean }) {
  let widthRef: HTMLSpanElement | undefined
  let valueRef: HTMLSpanElement | undefined

  onMount(() => {
    if (!props.animate) return
    requestAnimationFrame(() => {
      if (widthRef) {
        animate(widthRef, { width: "auto" }, { type: "spring", visualDuration: 0.25, bounce: 0 })
      }
      if (valueRef) {
        animate(valueRef, { opacity: 1, filter: "blur(0px)" }, { duration: 0.32, ease: [0.16, 1, 0.3, 1] })
      }
    })
  })

  return (
    <span data-component="shell-submessage" dir="ltr">
      <span ref={widthRef} data-slot="shell-submessage-width" style={{ width: props.animate ? "0px" : undefined }}>
        <span data-slot="basic-tool-tool-subtitle">
          <span
            ref={valueRef}
            data-slot="shell-submessage-value"
            style={props.animate ? { opacity: 0, filter: "blur(2px)" } : undefined}
          >
            {props.text}
          </span>
        </span>
      </span>
    </span>
  )
}

interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

type QuestionInfo = { question: string }
type QuestionAnswer = string[]

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function questionInfo(value: unknown): value is QuestionInfo {
  return record(value) && typeof value.question === "string"
}

function questionAnswer(value: unknown): value is QuestionAnswer {
  return Array.isArray(value) && value.every((answer) => typeof answer === "string")
}

function isDiagnostic(value: unknown): value is Diagnostic {
  if (!value || typeof value !== "object") return false
  if (!("message" in value) || typeof value.message !== "string") return false
  if (!("range" in value) || !value.range || typeof value.range !== "object") return false
  return "start" in value.range && !!value.range.start && typeof value.range.start === "object"
}

function getDiagnostics(diagnosticsByFile: unknown, filePath: string | undefined): Diagnostic[] {
  if (!record(diagnosticsByFile) || !filePath) return []
  const diagnostics = diagnosticsByFile[filePath]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics
    .filter(isDiagnostic)
    .filter((diagnostic) => diagnostic.severity === 1)
    .slice(0, 3)
}

function DiagnosticsDisplay(props: { diagnostics: Diagnostic[] }): JSX.Element {
  const i18n = useI18n()
  return (
    <Show when={props.diagnostics.length > 0}>
      <div data-component="diagnostics">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-label">{i18n.t("ui.messagePart.diagnostic.error")}</span>
              <span data-slot="diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

function relativizeProjectPath(path: string, directory?: string) {
  if (!path) return ""
  if (!directory) return path
  if (directory === "/") return path
  if (directory === "\\") return path
  if (path === directory) return ""

  const separator = directory.includes("\\") ? "\\" : "/"
  const prefix = directory.endsWith(separator) ? directory : directory + separator
  if (!path.startsWith(prefix)) return path
  return path.slice(directory.length)
}

function displayDirectory(path: string | undefined) {
  const data = useData()
  return relativizeProjectPath(getDirectory(path), data.directory)
}

import { resolveFileDiff } from "../components/session-diff"

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
}

function agentTitle(i18n: UiI18n, type?: string) {
  if (!type) return i18n.t("ui.tool.agent.default")
  return i18n.t("ui.tool.agent", { type })
}

const agentTones: Record<string, string> = {
  ask: "var(--icon-agent-ask-base)",
  build: "var(--icon-agent-build-base)",
  docs: "var(--icon-agent-docs-base)",
  plan: "var(--icon-agent-plan-base)",
}

const v2AgentTones: Record<string, string> = {
  build: "var(--v2-agent-build-solid)",
  explore: "var(--v2-agent-explore-solid)",
  plan: "var(--v2-agent-plan-solid)",
  review: "var(--v2-agent-review-solid)",
  writer: "var(--v2-agent-writer-solid)",
}

const agentThemeColors: Record<string, string> = {
  primary: "var(--text-interactive-base)",
  secondary: "var(--text-base)",
  accent: "var(--icon-info-base)",
  success: "var(--icon-success-base)",
  warning: "var(--icon-warning-base)",
  error: "var(--icon-critical-base)",
  info: "var(--icon-info-base)",
}

const v2AgentThemeColors: Record<string, string> = {
  primary: "var(--v2-text-text-accent)",
  secondary: "var(--v2-text-text-muted)",
  accent: "var(--v2-icon-icon-accent)",
  success: "var(--v2-state-fg-success)",
  warning: "var(--v2-state-fg-warning)",
  error: "var(--v2-state-fg-danger)",
  info: "var(--v2-state-fg-info)",
}

const agentPalette = [
  "var(--icon-agent-ask-base)",
  "var(--icon-agent-build-base)",
  "var(--icon-agent-docs-base)",
  "var(--icon-agent-plan-base)",
  "var(--syntax-info)",
  "var(--syntax-success)",
  "var(--syntax-warning)",
  "var(--syntax-property)",
  "var(--syntax-constant)",
  "var(--text-diff-add-base)",
  "var(--text-diff-delete-base)",
  "var(--icon-warning-base)",
]

function tone(name: string) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return agentPalette[hash % agentPalette.length]
}

function taskAgent(
  raw: unknown,
  list?: readonly { name: string; color?: string }[],
): { name?: string; color?: string; v2Color?: string } {
  if (typeof raw !== "string" || !raw) return {}
  const key = raw.toLowerCase()
  const item = list?.find((entry) => entry.name === raw || entry.name.toLowerCase() === key)
  const v2Tone = item?.color ? undefined : v2AgentTones[key]
  const color = agentColor(item?.color, agentThemeColors) ?? agentTones[key] ?? tone(key)
  const v2Color = agentColor(item?.color, v2AgentThemeColors) ?? v2Tone ?? color
  return {
    name: item?.name ?? `${raw[0].toUpperCase()}${raw.slice(1)}`,
    color,
    v2Color,
  }
}

function agentColor(value: string | undefined, themeColors: Record<string, string>) {
  if (!value) return undefined
  return themeColors[value] ?? value
}

function webSearchProviderLabel(provider: unknown, i18n: ReturnType<typeof useI18n>) {
  const name =
    provider === "parallel"
      ? "Parallel"
      : provider === "exa"
        ? "Exa"
        : provider === "firecrawl"
          ? "Firecrawl"
          : provider === "tavily"
            ? "Tavily"
            : undefined
  if (name) return i18n.t("ui.tool.websearch.provider", { provider: name })
  return i18n.t("ui.tool.websearch")
}

function readToolPath(input: Record<string, unknown>) {
  if (typeof input.path === "string") return input.path
  return undefined
}

function readImagePath(input: Record<string, unknown>) {
  const path = readToolPath(input)
  if (!path || !/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(path)) return
  return path.replaceAll("\\", "/")
}

function skillToolName(input: Record<string, unknown>, metadata?: Record<string, unknown>) {
  if (typeof metadata?.name === "string") return metadata.name
  if (typeof input.id === "string") return input.id
  if (typeof input.name === "string") return input.name
  return undefined
}

export function getToolInfo(
  tool: string,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> | undefined = {},
): ToolInfo {
  const i18n = useI18n()
  switch (tool) {
    case "read": {
      const path = readToolPath(input)
      return {
        icon: "glasses",
        title: i18n.t("ui.tool.read"),
        subtitle: path ? getFilename(path) : undefined,
      }
    }
    case "list":
      return {
        icon: "bullet-list",
        title: i18n.t("ui.tool.list"),
        subtitle: typeof input.path === "string" ? getFilename(input.path) : undefined,
      }
    case "glob":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.glob"),
        subtitle: typeof input.pattern === "string" ? input.pattern : undefined,
      }
    case "grep":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.grep"),
        subtitle: typeof input.pattern === "string" ? input.pattern : undefined,
      }
    case "browser":
      return {
        icon: "window-cursor",
        title: i18n.t("ui.tool.browser"),
      }
    case "webfetch":
      return {
        icon: "window-cursor",
        title: i18n.t("ui.tool.webfetch"),
        subtitle: typeof input.url === "string" ? input.url : undefined,
      }
    case "websearch":
      return {
        icon: "window-cursor",
        title: webSearchProviderLabel(metadata?.provider, i18n),
        subtitle: typeof input.query === "string" ? input.query : undefined,
      }
    case "subagent": {
      const raw = input.agent
      const type = typeof raw === "string" && raw ? raw[0].toUpperCase() + raw.slice(1) : undefined
      return {
        icon: "task",
        title: agentTitle(i18n, type),
        subtitle: typeof input.description === "string" ? input.description : undefined,
      }
    }
    case "shell":
      return {
        icon: "console",
        title: i18n.t("ui.tool.shell"),
        subtitle: typeof input.command === "string" ? input.command : undefined,
      }
    case "execute":
      return {
        icon: "console",
        title: i18n.t("ui.tool.execute"),
        subtitle: typeof input.code === "string" ? input.code : undefined,
      }
    case "edit":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.edit"),
        subtitle: typeof input.path === "string" ? getFilename(input.path) : undefined,
      }
    case "write":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.write"),
        subtitle: typeof input.path === "string" ? getFilename(input.path) : undefined,
      }
    case "patch":
      return {
        icon: "code-lines",
        title: i18n.t("ui.tool.patch"),
        subtitle:
          Array.isArray(input.files) && input.files.length
            ? `${input.files.length} ${i18n.plural("ui.common.file", input.files.length)}`
            : undefined,
      }
    case "todowrite":
      return {
        icon: "checklist",
        title: i18n.t("ui.tool.todos"),
      }
    case "question":
      return {
        icon: "bubble-5",
        title: i18n.t("ui.tool.questions"),
      }
    case "skill":
      return {
        icon: "brain",
        title: skillToolName(input, metadata) || i18n.t("ui.tool.skill"),
      }
    default:
      return {
        icon: "mcp",
        title: tool,
      }
  }
}

function urls(text: string | undefined) {
  if (!text) return []
  const seen = new Set<string>()
  return [...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)]
    .map((item) => item[0].replace(/[),.;:!?]+$/g, ""))
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

function sessionLink(id: string | undefined, href?: (id: string) => string | undefined) {
  if (!id) return undefined
  return href?.(id)
}

function taskSession(
  input: Record<string, unknown>,
  parentID: string | undefined,
  sessions: SessionSummary[] | undefined,
) {
  if (!parentID) return undefined
  const description = typeof input.description === "string" ? input.description : ""
  return (sessions ?? [])
    .filter((session) => session.parentID === parentID && !session.time?.archived)
    .filter((session) => (description ? session.title?.startsWith(description) : true))
    .sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))[0]?.id
}

function ExaOutput(props: { output?: string }) {
  const i18n = useI18n()
  const [showAll, setShowAll] = createSignal(false)
  let firstRevealedRef: HTMLAnchorElement | undefined
  const links = createMemo(() => urls(props.output))
  const visibleLinks = createMemo(() => {
    const all = links()
    if (showAll() || all.length <= 10) return all
    return all.slice(0, 10)
  })
  const remaining = createMemo(() => Math.max(0, links().length - 10))

  const expand = (event: MouseEvent) => {
    event.stopPropagation()
    setShowAll(true)
    requestAnimationFrame(() => {
      firstRevealedRef?.focus()
    })
  }

  return (
    <Show when={links().length > 0}>
      <div data-component="exa-tool-output">
        <div data-slot="exa-tool-links">
          <For each={visibleLinks()}>
            {(url, index) => (
              <a
                ref={(el) => {
                  if (index() === 10) firstRevealedRef = el
                }}
                data-slot="exa-tool-link"
                class="webfetch-link"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                <span data-slot="webfetch-link-text">{url}</span>
                <Icon name="outline-square-arrow" class="webfetch-link-icon" />
              </a>
            )}
          </For>
          <Show when={!showAll() && remaining() > 0}>
            <button type="button" data-slot="exa-tool-more" onClick={expand}>
              {i18n.plural("ui.common.moreCount", remaining())}
            </button>
          </Show>
        </div>
      </div>
    </Show>
  )
}

export type ContextGroupPart =
  | SessionMessageAssistantTool
  | (SessionMessageAssistantReasoning & { id: string; streaming?: boolean })
  | { type: "notice" | "shell"; id: string; render: () => JSX.Element }

export function CurrentContextToolGroup(props: {
  parts: ContextGroupPart[]
  busy: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSizeChange?: () => void
  reasoningDefaultOpen?: boolean
  reasoningOpen?: (id: string) => boolean | undefined
  onReasoningOpenChange?: (id: string, open: boolean) => void
  toolDefaultOpen?: (tool: SessionMessageAssistantTool) => boolean | undefined
  toolOpen?: (id: string) => boolean | undefined
  onToolOpenChange?: (id: string, open: boolean) => void
  fileOpen?: (path: string) => boolean | undefined
  onFileOpenChange?: (path: string, open: boolean) => void
  patchGroupKey?: (tools: SessionMessageAssistantTool[]) => string
}) {
  const i18n = useI18n()
  const tools = createMemo(() => props.parts.filter((part) => part.type === "tool"))
  const pending = createMemo(
    () => props.busy || tools().some((tool) => tool.state.status === "streaming" || tool.state.status === "running"),
  )
  const names = createMemo(() =>
    [
      ...new Set(
        props.parts.flatMap((part) => {
          if (part.type !== "tool" && part.type !== "shell") return []
          return [
            part.type !== "tool"
              ? i18n.t("ui.tool.shell")
              : part.name === "skill"
                ? i18n.t("ui.tool.skill")
                : part.name === "subagent"
                  ? i18n.t("ui.tool.agent.default")
                  : getToolInfo(part.name, undefined, part.name === "websearch" ? currentToolMetadata(part) : undefined)
                      .title,
          ]
        }),
      ),
    ].join(", "),
  )
  const patchedFiles = createMemo(() =>
    patchFileGroups(
      tools().flatMap((tool) => {
        if (tool.name !== "patch" || tool.state.status === "error") return []
        const files = currentToolMetadata(tool).files
        return Array.isArray(files) ? files : []
      }),
    ).length,
  )
  const label = createMemo(() => {
    const thoughts = props.parts.filter((part) => part.type === "reasoning").length
    if (!names() && !thoughts) {
      const title = i18n.t("ui.messagePart.context.details")
      return { text: title, title, before: "", count: "", between: "", after: "" }
    }
    const title = names() || i18n.plural("ui.messagePart.context.thought", thoughts)
    const count =
      patchedFiles() || props.parts.filter((part) => part.type === "tool" || part.type === "shell").length || thoughts
    const text = i18n.plural("ui.messagePart.tools.used", count, { tools: title })
    const index = text.indexOf(title)
    const before = text.slice(0, index).trim()
    const countText = String(count)
    const countIndex = before.indexOf(countText)
    const after = text.slice(index + title.length).trim()
    if (countIndex === -1) return { text, title, before, count: "", between: "", after }
    return {
      text,
      title,
      before: before.slice(0, countIndex).trim(),
      count: countText,
      between: before.slice(countIndex + countText.length).trim(),
      after,
    }
  })
  const items = createMemo(() =>
    (props.open ? props.parts : []).reduce<
      (SessionMessageAssistantTool[] | Exclude<ContextGroupPart, SessionMessageAssistantTool>)[]
    >((groups, tool) => {
      if (tool.type !== "tool") {
        groups.push(tool)
        return groups
      }
      const previous = groups.at(-1)
      if (
        tool.name === "patch" &&
        tool.state.status !== "error" &&
        Array.isArray(previous) &&
        previous?.[0]?.name === "patch" &&
        previous[0].state.status !== "error"
      ) {
        previous.push(tool)
        return groups
      }
      if (
        tool.name === "skill" &&
        tool.state.status !== "error" &&
        skillToolName(currentToolInput(tool), currentToolMetadata(tool)) &&
        Array.isArray(previous) &&
        previous?.[0]?.name === "skill" &&
        previous[0].state.status !== "error" &&
        skillToolName(currentToolInput(previous[0]), currentToolMetadata(previous[0]))
      ) {
        previous.push(tool)
        return groups
      }
      groups.push([tool])
      return groups
    }, []),
  )
  const patchKeys = createMemo(() => {
    const keys = new Map<SessionMessageAssistantTool, string>()
    items().forEach((item) => {
      if (!Array.isArray(item) || item[0]?.name !== "patch" || item[0].state.status === "error") return
      const key = props.patchGroupKey?.(item) ?? item[0].id
      item.forEach((tool) => keys.set(tool, key))
    })
    return keys
  })
  const change = (open: boolean) => {
    props.onOpenChange(open)
    props.onSizeChange?.()
  }

  return (
    <div data-component="collapsed-tool-group" data-timeline-part-ids={props.parts.map((part) => part.id).join(",")}>
      <BasicTool
        icon="glasses"
        status={pending() ? "running" : "completed"}
        compact
        hasContent
        allowOpenWhilePending
        open={props.open}
        onOpenChange={change}
        trigger={
          <div data-component="context-tool-group-trigger" aria-label={label().text}>
            <span data-slot="context-tool-group-title">
              <Show when={label().before || label().count || label().between}>
                <span data-slot="context-tool-group-usage">
                  <Show when={label().before}>
                    {(before) => <span data-slot="context-tool-group-prefix">{before()} </span>}
                  </Show>
                  <Show when={label().count}>
                    {(count) => <span data-slot="context-tool-group-count">{count()} </span>}
                  </Show>
                  <Show when={label().between}>
                    {(between) => <span data-slot="context-tool-group-prefix">{between()} </span>}
                  </Show>
                </span>
              </Show>
              <span data-slot="basic-tool-tool-title">{label().title}</span>
              <Show when={label().after}>
                {(after) => <span data-slot="context-tool-group-prefix">{after()}</span>}
              </Show>
            </span>
          </div>
        }
      >
        <div data-component="context-tool-group-list">
          <Index each={items()}>
            {(item) => {
              const group = createMemo(() => {
                const value = item()
                return Array.isArray(value) ? value : undefined
              })
              const reasoning = createMemo(() => {
                const value = item()
                return !Array.isArray(value) && value.type === "reasoning" ? value : undefined
              })
              const callback = createMemo(() => {
                const value = item()
                return !Array.isArray(value) && (value.type === "notice" || value.type === "shell") ? value : undefined
              })
              return (
                <Show
                  when={group()}
                  fallback={
                    <Show
                      when={reasoning()}
                      fallback={
                        <Show when={callback()}>
                          {(part) => <div data-slot="context-tool-group-item">{part().render()}</div>}
                        </Show>
                      }
                    >
                      {(part) => (
                        <div data-slot="context-tool-group-item">
                          <AssistantReasoningContent
                            id={part().id}
                            content={part()}
                            streaming={part().streaming ?? false}
                            defaultOpen={props.reasoningDefaultOpen}
                            open={props.reasoningOpen?.(part().id)}
                            onOpenChange={(open) => props.onReasoningOpenChange?.(part().id, open)}
                            onContentRendered={props.onSizeChange}
                          />
                        </div>
                      )}
                    </Show>
                  }
                >
                  {(group) => {
                    const tool = createMemo(() => group()[0]!)
                    const trigger = createMemo(() => currentContextToolTrigger(tool(), i18n))
                    const skills = createMemo(() =>
                      group().flatMap((item) => {
                        const name = skillToolName(currentToolInput(item), currentToolMetadata(item))
                        return name ? [name] : []
                      }),
                    )
                    const marker = "__OPENCODE_LOADED_SKILL__"
                    const loaded = createMemo(() =>
                      i18n.plural("ui.tool.loadedSkills", skills().length, { name: marker }),
                    )
                    return (
                      <div data-slot="context-tool-group-item">
                        <Show
                          when={
                            tool().state.status !== "error" &&
                            ["read", "glob", "grep", "list"].includes(tool().name) &&
                            !(tool().name === "read" && readImagePath(currentToolInput(tool()))) &&
                            !currentToolHasLoadedFiles(tool())
                          }
                          fallback={
                            <Show
                              when={tool().name === "skill" && group().length > 1 && skills().length === group().length}
                              fallback={
                                <Show
                                  when={tool().name === "patch" && tool().state.status !== "error"}
                                  fallback={
                                    <ToolDisplay
                                      id={tool().id}
                                      tool={tool().name}
                                      input={currentToolInput(tool())}
                                      metadata={currentToolMetadata(tool())}
                                      output={currentToolOutput(tool())}
                                      error={currentToolError(tool())}
                                      status={tool().state.status}
                                      defaultOpen={props.toolDefaultOpen?.(tool()) ?? false}
                                      open={props.toolOpen?.(tool().id) ?? props.toolDefaultOpen?.(tool())}
                                      onOpenChange={(open) => props.onToolOpenChange?.(tool().id, open)}
                                      deferContent
                                      virtualizeDiff={false}
                                      onContentRendered={props.onSizeChange}
                                    />
                                  }
                                >
                                  <CurrentFileToolGroup
                                    tools={group()}
                                    fileOpen={
                                      props.fileOpen &&
                                      ((path) => props.fileOpen?.(`${patchKeys().get(tool())}:${path}`))
                                    }
                                    onFileOpenChange={
                                      props.onFileOpenChange &&
                                      ((path, open) =>
                                        props.onFileOpenChange?.(`${patchKeys().get(tool())}:${path}`, open))
                                    }
                                    onSizeChange={props.onSizeChange}
                                  />
                                </Show>
                              }
                            >
                              <div
                                data-component="tool-loaded-item"
                                data-timeline-part-ids={group()
                                  .map((item) => item.id)
                                  .join(",")}
                                aria-label={i18n.plural("ui.tool.loadedSkills", skills().length, {
                                  name: skills().join(", "),
                                })}
                              >
                                <span data-slot="tool-loaded-label" aria-hidden="true">
                                  {loaded().split(marker)[0]?.trim()}
                                </span>
                                <span data-slot="tool-loaded-value" aria-hidden="true">
                                  <For each={skills()}>
                                    {(name, index) => (
                                      <>
                                        <Show when={index() > 0}>, </Show>
                                        <TextShimmer
                                          as="span"
                                          text={name}
                                          active={["streaming", "running"].includes(group()[index()]!.state.status)}
                                        />
                                      </>
                                    )}
                                  </For>
                                </span>
                                <Show when={loaded().split(marker)[1]?.trim()}>
                                  {(suffix) => (
                                    <span data-slot="tool-loaded-kind" aria-hidden="true">
                                      {suffix()}
                                    </span>
                                  )}
                                </Show>
                              </div>
                            </Show>
                          }
                        >
                          <div data-component="tool-trigger">
                            <div data-slot="basic-tool-tool-trigger-content">
                              <div data-slot="basic-tool-tool-info">
                                <div data-slot="basic-tool-tool-info-structured">
                                  <div data-slot="basic-tool-tool-info-main">
                                    <span data-slot="basic-tool-tool-title">
                                      <TextShimmer
                                        text={trigger().title}
                                        active={
                                          tool().state.status === "streaming" || tool().state.status === "running"
                                        }
                                      />
                                    </span>
                                    <Show when={trigger().subtitle}>
                                      {(subtitle) => <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>}
                                    </Show>
                                    <For each={trigger().args}>
                                      {(arg) => <span data-slot="basic-tool-tool-arg">{arg}</span>}
                                    </For>
                                  </div>
                                  <Show when={trigger().matches}>
                                    {(matches) => (
                                      <>
                                        <span data-slot="context-tool-group-dot" />
                                        <span data-slot="context-tool-group-matches">{matches()}</span>
                                      </>
                                    )}
                                  </Show>
                                </div>
                              </div>
                            </div>
                          </div>
                        </Show>
                      </div>
                    )
                  }}
                </Show>
              )
            }}
          </Index>
        </div>
      </BasicTool>
    </div>
  )
}

export function CurrentFileToolGroup(props: {
  tools: SessionMessageAssistantTool[]
  fileOpen?: (path: string) => boolean | undefined
  onFileOpenChange?: (path: string, open: boolean) => void
  onSizeChange?: () => void
}) {
  const files = createMemo((previous: { key: string; toolID: string; value: unknown }[]) => {
    const next = props.tools.flatMap((tool) => {
      const files = currentToolMetadata(tool).files
      if (Array.isArray(files) && files.length > 0)
        return files.map((value, index) => ({ key: `${tool.id}:${index}`, toolID: tool.id, value }))
      if (tool.name !== "write") return []
      const input = currentToolInput(tool)
      if (typeof input.path !== "string" || typeof input.content !== "string" || !input.content) return []
      return [
        {
          key: `${tool.id}:0`,
          toolID: tool.id,
          value: {
            file: input.path,
            patch: createTwoFilesPatch(input.path, input.path, "", input.content),
            additions: input.content.split("\n").length - Number(input.content.endsWith("\n")),
            deletions: 0,
            status: "modified",
          },
        },
      ]
    })
    const updates = new Map(next.map((entry) => [entry.key, entry.value]))
    const existing = new Set(previous.map((entry) => entry.key))
    const owners = new Set(props.tools.map((tool) => tool.id))
    const result = [
      ...previous
        .filter((entry) => owners.has(entry.toolID))
        .map((entry) => {
          if (!updates.has(entry.key)) return entry
          const value = updates.get(entry.key)
          return samePatchFile(value, entry.value) ? entry : { ...entry, value }
        }),
      ...next.filter((entry) => !existing.has(entry.key)),
    ]
    return result.length === previous.length && result.every((entry, index) => entry === previous[index])
      ? previous
      : result
  }, [])
  const metadata = createMemo(() => ({
    files: files().map((entry) => entry.value),
  }))
  const pending = createMemo(() =>
    props.tools.some((tool) => tool.state.status === "streaming" || tool.state.status === "running"),
  )
  const render = ToolRegistry.render("patch") ?? GenericTool
  const tool = createMemo(() => {
    const name = props.tools[0]?.name
    return name === "edit" || name === "write" ? name : "patch"
  })

  return (
    <div
      data-component="tool-part-wrapper"
      data-timeline-part-id={props.tools.length === 1 ? props.tools[0]?.id : undefined}
      data-timeline-part-ids={props.tools.length > 1 ? props.tools.map((tool) => tool.id).join(",") : undefined}
    >
      <Dynamic
        component={render}
        tool={tool()}
        input={{}}
        metadata={metadata()}
        status={pending() ? "running" : "completed"}
        fileOpen={props.fileOpen}
        onFileOpenChange={props.onFileOpenChange}
        deferContent
        virtualizeDiff={false}
        onContentRendered={props.onSizeChange}
      />
    </div>
  )
}

function samePatchFile(a: unknown, b: unknown) {
  if (a === b) return true
  if (!record(a) || !record(b)) return false
  return (
    a.file === b.file &&
    a.patch === b.patch &&
    a.additions === b.additions &&
    a.deletions === b.deletions &&
    a.status === b.status
  )
}

function currentContextToolTrigger(tool: SessionMessageAssistantTool, i18n: ReturnType<typeof useI18n>) {
  const input = currentToolInput(tool)
  const metadata = currentToolMetadata(tool)
  const path = typeof input.path === "string" ? input.path : "/"
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined
  const include = typeof input.include === "string" ? input.include : undefined
  const count = tool.name === "glob" ? metadata.count : tool.name === "grep" ? metadata.matches : undefined
  const matches =
    typeof count === "number" && Number.isFinite(count) && count !== 0
      ? i18n.plural("ui.messagePart.context.match", count)
      : undefined
  if (tool.name === "read") {
    const args = [
      ...(typeof input.offset === "number" ? [`offset=${input.offset}`] : []),
      ...(typeof input.limit === "number" ? [`limit=${input.limit}`] : []),
    ]
    return { title: i18n.t("ui.tool.read"), subtitle: getFilename(path), args, matches: undefined }
  }
  if (tool.name === "list")
    return { title: i18n.t("ui.tool.list"), subtitle: displayDirectory(path), args: [], matches: undefined }
  if (tool.name === "glob")
    return {
      title: i18n.t("ui.tool.glob"),
      subtitle: displayDirectory(path),
      args: pattern ? [`pattern=${pattern}`] : [],
      matches,
    }
  return {
    title: i18n.t("ui.tool.grep"),
    subtitle: displayDirectory(path),
    args: [...(pattern ? [`pattern=${pattern}`] : []), ...(include ? [`include=${include}`] : [])],
    matches,
  }
}

export interface ToolProps {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  sessionID?: string
  output?: string
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  fileOpen?: (path: string) => boolean | undefined
  onFileOpenChange?: (path: string, open: boolean) => void
  deferContent?: boolean
  virtualizeDiff?: boolean
  onContentRendered?: () => void
  forceOpen?: boolean
  locked?: boolean
}

export type ToolComponent = Component<ToolProps>

const state: Record<
  string,
  {
    name: string
    render?: ToolComponent
  }
> = {}

export function registerTool(input: { name: string; render?: ToolComponent }) {
  state[input.name] = input
  return input
}

export function getTool(name: string) {
  return state[name]?.render
}

export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}

function FileTool(props: ToolProps & { title: string; count: number; children?: JSX.Element }) {
  const i18n = useI18n()
  return (
    <BasicTool
      {...props}
      open
      onOpenChange={undefined}
      locked
      icon="code-lines"
      hasContent
      defer={false}
      rail={false}
      trigger={{
        title: props.title,
        subtitle: props.count > 0 ? `${props.count} ${i18n.plural("ui.common.file", props.count)}` : "",
      }}
    >
      {props.children}
    </BasicTool>
  )
}

function FileAccordionGroup(props: { children: JSX.Element }) {
  return (
    <div
      data-component="accordion"
      data-scope="apply-patch"
      style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
        if (!(event.target instanceof HTMLButtonElement) || event.target.dataset.slot !== "accordion-trigger") return
        if (event.target.closest('[data-component="accordion"]') !== event.currentTarget) return
        const triggers = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            ':scope > [data-slot="accordion-item"] > [data-slot="accordion-header"] > [data-slot="accordion-trigger"]',
          ),
        ]
        const index = triggers.indexOf(event.target)
        if (index < 0) return
        event.preventDefault()
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? triggers.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + triggers.length) % triggers.length
        triggers[next]?.focus()
      }}
    >
      {props.children}
    </div>
  )
}

function FileAccordionItem(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  type?: string
  header: JSX.Element
  children: JSX.Element
}) {
  const id = createUniqueId()
  return (
    <div
      data-slot="accordion-item"
      data-type={props.type}
      data-expanded={props.open ? "" : undefined}
      data-closed={!props.open ? "" : undefined}
    >
      <h3
        data-slot="accordion-header"
        data-component="sticky-accordion-header"
        data-expanded={props.open ? "" : undefined}
        data-closed={!props.open ? "" : undefined}
      >
        <button
          type="button"
          id={`${id}-trigger`}
          data-slot="accordion-trigger"
          data-expanded={props.open ? "" : undefined}
          data-closed={!props.open ? "" : undefined}
          aria-expanded={props.open}
          aria-controls={props.open ? `${id}-content` : undefined}
          onClick={() => batch(() => props.onOpenChange(!props.open))}
        >
          {props.header}
        </button>
      </h3>
      <Show when={props.open}>
        <div
          id={`${id}-content`}
          role="region"
          aria-labelledby={`${id}-trigger`}
          data-slot="accordion-content"
          data-expanded=""
        >
          {props.children}
        </div>
      </Show>
    </div>
  )
}

function ToolFileAccordion(props: {
  path: string
  actions?: JSX.Element
  children: JSX.Element
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  forceOpen?: boolean
  defer?: boolean
}) {
  const [expanded, setExpanded] = createSignal(props.defaultOpen ?? false)
  const [visible, setVisible] = createSignal(false)
  const open = () => props.open ?? expanded()
  const change = (value: boolean) => {
    if (props.open === undefined) setExpanded(value)
    props.onOpenChange?.(value)
  }

  createEffect(() => {
    if (props.forceOpen && !open()) change(true)
  })

  createEffect(() => {
    if (!open()) {
      setVisible(false)
      return
    }
    const frame = requestAnimationFrame(() => setVisible(true))
    onCleanup(() => cancelAnimationFrame(frame))
  })

  return (
    <FileAccordionGroup>
      <FileAccordionItem
        open={open()}
        onOpenChange={change}
        header={
          <div data-slot="apply-patch-trigger-content">
            <div data-slot="apply-patch-file-info">
              <FileIcon node={{ path: props.path, type: "file" }} />
              <div data-slot="apply-patch-file-name-container">
                <Show when={props.path.includes("/")}>
                  <span data-slot="apply-patch-directory">{`\u202A${displayDirectory(props.path)}\u202C`}</span>
                </Show>
                <span data-slot="apply-patch-filename">{getFilename(props.path)}</span>
              </div>
            </div>
            <div data-slot="apply-patch-trigger-actions">
              {props.actions}
              <Icon name="chevron-grabber-vertical" size="small" />
            </div>
          </div>
        }
      >
        <Show when={!props.defer || visible()}>{props.children}</Show>
      </FileAccordionItem>
    </FileAccordionGroup>
  )
}

export function ToolDisplay(
  props: ToolProps & {
    id: string
    error?: string
  },
) {
  const data = useData()
  const i18n = useI18n()
  if (props.tool === "todowrite") return null
  const hideQuestion = () => props.tool === "question" && (props.status === "streaming" || props.status === "running")
  const taskId = createMemo(() => {
    if (props.tool !== "subagent") return undefined
    const value = props.metadata.sessionID
    if (typeof value === "string" && value) return value
    return undefined
  })
  const taskHref = createMemo(() => sessionLink(taskId(), data.sessionHref))
  const taskSubtitle = createMemo(() => {
    if (props.tool !== "subagent") return undefined
    const value = props.input.description
    if (typeof value === "string" && value) return value
    return taskId()
  })
  const errorSubtitle = createMemo(() => toolErrorSubtitle(props, i18n))
  const error = createMemo(() => toolDisplayError(props, i18n.t("ui.toolErrorCard.failed")))
  const render = createMemo(() => ToolRegistry.render(props.tool) ?? GenericTool)

  return (
    <Show when={!hideQuestion()}>
      <div data-component="tool-part-wrapper" data-timeline-part-id={props.id}>
        <Switch>
          <Match when={error()}>
            {(error) => {
              const cleaned = error().replace("Error: ", "")
              if (props.tool === "question" && cleaned.includes("dismissed this question")) {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-13-regular text-text-weak cursor-default">
                      {i18n.t("ui.messagePart.questions.dismissed")}
                    </span>
                  </div>
                )
              }
              return (
                <ToolErrorCard
                  tool={props.tool}
                  error={error()}
                  title={props.tool === "websearch" ? webSearchProviderLabel(props.metadata.provider, i18n) : undefined}
                  defaultOpen={props.defaultOpen}
                  open={props.open}
                  onOpenChange={props.onOpenChange}
                  subtitle={taskSubtitle() ?? errorSubtitle()}
                  href={taskHref()}
                  onSubtitleClick={(event) => {
                    if (!data.navigateToSession) return
                    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
                    const id = taskId()
                    if (!id) return
                    event.preventDefault()
                    data.navigateToSession(id)
                  }}
                />
              )
            }}
          </Match>
          <Match when={true}>
            <Dynamic component={render()} {...props} />
          </Match>
        </Switch>
      </div>
    </Show>
  )
}

// Each branch must stay in sync with its tool trigger's subtitle expression so
// failed rows read like their non-error counterparts ("Shell sleep 30").
function toolErrorSubtitle(props: ToolProps, i18n: UiI18n) {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)
  if (props.tool === "shell") return text(props.input.command) ?? text(props.metadata.command)
  if (props.tool === "execute") return text(props.input.code)
  if (props.tool === "read") return getFilename(readToolPath(props.input) ?? "")
  if (props.tool === "edit" || props.tool === "write") return getFilename(text(props.input.path) ?? "")
  if (props.tool === "list" || props.tool === "glob" || props.tool === "grep")
    return displayDirectory(text(props.input.path) ?? "/")
  if (props.tool === "webfetch") return text(props.input.url)
  if (props.tool === "websearch") return text(props.input.query)
  if (props.tool === "skill") return skillToolName(props.input, props.metadata)
  if (props.tool === "patch") {
    const count = new Set(
      Array.isArray(props.metadata.files) ? props.metadata.files.filter(changedFileDiff).map((file) => file.file) : [],
    ).size
    if (count === 0) return undefined
    return `${count} ${i18n.plural("ui.common.file", count)}`
  }
  if (props.tool === "question") {
    const count = Array.isArray(props.input.questions) ? props.input.questions.filter(questionInfo).length : 0
    if (count === 0) return undefined
    return `${count} ${i18n.plural("ui.common.question", count)}`
  }
  return undefined
}

function toolDisplayError(props: ToolProps & { error?: string }, fallback: string) {
  if (props.status === "error") return props.error
  if (props.tool !== "execute") return undefined
  if (!executeToolFailed(props.metadata)) return undefined
  if (typeof props.output === "string" && props.output) return props.output
  return fallback
}

ToolRegistry.register({
  name: "read",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const image = createMemo(() => (props.status === "completed" ? readImagePath(props.input) : undefined))
    const args: string[] = []
    if (typeof props.input.offset === "number") args.push("offset=" + props.input.offset)
    if (typeof props.input.limit === "number") args.push("limit=" + props.input.limit)
    const loaded = createMemo(() => {
      if (props.status !== "completed") return []
      const value = props.metadata.loaded
      if (!value || !Array.isArray(value)) return []
      return value.filter((p): p is string => typeof p === "string")
    })
    const paths = createMemo(() =>
      loaded().map((filepath) => {
        const relative = relativizeProjectPath(filepath, data.directory)
        return relative === filepath ? relative : relative.replace(/^[/\\]/, "")
      }),
    )
    const marker = "__OPENCODE_LOADED_PATH__"
    const parts = createMemo(() => i18n.t("ui.tool.loadedFile", { path: marker }).split(marker))
    return (
      <>
        <BasicTool
          {...props}
          icon="glasses"
          hasContent={!!image()}
          defer
          onOpenChange={(open) => {
            props.onOpenChange?.(open)
            props.onContentRendered?.()
          }}
          trigger={{
            title: i18n.t("ui.tool.read"),
            subtitle: getFilename(readToolPath(props.input) ?? ""),
            args,
          }}
        >
          <Show when={image()} keyed>
            {(path) => <ReadImage path={path} onContentRendered={props.onContentRendered} />}
          </Show>
        </BasicTool>
        <Show when={paths().length > 0}>
          <div
            data-component="tool-loaded-item"
            aria-label={i18n.t("ui.tool.loadedFile", { path: paths().join(", ") })}
          >
            <span data-slot="tool-loaded-label" aria-hidden="true">
              {parts()[0]?.trim()}
            </span>
            <span data-slot="tool-loaded-value" aria-hidden="true">
              {paths().join(", ")}
            </span>
            <Show when={parts()[1]?.trim()}>
              {(suffix) => (
                <span data-slot="tool-loaded-kind" aria-hidden="true">
                  {suffix()}
                </span>
              )}
            </Show>
          </div>
        </Show>
      </>
    )
  },
})

function ReadImage(props: { path: string; onContentRendered?: () => void }) {
  const markdown = useMarkdown()
  let root!: HTMLDivElement
  createEffect(() => {
    if (!markdown?.readImage) return
    const images = createMarkdownImages(markdown.readImage)
    images.update(root)
    onCleanup(() => images.dispose())
  })
  onMount(() => props.onContentRendered?.())
  return (
    <div ref={root} data-component="read-image">
      <img
        data-local-image={props.path}
        alt={getFilename(props.path)}
        onLoad={() => props.onContentRendered?.()}
        onError={() => props.onContentRendered?.()}
      />
    </div>
  )
}

ToolRegistry.register({
  name: "list",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="bullet-list"
        hasContent={!!props.output}
        trigger={{
          title: i18n.t("ui.tool.list"),
          subtitle: displayDirectory(typeof props.input.path === "string" ? props.input.path : "/"),
        }}
      >
        <Show when={props.output}>
          <div
            data-component="tool-output"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "glob",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        hasContent={!!props.output}
        trigger={{
          title: i18n.t("ui.tool.glob"),
          subtitle: displayDirectory(typeof props.input.path === "string" ? props.input.path : "/"),
          args: typeof props.input.pattern === "string" ? ["pattern=" + props.input.pattern] : [],
        }}
      >
        <Show when={props.output}>
          <div
            data-component="tool-output"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "grep",
  render(props) {
    const i18n = useI18n()
    const args: string[] = []
    if (typeof props.input.pattern === "string") args.push("pattern=" + props.input.pattern)
    if (typeof props.input.include === "string") args.push("include=" + props.input.include)
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        hasContent={!!props.output}
        trigger={{
          title: i18n.t("ui.tool.grep"),
          subtitle: displayDirectory(typeof props.input.path === "string" ? props.input.path : "/"),
          args,
        }}
      >
        <Show when={props.output}>
          <div
            data-component="tool-output"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "webfetch",
  render(props) {
    const i18n = useI18n()
    const pending = createMemo(() => props.status === "streaming" || props.status === "running")
    const url = createMemo(() => {
      const value = props.input.url
      if (typeof value !== "string") return ""
      return value
    })
    return (
      <BasicTool
        {...props}
        hideDetails
        icon="window-cursor"
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.webfetch")} active={pending()} />
              </span>
              <Show when={!pending() && url()}>
                <a
                  data-slot="basic-tool-tool-subtitle"
                  class="webfetch-link"
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  <span data-slot="webfetch-link-text">{url()}</span>
                  <Icon name="outline-square-arrow" class="webfetch-link-icon" />
                </a>
              </Show>
            </div>
          </div>
        }
      />
    )
  },
})

ToolRegistry.register({
  name: "websearch",
  render(props) {
    const i18n = useI18n()
    const query = createMemo(() => {
      const value = props.input.query
      if (typeof value !== "string") return ""
      return value
    })
    const title = createMemo(() => webSearchProviderLabel(props.metadata.provider, i18n))

    return (
      <BasicTool
        {...props}
        icon="window-cursor"
        trigger={{
          title: title(),
          subtitle: query(),
          subtitleClass: "exa-tool-query",
        }}
      >
        <ExaOutput output={props.output} />
      </BasicTool>
    )
  },
})
ToolRegistry.register({
  name: "subagent",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const delegating = () => props.status === "streaming"
    const childSessionId = createMemo(() => {
      const value = props.metadata.sessionID
      if (typeof value === "string" && value) return value
      return taskSession(props.input, data.sessionID, data.store.session)
    })
    const agent = createMemo(() => taskAgent(props.input.agent, data.store.agent))
    const title = createMemo(() => agent().name ?? i18n.t("ui.tool.agent.default"))
    const tone = createMemo(() => agent().color)
    const v2Tone = createMemo(() => agent().v2Color)
    const background = createMemo(() => {
      return props.metadata.background === true || (props.status === "completed" && props.metadata.status === "running")
    })
    const subtitle = createMemo(() => {
      const value =
        typeof props.input.description === "string" && props.input.description
          ? props.input.description
          : childSessionId()
      if (!value) return value
      if (background()) return `${value} (background)`
      return value
    })
    const running = createMemo(() => {
      if (props.status === "streaming" || props.status === "running") return true
      const id = childSessionId()
      if (!id) return false
      return (data.store.session_status[id]?.type ?? "idle") !== "idle"
    })

    const href = createMemo(() => sessionLink(childSessionId(), data.sessionHref))
    const clickable = createMemo(() => !!(childSessionId() && (data.navigateToSession || href())))

    const open = () => {
      const id = childSessionId()
      if (!id) return
      data.navigateToSession?.(id)
    }

    const navigate = (event: MouseEvent) => {
      if (!data.navigateToSession) return
      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      event.preventDefault()
      open()
    }
    const navigateKey = (event: KeyboardEvent) => {
      if (!clickable() || href()) return
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      open()
    }

    const trigger = () => (
      <div
        data-component="task-tool-card"
        style={{
          "--task-agent-color": v2Tone(),
          "--task-agent-color-fallback": tone(),
        }}
      >
        <div data-component="task-tool-surface">
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <Show
                when={running()}
                fallback={
                  <span data-component="task-tool-icon">
                    <Icon name="subagent" size="small" />
                  </span>
                }
              >
                <span data-component="task-tool-spinner" style={{ color: tone() ?? "var(--icon-interactive-base)" }}>
                  <SessionProgressIndicatorV2
                    style={{ color: v2Tone() ?? "light-dark(var(--v2-text-text-base), #ffffff)" }}
                  />
                </span>
              </Show>
              <span data-component="task-tool-title">{title()}</span>
              <Show when={subtitle()}>
                <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
              </Show>
            </div>
            <Show when={clickable()}>
              <div data-component="task-tool-action">
                <Icon name="chevron-right" size="normal" />
              </div>
            </Show>
          </div>
        </div>
      </div>
    )

    return (
      <Show
        when={delegating()}
        fallback={
          <BasicTool
            icon="task"
            status={props.status}
            trigger={trigger()}
            hideDetails
            triggerAsLink
            triggerHref={href()}
            clickable={clickable()}
            onTriggerClick={navigate}
            onTriggerKeyDown={navigateKey}
          />
        }
      >
        <div
          data-component="task-tool-delegating"
          class="flex h-9 w-fit max-w-full items-center gap-2 rounded-[8px] bg-v2-background-bg-layer-02 p-2.5 text-[13px] font-[530] leading-text-compact tracking-[-0.04px]"
        >
          <Icon name="subagent" size="small" class="shrink-0 text-v2-icon-icon-faint" />
          <TextShimmer text={i18n.t("ui.tool.agent.delegating")} class="min-w-0 truncate" />
        </div>
      </Show>
    )
  },
})

function ConsoleOutput(props: { copy: string; children: JSX.Element; variant?: "shell" }) {
  const i18n = useI18n()
  const [copied, setCopied] = createSignal(false)

  const copy = async () => {
    if (!props.copy) return
    if (!(await writeClipboard(props.copy))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div data-component="bash-output" data-variant={props.variant} dir="ltr">
      <div data-slot="bash-copy">
        <Tooltip value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")} placement="top">
          <IconButton
            icon={<Icon name={copied() ? "check" : "outline-copy"} size="small" />}
            size="normal"
            variant="ghost-muted"
            onMouseDown={(event) => event.preventDefault()}
            onClick={copy}
            aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
          />
        </Tooltip>
      </div>
      <div
        data-slot="bash-scroll"
        data-scrollable
        tabIndex={0}
        role="region"
        aria-label={i18n.t("ui.scrollView.ariaLabel")}
      >
        <pre data-slot="bash-pre">
          <code>{props.children}</code>
        </pre>
      </div>
    </div>
  )
}

ToolRegistry.register({
  name: "execute",
  render(props) {
    const i18n = useI18n()
    const pending = () => props.status === "streaming" || props.status === "running"
    const code = createMemo(() => (typeof props.input.code === "string" ? props.input.code : ""))
    const output = () => stripAnsi(props.output ?? "").replace(/\r\n?/g, "\n")
    const sawPending = pending()
    return (
      <BasicTool
        {...props}
        icon="console"
        rail={false}
        hasContent
        compact
        allowOpenWhilePending
        trigger={(open) => (
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.execute")} active={pending()} />
              </span>
              <Show when={!open() && code()}>
                <ShellSubmessage text={code().split("\n", 1)[0]} animate={sawPending} />
              </Show>
            </div>
          </div>
        )}
      >
        <ConsoleOutput copy={code()} variant="shell">
          <span data-slot="bash-command">{code()}</span>
          <Show when={output()}>{(value) => <span data-slot="bash-result">{value()}</span>}</Show>
        </ConsoleOutput>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "shell",
  render(props) {
    const i18n = useI18n()
    const data = useData()
    const streaming = () => props.status === "streaming"
    const pending = () =>
      streaming() ||
      props.status === "running" ||
      (typeof props.metadata.shellID === "string" && data.shellRunning?.(props.metadata.shellID) === true)
    const sawStreaming = streaming()
    const command = () => {
      if (typeof props.input.command === "string") return props.input.command
      if (typeof props.metadata.command === "string") return props.metadata.command
      return ""
    }
    function Output() {
      const [streamed, setStreamed] = createSignal("")
      // Direct-user terminal snapshots are authoritative; agent results can describe background shells.
      const saved = createMemo(() =>
        props.metadata.status === "exited" || props.metadata.status === "timeout" || props.metadata.status === "killed"
          ? props.output
          : undefined,
      )
      createEffect(() => {
        if (saved() !== undefined) return
        const id = props.metadata.shellID
        const load = data.shellOutput
        if (typeof id !== "string" || !load) return
        onCleanup(followShellOutput({ id, directory: data.directory, running: pending(), load, onOutput: setStreamed }))
      })
      const output = createMemo(() =>
        stripAnsi(
          saved() ?? ((typeof props.metadata.shellID === "string" && streamed()) || props.output || ""),
        ).replace(/\r\n?/g, "\n"),
      )
      return (
        <ConsoleOutput copy={command()} variant="shell">
          <span data-slot="bash-command">{command()}</span>
          <Show when={output()}>{(value) => <span data-slot="bash-result">{value()}</span>}</Show>
        </ConsoleOutput>
      )
    }
    return (
      <BasicTool
        {...props}
        icon="console"
        rail={false}
        hasContent
        compact
        allowOpenWhilePending
        trigger={(open) => (
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.shell")} active={pending()} />
              </span>
              <Show when={!open()}>
                <Show
                  when={command()}
                  fallback={
                    <Show when={streaming()}>
                      <span data-slot="basic-tool-tool-subtitle">{i18n.t("ui.tool.shell.writingCommand")}</span>
                    </Show>
                  }
                >
                  {(command) => <ShellSubmessage text={command()} animate={sawStreaming} />}
                </Show>
              </Show>
            </div>
          </div>
        )}
      >
        <Output />
      </BasicTool>
    )
  },
})

export function SessionShellMessage(props: {
  message: SessionMessageShell
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const i18n = useI18n()
  const render = ToolRegistry.render("shell") ?? GenericTool
  const error = createMemo(() => {
    const message = props.message
    if (message.status === "timeout") return i18n.t("ui.tool.shell.timeout")
    if (message.status === "killed") return i18n.t("ui.tool.shell.cancelled")
    if (message.status !== "exited" || message.exit === undefined || message.exit === 0) return
    return i18n.t("ui.tool.shell.exit", { code: message.exit })
  })
  return (
    <div data-component="session-shell-message" data-timeline-part-id={props.message.id}>
      <Dynamic
        component={render}
        tool="shell"
        input={{ command: props.message.command }}
        metadata={{
          shellID: props.message.shellID,
          status: props.message.status,
          exit: props.message.exit,
          truncated: props.message.output?.truncated,
        }}
        output={props.message.output?.output}
        status={props.message.status === "running" ? "running" : "completed"}
        defaultOpen={props.defaultOpen}
        open={props.open}
        onOpenChange={props.onOpenChange}
      />
      <Show when={error()}>
        {(error) => <ToolErrorCard tool="shell" error={error()} subtitle={props.message.command} />}
      </Show>
    </div>
  )
}

ToolRegistry.register({
  name: "edit",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const inputPath = () => (typeof props.input.path === "string" ? props.input.path : "")
    const diff = createMemo(() => {
      const files = props.metadata.files
      if (!Array.isArray(files)) return undefined
      return files.find(changedFileDiff)
    })
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, inputPath()))
    const path = createMemo(() => {
      const value = diff()
      return typeof value?.file === "string" ? value.file : inputPath()
    })
    const pending = () => props.status === "streaming" || props.status === "running"
    const diffSource = createMemo(
      () => {
        const source = diff()
        if (!source) return undefined
        return {
          file: typeof source.file === "string" ? source.file : inputPath(),
          patch: typeof source.patch === "string" ? source.patch : undefined,
        }
      },
      undefined,
      {
        equals: (a, b) => a?.file === b?.file && a?.patch === b?.patch,
      },
    )

    const fileCompProps = createMemo(() => {
      try {
        const source = diffSource()
        if (source) {
          const fileDiff = resolveFileDiff(source)
          if (fileDiff) return { fileDiff, hunkSeparators: fileDiff.isPartial ? "simple" : "line-info-basic" }
        }
      } catch {}

      return {
        before: {
          name: path(),
          contents: typeof props.input.oldString === "string" ? props.input.oldString : "",
        },
        after: {
          name: path(),
          contents: typeof props.input.newString === "string" ? props.input.newString : "",
        },
      }
    })

    return (
      <div data-component="edit-tool">
        <FileTool {...props} title={i18n.t("ui.messagePart.title.edit")} count={path() ? 1 : 0}>
          <Show when={path()}>
            <ToolFileAccordion
              path={path()}
              defaultOpen={props.defaultOpen}
              open={props.open}
              onOpenChange={props.onOpenChange}
              forceOpen={props.forceOpen}
              defer={props.deferContent !== false}
              actions={
                <Show when={!pending() ? diff() : undefined}>
                  {(diff) => <DiffChanges appearance="standard" changes={diff()} />}
                </Show>
              }
            >
              <div data-component="edit-content">
                <Dynamic
                  component={fileComponent}
                  mode="diff"
                  virtualize={props.virtualizeDiff}
                  onRendered={props.onContentRendered}
                  {...fileCompProps()}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </FileTool>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "write",
  render(props) {
    const fileComponent = useFileComponent()
    const path = createMemo(() => (typeof props.input.path === "string" ? props.input.path : ""))
    const content = createMemo(() => (typeof props.input.content === "string" ? props.input.content : ""))
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, path()))
    return (
      <div data-component="write-tool">
        <Show when={content() && path()}>
          <ToolFileAccordion
            path={path()}
            defaultOpen={props.defaultOpen}
            open={props.open}
            onOpenChange={props.onOpenChange}
            forceOpen={props.forceOpen}
            defer={props.deferContent !== false}
          >
            <div data-component="write-content">
              <Dynamic
                component={fileComponent}
                mode="text"
                file={{
                  name: path(),
                  contents: content(),
                  cacheKey: checksum(content()),
                }}
                overflow="scroll"
                onRendered={props.onContentRendered}
              />
            </div>
          </ToolFileAccordion>
        </Show>
        <DiagnosticsDisplay diagnostics={diagnostics()} />
      </div>
    )
  },
})

ToolRegistry.register({
  name: "patch",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const files = createMemo(() => patchFileGroups(props.metadata.files))
    const [expanded, setExpanded] = createSignal<string[]>([])
    const title = createMemo(() =>
      props.tool === "edit"
        ? i18n.t("ui.messagePart.title.edit")
        : props.tool === "write"
          ? i18n.t("ui.messagePart.title.write")
          : i18n.t("ui.tool.patch"),
    )
    const open = createMemo(() => {
      if (!props.fileOpen) return expanded()
      return files().flatMap((file) => (props.fileOpen?.(file.path) === true ? [file.path] : []))
    })
    const change = (value: string | string[]) => {
      const next = Array.isArray(value) ? value : value ? [value] : []
      if (!props.onFileOpenChange) {
        setExpanded(next)
        return
      }
      files().forEach((file) => props.onFileOpenChange?.(file.path, next.includes(file.path)))
    }

    return (
      <div data-component="apply-patch-tool">
        <Show when={files().length > 0} fallback={<FileTool {...props} title={title()} count={0} />}>
          <FileAccordionGroup>
            <Index each={files()}>
              {(file) => {
                const value = () => file().path
                const active = createMemo(() => open().includes(value()))
                const [visible, setVisible] = createSignal(false)

                createEffect(() => {
                  if (!active()) {
                    setVisible(false)
                    return
                  }

                  requestAnimationFrame(() => {
                    if (!active()) return
                    setVisible(true)
                  })
                })

                return (
                  <FileAccordionItem
                    open={active()}
                    onOpenChange={(expanded) =>
                      change(expanded ? [...open(), value()] : open().filter((path) => path !== value()))
                    }
                    type={file().type}
                    header={
                      <div data-slot="apply-patch-trigger-content">
                        <div data-slot="apply-patch-file-info">
                          <FileIcon node={{ path: file().path, type: "file" }} />
                          <div data-slot="apply-patch-file-name-container">
                            <Show when={file().path.includes("/")}>
                              <span data-slot="apply-patch-directory">{`\u202A${displayDirectory(file().path)}\u202C`}</span>
                            </Show>
                            <span data-slot="apply-patch-filename">{getFilename(file().path)}</span>
                          </div>
                        </div>
                        <div data-slot="apply-patch-trigger-actions">
                          <Switch>
                            <Match when={file().type === "add"}>
                              <span data-slot="apply-patch-change" data-type="added">
                                {i18n.t("ui.patch.action.created")}
                              </span>
                            </Match>
                            <Match when={file().type === "delete"}>
                              <span data-slot="apply-patch-change" data-type="removed">
                                {i18n.t("ui.patch.action.deleted")}
                              </span>
                            </Match>
                            <Match when={true}>
                              <DiffChanges
                                appearance="standard"
                                changes={{ additions: file().additions, deletions: file().deletions }}
                              />
                            </Match>
                          </Switch>
                          <Icon name="chevron-grabber-vertical" size="small" />
                        </div>
                      </div>
                    }
                  >
                    <Show when={props.deferContent === false || visible()}>
                      <For each={file().views}>
                        {(view) => (
                          <div data-component="apply-patch-file-diff">
                            <Dynamic
                              component={fileComponent}
                              mode="diff"
                              virtualize={props.virtualizeDiff}
                              fileDiff={view.fileDiff}
                              hunkSeparators={view.fileDiff.isPartial ? "simple" : "line-info-basic"}
                              onRendered={props.onContentRendered}
                            />
                          </div>
                        )}
                      </For>
                    </Show>
                  </FileAccordionItem>
                )
              }}
            </Index>
          </FileAccordionGroup>
        </Show>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "question",
  render(props) {
    const i18n = useI18n()
    const questions = createMemo(() =>
      Array.isArray(props.input.questions) ? props.input.questions.filter(questionInfo) : [],
    )
    const answers = createMemo(() =>
      Array.isArray(props.metadata.answers) ? props.metadata.answers.filter(questionAnswer) : [],
    )
    const completed = createMemo(() => answers().length > 0)

    const subtitle = createMemo(() => {
      const count = questions().length
      if (count === 0) return ""
      if (completed()) return i18n.t("ui.question.subtitle.answered", { count })
      return `${count} ${i18n.plural("ui.common.question", count)}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen={completed()}
        icon="bubble-5"
        trigger={{
          title: i18n.t("ui.tool.questions"),
          subtitle: subtitle(),
        }}
      >
        <Show when={completed()}>
          <div data-component="question-answers">
            <For each={questions()}>
              {(q, i) => {
                const answer = () => answers()[i()] ?? []
                return (
                  <div data-slot="question-answer-item">
                    <div data-slot="question-text">{q.question}</div>
                    <div data-slot="answer-text">{answer().join(", ") || i18n.t("ui.question.answer.none")}</div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "skill",
  render(props) {
    const i18n = useI18n()
    const name = createMemo(() => skillToolName(props.input, props.metadata))
    const running = createMemo(() => props.status === "streaming" || props.status === "running")
    const marker = "__OPENCODE_LOADED_SKILL__"
    const parts = createMemo(() => i18n.t("ui.tool.loadedSkill", { name: marker }).split(marker))

    return (
      <Show when={name()} fallback={<TextShimmer text={i18n.t("ui.tool.skill")} active={running()} />}>
        {(name) => (
          <div data-component="tool-loaded-item" aria-label={i18n.t("ui.tool.loadedSkill", { name: name() })}>
            <span data-slot="tool-loaded-label" aria-hidden="true">
              {parts()[0].trim()}
            </span>
            <span data-slot="tool-loaded-value" aria-hidden="true">
              <TextShimmer as="span" text={name()} active={running()} />
            </span>
            <Show when={parts()[1]?.trim()}>
              {(suffix) => (
                <span data-slot="tool-loaded-kind" aria-hidden="true">
                  {suffix()}
                </span>
              )}
            </Show>
          </div>
        )}
      </Show>
    )
  },
})
