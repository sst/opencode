/** @jsxImportSource @opentui/solid */
// Split-footer status shown while a freshly launched CLI replaces a
// version-mismatched background service before the TUI attaches.
import { createCliRenderer, RGBA, TextAttributes, type CliRenderer } from "@opentui/core"
import { render, useTerminalDimensions } from "@opentui/solid"
import { OPENCODE_VERSION } from "../version"
import { registerOpencodeSpinner } from "@opencode/tui/component/register-spinner"
import { SPINNER_FRAMES } from "@opencode/tui/component/spinner"
import { go } from "@opencode/tui/logo"
import { setTimeout } from "node:timers/promises"
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"

const stages = ["Keeping your session safe", "Starting the new background service", "Loading OpenCode"] as const
const stageFloor = 480
const transitionDuration = 420
const completionHold = 650

export type Handle = {
  readonly begin: (from?: string) => boolean
  readonly loading: () => void
  readonly finish: () => Promise<undefined>
  readonly fail: (message: string) => Promise<void>
  readonly close: () => Promise<void>
}

export const make = (): Handle => {
  let session: Promise<Session | undefined> | undefined
  return {
    begin: (from) => {
      if (!process.stdout.isTTY || !process.stdin.isTTY) return false
      session ??= open(from).catch(() => {
        process.stderr.write("Restarting background server (version mismatch)...\n")
        return undefined
      })
      return true
    },
    loading: () => {
      void session?.then((active) => active?.loading())
    },
    finish: async () => {
      const active = await session
      return active?.finish()
    },
    fail: async (message) => {
      const active = await session
      await active?.fail(message)
    },
    close: async () => {
      const active = await session
      await active?.close()
    },
  }
}

type Session = {
  readonly loading: () => Promise<void>
  readonly finish: () => Promise<undefined>
  readonly fail: (message: string) => Promise<void>
  readonly close: () => Promise<void>
}

async function open(from?: string): Promise<Session> {
  registerOpencodeSpinner()
  const [active, setActive] = createSignal(0)
  const [outcome, setOutcome] = createSignal<"running" | "success" | "failure">("running")
  const [failure, setFailure] = createSignal("")
  const [animating, setAnimating] = createSignal(true)
  let resolveOutcome: (() => void) | undefined
  const renderer = await createCliRenderer({
    stdin: process.stdin,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
    exitOnCtrlC: false,
    screenMode: "split-footer",
    footerHeight: 4,
    targetFps: 60,
    useKittyKeyboard: {},
    consoleOptions: {
      keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
    },
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  await render(
    () => (
      <UpdateFooter
        from={from}
        active={active}
        outcome={outcome}
        failure={failure}
        animating={animating}
        renderer={renderer}
        onOutcomeSettled={() => resolveOutcome?.()}
      />
    ),
    renderer,
  ).catch((error) => {
    if (!renderer.isDestroyed) renderer.destroy()
    throw error
  })
  let shownAt = performance.now()
  const waitForStage = async () => {
    const remaining = stageFloor - (performance.now() - shownAt)
    if (remaining > 0) await setTimeout(remaining)
  }
  const advance = async (stage: number) => {
    await waitForStage()
    if (outcome() !== "running") return
    setActive(stage)
    shownAt = performance.now()
  }
  // Service.start currently exposes only its start boundary, so this first
  // transition is time-based. Finer lifecycle callbacks remain follow-up work.
  const auto = advance(1)
  const transitionTo = async (next: "success" | "failure", hold: number) => {
    const settled = Promise.withResolvers<void>()
    resolveOutcome = settled.resolve
    setOutcome(next)
    const completed = await Promise.race([
      settled.promise.then(() => true),
      setTimeout(transitionDuration + 500).then(() => false),
    ])
    resolveOutcome = undefined
    setAnimating(false)
    if (completed) await setTimeout(hold)
  }
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      setAnimating(false)
      if (renderer.isDestroyed) return
      renderer.pause()
      await Promise.race([renderer.idle(), setTimeout(500)])
      renderer.destroy()
    })())
  let loading: Promise<void> | undefined
  const load = () =>
    (loading ??= (async () => {
      await auto
      await advance(2)
    })())
  let settled: Promise<void> | undefined
  const settle = (task: () => Promise<void>) => (settled ??= task())
  return {
    loading: load,
    finish: async () => {
      await settle(async () => {
        await load()
        await waitForStage()
        await transitionTo("success", completionHold)
      })
      await close()
      return undefined
    },
    fail: (message) =>
      settle(async () => {
        setFailure(message)
        await transitionTo("failure", 250)
        await close()
      }),
    close,
  }
}

const colors = {
  accent: RGBA.fromHex("#a6b8ff"),
  accentBright: RGBA.fromHex("#eef1ff"),
  accentDim: RGBA.fromHex("#596998"),
  error: RGBA.fromHex("#ff8192"),
  muted: RGBA.fromHex("#808080"),
  success: RGBA.fromHex("#8bd5a5"),
  text: RGBA.fromHex("#eeeeee"),
}

