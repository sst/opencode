import { castDraft, produce, type WritableDraft } from "immer"
import { DateTime, Effect, Match, pipe, Schema } from "effect"
import { SessionEvent } from "./event.js"
import { SessionMessage } from "./message.js"

export interface Adapter {
  readonly getAgent: () => Effect.Effect<SessionMessage.AgentSelected["agent"] | undefined>
  readonly getModel: () => Effect.Effect<SessionMessage.ModelSelected["model"] | undefined>
  readonly getLocation: () => Effect.Effect<SessionMessage.LocationSwitched["previous"]>
  readonly getCurrentAssistant: () => Effect.Effect<SessionMessage.Assistant | undefined>
  readonly getAssistant: (messageID: SessionMessage.ID) => Effect.Effect<SessionMessage.Assistant | undefined>
  readonly getShell: (shellID: SessionMessage.Shell["shellID"]) => Effect.Effect<SessionMessage.Shell | undefined>
  readonly getCompaction: () => Effect.Effect<SessionMessage.Compaction | undefined>
  readonly updateAssistant: (assistant: SessionMessage.Assistant) => Effect.Effect<void>
  readonly updateShell: (shell: SessionMessage.Shell) => Effect.Effect<void>
  readonly updateCompaction: (compaction: SessionMessage.Compaction) => Effect.Effect<void>
  readonly appendMessage: (message: SessionMessage.Info) => Effect.Effect<void>
}

type DraftAssistant = WritableDraft<SessionMessage.Assistant>

const projectTerminalSnapshot = (draft: DraftAssistant, event: SessionEvent.Step.Ended | SessionEvent.Step.Failed) => {
  if (event.data.snapshot || event.data.files)
    draft.snapshot = {
      ...draft.snapshot,
      end: event.data.snapshot,
      files: event.data.files ? Array.from(event.data.files) : undefined,
    }
}

