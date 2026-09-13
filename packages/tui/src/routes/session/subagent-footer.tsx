import { createMemo, createSignal, Show } from "solid-js"
import { useRouteData } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { useTerminalDimensions } from "@opentui/solid"
import { useCommandShortcut, useOpencodeKeymap } from "../../keymap"

export function SubagentFooter() {
  const route = useRouteData("session")
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const session = createMemo(() => sync.session.get(route.sessionID))

  const subagentInfo = createMemo(() => {
    const s = session()
    if (!s) return { label: "Subagent", index: 0, total: 0 }
    const agentMatch = s.title.match(/@(\w+) subagent/)
    const label = agentMatch ? Locale.titlecase(agentMatch[1]) : "Subagent"

    if (!s.parentID) return { label, index: 0, total: 0 }

    const siblings = sync.data.session
      .filter((x) => x.parentID === s.parentID)
      .toSorted((a, b) => a.time.created - b.time.created)
    const index = siblings.findIndex((x) => x.id === s.id)

    return { label, index: index + 1, total: siblings.length }
  })

  const usage = createMemo(() => {
    const msg = messages()
    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (tokens <= 0) return

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const pct = model?.limit.context ? `${Math.round((tokens / model.limit.context) * 100)}%` : undefined
    const cost = session()?.cost ?? 0

    const money = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    })

    return {
      context: pct ? `${Locale.number(tokens)} (${pct})` : Locale.number(tokens),
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  const { theme } = useTheme()
  const keymap = useOpencodeKeymap()
  const parentShortcut = useCommandShortcut("session.parent")
  const previousShortcut = useCommandShortcut("session.child.previous")
  const nextShortcut = useCommandShortcut("session.child.next")
  const interruptShortcut = useCommandShortcut("session.subagent.interrupt")
  const interruptEnabled = createMemo(() => !!sync.data.config.experimental?.subagent_interrupt)
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | "interrupt" | null>(null)
  useTerminalDimensions()

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text}>
              <b>{subagentInfo().label}</b>
            </text>
            <Show when={subagentInfo().total > 0}>
              <text style={{ fg: theme.textMuted }}>
                ({subagentInfo().index} of {subagentInfo().total})
              </text>
            </Show>
            <Show when={usage()}>
              {(item) => (
                <text fg={theme.textMuted} wrapMode="none">
                  {[item().context, item().cost].filter(Boolean).join(" · ")}
                </text>
              )}
            </Show>
          </box>
          <box flexDirection="row" gap={2}>
            <box
              onMouseOver={() => setHover("parent")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.parent")}
              backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Parent <span style={{ fg: theme.textMuted }}>{parentShortcut()}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("prev")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.child.previous")}
              backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Prev <span style={{ fg: theme.textMuted }}>{previousShortcut()}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("next")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.child.next")}
              backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Next <span style={{ fg: theme.textMuted }}>{nextShortcut()}</span>
              </text>
            </box>
            <Show when={interruptEnabled()}>
              <box
                onMouseOver={() => setHover("interrupt")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => keymap.dispatchCommand("session.subagent.interrupt")}
                backgroundColor={hover() === "interrupt" ? theme.backgroundElement : theme.backgroundPanel}
              >
                <text fg={theme.text}>
                  Interrupt <span style={{ fg: theme.textMuted }}>{interruptShortcut()}</span>
                </text>
              </box>
            </Show>
          </box>
        </box>
      </box>
    </box>
  )
}
