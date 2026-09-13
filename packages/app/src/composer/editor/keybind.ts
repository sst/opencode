export type ComposerKeybinds = {
  submit: (event: KeyboardEvent) => boolean
  newline: (event: KeyboardEvent) => boolean
  alternate: (event: KeyboardEvent) => boolean
}

export function resolveComposerKeyAction(event: KeyboardEvent, keybinds: ComposerKeybinds, composing: boolean) {
  const bareEnter = event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
  const newline = keybinds.newline(event)
  if (composing && (!newline || event.key !== "Enter" || bareEnter)) return
  if (newline) return "newline" as const
  if (composing) return
  if (keybinds.submit(event)) return "submit" as const
  if (keybinds.alternate(event)) return "alternate" as const
}

export function handleComposerKeyDown(input: {
  event: KeyboardEvent
  keybinds?: ComposerKeybinds
  composing: boolean
  selectSuggestion: () => boolean
  handleController: () => boolean
  editFirst?: () => boolean
  insertNewline: () => void
  submit: (alternate: boolean) => void
}) {
  const submit = (alternate = false) => {
    input.event.preventDefault()
    input.event.stopPropagation()
    if (input.event.repeat || (input.event.key === "Enter" && input.selectSuggestion())) return
    input.submit(alternate)
  }
  const ime = input.event.isComposing || input.composing || input.event.keyCode === 229
  const action = input.keybinds ? resolveComposerKeyAction(input.event, input.keybinds, ime) : undefined
  if (action === "newline") {
    input.event.preventDefault()
    input.event.stopPropagation()
    if (!ime && input.event.key === "Enter" && input.selectSuggestion()) return
    input.insertNewline()
    return
  }
  if (ime) return
  if (action === "submit") return submit()
  if (action === "alternate") return submit(true)
  if (input.handleController()) return
  const mod = input.event.metaKey || input.event.ctrlKey
  if (mod && input.event.key === "ArrowUp" && !input.event.shiftKey && !input.event.altKey) {
    if (input.editFirst?.()) input.event.preventDefault()
    return
  }
  if (input.keybinds && input.event.key === "Enter") {
    input.event.preventDefault()
    input.event.stopPropagation()
    return
  }
  if (!input.keybinds && input.event.key === "Enter" && !input.event.shiftKey) return submit(mod)
}
