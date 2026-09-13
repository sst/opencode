import type { BoxRenderable, TextareaRenderable, ScrollBoxRenderable } from "@opentui/core"
import { pathToFileURL } from "node:url"
import fuzzysort from "fuzzysort"
import path from "path"
import { firstBy } from "remeda"
import { createMemo, createResource, createEffect, onMount, onCleanup, Index, Show, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useEditorContext } from "../../context/editor"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { getScrollAcceleration } from "../../util/scroll"
import { useTuiPaths } from "../../context/runtime"
import { useConfig } from "../../config"
import { useLocation } from "../../context/location"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { useTerminalDimensions } from "@opentui/solid"
import { Locale } from "../../util/locale"
import type { PromptInfo, PromptPartRef } from "../../prompt/history"
import { useFrecency } from "../../prompt/frecency"
import { Keymap, type KeymapCommand } from "../../context/keymap"
import { displayCharAt, mentionTriggerIndex, slashTriggerIndex } from "../../prompt/display"
import type { FileSystemEntry } from "@opencode/client"
import { Skill } from "@opencode/schema/skill"
import { stringWidth } from "../../util/string-width"
import { parseFileLineRange, stripFileLineRange } from "../../prompt/parse"
import { moveSelection, reconcileSelectionWindow, revealSelectionOffset } from "../../ui/select-controller"
import { directoryAutocomplete, slashArgumentAutocomplete } from "../../prompt/directory-completion"

export type AutocompleteRef = {
  onInput: (value: string) => void
  visible: false | "reference" | "command" | "directory"
  completeQueueableCommand: () => boolean
}

export type AutocompleteOption = {
  display: string
  value?: string
  aliases?: string[]
  disabled?: boolean
  description?: string
  isDirectory?: boolean
  onSelect?: () => void
  path?: string
  absolute?: string
  destructive?: { id: string; confirm: string; run: () => void }
  kind?: "skill"
  queueable?: boolean
}

type AutocompleteResults = {
  options: AutocompleteOption[]
  failed: boolean
  mode: AutocompleteRef["visible"]
  query: string
  resolved: boolean
}

