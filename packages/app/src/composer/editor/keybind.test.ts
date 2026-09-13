import { describe, expect, test } from "bun:test"
import { handleComposerKeyDown, resolveComposerKeyAction } from "./keybind"

const keybinds = {
  alternate: (event: KeyboardEvent) => event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey,
  submit: (event: KeyboardEvent) => event.key === "s" && event.metaKey,
  newline: (event: KeyboardEvent) => event.key === "Enter" && event.shiftKey,
}

function keyEvent(input: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">) {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    keyCode: 0,
    isComposing: false,
    preventDefault: () => undefined,
    repeat: false,
    stopPropagation: () => undefined,
    ...input,
  } as KeyboardEvent
}

function handle(input: {
  event: KeyboardEvent
  keybinds?: typeof keybinds
  composing?: boolean
  suggestion?: boolean
  controller?: boolean
}) {
  const result = { edits: 0, newlines: 0, selections: 0, submissions: [] as boolean[] }
  handleComposerKeyDown({
    event: input.event,
    keybinds: input.keybinds,
    composing: input.composing ?? false,
    selectSuggestion: () => {
      if (!input.suggestion) return false
      result.selections++
      return true
    },
    handleController: () => input.controller ?? false,
    editFirst: () => {
      result.edits++
      return true
    },
    insertNewline: () => result.newlines++,
    submit: (alternate) => result.submissions.push(alternate),
  })
  return result
}

describe("composer keybind resolution", () => {
  test("leaves bare Enter composition to the IME", () => {
    expect(
      resolveComposerKeyAction(
        keyEvent({ key: "Enter", isComposing: true }),
        {
          ...keybinds,
          submit: () => false,
          newline: (event) => event.key === "Enter",
        },
        true,
      ),
    ).toBeUndefined()
  })

  test("keeps modified Enter newline bindings available during composition", () => {
    expect(resolveComposerKeyAction(keyEvent({ key: "Enter", shiftKey: true }), keybinds, true)).toBe("newline")
  })

  test("ignores non-Enter bindings during composition", () => {
    expect(resolveComposerKeyAction(keyEvent({ key: "n", metaKey: true }), keybinds, true)).toBeUndefined()
    expect(resolveComposerKeyAction(keyEvent({ key: "s", metaKey: true }), keybinds, true)).toBeUndefined()
  })

  test("recognizes arbitrary submit bindings", () => {
    expect(resolveComposerKeyAction(keyEvent({ key: "s", metaKey: true }), keybinds, false)).toBe("submit")
  })

  test("leaves unbound chords without an action", () => {
    expect(resolveComposerKeyAction(keyEvent({ key: "Enter", altKey: true }), keybinds, false)).toBeUndefined()
  })
})

describe("composer keybind integration", () => {
  test("custom alternate delivery observes composition and repeat suppression", () => {
    const bindings = { ...keybinds, alternate: (event: KeyboardEvent) => event.key === "q" && event.ctrlKey }
    expect(handle({ event: keyEvent({ key: "q", ctrlKey: true }), keybinds: bindings }).submissions).toEqual([true])
    expect(
      handle({ event: keyEvent({ key: "q", ctrlKey: true, repeat: true }), keybinds: bindings }).submissions,
    ).toEqual([])
    expect(
      handle({ event: keyEvent({ key: "q", ctrlKey: true }), keybinds: bindings, composing: true }).submissions,
    ).toEqual([])
    expect(handle({ event: keyEvent({ key: "Enter", ctrlKey: true }), keybinds: bindings }).submissions).toEqual([])
  })

  test("disabled alternate delivery does not fall back to Mod+Enter", () => {
    expect(
      handle({ event: keyEvent({ key: "Enter", ctrlKey: true }), keybinds: { ...keybinds, alternate: () => false } })
        .submissions,
    ).toEqual([])
  })
  test("explicit submit bindings take precedence over alternate delivery", () => {
    expect(
      handle({
        event: keyEvent({ key: "Enter", ctrlKey: true }),
        keybinds: { ...keybinds, submit: (event) => event.key === "Enter" && event.ctrlKey, newline: () => false },
      }).submissions,
    ).toEqual([false])
  })

  test("default Mod+Enter uses alternate delivery", () => {
    expect(handle({ event: keyEvent({ key: "Enter", ctrlKey: true }), keybinds }).submissions).toEqual([true])
  })

  test("Mod+ArrowUp still edits the first queued prompt", () => {
    expect(handle({ event: keyEvent({ key: "ArrowUp", ctrlKey: true }), keybinds }).edits).toBe(1)
  })

  test("composition suppresses bare Enter submission", () => {
    expect(handle({ event: keyEvent({ key: "Enter" }), composing: true }).submissions).toEqual([])
  })

  test("Enter selects the active suggestion before submitting", () => {
    expect(
      handle({
        event: keyEvent({ key: "Enter" }),
        keybinds: { ...keybinds, submit: (event) => event.key === "Enter", newline: () => false },
        suggestion: true,
      }),
    ).toEqual({
      edits: 0,
      newlines: 0,
      selections: 1,
      submissions: [],
    })
  })

  test("a non-Enter submit binding ignores the active suggestion", () => {
    expect(
      handle({
        event: keyEvent({ key: "s", metaKey: true }),
        keybinds,
        suggestion: true,
      }),
    ).toEqual({
      edits: 0,
      newlines: 0,
      selections: 0,
      submissions: [false],
    })
  })

  test("Shift+Enter selects the active suggestion before inserting a newline", () => {
    expect(
      handle({
        event: keyEvent({ key: "Enter", shiftKey: true }),
        keybinds,
        suggestion: true,
      }),
    ).toEqual({
      edits: 0,
      newlines: 0,
      selections: 1,
      submissions: [],
    })
  })

  test("composing Shift+Enter inserts a newline without selecting a suggestion", () => {
    expect(
      handle({
        event: keyEvent({ key: "Enter", shiftKey: true, isComposing: true }),
        keybinds,
        suggestion: true,
      }),
    ).toEqual({
      edits: 0,
      newlines: 1,
      selections: 0,
      submissions: [],
    })
  })
})
