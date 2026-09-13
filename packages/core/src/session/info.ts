import { DateTime, Schema } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Model } from "@opencode/schema/model"
import { Project } from "@opencode/schema/project"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath, RelativePath } from "../schema.js"
import { Workspace } from "@opencode/schema/workspace"
import { SessionSchema } from "./schema.js"
import type { SessionTable } from "./sql.js"
import { PersistedRevert } from "@opencode/schema/session-revert"
import { Money } from "@opencode/schema/money"

const decodeRevert = Schema.decodeUnknownSync(PersistedRevert)

export function fromRow(row: typeof SessionTable.$inferSelect): SessionSchema.Info {
  return SessionSchema.Info.make({
    id: SessionSchema.ID.make(row.id),
    projectID: Project.ID.make(row.project_id),
    title: row.title ?? undefined,
    parentID: row.parent_id ? SessionSchema.ID.make(row.parent_id) : undefined,
    fork:
      row.fork_session_id && row.fork_boundary
        ? {
            sessionID: SessionSchema.ID.make(row.fork_session_id),
            boundary: row.fork_boundary,
          }
        : undefined,
    agent: row.agent ? Agent.ID.make(row.agent) : undefined,
    model: row.model
      ? {
          id: Model.ID.make(row.model.id),
          providerID: Provider.ID.make(row.model.providerID),
          variant: Model.VariantID.make(row.model.variant ?? "default"),
        }
      : undefined,
    cost: Money.USD.make(row.cost),
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    location: Location.Ref.make({
      directory: AbsolutePath.make(row.directory),
      workspaceID: row.workspace_id ? Workspace.ID.make(row.workspace_id) : undefined,
    }),
    subpath: row.path ? RelativePath.make(row.path) : undefined,
    metadata: row.metadata ?? undefined,
    permissions: row.permission ?? undefined,
    revert: row.revert ? decodeRevert(row.revert) : undefined,
    outcome: row.idle_outcome ?? undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      idle: row.time_idle === null ? undefined : DateTime.makeUnsafe(row.time_idle),
      viewed: row.time_viewed === null ? undefined : DateTime.makeUnsafe(row.time_viewed),
      archived: row.time_archived ? DateTime.makeUnsafe(row.time_archived) : undefined,
    },
  })
}
