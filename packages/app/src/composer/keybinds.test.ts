import { describe, expect, test } from "bun:test"
import { matchPromptKeybind, promptKeybindOptions } from "./keybinds"

function keyEvent(input: KeyboardEventInit = {}) {
  return new KeyboardEvent("keydown", { key: "Enter", ...input })
}

describe("prompt keybind matching", () => {
  test("rebinds, disables, and swaps alternate delivery with submit", () => {
    expect(matchPromptKeybind("alternate", {}, keyEvent({ ctrlKey: true }))).toBe(true)
    expect(matchPromptKeybind("alternate", {}, keyEvent({ metaKey: true }))).toBe(true)
    expect(matchPromptKeybind("alternate", { alternate: "none" }, keyEvent({ ctrlKey: true }))).toBe(false)
    const overrides = { alternate: "enter", submit: "ctrl+enter" }
    expect(matchPromptKeybind("alternate", overrides, keyEvent())).toBe(true)
    expect(matchPromptKeybind("alternate", overrides, keyEvent({ ctrlKey: true }))).toBe(false)
    expect(matchPromptKeybind("submit", overrides, keyEvent({ ctrlKey: true }))).toBe(true)
    expect(matchPromptKeybind("submit", { alternate: "enter" }, keyEvent())).toBe(false)
    expect(matchPromptKeybind("newline", { alternate: "shift+enter" }, keyEvent({ shiftKey: true }))).toBe(false)
  })
  test("keeps prompt actions out of the global keymap", () => {
    expect(
      promptKeybindOptions({ submit: "Submit", newline: "Newline", alternate: "Alternate" }).map(
        (option) => option.disabled,
      ),
    ).toEqual([true, true, true])
  })

  test("preserves submit defaults without overriding alternate delivery", () => {
    expect(matchPromptKeybind("submit", {}, keyEvent())).toBe(true)
    expect(matchPromptKeybind("submit", {}, keyEvent({ ctrlKey: true }))).toBe(false)
    expect(matchPromptKeybind("submit", {}, keyEvent({ metaKey: true }))).toBe(false)
    expect(matchPromptKeybind("submit", {}, keyEvent({ altKey: true }))).toBe(true)
  })

  test("preserves shifted newline variants without an override", () => {
    expect(matchPromptKeybind("newline", {}, keyEvent({ shiftKey: true }))).toBe(true)
    expect(matchPromptKeybind("newline", {}, keyEvent({ shiftKey: true, ctrlKey: true }))).toBe(true)
    expect(matchPromptKeybind("newline", {}, keyEvent({ shiftKey: true, metaKey: true }))).toBe(true)
    expect(matchPromptKeybind("newline", {}, keyEvent({ shiftKey: true, altKey: true }))).toBe(true)
  })

  test("uses exact matching after an explicit override", () => {
    expect(matchPromptKeybind("submit", { submit: "enter" }, keyEvent({ ctrlKey: true }))).toBe(false)
    expect(matchPromptKeybind("submit", { submit: "ctrl+enter" }, keyEvent({ ctrlKey: true }))).toBe(true)
    expect(matchPromptKeybind("newline", { newline: "shift+enter" }, keyEvent({ shiftKey: true, ctrlKey: true }))).toBe(
      false,
    )
  })

  test("lets explicit bindings override the other action fallback", () => {
    const event = keyEvent({ ctrlKey: true, shiftKey: true })
    const overrides = { submit: "ctrl+shift+enter" }

    expect(matchPromptKeybind("newline", overrides, event)).toBe(false)
    expect(matchPromptKeybind("submit", overrides, event)).toBe(true)
  })

  test("supports none and swapped bindings", () => {
    expect(matchPromptKeybind("submit", { submit: "none" }, keyEvent())).toBe(false)
    expect(matchPromptKeybind("newline", { newline: "none" }, keyEvent({ shiftKey: true }))).toBe(false)

    const overrides = { submit: "shift+enter", newline: "enter" }
    expect(matchPromptKeybind("submit", overrides, keyEvent({ shiftKey: true }))).toBe(true)
    expect(matchPromptKeybind("newline", overrides, keyEvent())).toBe(true)
  })
})