export function Autocomplete(props: {
  value: string
  sessionID?: string
  argumentAutocomplete?: (command: KeymapCommand) => "directory" | undefined
  directoryOptions?: (query: string) => AutocompleteOption[]
  setPrompt: (input: (prompt: PromptInfo) => void) => void
  setExtmark: (part: PromptPartRef, extmarkId: number) => void
  anchor: () => BoxRenderable
  input: () => TextareaRenderable
  ref: (ref: AutocompleteRef) => void
  fileStyleId: number
  agentStyleId: number
  skillStyleId: number
  hasSkill: (id: string) => boolean
  promptPartTypeId: () => number
}) {
  const editor = useEditorContext()
  const client = useClient()
  const data = useData()
  const keymap = Keymap.use()
  const keymapCommands = Keymap.useCommands()
  const theme = useTheme("overlay")
  const dimensions = useTerminalDimensions()
  const frecency = useFrecency()
  const config = useConfig().data
  const paths = useTuiPaths()
  const location = useLocation()
  const [store, setStore] = createStore({
    index: 0,
    selected: 0,
    visible: false as AutocompleteRef["visible"],
  })

  const [positionTick, setPositionTick] = createSignal(0)
  const [dismissedValue, setDismissedValue] = createSignal<string>()
  const [confirming, setConfirming] = createSignal<string>()

  createEffect(() => {
    if (!store.visible) return
    const popMode = keymap.mode.push("autocomplete")
    onCleanup(popMode)
  })

  createEffect(() => {
    if (store.visible) {
      let lastPos = { x: 0, y: 0, width: 0 }
      const interval = setInterval(() => {
        const anchor = props.anchor()
        if (anchor.x !== lastPos.x || anchor.y !== lastPos.y || anchor.width !== lastPos.width) {
          lastPos = { x: anchor.x, y: anchor.y, width: anchor.width }
          setPositionTick((t) => t + 1)
        }
      }, 50)

      onCleanup(() => clearInterval(interval))
    }
  })

  const position = createMemo(() => {
    if (!store.visible) return { x: 0, y: 0, width: 0 }
    dimensions()
    positionTick()
    const anchor = props.anchor()
    const parent = anchor.parent
    const parentX = parent?.x ?? 0
    const parentY = parent?.y ?? 0

    return {
      x: anchor.x - parentX,
      y: anchor.y - parentY,
      width: anchor.width,
    }
  })

  const filter = createMemo(() => {
    if (!store.visible) return
    // Track props.value to make memo reactive to text changes
    props.value // <- there surely is a better way to do this, like making .input() reactive

    return props
      .input()
      .getTextRange(store.visible === "directory" ? store.index : store.index + 1, props.input().cursorOffset)
  })

  // filter() reads reactive props.value plus non-reactive cursor/text state.
  // On keypress those can be briefly out of sync, so filter() may return an empty/partial string.
  // Copy it into search in an effect because effects run after reactive updates have been rendered and painted
  // so the input has settled and all consumers read the same stable value.
  const [search, setSearch] = createSignal("")
  createEffect(() => {
    const next = filter()
    setSearch(next ? next : "")
  })

  function insertPart(
    text: string,
    part:
      | { type: "file"; value: NonNullable<PromptInfo["files"]>[number]; path?: string }
      | { type: "agent"; value: NonNullable<PromptInfo["agents"]>[number] }
      | { type: "skill"; value: NonNullable<PromptInfo["skills"]>[number] },
  ) {
    if (part.type === "skill" && props.hasSkill(part.value.id)) return
    const input = props.input()
    const currentCursorOffset = input.cursorOffset

    const charAfterCursor = displayCharAt(props.value, currentCursorOffset)
    const needsSpace = charAfterCursor !== " "
    const prefix = "@"
    const append = prefix + text + (needsSpace ? " " : "")

    input.cursorOffset = store.index
    const startCursor = input.logicalCursor
    input.cursorOffset = currentCursorOffset
    const endCursor = input.logicalCursor

    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    input.insertText(append)

    const virtualText = prefix + text
    const extmarkStart = store.index
    const extmarkEnd = extmarkStart + stringWidth(virtualText)

    const styleId =
      part.type === "file" ? props.fileStyleId : part.type === "skill" ? props.skillStyleId : props.agentStyleId

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId,
      typeId: props.promptPartTypeId(),
    })

    props.setPrompt((draft) => {
      if (part.type === "file") {
        const files = (draft.files ??= [])
        const existingIndex = files.findIndex((file) => file.uri === part.value.uri)
        if (existingIndex !== -1) {
          const existing = files[existingIndex]
          if (existing?.mention) {
            existing.mention.start = extmarkStart
            existing.mention.end = extmarkEnd
            existing.mention.text = virtualText
          }
          return
        }
        if (part.value.mention) {
          part.value.mention.start = extmarkStart
          part.value.mention.end = extmarkEnd
          part.value.mention.text = virtualText
        }
        const index = files.length
        files.push(part.value)
        props.setExtmark({ type: "file", index }, extmarkId)
        return
      }

      if (part.type === "skill") {
        const skills = (draft.skills ??= [])
        if (skills.some((skill) => skill.id === part.value.id)) return
        if (part.value.mention) {
          part.value.mention.start = extmarkStart
          part.value.mention.end = extmarkEnd
          part.value.mention.text = virtualText
        }
        const index = skills.length
        skills.push(part.value)
        props.setExtmark({ type: "skill", index }, extmarkId)
        return
      }

      const agents = (draft.agents ??= [])
      if (part.value.mention) {
        part.value.mention.start = extmarkStart
        part.value.mention.end = extmarkEnd
        part.value.mention.text = virtualText
      }
      const index = agents.length
      agents.push(part.value)
      props.setExtmark({ type: "agent", index }, extmarkId)
    })

    if (part.type === "file" && part.path) frecency.updateFrecency(part.path)
  }

  function createFilePart(
    item: FileSystemEntry,
    filePath: string,
    lineRange?: { startLine: number; endLine?: number },
  ) {
    const urlObj = pathToFileURL(filePath)
    const filename =
      lineRange && item.type !== "directory"
        ? `${item.path}#${lineRange.startLine}${lineRange.endLine ? `-${lineRange.endLine}` : ""}`
        : item.path

    if (lineRange && item.type !== "directory") {
      urlObj.searchParams.set("start", String(lineRange.startLine))
      if (lineRange.endLine !== undefined) {
        urlObj.searchParams.set("end", String(lineRange.endLine))
      }
    }

    return {
      filename,
      part: {
        type: "file" as const,
        path: item.path,
        value: {
          uri: urlObj.href,
          name: filename,
          mention: { start: 0, end: 0, text: "" },
        },
      },
    }
  }

  const references = createMemo(() => data.location.reference.list() ?? [])

  const referenceMatch = createMemo(() => {
    if (store.visible !== "reference") return
    const base = parseFileLineRange(search()).base
    const slash = base.indexOf("/")
    const alias = slash === -1 ? base : base.slice(0, slash)
    return references().find((item) => !item.hidden && item.name === alias)
  })

  function normalizeMentionPath(filePath: string) {
    const baseDir = location.current?.directory || data.location.info()?.directory || paths.cwd
    const absolute = path.resolve(filePath)
    const relative = path.relative(baseDir, absolute)

    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/")
    }

    return absolute.split(path.sep).join("/")
  }

  function insertFileMention(input: { filePath: string; lineStart: number; lineEnd: number }) {
    const item = normalizeMentionPath(input.filePath)
    const lineRange = {
      startLine: input.lineStart,
      endLine: input.lineEnd > input.lineStart ? input.lineEnd : undefined,
    }
    const { filename, part } = createFilePart({ path: item, type: "file" }, input.filePath, lineRange)
    const index = store.visible === "reference" ? store.index : props.input().cursorOffset

    setStore("visible", false)
    setStore("index", index)
    insertPart(filename, part)
  }

  function insertDirectory(directory: string) {
    const input = props.input()
    const cursorOffset = input.cursorOffset
    input.cursorOffset = store.index
    const start = input.logicalCursor
    input.cursorOffset = cursorOffset
    const end = input.logicalCursor
    input.deleteRange(start.row, start.col, end.row, end.col)
    input.insertText(directory)
  }

  const [files] = createResource(
    () => ({ query: search(), location: location.current, visible: store.visible }),
    async (input, info): Promise<AutocompleteResults> => {
      if (!input.visible || input.visible === "command")
        return { options: [], failed: false, mode: input.visible, query: input.query, resolved: true }
      if (referenceMatch())
        return { options: [], failed: false, mode: input.visible, query: input.query, resolved: true }
      const { lineRange, base } = parseFileLineRange(input.query ?? "")
      const requestLocation = {
        directory: input.location?.directory,
        workspace: input.location?.workspaceID ?? data.location.default().workspaceID,
      }
      const width = props.anchor().width - 4
      if (input.visible === "directory") {
        const result = await directoryAutocomplete(
          client.api.file,
          { ...requestLocation, directory: requestLocation.directory ?? paths.cwd },
          base,
          paths.home,
        ).catch(() => undefined)
        if (!result)
          return info.value?.mode === input.visible
            ? { ...info.value, failed: true }
            : { options: [], failed: true, mode: input.visible, query: input.query, resolved: false }
        return {
          options: result.map((item) => ({
            display: Locale.truncateMiddle(item.value, width),
            value: item.value,
            isDirectory: true,
            path: item.value,
            absolute: item.absolute,
            onSelect: () => insertDirectory(item.value),
          })),
          failed: false,
          mode: input.visible,
          query: input.query,
          resolved: true,
        }
      }
      const result = await client.api.file.find({ query: base, limit: 20, location: requestLocation }).then(
        (result) => result,
        () => undefined,
      )

      if (!result)
        return info.value?.mode === input.visible
          ? { ...info.value, failed: true }
          : { options: [], failed: true, mode: input.visible, query: input.query, resolved: false }

      const options: AutocompleteOption[] = []

      options.push(
        ...result.data.map((item): AutocompleteOption => {
          const { filename, part } = createFilePart(item, path.join(result.location.directory, item.path), lineRange)
          return {
            display: Locale.truncateMiddle(filename, width),
            value: filename,
            isDirectory: item.type === "directory",
            path: item.path,
            onSelect: () => {
              insertPart(filename, part)
            },
          }
        }),
      )

      return { options, failed: false, mode: input.visible, query: input.query, resolved: true }
    },
    {
      initialValue: {
        options: [],
        failed: false,
        mode: false as AutocompleteRef["visible"],
        query: "",
        resolved: false,
      },
    },
  )

  const visibleFiles = createMemo(() => {
    const value = files.loading ? files.latest : files()
    if (value?.mode === store.visible) return value
    return { options: [], failed: false, query: "", resolved: false }
  })

  const mcpResources = createMemo(() => {
    if (store.visible !== "reference") return []

    const options: AutocompleteOption[] = []
    const width = props.anchor().width - 4

    for (const res of data.location.mcp.resource.list(location.current) ?? []) {
      options.push({
        display: Locale.truncateMiddle(res.name, width),
        // Match the name only; matching the URI caused unrelated fuzzy hits.
        value: res.name,
        description: res.description,
        onSelect: () => {
          insertPart(res.name, {
            type: "file",
            value: {
              uri: res.uri,
              name: res.name,
              description: res.description,
              mention: { start: 0, end: 0, text: "" },
            },
          })
        },
      })
    }

    return options
  })

  const agents = createMemo(() => {
    return (data.location.agent.list() ?? [])
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map(
        (agent): AutocompleteOption => ({
          display: "@" + agent.id,
          onSelect: () => {
            insertPart(agent.id, {
              type: "agent",
              value: {
                name: agent.id,
                mention: { start: 0, end: 0, text: "" },
              },
            })
          },
        }),
      )
  })

  const skillOptions = createMemo(() =>
    (data.location.skill.list(location.current) ?? []).map(
      (skill): AutocompleteOption => ({
        display: "@" + skill.id,
        description: skill.description,
        kind: "skill",
        onSelect: () => {
          insertPart(skill.id, {
            type: "skill",
            value: { id: Skill.ID.make(skill.id), mention: { start: 0, end: 0, text: "" } },
          })
        },
      }),
    ),
  )

  const referenceAliases = createMemo(() =>
    references()
      .filter((reference) => !reference.hidden)
      .map(
        (reference): AutocompleteOption => ({
          display: "@" + reference.name,
          description: ` ${reference.source.type === "git" ? reference.source.repository : reference.source.path}`,
          onSelect: () => {
            insertPart(reference.name, {
              type: "file",
              path: reference.name,
              value: {
                uri: pathToFileURL(reference.path).href,
                name: reference.name,
                mention: { start: 0, end: 0, text: "" },
              },
            })
          },
        }),
      ),
  )

  function insertSlash(name: string) {
    const newText = `/${name} `
    const cursor = props.input().logicalCursor
    props.input().deleteRange(0, 0, cursor.row, cursor.col)
    props.input().insertText(newText)
    props.input().cursorOffset = stringWidth(newText)
  }

  const commands = createMemo((): AutocompleteOption[] => {
    const results: AutocompleteOption[] = keymapCommands().flatMap((command) => {
      const slash = command.slash
      if (!slash) return []
      return [slash.name, ...(slash.aliases ?? [])].map((name) => ({
        display: `/${name}`,
        description: command.description ?? command.title,
        onSelect: slash.arguments ? () => insertSlash(name) : command.run,
      }))
    })
    const commandNames = new Set<string>()

    for (const serverCommand of data.location.command.list(location.current) ?? []) {
      commandNames.add(serverCommand.name)
      results.push({
        display: "/" + serverCommand.name,
        description: serverCommand.description,
        queueable: true,
        onSelect: () => insertSlash(serverCommand.name),
      })
    }

    for (const skill of data.location.skill
      .list(location.current)
      ?.filter((skill) => skill.slash === true && !commandNames.has(skill.id)) ?? []) {
      results.push({
        display: "/" + skill.id,
        description: skill.description,
        kind: "skill",
        onSelect: () => insertSlash(skill.id),
      })
    }

    results.sort((a, b) => a.display.localeCompare(b.display))

    const max = firstBy(results, [(x) => x.display.length, "desc"])?.display.length
    if (!max) return results
    return results.map((item) => ({
      ...item,
      display: item.display.padEnd(max + 2),
    }))
  })

  const supplementalDirectoryOptions = createMemo((): AutocompleteOption[] => {
    const results = visibleFiles()
    if (store.visible !== "directory" || !results.resolved) return []
    const width = props.anchor().width - 4
    return (props.directoryOptions?.(results.query) ?? []).map((item) => {
      const value = item.value
      return {
        ...item,
        display: Locale.truncateMiddle(item.display, width),
        onSelect: item.onSelect ?? (value ? () => insertDirectory(value) : undefined),
      }
    })
  })

  const options = createMemo(() => {
    const fileSearch = visibleFiles()
    const referenceMatchValue = referenceMatch()
    const agentsValue = agents()
    const referenceAliasesValue = referenceAliases()
    const commandsValue = commands()
    const searchValue = search()

    if (store.visible === "directory") {
      const supplemental = supplementalDirectoryOptions()
      const paths = new Set(supplemental.map((item) => item.absolute))
      return [...supplemental, ...fileSearch.options.filter((item) => !paths.has(item.absolute))]
    }

    if (store.visible === "reference" && referenceMatchValue) {
      return referenceAliasesValue.filter((item) => item.display === `@${referenceMatchValue.name}`)
    }

    // Files come from fff already fuzzy ranked and filtered
    // it shouldn't be additionally sorted by fuzzysort as it will loose the results
    const fileOptions: AutocompleteOption[] = store.visible === "reference" ? fileSearch.options : []
    const nonFileOptions: AutocompleteOption[] =
      store.visible === "reference"
        ? [...skillOptions(), ...referenceAliasesValue, ...agentsValue, ...mcpResources()]
        : store.index === 0
          ? [...commandsValue]
          : []

    if (!searchValue) {
      return [...nonFileOptions, ...fileOptions]
    }

    const fuzziedNonFiles = fuzzysort
      .go(stripFileLineRange(searchValue), nonFileOptions, {
        keys: [
          (obj) => stripFileLineRange((obj.value ?? obj.display).trimEnd()),
          // Match description for slash commands only; for "@" it surfaced unrelated items.
          ...(store.visible === "command" ? ["description" as const] : []),
          (obj) => obj.aliases?.join(" ") ?? "",
        ],
        threshold: store.visible === "reference" ? 0.5 : 0,
        limit: 10,
        scoreFn: (objResults) => {
          const displayResult = objResults[0]
          let score = objResults.score
          const prefix = store.visible === "reference" ? "@" : store.visible === "command" ? "/" : ""
          if (displayResult && displayResult.target.startsWith(prefix + searchValue)) {
            score *= 2
          }
          const frecencyScore = objResults.obj.path ? frecency.getFrecency(objResults.obj.path) : 0
          return score * (1 + frecencyScore)
        },
      })
      .map((arr) => arr.obj)

    return [...fuzziedNonFiles, ...fileOptions].slice(0, 10)
  })

  createEffect(() => {
    filter()
    setStore("selected", 0)
    setConfirming(undefined)
  })

  function move(direction: -1 | 1) {
    if (!store.visible) return
    if (!options().length) return
    moveTo(moveSelection(store.selected, { count: options().length, delta: direction, policy: "wrap" }))
  }

  function moveTo(next: number) {
    if (next !== store.selected) setConfirming(undefined)
    setStore("selected", next)
    if (!scroll) return
    const offset = revealSelectionOffset(scroll.scrollTop, {
      count: options().length,
      limit: Math.min(height(), options().length),
      selected: next,
    })
    if (offset === scroll.scrollTop) return
    scroll.scrollBy(offset - scroll.scrollTop)
  }

  function syncSelectionWindow() {
    if (!scroll) return
    const selected = reconcileSelectionWindow(store.selected, {
      count: options().length,
      limit: Math.min(height(), options().length),
      offset: scroll.scrollTop,
    })
    if (selected === store.selected) return
    setConfirming(undefined)
    setStore("selected", selected)
  }

  function select() {
    const selected = options()[store.selected]
    if (!selected) return
    if (store.visible !== "directory") {
      hide(true)
      selected.onSelect?.()
      return
    }
    selected.onSelect?.()
    setDismissedValue(props.input().plainText)
    hide(true)
  }

  function triggerDestructive() {
    const action = options()[store.selected]?.destructive
    if (!action) return false
    if (confirming() !== action.id) {
      setConfirming(action.id)
      return
    }
    action.run()
    setStore("selected", Math.max(0, Math.min(store.selected, options().length - 2)))
    setConfirming(undefined)
  }

  function expandDirectory() {
    const selected = options()[store.selected]
    if (!selected) return

    const input = props.input()
    const currentCursorOffset = input.cursorOffset

    const displayText = (selected.value ?? selected.display).trimEnd()
    const selectedPath = displayText.startsWith("@") ? displayText.slice(1) : displayText

    if (store.visible === "directory") {
      insertDirectory(selectedPath.endsWith(path.sep) ? selectedPath : selectedPath + path.sep)
      setStore("selected", 0)
      return
    }

    input.cursorOffset = store.index
    const startCursor = input.logicalCursor
    input.cursorOffset = currentCursorOffset
    const endCursor = input.logicalCursor

    input.deleteRange(startCursor.row, startCursor.col, endCursor.row, endCursor.col)
    input.insertText("@" + selectedPath + "/")

    setStore("selected", 0)
  }

  Keymap.createLayer(() => ({
    mode: "autocomplete",
    target: props.input,
    enabled: () => Boolean(store.visible),
    bindings: ["prompt.queue"],
    commands: [
      {
        id: "prompt.autocomplete.prev",
        title: "Previous autocomplete item",
        group: "Autocomplete",
        run() {
          move(-1)
        },
      },
      {
        id: "prompt.autocomplete.next",
        title: "Next autocomplete item",
        group: "Autocomplete",
        run() {
          move(1)
        },
      },
      {
        id: "prompt.autocomplete.hide",
        title: "Hide autocomplete",
        group: "Autocomplete",
        run() {
          hide()
        },
      },
      {
        id: "prompt.clear",
        title: "Dismiss autocomplete",
        group: "Autocomplete",
        run() {
          hide(true)
        },
      },
      {
        id: "prompt.autocomplete.select",
        title: "Select autocomplete item",
        group: "Autocomplete",
        run() {
          select()
        },
      },
      {
        id: "prompt.autocomplete.complete",
        title: "Complete autocomplete item",
        group: "Autocomplete",
        run() {
          const selected = options()[store.selected]
          if (selected?.isDirectory) {
            expandDirectory()
            return
          }

          select()
        },
      },
      {
        id: "prompt.autocomplete.destructive",
        title: "Confirm autocomplete action",
        group: "Autocomplete",
        bind: "ctrl+d",
        run: triggerDestructive,
      },
    ],
  }))

  function show(mode: Exclude<AutocompleteRef["visible"], false>, index = props.input().cursorOffset) {
    setStore({
      visible: mode,
      index,
    })
  }

  function hide(removeToken = false) {
    if (removeToken && store.visible === "command") {
      const input = props.input()
      const cursorOffset = input.cursorOffset
      input.cursorOffset = store.index
      const start = input.logicalCursor
      input.cursorOffset = cursorOffset
      const end = input.logicalCursor
      input.deleteRange(start.row, start.col, end.row, end.col)
      // Sync the prompt store immediately since onContentChange is async
      props.setPrompt((draft) => {
        draft.text = input.plainText
      })
    }
    setConfirming(undefined)
    setStore("visible", false)
  }

  onMount(() => {
    const unsubscribeMention = editor.onMention((mention) => {
      insertFileMention(mention)
    })

    onCleanup(() => {
      unsubscribeMention()
    })

    props.ref({
      get visible() {
        return store.visible
      },
      completeQueueableCommand() {
        if (store.visible !== "command" || !options()[store.selected]?.queueable) return false
        select()
        return true
      },
      onInput(value) {
        if (dismissedValue() === value) return
        setDismissedValue(undefined)
        const offset = props.input().cursorOffset
        const argument = slashArgumentAutocomplete(value, offset, keymapCommands(), props.argumentAutocomplete)
        if (argument?.type === "directory") {
          show("directory", argument.index)
          return
        }

        if (store.visible) {
          if (
            // Typed text before the trigger
            props.input().cursorOffset <= store.index ||
            // There is a space between the trigger and the cursor
            props.input().getTextRange(store.index, props.input().cursorOffset).match(/\s/)
          ) {
            hide()
          }
          return
        }

        // Check if autocomplete should reopen (e.g., after backspace deleted a space)
        if (offset === 0) return

        const slash = slashTriggerIndex(value, offset)
        if (slash !== undefined) {
          show("command")
          setStore("index", slash)
          return
        }

        // Check for "@" trigger - find the nearest "@" before cursor with no whitespace between
        const idx = mentionTriggerIndex(value, offset)
        if (idx !== undefined) {
          show("reference")
          setStore("index", idx)
        }
      },
    })
  })

  const height = createMemo(() => {
    const count = options().length || 1
    if (!store.visible) return Math.min(10, count)
    positionTick()
    return Math.min(10, count, Math.max(1, props.anchor().y))
  })

  let scroll: ScrollBoxRenderable | undefined
  onCleanup(() => scroll?.verticalScrollBar.off("change", syncSelectionWindow))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))
  const emptyMessage = createMemo(() => {
    const fileSearch = visibleFiles()
    if (store.visible === "command") return "No matching commands"
    if (store.visible === "directory") {
      if (files.loading) return "Searching…"
      if (fileSearch.failed) return "Could not search directories. Keep typing to try again."
      return "No matching directories"
    }
    if (files.loading) return "Searching…"
    if (fileSearch.failed) return "Could not search files. Keep typing to try again."
    return "No matching files, agents, or references"
  })
  const emptyError = createMemo(() => store.visible === "reference" && !files.loading && visibleFiles().failed)

  return (
    <box
      visible={store.visible !== false}
      position="absolute"
      top={position().y - height()}
      left={position().x}
      width={position().width}
      zIndex={100}
      {...SplitBorder}
      borderColor={theme.border.default}
    >
      <scrollbox
        ref={(r: ScrollBoxRenderable) => {
          scroll?.verticalScrollBar.off("change", syncSelectionWindow)
          scroll = r
          scroll.verticalScrollBar.on("change", syncSelectionWindow)
        }}
        backgroundColor={theme.background.default}
        height={height()}
        scrollbarOptions={{ visible: false }}
        scrollAcceleration={scrollAcceleration()}
      >
        <Index
          each={options()}
          fallback={
            <box paddingLeft={1} paddingRight={1}>
              <text fg={emptyError() ? theme.text.feedback.error.default : theme.text.subdued}>{emptyMessage()}</text>
            </box>
          }
        >
          {(option, index) => {
            const destructive = () => option().destructive
            const confirmingAction = () => {
              const action = destructive()
              return action !== undefined && action.id === confirming()
            }
            return (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={
                  confirmingAction()
                    ? theme.background.action.destructive.focused
                    : index === store.selected
                      ? theme.background.action.primary.focused
                      : undefined
                }
                flexDirection="row"
                onMouseMove={() => moveTo(index)}
                onMouseDown={() => moveTo(index)}
                onMouseUp={() => select()}
              >
                <text
                  fg={
                    confirmingAction()
                      ? theme.text.action.destructive.focused
                      : index === store.selected
                        ? theme.text.action.primary.focused
                        : theme.text.default
                  }
                  flexShrink={0}
                >
                  {confirmingAction() ? destructive()?.confirm : option().display}
                </text>
                <Show when={!confirmingAction() && option().description}>
                  <text
                    fg={index === store.selected ? theme.text.action.primary.focused : theme.text.subdued}
                    wrapMode="none"
                  >
                    {" " + option().description?.replace(/\s+/g, " ").trim()}
                  </text>
                </Show>
              </box>
            )
          }}
        </Index>
      </scrollbox>
    </box>
  )
}
