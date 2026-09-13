import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { For, Show } from "solid-js"
import { catalogSlug, formatCatalogLabName, type ModelCatalogEntry } from "./model-catalog"

export type ComparisonModelRef = {
  name: string
  lab: string
  slug: string
  labName?: string
  metric?: string
}

export type ComparisonPair = {
  first: ComparisonModelRef
  second: ComparisonModelRef
  detail: string
  description?: string
}

export function modelRefFromCatalog(entry: Pick<ModelCatalogEntry, "name" | "lab" | "slug">): ComparisonModelRef {
  return {
    name: entry.name,
    lab: entry.lab,
    slug: entry.slug,
    labName: formatCatalogLabName(entry.lab),
  }
}

export function comparisonHref(first: ComparisonModelRef, second: ComparisonModelRef) {
  return `${import.meta.env.BASE_URL}compare/${catalogSlug(first.lab)}/${catalogSlug(first.slug)}/${catalogSlug(
    second.lab,
  )}/${catalogSlug(second.slug)}`
}

export function canonicalComparisonHref(first: ComparisonModelRef, second: ComparisonModelRef) {
  const models = [first, second].toSorted((a, b) => modelKey(a).localeCompare(modelKey(b)))
  return comparisonHref(models[0], models[1])
}

export function uniqueComparisonPairs(pairs: ComparisonPair[]) {
  return pairs.reduce<{ keys: Set<string>; pairs: ComparisonPair[] }>(
    (result, pair) => {
      const key = [modelKey(pair.first), modelKey(pair.second)].toSorted().join("|")
      if (result.keys.has(key) || modelKey(pair.first) === modelKey(pair.second)) return result
      result.keys.add(key)
      result.pairs.push(pair)
      return result
    },
    { keys: new Set(), pairs: [] },
  ).pairs
}

export function ComparisonCardsSection(props: {
  pairs: ComparisonPair[]
  title?: string
  description?: string
  compact?: boolean
  variant?: "panel" | "featured"
}) {
  const featured = () => props.variant === "featured"
  const pairs = () => (featured() ? props.pairs.slice(0, 4) : props.pairs)

  return (
    <Show when={props.pairs.length > 0}>
      <section
        id="model-comparison"
        data-section={featured() ? "compare-home-related" : "model-panel"}
        data-variant={!featured() && props.compact ? "compact" : undefined}
      >
        <p data-slot="section-title">
          <strong>{props.title ?? "Model Comparisons"}.</strong>{" "}
          <span>{props.description ?? "Compare usage, cost, limits, and features."}</span>
        </p>
        <div data-component={featured() ? "compare-home-card-grid" : "comparison-card-grid"}>
          <For each={pairs()}>
            {(pair) => (featured() ? <FeaturedComparisonCard pair={pair} /> : <ComparisonPanelCard pair={pair} />)}
          </For>
        </div>
      </section>
    </Show>
  )
}

function FeaturedComparisonCard(props: { pair: ComparisonPair }) {
  return (
    <a data-component="compare-home-card" href={canonicalComparisonHref(props.pair.first, props.pair.second)}>
      <span data-slot="compare-home-card-head">
        <span>
          <strong>{props.pair.detail}</strong>
          <em>{props.pair.description ?? `${props.pair.first.name} vs ${props.pair.second.name}`}</em>
        </span>
        <ComparisonCardIcon />
      </span>
      <span data-slot="compare-home-card-divider" aria-hidden="true" />
      <span data-slot="compare-home-card-models">
        <span>{props.pair.first.name}</span>
        <i aria-hidden="true">·</i>
        <span>{props.pair.second.name}</span>
      </span>
      <span data-slot="compare-home-card-avatars" aria-hidden="true">
        <ComparisonLabLogo model={props.pair.first} />
        <ComparisonLabLogo model={props.pair.second} />
      </span>
    </a>
  )
}

function ComparisonCardIcon() {
  return (
    <b aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M12.9509 12.9884L14.4069 14.4444M2.44431 2.44434H6.44431V6.44434H2.44431V2.44434ZM2.44431 9.55542H6.44431V13.5554H2.44431V9.55542ZM9.55539 2.44434H13.5554V6.44434H9.55539V2.44434ZM13.5554 11.5554C13.5554 12.66 12.66 13.5554 11.5554 13.5554C10.4508 13.5554 9.55539 12.66 9.55539 11.5554C9.55539 10.4509 10.4508 9.55542 11.5554 9.55542C12.66 9.55542 13.5554 10.4509 13.5554 11.5554Z"
          stroke="#808080"
        />
      </svg>
    </b>
  )
}

function ComparisonPanelCard(props: { pair: ComparisonPair }) {
  const firstLabName = () => props.pair.first.labName
  const secondLabName = () => props.pair.second.labName

  return (
    <a data-component="comparison-card" href={canonicalComparisonHref(props.pair.first, props.pair.second)}>
      <span>{props.pair.detail}</span>
      <strong>
        {props.pair.first.name} <em>vs</em> {props.pair.second.name}
      </strong>
      <Show when={firstLabName() || secondLabName()}>
        <p>
          <Show when={firstLabName()}>{(name) => <b>{name()}</b>}</Show>
          <Show when={firstLabName() && secondLabName()}>
            <i />
          </Show>
          <Show when={secondLabName()}>{(name) => <b>{name()}</b>}</Show>
        </p>
      </Show>
      <Show when={props.pair.first.metric || props.pair.second.metric}>
        <small>
          {props.pair.first.metric ?? "Listed"} / {props.pair.second.metric ?? "Listed"}
        </small>
      </Show>
    </a>
  )
}

function ComparisonLabLogo(props: { model: ComparisonModelRef }) {
  const iconId = () => providerIconId(props.model.lab)

  return (
    <Show when={props.model.labName}>
      <span data-slot="compare-home-avatar" data-lab={iconId()} data-size="small" aria-label={props.model.labName}>
        <ProviderIcon aria-hidden="true" id={iconId()} />
      </span>
    </Show>
  )
}

function modelKey(model: ComparisonModelRef) {
  return `${catalogSlug(model.lab)}/${catalogSlug(model.slug)}`
}

function providerIconId(provider: string) {
  const id = provider.toLowerCase().replace(/[^a-z0-9]+/g, "")
  if (id === "moonshot") return "moonshotai"
  if (id === "zhipu") return "zhipuai"
  return id
}
