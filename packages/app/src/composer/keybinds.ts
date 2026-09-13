import { matchKeybind, parseKeybind } from "@/shell/commands/command"
import { useSettings } from "@/settings/model"

export const PROMPT_KEYBINDS = {
  submit: {
    id: "prompt.submit",
    keybind: "enter",
    title: "command.prompt.submit",
  },
  newline: {
    id: "prompt.newline",
    keybind: "shift+enter",
    title: "command.prompt.newline",
  },
  alternate: {
    id: "prompt.submit.alternate",
    keybind: "mod+enter",
    title: "command.prompt.submit.alternate",
  },
} as const

export function matchPromptKeybind(
  id: keyof typeof PROMPT_KEYBINDS,
  overrides: Partial<Record<keyof typeof PROMPT_KEYBINDS, string>>,
  event: KeyboardEvent,
) {
  const override = overrides[id]
  if (override !== undefined) return matchKeybind(parseKeybind(override), event)
  if (
    Object.entries(overrides).some(
      ([action, value]) => action !== id && value !== undefined && matchKeybind(parseKeybind(value), event),
    )
  )
    return false
  if (event.key !== "Enter") return false
  if (id === "alternate") return (event.ctrlKey || event.metaKey) && !event.shiftKey
  return id === "submit" ? !event.shiftKey && !event.ctrlKey && !event.metaKey : event.shiftKey
}

export function createPromptKeybinds() {
  const settings = useSettings()
  const overrides = () => ({
    submit: settings.keybinds.get(PROMPT_KEYBINDS.submit.id),
    newline: settings.keybinds.get(PROMPT_KEYBINDS.newline.id),
    alternate: settings.keybinds.get(PROMPT_KEYBINDS.alternate.id),
  })

  return {
    submit: (event: KeyboardEvent) => matchPromptKeybind("submit", overrides(), event),
    newline: (event: KeyboardEvent) => matchPromptKeybind("newline", overrides(), event),
    alternate: (event: KeyboardEvent) => matchPromptKeybind("alternate", overrides(), event),
  }
}

export function promptKeybindOptions(titles: { submit: string; newline: string; alternate: string }) {
  return [
    {
      id: PROMPT_KEYBINDS.alternate.id,
      title: titles.alternate,
      keybind: PROMPT_KEYBINDS.alternate.keybind,
      disabled: true,
    },
    {
      id: PROMPT_KEYBINDS.submit.id,
      title: titles.submit,
      keybind: PROMPT_KEYBINDS.submit.keybind,
      disabled: true,
    },
    {
      id: PROMPT_KEYBINDS.newline.id,
      title: titles.newline,
      keybind: PROMPT_KEYBINDS.newline.keybind,
      disabled: true,
    },
  ]
}
