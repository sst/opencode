import type { SessionMessageAssistant } from "@opencode/client"
import { groupEntries, mergeGroups, splitGroups, type GroupNode } from "./tree"

export type PartRef = {
  messageID: string
  partID: string
}

export type CacheUsage = {
  read: number
  model: SessionMessageAssistant["model"]
}

export type SessionEntry =
  | { type: "message"; messageID: string }
  | { type: "compaction-queued"; inboxID: string }
  | { type: "part"; ref: PartRef }
  | { type: "assistant-footer"; messageID: string }
  | { type: "turn-usage"; messageIDs: string[]; previousCache?: CacheUsage }

type GroupKind = "reasoning" | "exploration"
type SessionGroup = {
  type: "group"
  children: readonly GroupNode<SessionEntry, GroupKind>[]
  size: number
  completed: boolean
} & ({ kind: "reasoning" } | { kind: "exploration"; pending: PartRef[] })

export type SessionRow = SessionEntry | SessionGroup

export type AppendPart =
  | { type: "text" }
  | { type: "reasoning"; time?: { completed?: number } }
  | { type: "tool"; name: string }

export type ProjectionEntry = {
  entry: SessionEntry
  part?: AppendPart
  closesPrevious?: boolean
}

/** Hydrate a fresh history batch in one pass rather than merging one leaf at a time. */
export function projectEntries(entries: ProjectionEntry[]): SessionRow[] {
  const nodes = groupEntries(entries, (item) => (item.part ? partPath(item.part) : []))
  return nodes.map((node, index) => {
    if (node.type === "entry") return node.entry.entry
    const next = nodes[index + 1]
    const completed =
      (next !== undefined && (next.type === "group" || next.entry.closesPrevious !== false)) ||
      (node.kind === "reasoning" &&
        node.children.every(
          (child) =>
            child.type === "entry" &&
            child.entry.part?.type === "reasoning" &&
            child.entry.part.time?.completed !== undefined,
        ))
    const group = { ...node, children: node.children.map(unwrap), completed }
    return node.kind === "reasoning" ? { ...group, kind: "reasoning" } : { ...group, kind: "exploration", pending: [] }
  })
}

function unwrap(node: GroupNode<ProjectionEntry, GroupKind>): GroupNode<SessionEntry, GroupKind> {
  if (node.type === "entry") return { ...node, entry: node.entry.entry }
  return { ...node, children: node.children.map(unwrap) }
}

function partPath(part: AppendPart): readonly GroupKind[] {
  if (part.type === "reasoning") return ["reasoning"]
  if (part.type === "tool" && ["read", "glob", "grep"].includes(part.name.toLowerCase())) return ["exploration"]
  return []
}

/** Production rules only: keep lifecycle/status decisions outside the tree engine. */
export function append(rows: SessionRow[], ref: PartRef, part: AppendPart, index = rows.length) {
  const [node] = groupEntries<SessionEntry, GroupKind>([{ type: "part", ref }], () => partPath(part))
  if (node.type === "entry") {
    completePrevious(rows, index)
    rows.splice(index, 0, node.entry)
    return
  }
  const previous = rows[index - 1]
  if (previous?.type === "group" && previous.kind === node.kind) {
    // Permission-blocked tools remain at the end, just as the former refs/pending
    // partition did. Inserting a new ref must precede those blocked tools.
    const pending = previous.kind === "exploration" ? previous.pending.length : 0
    const [left, right] = splitGroups([previous], previous.size - pending)
    const [merged] = mergeGroups(mergeGroups(left, [node]), right)
    if (merged.type !== "group") throw new Error("Expected merged session group")
    previous.children = merged.children
    previous.size = merged.size
    if (part.type === "reasoning") previous.completed &&= part.time?.completed !== undefined
    return
  }
  completePrevious(rows, index)
  rows.splice(
    index,
    0,
    node.kind === "reasoning"
      ? { ...node, kind: "reasoning", completed: part.type === "reasoning" && part.time?.completed !== undefined }
      : { ...node, kind: "exploration", pending: [], completed: false },
  )
}

export function completePrevious(rows: SessionRow[], index = rows.length) {
  const previous = rows[index - 1]
  if (previous?.type === "group") previous.completed = true
}

/** Part references for an existing production subgroup, not a flat timeline. */
export function groupRefs(row: SessionGroup, includePending = false): PartRef[] {
  const pending = !includePending && row.kind === "exploration" ? row.pending : []
  const visit = (nodes: readonly GroupNode<SessionEntry, GroupKind>[]): PartRef[] =>
    nodes.flatMap((node) => {
      if (node.type === "group") return visit(node.children)
      if (node.entry.type !== "part") return []
      const ref = node.entry.ref
      if (pending.some((item) => item.messageID === ref.messageID && item.partID === ref.partID)) return []
      return [ref]
    })
  return visit(row.children)
}

export function partitionPending(rows: SessionRow[], pending: Set<string>) {
  rows.forEach((row) => {
    if (row.type !== "group" || row.kind !== "exploration") return
    // The production exploration rule creates direct part children. Preserve the
    // existing stable partition order when permissions are admitted or dismissed.
    const blocked = (node: GroupNode<SessionEntry, GroupKind>) =>
      node.type === "entry" && node.entry.type === "part" && pending.has(node.entry.ref.partID)
    row.children = [...row.children.filter((node) => !blocked(node)), ...row.children.filter(blocked)]
    row.pending = groupRefs(row, true).filter((ref) => pending.has(ref.partID))
  })
}

export function hasPart(rows: SessionRow[], ref: PartRef) {
  return rows.some((row) => {
    if (row.type === "part") return row.ref.messageID === ref.messageID && row.ref.partID === ref.partID
    if (row.type !== "group") return false
    return groupRefs(row, true).some((item) => item.messageID === ref.messageID && item.partID === ref.partID)
  })
}
