export * as SessionTransfer from "./transfer.js"

import { SessionTransfer } from "@opencode/schema/session-transfer"
import { Tool } from "@opencode/schema/tool"
import { Skill } from "@opencode/schema/skill"
import { eq } from "drizzle-orm"
import { Clock, Context, DateTime, Effect, Layer, Schema } from "effect"
import { map } from "effect/Array"
import path from "path"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { App } from "../app.js"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Location } from "../location.js"
import { Project } from "../project.js"
import { upsertProject } from "../project/sql.js"
import { AbsolutePath, RelativePath } from "../schema.js"
import { Session } from "../session.js"
import { Slug } from "../util/slug.js"
import { SessionEvent } from "./event.js"
import { SessionMessage } from "./message.js"
import { SessionProjector } from "./projector.js"
import { SessionMessageTable, SessionTable } from "./sql.js"

export const Data = SessionTransfer.Data
export type Data = SessionTransfer.Data

export class ImportConflictError extends Schema.TaggedError<ImportConflictError>()(
  "SessionTransfer.ImportConflictError",
  { sessionID: Session.ID },
) {}

export interface Interface {
  readonly export: (input: {
    sessionID: Session.ID
    sanitize?: boolean
  }) => Effect.Effect<Data, Session.NotFoundError | Session.MessageDecodeError>
  readonly import: (input: {
    data: Data
    location: Location.Ref
  }) => Effect.Effect<Session.Info, ImportConflictError | Session.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTransfer") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const app = yield* App.Metadata
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    const projects = yield* Project.Service
    const sessions = yield* Session.Service
    const encodeMessage = Schema.encodeSync(SessionMessage.Info)

