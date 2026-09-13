export * as ConfigWorktree from "./worktree.js"

import { Schema } from "effect"

export const Info = Schema.Struct({
  directory: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())).annotate({
    description: "Parent directory for new worktrees, relative to the project's primary checkout when not absolute",
  }),
}).annotate({ identifier: "Config.Worktree" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