const monogram = go.right.slice(1)
const sweepBlend = 8
const textDim = RGBA.fromHex("#4c4c4c")
const rampSteps = 32

const blend = (from: RGBA, to: RGBA, amount: number) =>
  RGBA.fromValues(
    from.r + (to.r - from.r) * amount,
    from.g + (to.g - from.g) * amount,
    from.b + (to.b - from.b) * amount,
  )
const ramp = (from: RGBA, to: RGBA) =>
  Array.from({ length: rampSteps + 1 }, (_, step) => blend(from, to, step / rampSteps))
const railRamp = ramp(colors.accentDim, colors.accentBright)
const monogramRamp = ramp(colors.muted, colors.accent)
const rampCache = new Map<RGBA, ReadonlyArray<RGBA>>()
const rampFor = (color: RGBA) => {
  const cached = rampCache.get(color)
  if (cached) return cached
  const result = ramp(textDim, color)
  rampCache.set(color, result)
  return result
}
const shade = (palette: ReadonlyArray<RGBA>, brightness: number) =>
  palette[Math.round(Math.max(0, Math.min(1, brightness)) * rampSteps)]

type Cell = { readonly char: string; readonly color: RGBA; readonly bold?: boolean }
const styled = (text: string, color: RGBA, bold?: boolean): Cell[] =>
  Array.from(text).map((char) => ({ char, color, bold }))
const phrase = (...segments: ReadonlyArray<readonly [string, RGBA, boolean?]>): Cell[] =>
  segments.flatMap((segment, index) => [
    ...(index > 0 ? styled(" ", colors.muted) : []),
    ...styled(segment[0], segment[1], segment[2]),
  ])

