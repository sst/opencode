import { createEffect, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLanguage } from "@/runtime/i18n/language"

export function SettingsSearchEmpty(props: { query: string }) {
  const language = useLanguage()
  const [state, setState] = createStore({ query: props.query })
  let quoted: HTMLSpanElement | undefined
  let measure: HTMLSpanElement | undefined
  const text = (query: string) => language.t("settings.search.empty.query", { query })
  const update = () => {
    if (!quoted || !measure) return
    const width = quoted.getBoundingClientRect().width
    const fits = (query: string) => {
      measure!.textContent = text(query)
      return measure!.getBoundingClientRect().width <= width
    }
    if (fits(props.query)) {
      setState("query", props.query)
      return
    }

    const characters = Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(props.query),
      (item) => item.segment,
    )
    let start = 0
    let end = characters.length
    while (start < end) {
      const middle = Math.ceil((start + end) / 2)
      if (fits(`${characters.slice(0, middle).join("").trimEnd()}…`)) {
        start = middle
        continue
      }
      end = middle - 1
    }
    setState("query", `${characters.slice(0, start).join("").trimEnd()}…`)
  }

  createEffect(update)
  onMount(() => {
    if (!quoted || !measure) return
    // The measuring text also observes font changes that do not resize the available space.
    createResizeObserver([quoted, measure], update)
  })

  return (
    <>
      <div
        class="settings-search-empty"
        role="status"
        aria-label={language.t("settings.search.empty", { query: text(props.query) })}
      >
        {language.rich("settings.search.empty", {
          query: (
            <span ref={quoted} class="settings-search-empty-quoted">
              <bdi dir="auto">{text(state.query)}</bdi>
            </span>
          ),
        })}
      </div>
      <span class="settings-search-empty-measure" aria-hidden="true">
        <span ref={measure} dir="auto" />
      </span>
    </>
  )
}
