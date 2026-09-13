export interface WorktreeCreateInput {
  readonly sourceDirectory: string
  /** Suggested destination after naming and collision handling. Strategies may return a different directory. */
  readonly directory: string
  /** Starting ref, not the name of a new branch. Reject unsupported refs rather than ignoring them. */
  readonly branch?: string
}

export interface WorktreeRemoveInput {
  readonly directory: string
  readonly force: boolean
}

export interface WorktreeResult {
  /** Actual directory created by the strategy, used for inventory and startup commands. */
  readonly directory: string
}

export interface WorktreeEntry extends WorktreeResult {
  readonly type: "root" | "worktree"
}
