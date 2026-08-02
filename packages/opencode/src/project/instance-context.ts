import { LocalContext } from "@/util/local-context"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  if (FSUtil.contains(ctx.directory, filepath)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return FSUtil.contains(ctx.worktree, filepath)
}

export function permissionPath(filepath: string, ctx: InstanceContext): string {
  // A root worktree is the non-git sentinel, not a project boundary.
  if (ctx.worktree === "/" || !containsPath(filepath, ctx)) return filepath
  return path.relative(ctx.worktree, filepath)
}
