import { For, Show, createEffect, createMemo, onCleanup, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@opencode/ui/button"
import { IconButton } from "@opencode/ui/icon-button"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Icon } from "@opencode/ui/icon"
import { useSpring } from "@opencode/ui/motion-spring"
import { showToast } from "@/shell/notifications/toast"
import type { FormAnswer, FormInfo, FormMultiselectField, FormStringField } from "@opencode/client/promise"
import { useLanguage } from "@/runtime/i18n/language"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useServerSDK } from "@/runtime/server/client"
import { ScopedKey } from "@/runtime/server/scope"

const cache = new Map<string, { tab: number; answers: string[][]; custom: string[]; customOn: boolean[] }>()

type QuestionField = FormStringField | FormMultiselectField

function questionField(field: FormInfo["fields"][number]): field is QuestionField {
  return field.type === "string" || field.type === "multiselect"
}

function Mark(props: { multi: boolean; picked: boolean; onClick?: (event: MouseEvent) => void }) {
  return (
    <span data-slot="question-option-check" aria-hidden="true" onClick={props.onClick}>
      <span data-slot="question-option-box" data-type={props.multi ? "checkbox" : "radio"} data-picked={props.picked}>
        <Show when={props.multi} fallback={<span data-slot="question-option-radio-dot" />}>
          <Icon name="check-small" size="small" />
        </Show>
      </span>
    </span>
  )
}

function Option(props: {
  multi: boolean
  picked: boolean
  label: string
  description?: string
  disabled: boolean
  ref?: (el: HTMLButtonElement) => void
  onFocus?: VoidFunction
  onClick: VoidFunction
}) {
  return (
    <button
      type="button"
      ref={props.ref}
      data-slot="question-option"
      data-picked={props.picked}
      role={props.multi ? "checkbox" : "radio"}
      aria-checked={props.picked}
      disabled={props.disabled}
      onFocus={props.onFocus}
      onClick={props.onClick}
    >
      <Mark multi={props.multi} picked={props.picked} />
      <span data-slot="question-option-main">
        <span data-slot="option-label">{props.label}</span>
        <Show when={props.description}>
          <span data-slot="option-description">{props.description}</span>
        </Show>
      </span>
    </button>
  )
}