export function update(adapter: Adapter, event: SessionEvent.DurableEvent) {
  type DraftTool = WritableDraft<SessionMessage.AssistantTool>
  type DraftText = WritableDraft<SessionMessage.AssistantText>
  type DraftReasoning = WritableDraft<SessionMessage.AssistantReasoning>
  const created = DateTime.makeUnsafe(event.created)

  const latestTool = (assistant: DraftAssistant, id: string) =>
    assistant.content.findLast((item): item is DraftTool => item.type === "tool" && item.id === id)

  const latestText = (assistant: DraftAssistant) =>
    assistant.content.findLast((item): item is DraftText => item.type === "text")

  const latestReasoning = (assistant: DraftAssistant) =>
    assistant.content.findLast((item): item is DraftReasoning => item.type === "reasoning" && !item.time?.completed)

  const updateOwnedAssistant = (messageID: SessionMessage.ID, recipe: (draft: DraftAssistant) => void) =>
    Effect.gen(function* () {
      const assistant = yield* adapter.getAssistant(messageID)
      if (!assistant) return
      yield* adapter.updateAssistant(produce(assistant, recipe))
    })

  const clearCurrentRetry = Effect.gen(function* () {
    const assistant = yield* adapter.getCurrentAssistant()
    if (!assistant?.retry) return
    yield* adapter.updateAssistant(
      produce(assistant, (draft) => {
        draft.retry = undefined
      }),
    )
  })

  const idle = (outcome: SessionMessage.Idle["outcome"]) =>
    clearCurrentRetry.pipe(
      Effect.andThen(
        adapter.appendMessage(
          SessionMessage.Idle.make({
            id: SessionMessage.ID.fromEvent(event.id),
            type: "idle",
            outcome,
            metadata: event.metadata,
            time: { created },
          }),
        ),
      ),
    )

  const project = pipe(
    Match.type<SessionEvent.DurableEvent>(),
    Match.discriminatorsExhaustive("type")({
      "session.created": () => Effect.void,
      "session.viewed": () => Effect.void,
      "session.message.content.updated": (event) =>
        updateOwnedAssistant(event.data.messageID, (draft) => {
          draft.content = castDraft(
            Schema.decodeUnknownSync(Schema.Array(SessionMessage.AssistantContent))(event.data.content),
          )
        }),
      "session.usage.recorded": () => Effect.void,
      "session.agent.selected": (event) =>
        Effect.gen(function* () {
          const previous = event.data.previous ?? (yield* adapter.getAgent())
          yield* adapter.appendMessage(
            SessionMessage.AgentSelected.make({
              id: SessionMessage.ID.fromEvent(event.id),
              type: "agent-switched",
              metadata: event.metadata,
              agent: event.data.agent,
              previous,
              time: { created },
            }),
          )
        }),
      "session.model.selected": (event) =>
        Effect.gen(function* () {
          const previous = event.data.previous ?? (yield* adapter.getModel())
          yield* adapter.appendMessage(
            SessionMessage.ModelSelected.make({
              id: SessionMessage.ID.fromEvent(event.id),
              type: "model-switched",
              metadata: event.metadata,
              model: event.data.model,
              previous,
              time: { created },
            }),
          )
        }),
      "session.moved": (event) =>
        Effect.gen(function* () {
          yield* adapter.appendMessage(
            SessionMessage.LocationSwitched.make({
              id: SessionMessage.ID.fromEvent(event.id),
              type: "location-switched",
              metadata: event.metadata,
              location: event.data.location,
              projectID: event.data.projectID,
              subpath: event.data.subpath,
              previous: yield* adapter.getLocation(),
              time: { created },
            }),
          )
        }),
      "session.renamed": () => Effect.void,
      "session.permissions.updated": () => Effect.void,
      "session.deleted": () => Effect.void,
      "session.forked": () => Effect.void,
      "session.inbox.delivered": () => Effect.void,
      "session.inbox.enqueued": () => Effect.void,
      "session.inbox.cancelled": () => Effect.void,
      "session.inbox.delivery.changed": () => Effect.void,
      "session.execution.started": () => Effect.void,
      "session.execution.succeeded": () => idle("succeeded"),
      "session.execution.failed": () => idle("failed"),
      // Shutdown keeps the execution claim and the resumed drain continues the turn.
      "session.execution.interrupted": (event) =>
        event.data.reason === "shutdown" ? clearCurrentRetry : idle("interrupted"),
      "session.instructions.updated": (event) => {
        if (event.data.text === undefined) return Effect.void
        return adapter.appendMessage(
          SessionMessage.System.make({
            id: SessionMessage.ID.fromEvent(event.id),
            type: "system",
            text: event.data.text,
            description: `Instructions updated: ${Object.keys(event.data.delta).join(", ")}`,
            metadata: event.metadata,
            time: { created },
          }),
        )
      },
      "session.synthetic": (event) => {
        return adapter.appendMessage(
          SessionMessage.Synthetic.make({
            text: event.data.text,
            description: event.data.description,
            metadata: event.data.metadata,
            id: SessionMessage.ID.fromEvent(event.id),
            type: "synthetic",
            time: { created },
          }),
        )
      },
      "session.skill.activated": (event) => {
        return adapter.appendMessage(
          SessionMessage.Skill.make({
            id: SessionMessage.ID.fromEvent(event.id),
            type: "skill",
            skill: event.data.id,
            name: event.data.name,
            text: event.data.text,
            metadata: event.metadata,
            time: { created },
          }),
        )
      },
      "session.shell.started": (event) => {
        return adapter.appendMessage(
          SessionMessage.Shell.make({
            id: SessionMessage.ID.fromEvent(event.id),
            type: "shell",
            metadata:
              event.data.shell.metadata.background === true ? { ...event.metadata, background: true } : event.metadata,
            shellID: event.data.shell.id,
            command: event.data.shell.command,
            status: event.data.shell.status,
            time: { created },
          }),
        )
      },
      "session.shell.ended": (event) =>
        Effect.gen(function* () {
          const currentShell = yield* adapter.getShell(event.data.shell.id)
          if (currentShell) {
            yield* adapter.updateShell(
              produce(currentShell, (draft) => {
                draft.status = event.data.shell.status
                draft.exit = event.data.shell.exit
                draft.output = event.data.output
                draft.time.completed = created
              }),
            )
          }
        }),
      "session.step.started": (event) =>
        Effect.gen(function* () {
          const existing = yield* adapter.getAssistant(event.data.assistantMessageID)
          if (existing) {
            yield* adapter.updateAssistant(
              produce(existing, (draft) => {
                draft.agent = event.data.agent
                draft.model = castDraft(event.data.model)
                draft.retry = undefined
                draft.error = undefined
                draft.finish = undefined
                draft.rawFinish = undefined
                draft.providerState = undefined
                draft.time.streamed = undefined
                draft.time.requestDurationMs = undefined
                draft.time.completed = undefined
                if (event.data.snapshot) draft.snapshot = { ...draft.snapshot, start: event.data.snapshot }
              }),
            )
            return
          }
          const currentAssistant = yield* adapter.getCurrentAssistant()
          if (currentAssistant) {
            yield* adapter.updateAssistant(
              produce(currentAssistant, (draft) => {
                draft.retry = undefined
                draft.time.completed = created
              }),
            )
          }
          yield* adapter.appendMessage(
            SessionMessage.Assistant.make({
              id: event.data.assistantMessageID,
              type: "assistant",
              agent: event.data.agent,
              model: event.data.model,
              metadata: event.metadata,
              time: { created },
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
            }),
          )
        }),
      "session.step.streamed": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.time.streamed = created
        })
      },
      "session.step.ended": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.time.completed = created
          draft.finish = event.data.finish
          draft.rawFinish = event.data.rawFinish
          draft.providerState = castDraft(event.data.providerState)
          draft.cost = event.data.cost
          draft.tokens = event.data.tokens
          draft.time.requestDurationMs = event.data.requestDurationMs
          projectTerminalSnapshot(draft, event)
        })
      },
      "session.step.failed": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.time.completed = created
          draft.finish = event.data.finish ?? "error"
          draft.rawFinish = event.data.rawFinish
          draft.providerState = castDraft(event.data.providerState)
          draft.error = castDraft(event.data.error)
          draft.retry = undefined
          if (event.data.cost !== undefined && event.data.tokens !== undefined) {
            draft.cost = event.data.cost
            draft.tokens = castDraft(event.data.tokens)
          }
          projectTerminalSnapshot(draft, event)
        })
      },
      "session.text.started": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.content.push(castDraft(SessionMessage.AssistantText.make({ type: "text", text: "" })))
        })
      },
      "session.text.ended": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestText(draft)
          if (match) {
            match.text = event.data.text
            match.state = castDraft(event.data.state)
          }
        })
      },
      "session.tool.input.started": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.content.push(
            castDraft(
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: event.data.id,
                name: event.data.name,
                time: { created },
                state: SessionMessage.ToolStateStreaming.make({ status: "streaming", input: "" }),
              }),
            ),
          )
        })
      },
      "session.tool.input.ended": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.id)
          if (match && match.state.status === "streaming") match.state.input = event.data.text
        })
      },
      "session.tool.called": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.id)
          if (match) {
            match.executed = event.data.executed
            match.providerState = event.data.state
            match.time.ran = created
            match.state = castDraft(
              SessionMessage.ToolStateRunning.make({
                status: "running",
                input: event.data.input,
                metadata: {},
              }),
            )
          }
        })
      },
      // Terminal tool events are self-contained; projection is a direct copy and
      // never reaches into ephemeral progress history.
      "session.tool.success": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.id)
          if (match && match.state.status === "running") {
            match.executed = event.data.executed || match.executed === true
            match.providerResultState = event.data.resultState
            match.time.completed = created
            match.state = castDraft(
              SessionMessage.ToolStateCompleted.make({
                status: "completed",
                input: match.state.input,
                content: event.data.content,
                ...(event.data.metadata === undefined ? {} : { metadata: event.data.metadata }),
              }),
            )
          }
        })
      },
      "session.tool.failed": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestTool(draft, event.data.id)
          if (match && (match.state.status === "streaming" || match.state.status === "running")) {
            match.executed = event.data.executed || match.executed === true
            match.providerResultState = event.data.resultState
            match.time.completed = created
            match.state = castDraft(
              SessionMessage.ToolStateError.make({
                status: "error",
                error: event.data.error,
                input: typeof match.state.input === "string" ? {} : match.state.input,
                ...(event.data.content === undefined ? {} : { content: event.data.content }),
                ...(event.data.metadata === undefined ? {} : { metadata: event.data.metadata }),
              }),
            )
          }
        })
      },
      "session.reasoning.started": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.content.push(
            castDraft(
              SessionMessage.AssistantReasoning.make({
                type: "reasoning",
                text: "",
                state: event.data.state,
                time: { created },
              }),
            ),
          )
        })
      },
      "session.reasoning.ended": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          const match = latestReasoning(draft)
          if (match) {
            match.text = event.data.text
            match.time = { created: match.time?.created ?? created, completed: created }
            if (event.data.state !== undefined) match.state = event.data.state
          }
        })
      },
      "session.retry.scheduled": (event) => {
        return updateOwnedAssistant(event.data.assistantMessageID, (draft) => {
          draft.retry = {
            attempt: event.data.attempt,
            at: DateTime.makeUnsafe(event.data.at),
            error: castDraft(event.data.error),
          }
        })
      },
      "session.compaction.started": (event) =>
        adapter.appendMessage(
          SessionMessage.CompactionRunning.make({
            id: event.data.inputID ?? SessionMessage.ID.fromEvent(event.id),
            type: "compaction",
            status: "running",
            metadata: event.metadata,
            reason: event.data.reason,
            summary: "",
            recent: event.data.recent ?? "",
            time: { created },
          }),
        ),
      "session.compaction.ended": (event) =>
        Effect.gen(function* () {
          const current = yield* adapter.getCompaction()
          if (current?.status === "running") {
            yield* adapter.updateCompaction({
              ...current,
              status: "completed",
              metadata: event.metadata ? { ...current.metadata, ...event.metadata } : current.metadata,
              reason: event.data.reason,
              model: event.data.model,
              providerState: event.data.providerState,
              summary: event.data.text,
              providerContext: event.data.providerContext,
              recent: event.data.recent,
              cost: event.data.cost,
              tokens: event.data.tokens,
            })
            return
          }
          yield* adapter.appendMessage(
            SessionMessage.Compaction.make({
              id: SessionMessage.ID.fromEvent(event.id),
              type: "compaction",
              status: "completed",
              metadata: event.metadata,
              reason: event.data.reason,
              model: event.data.model,
              providerState: event.data.providerState,
              summary: event.data.text,
              providerContext: event.data.providerContext,
              recent: event.data.recent,
              cost: event.data.cost,
              tokens: event.data.tokens,
              time: { created },
            }),
          )
        }),
      "session.compaction.failed": (event) =>
        Effect.gen(function* () {
          const current = yield* adapter.getCompaction()
          const failed = SessionMessage.CompactionFailed.make({
            id: current?.id ?? event.data.inputID ?? SessionMessage.ID.fromEvent(event.id),
            type: "compaction",
            status: "failed",
            metadata: current?.metadata ?? event.metadata,
            reason: event.data.reason,
            error: event.data.error,
            cost: event.data.cost,
            tokens: event.data.tokens,
            time: current?.time ?? { created },
          })
          if (current?.status === "running") return yield* adapter.updateCompaction(failed)
          yield* adapter.appendMessage(failed)
        }),
      "session.revert.staged": () => Effect.void,
      "session.revert.cleared": () => Effect.void,
      "session.revert.committed": () => Effect.void,
    }),
  )
  return project(event)
}

export * as SessionMessageUpdater from "./message-updater.js"
