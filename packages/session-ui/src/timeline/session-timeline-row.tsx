import type {
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessageUser,
  SessionStatus,
} from "@opencode/client/promise"
import { useI18n } from "@opencode/ui/context/i18n"
import { Tooltip } from "@opencode/ui/tooltip"
import { For, Show, createMemo, type Accessor, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { SessionUserActions, SessionUserComment } from "../actions"
import { useData } from "../context"
import { TimelineSeparator } from "../components/timeline-separator"
import {
  SessionAssistantContent,
  SessionContextToolGroup,
  SessionFileToolGroup,
  SessionShellMessage,
  SessionUserMessage,
  currentContentDefaultOpen,
} from "../message/current-message"
import { AssistantReasoningContent, SessionCompactionMessage } from "../message/message-content"
import type { ContextGroupPart } from "../tools/tool-renderer"
import { SessionRetry } from "../components/session-retry"
import { SessionError } from "../components/session-error"
import { timelineCategory, type TimelineDetail } from "./detail"
import { currentToolFailed } from "../message/current-tool-state"
import {
  createReactiveTimelineProjection,
  Timeline,
  TimelineRow,
  unwrapErrorMessage,
  type PartRef,
  type ReasoningMode,
} from "./projection"

const emptyAssistantMessages: SessionMessageAssistant[] = []
type Projection = ReturnType<typeof createReactiveTimelineProjection>
type FramedTimelineRow = Exclude<TimelineRow.TimelineRow, TimelineRow.TurnGap>

export type SessionUserPresentation = {
  displayText?: string
  comments?: SessionUserComment[]
}

export function createSessionTimelineRowRenderer(input: {
  sessionID: Accessor<string>
  status: Accessor<SessionStatus>
  projection: Projection
  presentation: (message: SessionMessageUser) => SessionUserPresentation | undefined
  actions?: SessionUserActions
  reasoningMode: Accessor<ReasoningMode>
  shellToolDefaultOpen: Accessor<boolean>
  editToolDefaultOpen: Accessor<boolean>
  timelineDetail?: Accessor<TimelineDetail>
  disclosure: {
    value: (key: string) => boolean | undefined
    set: (key: string, open: boolean) => void
    patchGroupKeys?: Map<string, string>
  }
  centered?: Accessor<boolean>
  padding?: Accessor<string>
  anchor?: (messageID: string) => string | undefined
}) {
  const i18n = useI18n()
  const data = useData()
  // Cached timelines retain subgroup identities alongside their disclosure choices.
  const patchGroupKeys = input.disclosure.patchGroupKeys ?? new Map<string, string>()
  const patchPartKeys = new WeakMap<SessionMessageAssistant["content"][number], string>()
  const patchOwners = createMemo(() => {
    const owners = new Map<string, string>()
    const rows = input.projection.rows()
    // Track status changes before a group is first opened: a failed patch can
    // split an existing group without changing the projection's row identities.
    rows.forEach((row) => {
      if (row._tag !== "AssistantPart" || row.group.type !== "context") return
      row.group.refs.forEach((ref) => {
        const content = Timeline.resolveContent(input.projection.messageByID().get(ref.messageID), ref.partID)
        if (content?.type !== "tool" || content.name !== "patch" || content.state.status === "error") return
        const part = `${ref.messageID}:${ref.partID}`
        const key = patchGroupKeys.get(part)
        if (key && !owners.has(key)) owners.set(key, part)
      })
    })
    return owners
  })
  const workingTurn = (messageID: string) =>
    input.status().type !== "idle" && input.projection.activeMessageID() === messageID
  const duration = (messageID: string) => {
    const user = input.projection.messageByID().get(messageID)
    if (user?.type !== "user") return null
    const completed = (input.projection.assistantMessagesByParent().get(messageID) ?? emptyAssistantMessages).reduce<
      number | undefined
    >((latest, message) => {
      if (message.time.completed === undefined) return latest
      return latest === undefined ? message.time.completed : Math.max(latest, message.time.completed)
    }, undefined)
    if (completed === undefined || completed < user.time.created) return undefined
    return completed - user.time.created
  }
  const copyContentID = (messageID: string) => {
    if (workingTurn(messageID)) return null
    const message = input.projection
      .assistantMessagesByParent()
      .get(messageID)
      ?.findLast((message) => message.content.some((content) => content.type === "text" && !!content.text.trim()))
    return message
      ? Timeline.contentEntries(message).findLast(
          (entry) => entry.content.type === "text" && !!entry.content.text.trim(),
        )?.id
      : undefined
  }
  const padding = () => input.padding?.() ?? "px-4 md:px-5"
  const indexGroupContents = (refs: PartRef[]) => {
    const result = new Map<string, Map<string, SessionMessageAssistant["content"][number]>>()
    refs.forEach((ref) => {
      if (result.has(ref.messageID)) return
      const contents = new Map<string, SessionMessageAssistant["content"][number]>()
      const message = input.projection.messageByID().get(ref.messageID)
      if (message?.type === "assistant") {
        Timeline.contentEntries(message).forEach((entry) => {
          // Match resolveContent's first entry when content IDs repeat.
          if (!contents.has(entry.id)) contents.set(entry.id, entry.content)
        })
      }
      result.set(ref.messageID, contents)
    })
    return result
  }

  const renderAssistant = (row: Accessor<TimelineRow.AssistantPart>, onSizeChange?: () => void) => {
    if (row().group.type === "context") {
      const parts = createMemo(() => {
        const group = row().group
        if (group.type !== "context") return []
        const contents = indexGroupContents(group.refs)
        const lastAssistant = input.projection.assistantMessagesByParent().get(row().userMessageID)?.at(-1)
        return group.refs.flatMap<ContextGroupPart>((ref) => {
          const content = contents.get(ref.messageID)?.get(ref.partID)
          if (content?.type === "tool") {
            patchPartKeys.set(content, `${ref.messageID}:${ref.partID}`)
            return [content]
          }
          if (content?.type === "reasoning")
            return [
              {
                ...content,
                id: ref.partID,
                streaming:
                  workingTurn(row().userMessageID) &&
                  input.status().type === "busy" &&
                  lastAssistant?.id === ref.messageID &&
                  lastAssistant.time.completed === undefined &&
                  !lastAssistant.error &&
                  !lastAssistant.retry &&
                  lastAssistant.content.at(-1) === content &&
                  content.time?.completed === undefined,
              },
            ]
          const message = input.projection.messageByID().get(ref.messageID)
          if (ref.messageID !== ref.partID || !message) return []
          if (message.type === "shell")
            return [{ type: "shell", id: ref.partID, render: () => <Shell messageID={ref.messageID} grouped /> }]
          if (message.type !== "assistant" && message.type !== "user")
            return [{ type: "notice", id: ref.partID, render: () => <Notice messageID={ref.messageID} grouped /> }]
          return []
        })
      })
      const key = () => `context:${row().group.key}`
      return (
        <SessionContextToolGroup
          parts={parts()}
          patchGroupKey={(tools) => {
            const parts = tools.map((tool) => patchPartKeys.get(tool)!)
            // After a split, only the subgroup with the earliest surviving member keeps the old anchor.
            const key =
              parts
                .map((part) => patchGroupKeys.get(part))
                .find((key) => key !== undefined && parts.includes(patchOwners().get(key)!)) ?? parts[0]!
            parts.forEach((part) => patchGroupKeys.set(part, key))
            return key
          }}
          reasoningDefaultOpen={
            input.timelineDetail
              ? input.timelineDetail().thinking.details === "expanded"
              : input.reasoningMode() === "full"
          }
          reasoningOpen={(id) => input.disclosure.value(id)}
          onReasoningOpenChange={(id, open) => input.disclosure.set(id, open)}
          toolDefaultOpen={(tool) => (input.timelineDetail ? contentDefaultOpen(tool) : false)}
          toolOpen={(id) => input.disclosure.value(`${row().group.key}:tool:${id}`)}
          onToolOpenChange={(id, open) => input.disclosure.set(`${row().group.key}:tool:${id}`, open)}
          fileOpen={(path) =>
            input.disclosure.value(`patch:${path}`) ?? input.timelineDetail?.().edit.details === "expanded"
          }
          onFileOpenChange={(path, open) => input.disclosure.set(`patch:${path}`, open)}
          open={input.disclosure.value(key()) === true}
          busy={
            workingTurn(row().userMessageID) &&
            input.projection.lastAssistantGroupKey().get(row().userMessageID) === row().group.key
          }
          onOpenChange={(open) => input.disclosure.set(key(), open)}
          onSizeChange={onSizeChange}
        />
      )
    }

    if (row().group.type === "file") {
      const tools = createMemo(() => {
        const group = row().group
        if (group.type !== "file") return []
        const contents = indexGroupContents(group.refs)
        return group.refs.flatMap((ref) => {
          const content = contents.get(ref.messageID)?.get(ref.partID)
          return content?.type === "tool" ? [content] : []
        })
      })
      const firstPath = createMemo(() => {
        const tool = tools()[0]
        if (!tool || !("metadata" in tool.state)) return undefined
        const files = tool.state.metadata?.files
        if (!Array.isArray(files)) return undefined
        const file = files[0]
        return file && typeof file === "object" && "file" in file && typeof file.file === "string"
          ? file.file
          : undefined
      })
      return (
        <SessionFileToolGroup
          tools={tools()}
          fileOpen={(path) => {
            const open = input.disclosure.value(`${row().group.key}:file:${path}`)
            if (open !== undefined) return open
            if (input.timelineDetail) return input.timelineDetail().edit.details === "expanded"
            if (tools()[0]?.name !== "edit" || path !== firstPath()) return false
            return input.disclosure.value(row().group.key) ?? input.editToolDefaultOpen()
          }}
          onFileOpenChange={(path, open) => input.disclosure.set(`${row().group.key}:file:${path}`, open)}
          onSizeChange={onSizeChange}
        />
      )
    }

    const ref = createMemo(() => {
      const group = row().group
      return group.type === "part" ? group.ref : undefined
    })
    const message = createMemo(() => {
      const current = ref()
      const message = current ? input.projection.messageByID().get(current.messageID) : undefined
      return message?.type === "assistant" ? message : undefined
    })
    const content = createMemo(() => {
      const current = ref()
      return current ? Timeline.resolveContent(message(), current.partID) : undefined
    })
    const defaultOpen = createMemo(() => {
      const item = content()
      return item ? contentDefaultOpen(item) : undefined
    })
    const disclosureKey = () => (content()?.type === "reasoning" ? ref()!.partID : row().group.key)
    return (
      <Show when={message()}>
        {(message) => (
          <Show when={content()}>
            {(content) => (
              <SessionAssistantContent
                message={message()}
                content={content()}
                contentID={ref()!.partID}
                showAssistantCopyPartID={copyContentID(row().userMessageID)}
                turnDurationMs={duration(row().userMessageID)}
                defaultOpen={defaultOpen()}
                toolOpen={input.disclosure.value(disclosureKey()) ?? defaultOpen()}
                onToolOpenChange={(open) => input.disclosure.set(disclosureKey(), open)}
                onContentRendered={onSizeChange}
              />
            )}
          </Show>
        )}
      </Show>
    )
  }

  function contentDefaultOpen(item: SessionMessageAssistant["content"][number]) {
    if (input.timelineDetail) {
      const category = timelineCategory(item)
      if (
        category &&
        input.timelineDetail()[category].placement === "hidden" &&
        item.type === "tool" &&
        currentToolFailed(item)
      )
        return true
      if (category === "shell" || category === "edit" || category === "thinking")
        return input.timelineDetail()[category].details === "expanded"
    }
    if (item.type === "reasoning") return input.reasoningMode() === "full"
    return currentContentDefaultOpen(item, input.shellToolDefaultOpen(), input.editToolDefaultOpen())
  }

  const notice = (message: SessionMessageInfo) => {
    if (message.type === "agent-switched")
      return {
        label: i18n.t("ui.sessionTimeline.notice.agentChanged"),
        data: message.previous
          ? `${capitalizeAgent(message.previous)} → ${capitalizeAgent(message.agent)}`
          : capitalizeAgent(message.agent),
      }
    if (message.type === "model-switched") return undefined
    if (message.type === "skill") return { label: i18n.t("ui.tool.skill"), data: message.name }
    if (message.type === "system") {
      const prefix = "Instructions updated: "
      if (message.description?.startsWith(prefix)) {
        const keys = message.description
          .slice(prefix.length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
        return {
          label: i18n.t("ui.sessionTimeline.notice.instructionsUpdated"),
          items: keys,
        }
      }
      return { label: message.description ?? message.text }
    }
    if (message.type !== "synthetic") return undefined
    if (message.description === "Continuing after restart") return { label: message.description }
    const source = typeof message.metadata?.source === "string" ? message.metadata.source : undefined
    const state = typeof message.metadata?.state === "string" ? message.metadata.state : undefined
    if (source === "subagent" || source === "shell") {
      const agent = typeof message.metadata?.agent === "string" ? message.metadata.agent : undefined
      const actor = source === "shell" ? i18n.t("ui.tool.shell") : (agent ?? i18n.t("ui.tool.agent.default"))
      return {
        label: i18n.t(
          state === "error"
            ? "ui.sessionTimeline.notice.failed"
            : state === "cancelled"
              ? "ui.sessionTimeline.notice.cancelled"
              : "ui.sessionTimeline.notice.finished",
          { actor },
        ),
        data: message.description,
      }
    }
    return { label: message.description ?? message.text }
  }

  const Frame = (props: { row: FramedTimelineRow; children: JSX.Element }) => (
    <div
      id={props.row._tag === "UserMessage" ? input.anchor?.(props.row.userMessageID) : undefined}
      data-message-id={props.row.userMessageID}
      data-timeline-row={props.row._tag}
      data-timeline-spacing={props.row._tag === "AssistantPart" ? props.row.spacing : undefined}
      classList={{
        "min-w-0 w-full max-w-full": true,
        "md:max-w-[1000px] md:mx-auto": input.centered?.(),
        "pt-2": props.row._tag === "AssistantPart" && props.row.spacing === "tool",
        "pt-4": props.row._tag === "AssistantPart" && props.row.spacing === "content",
      }}
    >
      <div data-component="session-turn" class="min-w-0 w-full relative" style={{ height: "auto" }}>
        {props.children}
      </div>
    </div>
  )

  function Notice(props: { messageID: string; grouped?: boolean }) {
    const inset = () => (props.grouped ? "" : padding())
    const message = createMemo(() => input.projection.messageByID().get(props.messageID))
    const compaction = createMemo(() => {
      const value = message()
      return value?.type === "compaction" ? value : undefined
    })
    const compactionError = createMemo(() => {
      const value = compaction()
      if (value?.status !== "failed") return ""
      return unwrapErrorMessage(value.error.message)
    })
    const moved = createMemo(() => {
      const value = message()
      return value?.type === "location-switched" ? value : undefined
    })
    const model = createMemo(() => {
      const value = message()
      if (value?.type !== "model-switched") return undefined
      const match = data.store.provider?.all?.get(value.model.providerID)
      return {
        providerID: value.model.providerID,
        variant: value.model.variant,
        label: i18n.t("ui.sessionTimeline.notice.modelSwitched", {
          model: match?.models?.[value.model.id]?.name ?? value.model.id,
        }),
      }
    })
    const content = createMemo(() => {
      const value = message()
      return value ? notice(value) : undefined
    })
    const childID = createMemo(() => {
      const value = message()
      if (value?.type !== "synthetic" || value.metadata?.source !== "subagent") return
      const id = value.metadata.childID
      if (typeof id === "string" && id) return id
    })
    const href = createMemo(() => {
      const id = childID()
      if (id) return data.sessionHref?.(id)
    })
    const clickable = createMemo(() => !!(childID() && (data.navigateToSession || href())))
    const open = () => {
      const id = childID()
      if (id) data.navigateToSession?.(id)
    }
    const navigate = (event: MouseEvent) => {
      if (!childID() || !data.navigateToSession) return
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
    return (
      <>
        <Show when={compaction()}>
          {(message) => (
            <div data-slot="session-turn-message-container" class={`w-full ${inset()}`}>
              <div data-slot="session-turn-compaction">
                <SessionCompactionMessage message={message()} error={compactionError()} />
              </div>
            </div>
          )}
        </Show>
        <Show
          when={moved()}
          fallback={
            <Show
              when={model()}
              fallback={
                <Show when={content()}>
                  {(content) => (
                    <Show
                      when={content().items?.length}
                      fallback={
                        <Dynamic
                          component={href() ? "a" : "div"}
                          data-slot="session-timeline-notice"
                          class={`block w-full truncate ${props.grouped ? "py-1" : "pt-3 pb-1"} text-13-regular leading-text-compact text-text-weak ${inset()}`}
                          classList={{ "cursor-pointer": clickable() }}
                          href={href()}
                          role={clickable() && !href() ? "link" : undefined}
                          tabIndex={clickable() && !href() ? 0 : undefined}
                          onClick={navigate}
                          onKeyDown={navigateKey}
                        >
                          <bdi
                            dir="auto"
                            class="font-[530]"
                            classList={{ "text-v2-text-text-faint": message()?.type === "agent-switched" }}
                          >
                            {content().label}
                          </bdi>
                          <Show when={content().data}>
                            {(data) => (
                              <span classList={{ "ms-2": message()?.type === "agent-switched" }}>
                                <Show when={message()?.type !== "agent-switched"}>{" · "}</Show>
                                <bdi dir="auto">{data()}</bdi>
                              </span>
                            )}
                          </Show>
                        </Dynamic>
                      }
                    >
                      <div data-slot="session-timeline-notice" class={`w-full py-1 ${inset()}`}>
                        <div class="flex min-h-5 min-w-0 items-center gap-2 overflow-hidden">
                          <bdi
                            dir="auto"
                            class="shrink-0 text-[13px] font-[530] leading-text-compact tracking-[-0.04px] text-v2-text-text-faint"
                          >
                            {content().label}
                          </bdi>
                          <For each={content().items}>
                            {(item) => (
                              <bdi
                                dir="auto"
                                class="min-w-0 truncate text-[13px] font-[440] leading-text-compact tracking-[-0.04px] text-v2-text-text-faint"
                              >
                                {item}
                              </bdi>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>
                  )}
                </Show>
              }
            >
              {(model) => (
                <div data-slot="session-timeline-notice" data-type="model-switched" class={`w-full py-2 ${inset()}`}>
                  <TimelineSeparator label={model().label} providerID={model().providerID} variant={model().variant} />
                </div>
              )}
            </Show>
          }
        >
          {(message) => (
            <div
              data-slot="session-timeline-notice"
              data-type="location-switched"
              class={`flex h-7 w-full min-w-0 items-center gap-2 py-1 text-[13px] leading-text-compact tracking-[-0.04px] text-v2-text-text-faint ${inset()}`}
            >
              <Tooltip
                appearance="compact"
                placement="top"
                value={i18n.t("ui.sessionTimeline.notice.movedTooltip")}
                class="shrink-0"
                triggerTabIndex={0}
              >
                <bdi data-slot="session-timeline-notice-label" dir="auto" class="font-[530]">
                  {i18n.t("ui.sessionTimeline.notice.movedTo")}
                </bdi>
              </Tooltip>{" "}
              <bdi data-slot="session-timeline-notice-value" dir="ltr" class="min-w-0 truncate font-[440]">
                {message().location.directory}
              </bdi>
            </div>
          )}
        </Show>
      </>
    )
  }

  function Shell(props: { messageID: string; grouped?: boolean }) {
    const message = createMemo(() => {
      const value = input.projection.messageByID().get(props.messageID)
      return value?.type === "shell" ? value : undefined
    })
    const defaultOpen = createMemo(() => {
      if (!input.timelineDetail) return input.shellToolDefaultOpen()
      const value = message()
      return (
        input.timelineDetail().shell.details === "expanded" ||
        (input.timelineDetail().shell.placement === "hidden" &&
          (value?.status === "timeout" || (value?.status === "exited" && value.exit !== undefined && value.exit !== 0)))
      )
    })
    return (
      <Show when={message()}>
        {(message) => (
          <div data-slot="session-turn-message-container" class={`w-full ${props.grouped ? "" : padding()}`}>
            <SessionShellMessage
              message={message()}
              defaultOpen={defaultOpen()}
              open={input.disclosure.value(message().id) ?? (input.timelineDetail ? defaultOpen() : undefined)}
              onOpenChange={(open) => input.disclosure.set(message().id, open)}
            />
          </div>
        )}
      </Show>
    )
  }

  const render = (row: Accessor<TimelineRow.TimelineRow>, onSizeChange?: () => void) => {
    if (row()._tag === "TurnGap") return <div data-timeline-row="TurnGap" aria-hidden="true" class="h-6" />
    if (row()._tag === "UserMessage") {
      const current = () => {
        const value = row()
        if (value._tag !== "UserMessage") throw new Error("Expected a user-message timeline row")
        return value
      }
      const message = createMemo(() => {
        const value = input.projection.messageByID().get(current().userMessageID)
        return value?.type === "user" ? value : undefined
      })
      const context = createMemo(() => input.projection.userContextByID().get(current().userMessageID))
      return (
        <Frame row={current()}>
          <Show when={message()}>
            {(message) => {
              const presentation = () => input.presentation(message())
              return (
                <div data-slot="session-turn-message-container" class={`w-full ${padding()}`}>
                  <div data-slot="session-turn-message-content" aria-live="off">
                    <SessionUserMessage
                      sessionID={input.sessionID()}
                      message={message()}
                      displayText={presentation()?.displayText}
                      comments={presentation()?.comments}
                      historicalAgent={context()?.agent ?? ""}
                      historicalModel={context()?.model ?? { id: "", providerID: "" }}
                      actions={input.actions}
                    />
                  </div>
                </div>
              )
            }}
          </Show>
        </Frame>
      )
    }
    if (row()._tag === "Shell") {
      const current = () => {
        const value = row()
        if (value._tag !== "Shell") throw new Error("Expected a shell timeline row")
        return value
      }
      return (
        <Frame row={current()}>
          <Shell messageID={current().messageID} />
        </Frame>
      )
    }
    if (row()._tag === "Notice") {
      const current = () => {
        const value = row()
        if (value._tag !== "Notice") throw new Error("Expected a notice timeline row")
        return value
      }
      return (
        <Frame row={current()}>
          <Notice messageID={current().messageID} />
        </Frame>
      )
    }
    if (row()._tag === "TurnDivider") {
      const current = () => {
        const value = row()
        if (value._tag !== "TurnDivider") throw new Error("Expected a turn-divider timeline row")
        return value
      }
      return (
        <Frame row={current()}>
          <div data-slot="session-turn-message-container" class={`w-full ${padding()}`}>
            <div data-slot="session-turn-compaction">
              <div class="py-2">
                <TimelineSeparator label={i18n.t("ui.message.interrupted")} />
              </div>
            </div>
          </div>
        </Frame>
      )
    }
    if (row()._tag === "AssistantPart") {
      const current = () => {
        const value = row()
        if (value._tag !== "AssistantPart") throw new Error("Expected an assistant-part timeline row")
        return value
      }
      // Construct once per row key, not inside JSX that reruns when group refs change.
      const content = renderAssistant(current, onSizeChange)
      return (
        <Frame row={current()}>
          <div data-slot="session-turn-message-container" class={`w-full ${padding()}`}>
            <div data-slot="session-turn-assistant-content" aria-hidden={workingTurn(current().userMessageID)}>
              {content}
            </div>
          </div>
        </Frame>
      )
    }
    if (row()._tag === "Thinking") {
      const current = () => {
        const value = row()
        if (value._tag !== "Thinking") throw new Error("Expected a thinking timeline row")
        return value
      }
      const content = createMemo(() => {
        const ref = current().ref
        const content = Timeline.resolveContent(input.projection.messageByID().get(ref.messageID), ref.partID)
        return content?.type === "reasoning" ? content : undefined
      })
      return (
        <Frame row={current()}>
          <div data-slot="session-turn-message-container" class={`w-full ${padding()}`}>
            <div data-slot="session-turn-thinking-row">
              <Show when={content()}>
                {(content) => (
                  <AssistantReasoningContent
                    id={current().ref.partID}
                    content={content()}
                    streaming
                    defaultOpen={
                      input.timelineDetail
                        ? input.timelineDetail().thinking.details === "expanded"
                        : input.reasoningMode() === "full"
                    }
                    open={
                      input.disclosure.value(current().ref.partID) ??
                      (input.timelineDetail ? input.timelineDetail().thinking.details === "expanded" : undefined)
                    }
                    onOpenChange={(open) => input.disclosure.set(current().ref.partID, open)}
                    onContentRendered={onSizeChange}
                  />
                )}
              </Show>
            </div>
          </div>
        </Frame>
      )
    }
    if (row()._tag === "Retry") {
      const current = () => {
        const value = row()
        if (value._tag !== "Retry") throw new Error("Expected a retry timeline row")
        return value
      }
      const status = createMemo(() => {
        const retry = (
          input.projection.assistantMessagesByParent().get(current().userMessageID) ?? emptyAssistantMessages
        ).at(-1)?.retry
        if (!retry) return input.status()
        return { type: "retry" as const, attempt: retry.attempt, message: retry.error.message, next: retry.at }
      })
      return (
        <Frame row={current()}>
          <div data-slot="session-turn-message-container" class={`w-full ${padding()}`}>
            <SessionRetry status={status()} show={input.projection.activeMessageID() === current().userMessageID} />
          </div>
        </Frame>
      )
    }
    const current = () => {
      const value = row()
      if (value._tag !== "Error") throw new Error("Expected an error timeline row")
      return value
    }
    return (
      <Frame row={current()}>
        <div data-slot="session-turn-message-container" class={`w-full ${padding()}`}>
          <SessionError message={current().text} />
        </div>
      </Frame>
    )
  }

  function Row(props: { row: Accessor<TimelineRow.TimelineRow>; onSizeChange?: () => void }) {
    return (
      <Show when={TimelineRow.key(props.row())} keyed>
        {(_key) => render(props.row, props.onSizeChange)}
      </Show>
    )
  }

  return { Row }
}

function capitalizeAgent(agent: string) {
  return agent.slice(0, 1).toUpperCase() + agent.slice(1)
}