export const SessionQuestionDock: Component<{ request: FormInfo; onSubmit: () => void }> = (props) => {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const cacheKey = ScopedKey.from(serverSDK.scope, props.request.id)

  const questions = createMemo(() =>
    props.request.fields.filter(questionField).map((field) => ({
      field,
      header: field.title ?? "",
      question: field.description ?? field.title ?? "",
      options: field.type === "string" ? (field.options ?? []) : field.options,
      multiple: field.type === "multiselect",
    })),
  )
  const total = createMemo(() => questions().length)

  const cached = cache.get(cacheKey)
  const [store, setStore] = createStore({
    tab: cached?.tab ?? 0,
    answers: cached?.answers ?? ([] as string[][]),
    custom: cached?.custom ?? ([] as string[]),
    customOn: cached?.customOn ?? ([] as boolean[]),
    editing: false,
    focus: 0,
    minimized: false,
    optionsHeight: 180,
  })

  let root: HTMLDivElement | undefined
  let optionsRef: HTMLDivElement | undefined
  let customRef: HTMLButtonElement | undefined
  let optsRef: HTMLButtonElement[] = []
  let replied = false
  let focusFrame: number | undefined

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => question()?.options ?? [])
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const on = createMemo(() => store.customOn[store.tab] === true)
  const multi = createMemo(() => question()?.multiple === true)
  const count = createMemo(() => options().length + 1)

  const summary = createMemo(() => {
    const n = Math.min(store.tab + 1, total())
    return language.t("session.question.progress", { current: n, total: total() })
  })
  const customLabel = () => language.t("ui.messagePart.option.typeOwnAnswer")
  const customPlaceholder = () => language.t("ui.question.custom.placeholder")

  const last = createMemo(() => store.tab >= total() - 1)
  const collapse = useSpring(() => (store.minimized ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const hidden = createMemo(() => Math.max(0, Math.min(1, collapse())))
  const optionsOff = createMemo(() => hidden() > 0.98)

  const customUpdate = (value: string, selected: boolean = on()) => {
    const prev = input().trim()
    const next = value.trim()

    setStore("custom", store.tab, value)
    if (!selected) return

    if (multi()) {
      setStore("answers", store.tab, (current = []) => {
        const removed = prev ? current.filter((item) => item.trim() !== prev) : current
        if (!next) return removed
        if (removed.some((item) => item.trim() === next)) return removed
        return [...removed, next]
      })
      return
    }

    setStore("answers", store.tab, next ? [next] : [])
  }

  const measure = () => {
    if (!root) return

    const scroller = document.querySelector(".scroll-view__viewport")
    const head = scroller instanceof HTMLElement ? scroller.firstElementChild : undefined
    const top =
      head instanceof HTMLElement && head.classList.contains("sticky") ? head.getBoundingClientRect().bottom : 0
    if (!top) {
      root.style.removeProperty("--question-prompt-max-height")
      return
    }

    const dock = root.closest('[data-component="session-composer-dock"]')
    if (!(dock instanceof HTMLElement)) return

    const dockBottom = dock.getBoundingClientRect().bottom
    const below = Math.max(0, dockBottom - root.getBoundingClientRect().bottom)
    const gap = 8
    const max = Math.max(240, Math.floor(dockBottom - top - gap - below))
    root.style.setProperty("--question-prompt-max-height", `${max}px`)
  }

  const clamp = (i: number) => Math.max(0, Math.min(count() - 1, i))

  const pickFocus = (tab: number = store.tab) => {
    const list = questions()[tab]?.options ?? []
    if (store.customOn[tab] === true) return list.length
    return Math.max(
      0,
      list.findIndex((item) => store.answers[tab]?.includes(item.value) ?? false),
    )
  }

  const focus = (i: number) => {
    const next = clamp(i)
    setStore("focus", next)
    if (store.editing) return
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined
      const el = next === options().length ? customRef : optsRef[next]
      el?.focus()
    })
  }

  onMount(() => {
    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        measure()
      })
    }

    update()

    makeEventListener(window, "resize", update)

    const dock = root?.closest('[data-component="session-composer-dock"]')
    const scroller = document.querySelector(".scroll-view__viewport")
    createResizeObserver([dock, scroller], update)

    onCleanup(() => {
      if (raf !== undefined) cancelAnimationFrame(raf)
    })

    focus(pickFocus())
  })

  createEffect(() => {
    const el = optionsRef
    if (!el) return
    const update = () => setStore("optionsHeight", (height) => Math.max(height, el.scrollHeight))
    update()
    createResizeObserver(el, update)
  })

  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    if (replied) return
    cache.set(cacheKey, {
      tab: store.tab,
      answers: store.answers.map((a) => (a ? [...a] : [])),
      custom: store.custom.map((s) => s ?? ""),
      customOn: store.customOn.map((b) => b ?? false),
    })
  })

  const fail = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    showToast({ title: language.t("common.requestFailed"), description: message })
  }

  const replyMutation = useMutation(() => ({
    mutationFn: (answer: FormAnswer) =>
      serverSDK.api.form.reply({ sessionID: props.request.sessionID, formID: props.request.id, answer }),
    onMutate: () => {
      props.onSubmit()
    },
    onSuccess: () => {
      replied = true
      cache.delete(cacheKey)
    },
    onError: fail,
  }))

  const rejectMutation = useMutation(() => ({
    mutationFn: () => serverSDK.api.form.cancel({ sessionID: props.request.sessionID, formID: props.request.id }),
    onMutate: () => {
      props.onSubmit()
    },
    onSuccess: () => {
      replied = true
      cache.delete(cacheKey)
    },
    onError: fail,
  }))

  const sending = createMemo(() => replyMutation.isPending || rejectMutation.isPending)

  const reply = (answer: FormAnswer) => {
    if (sending()) return
    replyMutation.mutate(answer)
  }

  const reject = () => {
    if (sending()) return
    rejectMutation.mutate()
  }

  const submit = () =>
    reply(
      Object.fromEntries(
        questions().flatMap((question, index) => {
          const answers = store.answers[index] ?? []
          if (answers.length === 0) return []
          return [[question.field.key, question.multiple ? answers : answers[0]]]
        }),
      ),
    )

  const answered = (i: number) => {
    if ((store.answers[i]?.length ?? 0) > 0) return true
    return store.customOn[i] === true && (store.custom[i] ?? "").trim().length > 0
  }

  const picked = (answer: string) => store.answers[store.tab]?.includes(answer) ?? false

  const pick = (answer: string, custom: boolean = false) => {
    setStore("answers", store.tab, [answer])
    if (custom) setStore("custom", store.tab, answer)
    if (!custom) setStore("customOn", store.tab, false)
    setStore("editing", false)
  }

  const toggle = (answer: string) => {
    setStore("answers", store.tab, (current = []) => {
      if (current.includes(answer)) return current.filter((item) => item !== answer)
      return [...current, answer]
    })
  }

  const customToggle = () => {
    if (sending()) return
    setStore("focus", options().length)

    if (!multi()) {
      setStore("customOn", store.tab, true)
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const next = !on()
    setStore("customOn", store.tab, next)
    if (next) {
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const value = input().trim()
    if (value) setStore("answers", store.tab, (current = []) => current.filter((item) => item.trim() !== value))
    setStore("editing", false)
    focus(options().length)
  }

  const customOpen = () => {
    if (sending()) return
    setStore("focus", options().length)
    if (!on()) setStore("customOn", store.tab, true)
    setStore("editing", true)
    customUpdate(input(), true)
  }

  const move = (step: number) => {
    if (store.editing || sending()) return
    focus(store.focus + step)
  }

  const nav = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return

    if (event.key === "Escape") {
      event.preventDefault()
      reject()
      return
    }

    const mod = (event.metaKey || event.ctrlKey) && !event.altKey
    if (mod && event.key === "Enter") {
      if (event.repeat) return
      event.preventDefault()
      next()
      return
    }

    const target =
      event.target instanceof HTMLElement ? event.target.closest('[data-slot="question-options"]') : undefined
    if (store.editing) return
    if (!(target instanceof HTMLElement)) return
    if (event.altKey || event.ctrlKey || event.metaKey) return

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault()
      move(1)
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault()
      move(-1)
      return
    }

    if (event.key === "Home") {
      event.preventDefault()
      focus(0)
      return
    }

    if (event.key !== "End") return
    event.preventDefault()
    focus(count() - 1)
  }

  const selectOption = (optIndex: number) => {
    if (sending()) return

    if (optIndex === options().length) {
      customOpen()
      return
    }

    const opt = options()[optIndex]
    if (!opt) return
    if (multi()) {
      setStore("editing", false)
      toggle(opt.value)
      return
    }
    pick(opt.value)
  }

  const commitCustom = () => {
    setStore("editing", false)
    customUpdate(input())
    focus(options().length)
  }

  const resizeInput = (el: HTMLTextAreaElement) => {
    el.style.height = "0px"
    el.style.height = `${el.scrollHeight}px`
  }

  const focusCustom = (el: HTMLTextAreaElement) => {
    setTimeout(() => {
      el.focus()
      resizeInput(el)
    }, 0)
  }

  const toggleCustomMark = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    customToggle()
  }

  const next = () => {
    if (sending()) return
    if (store.editing) commitCustom()

    if (store.tab >= total() - 1) {
      submit()
      return
    }

    const tab = store.tab + 1
    setStore("tab", tab)
    setStore("editing", false)
    if (!store.minimized) focus(pickFocus(tab))
  }

  const back = () => {
    if (sending()) return
    if (store.tab <= 0) return
    const tab = store.tab - 1
    setStore("tab", tab)
    setStore("editing", false)
    if (!store.minimized) focus(pickFocus(tab))
  }

  const jump = (tab: number) => {
    if (sending()) return
    setStore("tab", tab)
    setStore("editing", false)
    if (!store.minimized) focus(pickFocus(tab))
  }

  const minimize = () => {
    if (sending()) return
    setStore("editing", false)
    setStore("minimized", true)
  }

  const restore = () => {
    if (sending()) return
    setStore("minimized", false)
    focus(pickFocus())
  }

  return (
    <div data-component="session-question-dock">
      <DockPrompt
        kind="question"
        ref={(el) => (root = el)}
        onKeyDown={nav}
        header={
          <>
            <div data-slot="question-header-title">{summary()}</div>
            <div data-slot="question-header-actions">
              <Show when={total() > 1}>
                <div data-slot="question-progress">
                  <For each={questions()}>
                    {(_, i) => (
                      <button
                        type="button"
                        data-slot="question-progress-segment"
                        data-active={i() === store.tab}
                        data-answered={answered(i())}
                        disabled={sending()}
                        onClick={() => jump(i())}
                        aria-label={language.t("ui.tool.questions.numbered", { number: i() + 1 })}
                      />
                    )}
                  </For>
                </div>
              </Show>
              <IconButton
                icon={<Icon name="chevron-down" size="small" />}
                variant="ghost"
                disabled={sending()}
                style={{ transform: `rotate(${hidden() * 180}deg)` }}
                onClick={store.minimized ? restore : minimize}
                aria-label={language.t(store.minimized ? "session.question.restore" : "session.question.minimize")}
              />
            </div>
          </>
        }
        footer={
          <>
            <Button variant="ghost" size="large" disabled={sending()} onClick={reject} aria-keyshortcuts="Escape">
              {language.t("ui.common.dismiss")}
            </Button>
            <div data-slot="question-footer-actions">
              <Show when={store.tab > 0}>
                <Button variant="neutral" size="large" disabled={sending()} onClick={back}>
                  {language.t("ui.common.back")}
                </Button>
              </Show>
              <Button
                variant={last() ? "submit" : "neutral"}
                size="large"
                disabled={sending()}
                onClick={next}
                aria-keyshortcuts="Meta+Enter Control+Enter"
              >
                {last() ? language.t("ui.common.submit") : language.t("ui.common.next")}
              </Button>
            </div>
          </>
        }
      >
        <div
          data-slot="question-text"
          style={{
            display: store.minimized ? "-webkit-box" : undefined,
            "-webkit-line-clamp": store.minimized ? "3" : undefined,
            "-webkit-box-orient": store.minimized ? "vertical" : undefined,
            overflow: store.minimized ? "hidden" : undefined,
          }}
        >
          {question()?.question}
        </div>
        <Show when={!store.minimized}>
          <Show when={multi()} fallback={<div data-slot="question-hint">{language.t("ui.question.singleHint")}</div>}>
            <div data-slot="question-hint">{language.t("ui.question.multiHint")}</div>
          </Show>
        </Show>
        <div
          ref={(el) => (optionsRef = el)}
          data-slot="question-options"
          aria-hidden={store.minimized || optionsOff() ? "true" : undefined}
          classList={{ "pointer-events-none": hidden() > 0.1 }}
          style={{
            "max-height": `${Math.max(0, store.optionsHeight * (1 - hidden()))}px`,
            opacity: `${Math.max(0, Math.min(1, 1 - hidden()))}`,
            visibility: optionsOff() ? "hidden" : "visible",
          }}
        >
          <For each={options()}>
            {(opt, i) => (
              <Option
                multi={multi()}
                picked={picked(opt.value)}
                label={opt.label}
                description={opt.description}
                disabled={sending()}
                ref={(el) => (optsRef[i()] = el)}
                onFocus={() => setStore("focus", i())}
                onClick={() => selectOption(i())}
              />
            )}
          </For>

          <Show
            when={store.editing}
            fallback={
              <button
                type="button"
                ref={customRef}
                data-slot="question-option"
                data-custom="true"
                data-picked={on()}
                role={multi() ? "checkbox" : "radio"}
                aria-checked={on()}
                disabled={sending()}
                onFocus={() => setStore("focus", options().length)}
                onClick={customOpen}
              >
                <Mark multi={multi()} picked={on()} onClick={toggleCustomMark} />
                <span data-slot="question-option-main">
                  <span data-slot="option-label">{customLabel()}</span>
                  <span data-slot="option-description" dir="auto">
                    {input() || customPlaceholder()}
                  </span>
                </span>
              </button>
            }
          >
            <form
              data-slot="question-option"
              data-custom="true"
              data-picked={on()}
              role={multi() ? "checkbox" : "radio"}
              aria-checked={on()}
              onMouseDown={(e) => {
                if (sending()) {
                  e.preventDefault()
                  return
                }
                if (e.target instanceof HTMLTextAreaElement) return
                const input = e.currentTarget.querySelector('[data-slot="question-custom-input"]')
                if (input instanceof HTMLTextAreaElement) input.focus()
              }}
              onSubmit={(e) => {
                e.preventDefault()
                commitCustom()
              }}
            >
              <Mark multi={multi()} picked={on()} onClick={toggleCustomMark} />
              <span data-slot="question-option-main">
                <span data-slot="option-label">{customLabel()}</span>
                <textarea
                  ref={focusCustom}
                  data-slot="question-custom-input"
                  dir="auto"
                  placeholder={customPlaceholder()}
                  value={input()}
                  rows={1}
                  disabled={sending()}
                  style={{ "unicode-bidi": "plaintext", "text-align": "start" }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault()
                      setStore("editing", false)
                      focus(options().length)
                      return
                    }
                    if ((e.metaKey || e.ctrlKey) && !e.altKey) return
                    if (e.key !== "Enter" || e.shiftKey) return
                    e.preventDefault()
                    commitCustom()
                  }}
                  onInput={(e) => {
                    customUpdate(e.currentTarget.value)
                    resizeInput(e.currentTarget)
                  }}
                />
              </span>
            </form>
          </Show>
        </div>
      </DockPrompt>
    </div>
  )
}
