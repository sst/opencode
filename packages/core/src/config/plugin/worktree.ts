export * as ConfigWorktreePlugin from "./worktree.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import path from "path"
import { Config } from "../../config.js"
import { Global } from "@opencode/util/global"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"
import { Worktree } from "../../worktree.js"
import { ConfigEntryObserver } from "./entry-observer.js"

export const Plugin = define({
  id: "opencode.config.worktree",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const global = yield* Global.Service
    const worktrees = yield* Worktree.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, worktrees.reload())
    yield* worktrees.transform((editor) => {
      for (const entry of loaded.entries) {
        if (entry.type !== "document" || !entry.info.worktree) continue
        const directory = entry.info.worktree.directory
        editor.configure({
          directory: AbsolutePath.make(
            directory.startsWith("~/")
              ? path.join(global.home, directory.slice(2))
              : path.resolve(location.project.canonical, directory),
          ),
        })
      }
    })
  }),
})