function Monogram(props: { ink: () => RGBA }) {
  const shadow = createMemo(() => {
    const ink = props.ink()
    return RGBA.fromValues(ink.r * 0.25, ink.g * 0.25, ink.b * 0.25)
  })
  return (
    <box flexDirection="column">
      <For each={monogram}>
        {(line) => (
          <box flexDirection="row">
            <For each={Array.from(line)}>
              {(char) =>
                char === "_" ? (
                  <text bg={shadow()} selectable={false}>
                    {" "}
                  </text>
                ) : (
                  <text fg={props.ink()} selectable={false}>
                    {char}
                  </text>
                )
              }
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

type CellTransition = { from: Cell[]; to: Cell[]; done?: () => void }

function createTransition(render: (transition: CellTransition, progress: number) => Cell[]) {
  const [state, setState] = createSignal<{ from: Cell[]; to: Cell[]; done?: () => void } | undefined>()
  const [progress, setProgress] = createSignal(0)
  let elapsed = 0
  const cells = createMemo(() => {
    const transition = state()
    if (!transition) return undefined
    return render(transition, progress())
  })
  return {
    start(from: Cell[], to: Cell[], done?: () => void) {
      elapsed = 0
      setProgress(0)
      setState({ from, to, done })
    },
    tick(deltaTime: number) {
      const transition = state()
      if (!transition) return
      elapsed = Math.min(transitionDuration, elapsed + deltaTime)
      setProgress(elapsed / transitionDuration)
      if (elapsed < transitionDuration) return
      setState(undefined)
      transition.done?.()
    },
    cells,
    progress,
  }
}

const createSweep = () =>
  createTransition((transition, progress) => {
    const length = Math.max(transition.from.length, transition.to.length)
    const front = smoothstep(progress) * (length + 2 * sweepBlend) - sweepBlend
    return Array.from({ length }, (_, index) => {
      const passed = Math.max(0, Math.min(1, (front - index) / sweepBlend))
      const brightness = smoothstep(Math.abs(passed * 2 - 1))
      const cell = (passed >= 0.5 ? transition.to[index] : transition.from[index]) ?? {
        char: " ",
        color: colors.text,
      }
      return { ...cell, color: shade(rampFor(cell.color), brightness) }
    })
  })

const createFade = () =>
  createTransition((transition, progress) => {
    const entering = progress >= 0.5
    const brightness = smoothstep(entering ? progress * 2 - 1 : 1 - progress * 2)
    return (entering ? transition.to : transition.from).map((cell) => ({
      ...cell,
      color: shade(rampFor(cell.color), brightness),
    }))
  })

const smoothstep = (value: number) => value * value * (3 - 2 * value)
const frameDone = Promise.resolve()

function UpdateFooter(props: {
  from?: string
  active: () => number
  outcome: () => "running" | "success" | "failure"
  failure: () => string
  animating: () => boolean
  renderer: CliRenderer
  onOutcomeSettled: () => void
}) {
  const term = useTerminalDimensions()
  const [position, setPosition] = createSignal(0)
  const [pulse, setPulse] = createSignal(0)
  const headerFade = createFade()
  const statusSweep = createSweep()
  const runningHeader = () =>
    phrase(
      ["OpenCode", colors.muted, true],
      ["is updating", colors.muted],
      ...(props.from
        ? ([
            ["from", colors.muted],
            [props.from, colors.accentDim],
          ] as const)
        : []),
      ["to", colors.muted],
      [OPENCODE_VERSION, colors.accent],
    )
  const completedHeader = phrase(
    ["OpenCode", colors.muted, true],
    ["updated to", colors.muted],
    [OPENCODE_VERSION, colors.accent],
  )
  const pausedHeader = phrase(["OpenCode", colors.muted, true], ["update paused", colors.muted])
  const outcomeStatus = () =>
    props.outcome() === "success"
      ? [...styled("✓", colors.success), ...styled(" Ready", colors.text)]
      : [...styled("!", colors.error), ...styled(" " + props.failure(), colors.text)]
  let previousStage: string = stages[0]
  createEffect(
    on(props.active, (index) => {
      if (props.outcome() !== "running") return
      const next = stages[index]
      if (next === previousStage) return
      statusSweep.start(styled(previousStage, colors.text), styled(next, colors.text))
      previousStage = next
    }),
  )
  createEffect(
    on(
      props.outcome,
      (outcome) => {
        if (outcome === "running") return
        const visibleStatus = untrack(statusSweep.cells) ?? styled(previousStage, colors.text)
        headerFade.start(runningHeader(), outcome === "success" ? completedHeader : pausedHeader)
        statusSweep.start([...styled("  ", colors.text), ...visibleStatus], outcomeStatus(), props.onOutcomeSettled)
      },
      { defer: true },
    ),
  )
  const header = createMemo(
    () =>
      headerFade.cells() ??
      (props.outcome() === "success"
        ? completedHeader
        : props.outcome() === "failure"
          ? pausedHeader
          : runningHeader()),
  )
  const monogramInk = createMemo(() =>
    props.outcome() === "success" ? shade(monogramRamp, smoothstep(headerFade.progress())) : colors.muted,
  )
  const rail = createMemo(() => {
    const width = Math.max(0, Math.min(30, term().width - 39))
    if (width === 0) return []
    const filled = Math.round(position() * width)
    const glowRadius = 6
    const span = Math.max(1, filled + glowRadius * 2)
    const center = pulse() * span - glowRadius
    const success = props.outcome() === "success"
    const completion = smoothstep(headerFade.progress())
    return Array.from({ length: width }, (_, index) => {
      const color =
        index >= filled ? colors.muted : shade(railRamp, Math.max(0, 1 - Math.abs(index - center) / glowRadius) ** 2)
      return {
        char: success || index < filled ? "━" : "·",
        color: success ? blend(color, colors.accent, completion) : color,
      }
    })
  })

  onMount(() => {
    let value = 0
    let velocity = 0
    let phase = 0
    const frame = (deltaTime: number) => {
      if (!props.animating()) return frameDone
      const elapsed = Math.min(0.032, deltaTime / 1_000)
      const stiffness = 110
      const damping = 2 * Math.sqrt(stiffness)
      const target = props.outcome() === "success" ? 1 : (props.active() + 1) / stages.length
      velocity += (stiffness * (target - value) - damping * velocity) * elapsed
      value += velocity * elapsed
      phase = (phase + deltaTime / 900) % 1
      batch(() => {
        setPosition(Math.max(0, Math.min(1, value)))
        setPulse(phase)
      })
      headerFade.tick(deltaTime)
      statusSweep.tick(deltaTime)
      return frameDone
    }
    props.renderer.setFrameCallback(frame)
    onCleanup(() => props.renderer.removeFrameCallback(frame))
  })

  return (
    <box width="100%" height={4} flexDirection="row" gap={1} paddingLeft={1} live={props.animating()}>
      <Monogram ink={monogramInk} />
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <CellLine cells={header()} />
        <Show
          when={props.outcome() === "running"}
          fallback={<CellLine cells={statusSweep.cells() ?? outcomeStatus()} />}
        >
          <box flexDirection="row" gap={1}>
            <spinner frames={SPINNER_FRAMES} interval={80} color={colors.accent} />
            <CellLine cells={statusSweep.cells() ?? styled(stages[props.active()], colors.text)} />
          </box>
        </Show>
        <box flexDirection="row" gap={1}>
          <CellLine cells={rail()} />
          <text fg={colors.muted}>
            {props.outcome() === "success" ? stages.length : props.active() + 1}/{stages.length}
          </text>
        </box>
      </box>
    </box>
  )
}

function CellLine(props: { cells: ReadonlyArray<Cell> }) {
  return (
    <text truncate>
      <Index each={props.cells}>
        {(cell) => (
          <span
            style={{
              fg: cell().color,
              attributes: cell().bold ? TextAttributes.BOLD : TextAttributes.NONE,
            }}
          >
            {cell().char}
          </span>
        )}
      </Index>
    </text>
  )
}

export * as UpdatePreflight from "./update-preflight"