    return Service.of({
      export: Effect.fn("SessionTransfer.export")(function* (input) {
        const data = {
          info: yield* sessions.get(input.sessionID),
          messages: (yield* sessions.messages({ sessionID: input.sessionID, order: "asc" })).filter(isSettled),
        }
        return input.sanitize ? sanitize(data) : data
      }),
      import: Effect.fn("SessionTransfer.import")(function* (input) {
        const recorded = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.data.info.id))
          .get()
          .pipe(Effect.orDie)
        const sessionID = recorded ? Session.ID.create() : input.data.info.id
        if (input.data.info.parentID) yield* sessions.get(input.data.info.parentID)
        const project = yield* projects.resolve(input.location.directory)
        yield* upsertProject(db, project).pipe(Effect.orDie)
        const importedAt = yield* Clock.currentTimeMillis
        const messages = input.data.messages.filter(isSettled).map((message, index) => {
          const encoded = encodeMessage(message)
          const { id: _, type, ...data } = encoded
          return {
            id: recorded ? SessionMessage.ID.create() : message.id,
            session_id: sessionID,
            type,
            seq: index + 1,
            time_created: DateTime.toEpochMillis(message.time.created),
            data,
          }
        })
        yield* bus
          .publish(
            SessionEvent.Created,
            {
              sessionID,
              parentID: input.data.info.parentID,
              slug: Slug.create(),
              version: app.version,
              projectID: project.id,
              location: input.location,
              subpath: RelativePath.make(
                path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
              ),
              title: input.data.info.title,
              agent: input.data.info.agent,
              model: input.data.info.model,
              metadata: input.data.info.metadata,
              permissions: input.data.info.permissions,
            },
            {
              location: input.location,
              commit: (seq) =>
                Effect.gen(function* () {
                  if (messages.length > 0) {
                    yield* db.insert(SessionMessageTable).values(messages).run().pipe(Effect.orDie)
                    yield* Bus.reserveSequence(db, sessionID, seq + messages.length)
                  }
                  yield* db
                    .update(SessionTable)
                    .set({
                      cost: input.data.info.cost,
                      tokens_input: input.data.info.tokens.input,
                      tokens_output: input.data.info.tokens.output,
                      tokens_reasoning: input.data.info.tokens.reasoning,
                      tokens_cache_read: input.data.info.tokens.cache.read,
                      tokens_cache_write: input.data.info.tokens.cache.write,
                      time_created: DateTime.toEpochMillis(input.data.info.time.created),
                      time_updated: importedAt,
                      time_idle: input.data.info.time.idle ? DateTime.toEpochMillis(input.data.info.time.idle) : null,
                      time_viewed:
                        input.data.info.time.idle && input.data.info.time.viewed
                          ? Math.min(
                              DateTime.toEpochMillis(input.data.info.time.idle),
                              DateTime.toEpochMillis(input.data.info.time.viewed),
                            )
                          : null,
                      idle_outcome: input.data.info.time.idle ? (input.data.info.outcome ?? null) : null,
                      time_archived: input.data.info.time.archived
                        ? DateTime.toEpochMillis(input.data.info.time.archived)
                        : null,
                    })
                    .where(eq(SessionTable.id, sessionID))
                    .run()
                    .pipe(Effect.orDie)
                }),
            },
          )
          .pipe(
            Effect.catchDefect((defect) =>
              defect instanceof SessionProjector.SessionAlreadyProjected
                ? Effect.fail(new ImportConflictError({ sessionID }))
                : Effect.die(defect),
            ),
          )
        return yield* sessions.get(sessionID).pipe(Effect.orDie)
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [App.node, Bus.node, Database.node, Project.node, Session.node],
})

function isSettled(message: SessionMessage.Info) {
  if (message.type === "assistant") return message.time.completed !== undefined
  if (message.type === "shell" || message.type === "compaction") return message.status !== "running"
  return true
}

function redact(kind: string, id: string, value: string) {
  return value.trim() ? `[redacted:${kind}:${id}]` : value
}

function metadata(kind: string, id: string, value: Readonly<Record<string, unknown>> | undefined) {
  if (!value) return value
  return Object.keys(value).length > 0 ? { redacted: `${kind}:${id}` } : value
}

function sanitize(data: Data): Data {
  return {
    info: {
      ...data.info,
      title: data.info.title === undefined ? undefined : redact("session-title", data.info.id, data.info.title),
      metadata:
        data.info.metadata && Object.keys(data.info.metadata).length > 0
          ? { redacted: `session-metadata:${data.info.id}` }
          : data.info.metadata,
      location: {
        ...data.info.location,
        directory: AbsolutePath.make(`/${redact("session-directory", data.info.id, data.info.location.directory)}`),
      },
      revert: data.info.revert
        ? {
            ...data.info.revert,
            files: data.info.revert.files?.map((file, index) => ({
              ...file,
              file: redact("revert-file", String(index), file.file),
              patch: redact("revert-patch", String(index), file.patch),
            })),
          }
        : undefined,
    },
    messages: data.messages.map(sanitizeMessage),
  }
}

function sanitizeMessage(message: SessionMessage.Info): SessionMessage.Info {
  const meta = metadata("message-metadata", message.id, message.metadata)
  if (message.type === "user")
    return {
      ...message,
      metadata: meta,
      text: redact("text", message.id, message.text),
      files: message.files?.map((file, index) => ({
        ...file,
        data: "",
        source: { type: "inline" },
        name: file.name === undefined ? undefined : redact("file-name", String(index), file.name),
        description:
          file.description === undefined ? undefined : redact("file-description", String(index), file.description),
        mention: file.mention
          ? { ...file.mention, text: redact("file-mention", String(index), file.mention.text) }
          : undefined,
      })),
      agents: message.agents?.map((agent, index) => ({
        ...agent,
        name: redact("agent-name", String(index), agent.name),
        mention: agent.mention
          ? { ...agent.mention, text: redact("agent-mention", String(index), agent.mention.text) }
          : undefined,
      })),
      skills: message.skills?.map((skill, index) => ({
        ...skill,
        name: Skill.Name.make(redact("skill-name", String(index), skill.name)),
        text: skill.text === undefined ? undefined : redact("skill", String(index), skill.text),
        mention: skill.mention
          ? { ...skill.mention, text: redact("skill-mention", String(index), skill.mention.text) }
          : undefined,
      })),
    }
  if (message.type === "synthetic")
    return {
      ...message,
      metadata: meta,
      text: redact("synthetic", message.id, message.text),
      description:
        message.description === undefined
          ? undefined
          : redact("synthetic-description", message.id, message.description),
    }
  if (message.type === "system") return { ...message, metadata: meta, text: redact("system", message.id, message.text) }
  if (message.type === "skill") return { ...message, metadata: meta, text: redact("skill", message.id, message.text) }
  if (message.type === "shell")
    return {
      ...message,
      metadata: meta,
      command: redact("shell-command", message.id, message.command),
      output: message.output
        ? { ...message.output, output: redact("shell-output", message.id, message.output.output) }
        : undefined,
    }
  if (message.type === "assistant")
    return {
      ...message,
      metadata: meta,
      content: message.content.map((content) => {
        if (content.type === "text")
          return {
            ...content,
            text: redact("text", message.id, content.text),
            state: content.state ? { redacted: `text-state:${message.id}` } : undefined,
          }
        if (content.type === "reasoning")
          return {
            ...content,
            text: redact("reasoning", message.id, content.text),
            state: content.state ? { redacted: `reasoning-state:${message.id}` } : undefined,
          }
        return {
          ...content,
          providerState: content.providerState ? { redacted: `tool-provider-state:${message.id}` } : undefined,
          providerResultState: content.providerResultState
            ? { redacted: `tool-provider-result-state:${message.id}` }
            : undefined,
          state: sanitizeToolState(message.id, content.state),
        }
      }),
    }
  if (message.type === "compaction") {
    if (message.status === "failed")
      return {
        ...message,
        metadata: meta,
      }
    return {
      ...message,
      metadata: meta,
      summary: redact("compaction-summary", message.id, message.summary),
      recent: redact("compaction-recent", message.id, message.recent),
      ...(message.status === "completed"
        ? { providerState: metadata("compaction-provider-state", message.id, message.providerState) }
        : {}),
    }
  }
  return { ...message, metadata: meta }
}

function sanitizeToolState(id: string, state: SessionMessage.ToolState): SessionMessage.ToolState {
  if (state.status === "streaming") return { ...state, input: redact("tool-input", id, state.input) }
  if (state.status === "running")
    return { ...state, input: { redacted: `tool-input:${id}` }, metadata: { redacted: `tool-metadata:${id}` } }
  const meta = state.metadata === undefined ? undefined : { redacted: `tool-metadata:${id}` }
  if (state.status === "completed")
    return {
      ...state,
      input: { redacted: `tool-input:${id}` },
      content: map(state.content, (item) => sanitizeToolContent(id, item)),
      metadata: meta,
    }
  return {
    ...state,
    input: { redacted: `tool-input:${id}` },
    content: state.content ? map(state.content, (item) => sanitizeToolContent(id, item)) : undefined,
    metadata: meta,
  }
}

function sanitizeToolContent(id: string, content: Tool.Content): Tool.Content {
  if (content.type === "text") return { ...content, text: redact("tool-output", id, content.text) }
  return {
    ...content,
    uri: redact("tool-file-uri", id, content.uri),
    name: content.name === undefined ? undefined : redact("tool-file-name", id, content.name),
  }
}
