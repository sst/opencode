import "./limits-graph.css"
import { For, Show, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"
import { goModels } from "./go-models"

// Compress the request range, with the same domain in both views.
const max = Math.max(...goModels.map((model) => model.requests))
const position = (requests: number) =>
  4 + Math.pow(Math.log10(Math.max(requests / 100, 1)) / Math.log10(max / 100), 2.2) * 96
const ticks = [100, 1000, 10000, 40000]

export function LimitsGraph(props: { href: string }) {
  const i18n = useI18n()
  const language = useLanguage()
  const id = createUniqueId()
  const [expanded, setExpanded] = createSignal(false)
  const [visible, setVisible] = createSignal(false)
  const models = createMemo(() => goModels.filter((model) => expanded() || model.featured || model.fresh))
  const format = createMemo(() => new Intl.NumberFormat(language.tag(language.locale())))
  const compact = createMemo(
    () => new Intl.NumberFormat(language.tag(language.locale()), { notation: "compact", maximumFractionDigits: 1 }),
  )
  const currency = createMemo(
    () =>
      new Intl.NumberFormat(language.tag(language.locale()), {
        style: "currency",
        currency: "USD",
        currencyDisplay: "narrowSymbol",
        maximumFractionDigits: 0,
      }),
  )
  let root!: HTMLElement

  onMount(() => {
    if (!window.IntersectionObserver) return setVisible(true)
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setVisible(true)
        observer.disconnect()
      },
      { threshold: 0.1 },
    )
    observer.observe(root)
    onCleanup(() => observer.disconnect())
  })

  return (
    <figure
      ref={root}
      id="usage"
      dir={language.dir(language.locale())}
      data-component="go-usage"
      data-visible={visible() ? "" : undefined}
      aria-labelledby={`${id}-title`}
    >
      <div data-slot="heading">
        <h2 id={`${id}-title`}>{i18n.t("go.graph.period")}</h2>
      </div>

      <div role="table" aria-labelledby={`${id}-title`} id={`${id}-models`}>
        <div role="row" data-slot="columns">
          <div role="columnheader" data-slot="model-heading">
            {i18n.t("go.graph.model")}
          </div>
          <div role="columnheader" data-slot="requests-heading">
            {i18n.t("go.graph.requests")}
          </div>
          <div role="columnheader" data-slot="allowance-heading">
            {i18n.t("go.graph.allowance")}
          </div>
        </div>
        <div role="rowgroup" data-slot="rows">
          <For each={models()}>
            {(model, index) => (
              <div role="row" data-slot="model-row" data-model={model.id} style={{ "--delay": `${index() * 30}ms` }}>
                <div role="rowheader" data-slot="model">
                  <bdi>{model.name}</bdi>
                  <Show when={model.fresh}>
                    <span data-slot="badge">{i18n.t("go.graph.new")}</span>
                  </Show>
                  <Show when={model.bonus}>
                    <span data-slot="badge">{i18n.t("go.graph.bonus", { count: model.bonus! })}</span>
                  </Show>
                  <Show when={model.regions}>
                    <a
                      data-slot="region"
                      href="https://ai.developer.meta.com/legal/geographic-use-policy"
                      aria-label={`${model.name}: ${i18n.t("go.graph.limitedRegions")}`}
                      title={i18n.t("go.graph.limitedRegions")}
                    >
                      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
                        <circle cx="8" cy="8" r="6" stroke="currentColor" />
                        <ellipse cx="8" cy="8" rx="2.5" ry="6" stroke="currentColor" />
                        <path d="M2 8h12" stroke="currentColor" />
                      </svg>
                    </a>
                  </Show>
                </div>
                <div role="cell" data-slot="usage-value">
                  <div data-slot="track" aria-hidden="true">
                    <For each={ticks}>
                      {(tick) => <span data-slot="gridline" style={{ "--position": `${position(tick)}%` }} />}
                    </For>
                    <div data-slot="bar" style={{ "--width": `${position(model.requests)}%` }} />
                  </div>
                  <div data-slot="requests">
                    <Show when={model.baseRequests}>
                      <s>{format().format(model.baseRequests!)}</s>{" "}
                    </Show>
                    <bdi>{format().format(model.requests)}</bdi>
                  </div>
                </div>
                <div role="cell" data-slot="allowance" data-high={model.allowance >= 60 ? "" : undefined}>
                  <Show when={model.baseAllowance}>
                    <s>{currency().format(model.baseAllowance!)}</s>{" "}
                  </Show>
                  <bdi>
                    <For each={currency().formatToParts(model.allowance)}>
                      {(part) => (
                        <span data-slot={part.type === "currency" ? "currency" : undefined}>{part.value}</span>
                      )}
                    </For>
                  </bdi>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>

      <div data-slot="axis" aria-hidden="true" title={i18n.t("go.graph.scale")}>
        <div data-slot="ticks">
          <For each={ticks}>
            {(tick) => <span style={{ "--position": `${position(tick)}%` }}>{compact().format(tick)}</span>}
          </For>
        </div>
      </div>

      <figcaption>
        <button
          type="button"
          data-slot="expand"
          aria-expanded={expanded()}
          aria-controls={`${id}-models`}
          onClick={() => {
            if (expanded()) {
              const top = root.getBoundingClientRect().top
              if (top < 80) window.scrollTo({ top: window.scrollY + top - 96, behavior: "instant" })
            }
            setExpanded(!expanded())
          }}
        >
          {expanded()
            ? i18n.t("go.graph.showLess")
            : i18n.t("go.graph.showAll", { count: format().format(goModels.length) })}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.25" />
          </svg>
        </button>
        <a href={props.href}>{i18n.t("go.graph.usageLimits")}</a>
      </figcaption>
    </figure>
  )
}
