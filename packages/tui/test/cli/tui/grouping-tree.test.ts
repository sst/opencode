import { expect, test } from "bun:test"
import { groupEntries, mergeGroups, splitGroups } from "../../../src/routes/session/grouping/tree"

const path = (entry: { path: string[] }) => entry.path
const read = { id: "read", path: ["activity", "exploration"] }
const search = { id: "search", path: ["activity", "exploration"] }
const thought = { id: "thought", path: ["activity", "reasoning"] }
const text = { id: "text", path: [] }
const leaf = (entry: typeof read) => ({ type: "entry" as const, entry, size: 1 as const })

test("groups adjacent entries by path and counts leaves, not wrappers", () => {
  expect(groupEntries([read, search, thought, text, read], path)).toEqual([
    {
      type: "group",
      kind: "activity",
      size: 3,
      children: [
        { type: "group", kind: "exploration", size: 2, children: [leaf(read), leaf(search)] },
        { type: "group", kind: "reasoning", size: 1, children: [leaf(thought)] },
      ],
    },
    leaf(text),
    {
      type: "group",
      kind: "activity",
      size: 1,
      children: [{ type: "group", kind: "exploration", size: 1, children: [leaf(read)] }],
    },
  ])
})

test("a direct child breaks a subgroup without ending the outer group", () => {
  const shell = { id: "shell", path: ["activity"] }
  expect(groupEntries([read, shell, search], path)).toEqual([
    {
      type: "group",
      kind: "activity",
      size: 3,
      children: [
        { type: "group", kind: "exploration", size: 1, children: [leaf(read)] },
        leaf(shell),
        { type: "group", kind: "exploration", size: 1, children: [leaf(search)] },
      ],
    },
  ])
})

test("merges both grouping levels at a page seam without changing the inputs", () => {
  const left = groupEntries([text, read], path)
  const right = groupEntries([search, thought], path)
  const saved = structuredClone([left, right])
  const merged = mergeGroups(left, right)
  expect(merged).toEqual(groupEntries([text, read, search, thought], path))
  expect([left, right]).toEqual(saved)
  expect(merged[0]).toBe(left[0])
})

test("splits at each leaf boundary and merges back to the original tree", () => {
  const entries = [read, search, thought, text]
  const tree = groupEntries(entries, path)
  for (let count = 0; count <= entries.length; count++) {
    const [left, right] = splitGroups(tree, count)
    expect(left).toEqual(groupEntries(entries.slice(0, count), path))
    expect(right).toEqual(groupEntries(entries.slice(count), path))
    expect(mergeGroups(left, right)).toEqual(tree)
  }
})

test("handles empty chunks", () => {
  const tree = groupEntries([read], path)
  expect(groupEntries([], path)).toEqual([])
  expect(mergeGroups([], tree)).toBe(tree)
  expect(mergeGroups(tree, [])).toBe(tree)
  expect(splitGroups([], 0)).toEqual([[], []])
})

test("rejects invalid split offsets", () => {
  const tree = groupEntries([read], path)
  for (const count of [-1, 0.5, 2, NaN]) {
    expect(() => splitGroups(tree, count)).toThrow(RangeError)
  }
})
