import { afterEach, describe, expect, test } from "bun:test"
import { createComposerEditor } from "@/composer/editor/interaction"
import type { ComposerPersistedState } from "@/composer/types"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"

afterEach(() => {
  document.body.replaceChildren()
  window.getSelection()?.removeAllRanges()
})

function setup(value: string) {
  const [store, setStore] = createStore<ComposerPersistedState>({
    prompt: [{ type: "text", content: value, start: 0, end: value.length }],
    cursor: value.length,
    context: { items: [] },
  })
  let controller!: ReturnType<typeof createComposerEditor>
  const dispose = createRoot((dispose) => {
    controller = createComposerEditor({
      store: [store, setStore],
      commands: () => [],
      context: () => [],
      searchContextFiles: () => [],
      view: {
        submit: {
          stopping: () => false,
          onSubmit: () => undefined,
          onStop: () => undefined,
        },
      },
    })
    return dispose
  })
  const editor = document.createElement("div")
  editor.contentEditable = "true"
  editor.textContent = value
  document.body.append(editor)
  controller.setEditor(editor)
  return { controller, dispose, editor }
}

function select(start: Node, startOffset: number, end: Node, endOffset: number) {
  const range = document.createRange()
  range.setStart(start, startOffset)
  range.setEnd(end, endOffset)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

describe("composer editor insertion", () => {
  test("replaces the live editor selection and emits an input event", () => {
    const state = setup("hello")
    select(state.editor.firstChild!, 1, state.editor.firstChild!, 4)
    let inputType: string | undefined
    state.editor.addEventListener("input", (event) => {
      inputType = (event as InputEvent).inputType
    })

    state.controller.insertNewline()

    expect({ text: state.editor.textContent, inputType, collapsed: window.getSelection()?.isCollapsed }).toEqual({
      text: "h\no",
      inputType: "insertLineBreak",
      collapsed: true,
    })
    state.dispose()
  })

  test("does not mutate a selection that leaves the editor", () => {
    const state = setup("inside")
    const outside = document.createElement("div")
    outside.textContent = "outside"
    document.body.append(outside)
    select(state.editor.firstChild!, 2, outside.firstChild!, 3)
    let inputs = 0
    state.editor.addEventListener("input", () => inputs++)

    state.controller.insertNewline()

    expect({ editor: state.editor.textContent, outside: outside.textContent, inputs }).toEqual({
      editor: "inside",
      outside: "outside",
      inputs: 0,
    })
    state.dispose()
  })
})
