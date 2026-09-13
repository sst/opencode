import { Link, Meta, Title } from "@solidjs/meta"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import {
  getStatsModelsComparisonData,
  type ModelUsagePoint,
  type RetentionEntry,
  type StatsModelComparisonInput,
  type StatsModelComparisonEntry,
} from "@opencode-ai/stats-core/domain/home"
import { createAsync, query, useParams, useSearchParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { getRequestEvent } from "solid-js/web"
import {
  ComparisonCardsSection,
  comparisonHref,
  modelRefFromCatalog,
  uniqueComparisonPairs,
  type ComparisonModelRef,
  type ComparisonPair,
} from "../routes/compare-cards"
import { ComparisonRadar } from "../routes/compare-radar"
import {
  catalogSlug,
  findModelCatalogEntry,
  formatCatalogLabName,
  getModelCatalog,
  isKnownCatalogLab,
  isProviderlessLab,
  type ModelCatalog,
  type ModelCatalogEntry,
} from "../routes/model-catalog"
import {
  applyThemePreference,
  Footer,
  getGitHubStars,
  githubLink,
  Header,
  isThemePreference,
  themeStorageKey,
  type HeaderLink,
  type ThemePreference,
} from "../routes/stats-shell"
import {
  canonicalFamilyComparisonPath,
  canonicalModelComparisonPath,
  latestFamilyComparisonPath,
  type ResolvedComparisonFamily,
} from "../lib/comparison-pages"
import { baseUrl } from "../lib/language"
import { runStatsEffect } from "../stats-runtime"

const compareHeaderLinks: readonly HeaderLink[] = [
  { href: `${import.meta.env.BASE_URL}#top-models`, label: "Top Models" },
  { href: `${import.meta.env.BASE_URL}#leaderboard`, label: "Leaderboard" },
  { href: `${import.meta.env.BASE_URL}#market-share`, label: "Market Share" },
  { href: `${import.meta.env.BASE_URL}#token-cost`, label: "Token Cost" },
  { href: `${import.meta.env.BASE_URL}#session-cost`, label: "Session Cost" },
]
const compareFooterLinks: readonly HeaderLink[] = [
  { href: import.meta.env.BASE_URL, label: "Data Home" },
  { href: `${import.meta.env.BASE_URL}compare`, label: "Model Compare" },
  { href: `${import.meta.env.BASE_URL}#top-models`, label: "Top Models" },
  { href: `${import.meta.env.BASE_URL}#token-cost`, label: "Token Cost" },
]
const heroLabs = [
  { lab: "deepseek", label: "DeepSeek" },
  { lab: "openai", label: "OpenAI" },
  { lab: "anthropic", label: "Anthropic" },
] as const
const usageBarLimit = 60
const comparisonModelLimit = 6

type ComparisonModel = {
  name: string
  lab: string
  labName?: string
  slug: string
  catalog: ModelCatalogEntry | null
  stats: StatsModelComparisonEntry | null
}
type ComparisonDirection = "higher" | "lower"
type ComparisonDetailCell = {
  value: string
  unit?: string
  href?: string
  kind?: "boolean"
  score?: number
  trend?: number
}
type ComparisonDetailRow = {
  label: string
  direction?: ComparisonDirection
  cells: ComparisonDetailCell[]
}
type ComparisonDetailSection = {
  title: string
  badge?: string
  rows: ComparisonDetailRow[]
  usage?: ModelUsagePoint[][]
}
type ComparisonModelRequest = {
  lab: string
  slug: string
}

export type ModelCompareDetailPageProps = {
  first?: { lab: string; slug: string }
  second?: { lab: string; slug: string }
  family?: { first: ResolvedComparisonFamily; second: ResolvedComparisonFamily }
  catalog?: ModelCatalog
}

const getComparisonData = query(async (models: StatsModelComparisonInput[]) => {
  "use server"
  return runStatsEffect(getStatsModelsComparisonData(models))
}, "getStatsModelComparisonDetailData")

export default function ModelCompareDetailPage(props: ModelCompareDetailPageProps = {}) {
  const event = getRequestEvent()
  event?.response.headers.set("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=86400")
  const params = useParams()
  const [searchParams] = useSearchParams<{ add?: string }>()
  const firstLabParam = createMemo(() => props.first?.lab ?? params.firstLab ?? "")
  const firstModelParam = createMemo(() => props.first?.slug ?? params.firstModel ?? "")
  const secondLabParam = createMemo(() => props.second?.lab ?? params.secondLab ?? "")
  const secondModelParam = createMemo(() => props.second?.slug ?? params.secondModel ?? "")
  const catalogData = createAsync(() => getModelCatalog())
  const catalog = createMemo(() => props.catalog ?? catalogData())
  const firstCatalog = createMemo(() => resolvedCatalogEntry(catalog(), firstLabParam(), firstModelParam()))
  const secondCatalog = createMemo(() => resolvedCatalogEntry(catalog(), secondLabParam(), secondModelParam()))
  const modelRequests = createMemo(() => {
    const selected: ComparisonModelRequest[] = [
      { lab: firstLabParam(), slug: firstModelParam() },
      { lab: secondLabParam(), slug: secondModelParam() },
      ...parseAdditionalModels(searchParams.add),
    ]
    return selected
      .filter(
        (model, index) =>
          index < 2 ||
          selected.findIndex(
            (candidate) => comparisonModelRequestKey(candidate) === comparisonModelRequestKey(model),
          ) === index,
      )
      .slice(0, comparisonModelLimit)
  })
  const modelSelections = createMemo(() =>
    modelRequests().map((model) => ({
      ...model,
      catalog: resolvedCatalogEntry(catalog(), model.lab, model.slug),
    })),
  )
  const stats = createAsync(() =>
    getComparisonData(modelRequests().map((model) => ({ provider: model.lab, model: model.slug }))),
  )
  const githubStars = createAsync(() => getGitHubStars())
  const [themePreference, setThemePreference] = createSignal<ThemePreference>("system")
  const [highlightBest, setHighlightBest] = createSignal(true)
  const [addingModel, setAddingModel] = createSignal(false)
  let comparisonHeadingScroll: HTMLDivElement | undefined
  let comparisonBodyScroll: HTMLDivElement | undefined
  const models = createMemo(() =>
    modelSelections().map((model, index) =>
      buildComparisonModel(
        model.lab,
        model.slug,
        model.catalog ?? null,
        stats()?.models[index] ?? null,
        catalog()?.labs.map((lab) => lab.id) ?? [],
      ),
    ),
  )
  const title = createMemo(() => `${models()[0].name} vs ${models()[1].name} - AI Model Comparison`)
  const description = createMemo(
    () =>
      `Compare ${comparisonModelLabel(models()[0])} and ${comparisonModelLabel(models()[1])} on key metrics including benchmarks, price, context length, usage, and model features.`,
  )
  const canonicalPath = createMemo(() => {
    if (props.family) return canonicalFamilyComparisonPath(props.family.first, props.family.second)
    const first = firstCatalog()
    const second = secondCatalog()
    const source = catalog()
    if (source && first && second)
      return latestFamilyComparisonPath(source, first, second) ?? canonicalModelComparisonPath(first, second)
    return canonicalModelComparisonPath(comparisonCatalogEntry(models()[0]), comparisonCatalogEntry(models()[1]))
  })
  const canonicalUrl = createMemo(() => new URL(canonicalPath(), baseUrl).toString())
  const detailSections = createMemo(() => buildComparisonDetailSections(models()))
  const relatedPairs = createMemo(() => buildRelatedPairs(catalog(), models()[0], models()[1]))
  const selectorModels = createMemo(() =>
    uniqueCatalogModels([...models().map(comparisonCatalogEntry), ...(catalog()?.models ?? [])]),
  )
  const selectedCatalogModels = createMemo(() => models().map(comparisonCatalogEntry))
  const canAddModel = createMemo(
    () =>
      models().length < comparisonModelLimit &&
      selectorModels().some((model) => !selectedCatalogModels().some((selected) => selected.id === model.id)),
  )
  const navigateToModels = (next: ModelCatalogEntry[]) => {
    if (typeof window === "undefined" || next.length < 2) return
    window.location.href = comparisonModelsHref(next)
  }
  const syncComparisonScroll = (source: HTMLDivElement, target: HTMLDivElement | undefined) => {
    if (target && target.scrollLeft !== source.scrollLeft) target.scrollLeft = source.scrollLeft
  }
  const structuredData = createMemo(() =>
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: title(),
      description: description(),
      url: canonicalUrl(),
      about: models().map((model) => ({
        "@type": "SoftwareApplication",
        name: model.name,
        applicationCategory: "AI model",
        ...(model.labName ? { provider: model.labName } : {}),
      })),
    }),
  )
  const updateThemePreference = (preference: ThemePreference) => {
    applyThemePreference(preference)
    setThemePreference(preference)
    if (typeof window === "undefined") return
    window.localStorage.setItem(themeStorageKey, preference)
  }

  onMount(() => {
    if (typeof window === "undefined") return
    const preference = window.localStorage.getItem(themeStorageKey)
    const nextPreference = isThemePreference(preference) ? preference : "system"
    applyThemePreference(nextPreference)
    setThemePreference(nextPreference)
  })

  return (
    <main data-page="stats" data-layout="compare-detail" data-theme={themePreference()}>
      <Show when={catalog() !== undefined}>
        <Title>{title()}</Title>
        <Meta name="description" content={description()} />
        <Meta name="robots" content={models().length > 2 ? "noindex,follow" : "index,follow"} />
        <Link rel="canonical" href={canonicalUrl()} />
        <Meta property="og:type" content="website" />
        <Meta property="og:site_name" content="OpenCode" />
        <Meta property="og:title" content={title()} />
        <Meta property="og:description" content={description()} />
        <Meta property="og:url" content={canonicalUrl()} />
        <Meta name="twitter:card" content="summary" />
        <Meta name="twitter:title" content={title()} />
        <Meta name="twitter:description" content={description()} />
        <script type="application/ld+json">{structuredData()}</script>
      </Show>
      <Header
        githubStars={githubStars() ?? githubLink.fallbackStars}
        links={compareHeaderLinks}
        brandHref={import.meta.env.BASE_URL}
      />
      <div data-component="container">
        <div data-component="content">
          <ComparisonHero
            canAddModel={canAddModel()}
            highlightBest={highlightBest()}
            models={models()}
            onAddModel={() => setAddingModel(true)}
            onHighlightBestChange={() => setHighlightBest(!highlightBest())}
          />
          <Show when={addingModel()}>
            <CompareModelSelectModal
              blockedIds={selectedCatalogModels().map((model) => model.id)}
              label="Add model"
              models={selectorModels()}
              onClose={() => setAddingModel(false)}
              onSelect={(model) => {
                setAddingModel(false)
                navigateToModels([...selectedCatalogModels(), model])
              }}
            />
          </Show>
          <div
            data-component="compare-detail-comparison"
            data-model-count={models().length}
            style={`--compare-detail-grid: ${comparisonDetailGridTemplate(models().length)}`}
          >
            <div
              data-component="compare-detail-heading-scroll"
              ref={(element) => (comparisonHeadingScroll = element)}
              onScroll={(event) => syncComparisonScroll(event.currentTarget, comparisonBodyScroll)}
            >
              <ComparisonPairSelector catalogModels={selectorModels()} models={models()} />
            </div>
            <ComparisonRadar models={models()} catalogModels={catalog()?.models ?? []} />
            <div
              data-component="compare-detail-body-scroll"
              ref={(element) => (comparisonBodyScroll = element)}
              onScroll={(event) => syncComparisonScroll(event.currentTarget, comparisonHeadingScroll)}
            >
              <ComparisonDetailMatrix
                highlightBest={highlightBest()}
                modelCount={models().length}
                sections={detailSections()}
              />
            </div>
          </div>
          <ComparisonCardsSection
            pairs={relatedPairs()}
            title="Related comparisons"
            description="Other model pairs to check."
            variant="featured"
          />
        </div>
        <Footer
          themePreference={themePreference()}
          onThemePreferenceChange={updateThemePreference}
          links={compareFooterLinks}
          bridge={{ href: "#comparison", label: "MODEL COMPARISON" }}
        />
      </div>
    </main>
  )
}

function ComparisonHero(props: {
  models: readonly ComparisonModel[]
  canAddModel: boolean
  highlightBest: boolean
  onAddModel: () => void
  onHighlightBestChange: () => void
}) {
  return (
    <section id="overview" data-section="compare-detail-hero">
      <nav data-component="compare-home-breadcrumb" aria-label="Breadcrumb">
        <a data-slot="compare-home-crumb" href={import.meta.env.BASE_URL}>
          Data
        </a>
        <span data-slot="compare-home-separator">/</span>
        <a data-slot="compare-home-crumb" href={`${import.meta.env.BASE_URL}compare`}>
          Compare
        </a>
      </nav>
      <div data-slot="compare-detail-hero-grid">
        <h1 aria-label={`Compare ${props.models.map((model) => model.name).join(", ")}`}>
          <span>Compare</span>
          <HeroModelStack />
          <span>AI models</span>
        </h1>
        <div data-slot="compare-detail-actions">
          <button
            type="button"
            data-slot="compare-detail-action"
            data-active={props.highlightBest ? "true" : undefined}
            aria-pressed={props.highlightBest}
            onClick={props.onHighlightBestChange}
          >
            <span data-slot="compare-detail-highlight-icon" aria-hidden="true">
              <i />
              <i />
            </span>
            <span>Highlight best</span>
          </button>
          <button
            type="button"
            data-slot="compare-detail-action"
            disabled={!props.canAddModel}
            aria-haspopup="dialog"
            onClick={props.onAddModel}
          >
            <span data-slot="compare-home-plus" aria-hidden="true">
              +
            </span>
            <span>Add model</span>
          </button>
        </div>
      </div>
      <div data-slot="compare-home-pattern" aria-hidden="true" />
    </section>
  )
}

function HeroModelStack() {
  return (
    <span data-slot="compare-home-avatar-stack" aria-hidden="true">
      <For each={heroLabs}>
        {(lab) => (
          <span data-slot="compare-home-avatar-frame">
            <LabLogo lab={lab.lab} label={lab.label} size="large" />
          </span>
        )}
      </For>
    </span>
  )
}

function ComparisonPairSelector(props: { catalogModels: ModelCatalogEntry[]; models: readonly ComparisonModel[] }) {
  const [activeIndex, setActiveIndex] = createSignal<number>()
  const selectedModels = createMemo(() => props.models.map(comparisonCatalogEntry))
  const activeSelected = createMemo(() => {
    const index = activeIndex()
    if (index === undefined) return undefined
    return selectedModels()[index]
  })
  const blockedIds = createMemo(() =>
    selectedModels()
      .filter((_, index) => index !== activeIndex())
      .map((model) => model.id),
  )
  const navigateToSelection = (index: number, model: ModelCatalogEntry) => {
    if (typeof window === "undefined") return
    window.location.href = comparisonModelsHref(
      selectedModels().map((selected, selectedIndex) => (selectedIndex === index ? model : selected)),
    )
  }

  return (
    <section data-section="compare-detail-selector" aria-label="Selected models">
      <div data-component="compare-detail-selector-grid">
        <div data-slot="compare-detail-selector-spacer" aria-hidden="true" />
        <For each={props.models}>
          {(model, index) => (
            <CompareDetailSelectButton
              model={model}
              label={`Model ${index() + 1}`}
              column={index()}
              last={index() === props.models.length - 1}
              expanded={activeIndex() === index()}
              onOpen={() => setActiveIndex(index())}
            />
          )}
        </For>
      </div>
      <Show when={activeSelected()}>
        {(selected) => (
          <CompareModelSelectModal
            blockedIds={blockedIds()}
            label={`Choose model ${(activeIndex() ?? 0) + 1}`}
            models={props.catalogModels}
            selected={selected()}
            onClose={() => setActiveIndex(undefined)}
            onSelect={(model) => {
              const index = activeIndex()
              if (index === undefined) return
              setActiveIndex(undefined)
              navigateToSelection(index, model)
            }}
          />
        )}
      </Show>
    </section>
  )
}

function CompareDetailSelectButton(props: {
  model: ComparisonModel
  label: string
  column: number
  last: boolean
  expanded: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      data-slot="compare-detail-select-model"
      data-column={props.column}
      data-last={props.last ? "true" : undefined}
      aria-label={props.label}
      aria-haspopup="dialog"
      aria-expanded={props.expanded}
      onClick={props.onOpen}
    >
      <Show when={props.model.labName}>
        {(labName) => <LabLogo lab={props.model.lab} label={labName()} size="small" />}
      </Show>
      <span data-slot="compare-detail-select-name">{props.model.name}</span>
      <ChevronDownIcon />
    </button>
  )
}

function CompareModelSelectModal(props: {
  models: ModelCatalogEntry[]
  selected?: ModelCatalogEntry
  blockedIds: string[]
  label: string
  onClose: () => void
  onSelect: (model: ModelCatalogEntry) => void
}) {
  let searchInput: HTMLInputElement | undefined
  const [search, setSearch] = createSignal("")
  const [previewId, setPreviewId] = createSignal(props.selected?.id ?? "")
  const availableModels = createMemo(() =>
    uniqueCatalogModels([...(props.selected ? [props.selected] : []), ...props.models]).filter(
      (model) => !props.blockedIds.includes(model.id),
    ),
  )
  const filteredModels = createMemo(() => {
    const terms = search().trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return availableModels()
    return availableModels().filter((model) => terms.every((term) => modelSearchText(model).includes(term)))
  })
  const preview = createMemo(
    () => filteredModels().find((model) => model.id === previewId()) ?? filteredModels()[0] ?? availableModels()[0],
  )

  createEffect(() => {
    const models = filteredModels()
    if (models.some((model) => model.id === previewId())) return
    const selected =
      props.selected && models.some((model) => model.id === props.selected?.id) ? props.selected.id : undefined
    setPreviewId(selected ?? models[0]?.id ?? "")
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.requestAnimationFrame(() => searchInput?.focus())
  })

  return (
    <div
      data-component="compare-model-modal-scrim"
      role="presentation"
      onClick={props.onClose}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        props.onClose()
      }}
    >
      <div
        data-component="compare-model-modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        onClick={(event) => event.stopPropagation()}
      >
        <div data-slot="compare-model-modal-list">
          <label data-slot="compare-model-modal-search">
            <span data-slot="compare-model-modal-search-icon" aria-hidden="true" />
            <input
              ref={searchInput}
              value={search()}
              placeholder="Search models"
              aria-label="Search models"
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
          </label>
          <div data-slot="compare-model-modal-results">
            <Show
              when={filteredModels().length > 0}
              fallback={
                <div data-slot="compare-model-modal-empty">
                  <strong>No models found</strong>
                  <span>Try another search.</span>
                </div>
              }
            >
              <For each={filteredModels()}>
                {(model) => (
                  <button
                    type="button"
                    data-slot="compare-model-modal-row"
                    data-active={preview()?.id === model.id ? "true" : undefined}
                    onMouseMove={() => setPreviewId(model.id)}
                    onFocus={() => setPreviewId(model.id)}
                    onClick={() => props.onSelect(model)}
                  >
                    <span data-slot="compare-model-modal-row-main">
                      <ModelAvatar model={model} size="tiny" />
                      <span>{model.name}</span>
                    </span>
                    <Show when={isFreeModel(model)}>
                      <span data-slot="compare-model-modal-badge">Free</span>
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
        <div data-slot="compare-model-modal-divider" aria-hidden="true" />
        <Show when={preview()}>{(model) => <CompareModelDetail model={model()} />}</Show>
      </div>
    </div>
  )
}

function CompareModelDetail(props: { model: ModelCatalogEntry }) {
  return (
    <aside data-slot="compare-model-modal-detail">
      <header data-slot="compare-model-modal-detail-header">
        <ModelAvatar model={props.model} size="small" />
        <strong>{props.model.name}</strong>
      </header>
      <div data-slot="compare-model-modal-description">
        <p>{props.model.description ?? `${props.model.name} is an AI model.`}</p>
        <span aria-hidden="true" />
      </div>
      <dl data-slot="compare-model-modal-facts">
        <CompareModelFact label="Release" value={formatCatalogDate(props.model.releaseDate)} />
        <CompareModelFact label="Context" value={formatCatalogLimit(props.model.limit?.context)} />
        <CompareModelFact label="Input" value={formatCatalogUnitPrice(props.model.cost?.input)} />
        <CompareModelFact label="Output" value={formatCatalogUnitPrice(props.model.cost?.output)} />
        <CompareModelFact label="URL" value={formatModelUrl(props.model)} href={modelHref(props.model)} />
      </dl>
    </aside>
  )
}

function CompareModelFact(props: { label: string; value: string; href?: string }) {
  return (
    <div data-slot="compare-model-modal-fact">
      <dt>{props.label}</dt>
      <dd>
        <Show when={props.href} fallback={props.value}>
          {(href) => <a href={href()}>{props.value}</a>}
        </Show>
      </dd>
    </div>
  )
}

function ComparisonDetailMatrix(props: {
  sections: ComparisonDetailSection[]
  highlightBest: boolean
  modelCount: number
}) {
  return (
    <section id="comparison" data-section="compare-detail-matrix" aria-label="Model comparison">
      <div data-component="compare-detail-matrix">
        <For each={props.sections}>
          {(section) => (
            <section data-slot="compare-detail-group" aria-label={section.title}>
              <ComparisonDetailSpacer modelCount={props.modelCount} />
              <div data-slot="compare-detail-label" data-heading="true">
                <strong>{section.title}</strong>
                <Show when={section.badge}>{(badge) => <span>{badge()}</span>}</Show>
              </div>
              <For each={Array.from({ length: props.modelCount })}>
                {(_, index) => (
                  <div
                    data-slot="compare-detail-value"
                    data-column={index()}
                    data-last={index() === props.modelCount - 1 ? "true" : undefined}
                    data-heading="true"
                    aria-hidden="true"
                  />
                )}
              </For>
              <For each={section.rows}>
                {(row) => {
                  const best = () => (props.highlightBest ? bestDetailCellIndex(row) : undefined)
                  return (
                    <>
                      <div data-slot="compare-detail-label">{row.label}</div>
                      <For each={row.cells}>
                        {(cell, index) => (
                          <ComparisonDetailValue
                            best={best() === index()}
                            cell={cell}
                            column={index()}
                            last={index() === props.modelCount - 1}
                          />
                        )}
                      </For>
                    </>
                  )
                }}
              </For>
              <Show when={section.usage}>
                {(usage) => (
                  <>
                    <div data-slot="compare-detail-label" data-empty="true" />
                    <For each={usage()}>
                      {(modelUsage, index) => (
                        <ComparisonUsageBars
                          data={modelUsage}
                          column={index()}
                          last={index() === props.modelCount - 1}
                        />
                      )}
                    </For>
                  </>
                )}
              </Show>
              <ComparisonDetailSpacer modelCount={props.modelCount} />
            </section>
          )}
        </For>
      </div>
    </section>
  )
}

function ComparisonDetailSpacer(props: { modelCount: number }) {
  return (
    <>
      <div data-slot="compare-detail-label" data-spacer="true" aria-hidden="true" />
      <For each={Array.from({ length: props.modelCount })}>
        {(_, index) => (
          <div
            data-slot="compare-detail-value"
            data-column={index()}
            data-last={index() === props.modelCount - 1 ? "true" : undefined}
            data-spacer="true"
            aria-hidden="true"
          />
        )}
      </For>
    </>
  )
}

function ComparisonDetailValue(props: { cell: ComparisonDetailCell; best: boolean; column: number; last: boolean }) {
  return (
    <div
      data-slot="compare-detail-value"
      data-column={props.column}
      data-last={props.last ? "true" : undefined}
      data-best={props.best ? "true" : undefined}
    >
      <Show when={props.cell.href} fallback={<ComparisonCellContent cell={props.cell} />}>
        {(href) => (
          <a href={href()} data-slot="compare-detail-value-link">
            <ComparisonCellContent cell={props.cell} />
          </a>
        )}
      </Show>
    </div>
  )
}

function ComparisonCellContent(props: { cell: ComparisonDetailCell }) {
  return (
    <Show
      when={props.cell.kind === "boolean"}
      fallback={
        <span data-slot="compare-detail-value-main">
          <span>{props.cell.value}</span>
          <Show when={props.cell.unit}>{(unit) => <span data-slot="compare-detail-unit">{unit()}</span>}</Show>
          <Show when={props.cell.trend !== undefined}>
            <span
              data-slot="compare-detail-trend"
              data-trend={
                props.cell.trend && props.cell.trend > 0
                  ? "up"
                  : props.cell.trend && props.cell.trend < 0
                    ? "down"
                    : "flat"
              }
            >
              {props.cell.trend && props.cell.trend > 0 ? "+" : ""}
              {formatPercent(props.cell.trend ?? 0)}
            </span>
          </Show>
        </span>
      }
    >
      <span data-slot="compare-detail-boolean" data-value={props.cell.value.toLowerCase()}>
        {props.cell.value}
      </span>
    </Show>
  )
}

function ComparisonUsageBars(props: { data: ModelUsagePoint[]; column: number; last: boolean }) {
  const points = () => props.data.slice(-usageBarLimit)
  const max = () => Math.max(...points().map((point) => point.tokens), 0)
  return (
    <div
      data-slot="compare-detail-value"
      data-column={props.column}
      data-last={props.last ? "true" : undefined}
      data-chart="true"
    >
      <Show
        when={points().length > 0 && max() > 0}
        fallback={<span data-slot="compare-detail-no-chart">No trend data</span>}
      >
        <span data-slot="compare-detail-bars" aria-hidden="true">
          <For each={points()}>
            {(point) => <i style={{ height: `${Math.max(4, Math.round((point.tokens / max()) * 40))}px` }} />}
          </For>
        </span>
        <span data-slot="compare-detail-bar-dates">
          <span>{formatUsageDate(points()[0]?.date)}</span>
          <span>{formatUsageDate(points()[points().length - 1]?.date)}</span>
        </span>
      </Show>
    </div>
  )
}

function ModelAvatar(props: { model: ModelCatalogEntry; size: "large" | "small" | "tiny" }) {
  return <LabLogo lab={props.model.lab} label={props.model.name} size={props.size} />
}

function LabLogo(props: { lab: string; label: string; size: "large" | "small" | "tiny" }) {
  const iconId = () => getProviderIconId(props.lab)

  return (
    <Show when={!isProviderlessLab(props.lab)}>
      <span data-slot="compare-home-avatar" data-lab={iconId()} data-size={props.size} aria-label={props.label}>
        <ProviderIcon aria-hidden="true" id={iconId()} />
      </span>
    </Show>
  )
}

function resolvedCatalogEntry(catalog: ModelCatalog | undefined, lab: string, model: string) {
  if (!catalog) return undefined
  return findModelCatalogEntry(catalog, model, lab) ?? null
}

function parseAdditionalModels(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .flatMap((entry) => {
      const parts = entry.split("/")
      if (parts.length !== 2) return []
      const lab = catalogSlug(parts[0])
      const slug = catalogSlug(parts[1])
      return lab && slug ? [{ lab, slug }] : []
    })
    .slice(0, comparisonModelLimit - 2)
}

function comparisonModelRequestKey(model: ComparisonModelRequest) {
  return `${catalogSlug(model.lab)}/${catalogSlug(model.slug)}`
}

function comparisonModelsHref(models: ModelCatalogEntry[]) {
  const path = comparisonHref(modelRefFromCatalog(models[0]), modelRefFromCatalog(models[1]))
  const additional = models.slice(2).map((model) => `${catalogSlug(model.lab)}/${catalogSlug(model.slug)}`)
  return additional.length === 0 ? path : `${path}?add=${additional.join(",")}`
}

function comparisonDetailGridTemplate(modelCount: number) {
  return `minmax(0, var(--compare-detail-label-column)) repeat(${modelCount}, minmax(var(--compare-detail-model-column-min), 1fr))`
}

function buildComparisonModel(
  labParam: string,
  modelParam: string,
  catalog: ModelCatalogEntry | null,
  stats: StatsModelComparisonEntry | null,
  catalogLabs: readonly string[],
): ComparisonModel {
  const lab = catalog?.lab ?? stats?.provider ?? catalogSlug(labParam)
  return {
    name: catalog?.name ?? stats?.model ?? formatParamName(modelParam),
    lab,
    labName: isKnownCatalogLab(lab, catalogLabs) ? formatCatalogLabName(lab) : undefined,
    slug: catalog?.slug ?? stats?.slug ?? catalogSlug(modelParam),
    catalog,
    stats,
  }
}

function comparisonCatalogEntry(model: ComparisonModel): ModelCatalogEntry {
  if (model.catalog) return model.catalog
  return {
    id: `${catalogSlug(model.lab)}/${catalogSlug(model.slug)}`,
    lab: catalogSlug(model.lab),
    slug: catalogSlug(model.slug),
    name: model.name,
    modalities: { input: [], output: [] },
    openWeights: false,
    reasoning: false,
    toolCall: false,
    attachment: false,
    temperature: false,
    weights: [],
    benchmarks: [],
  }
}

function uniqueCatalogModels(models: ModelCatalogEntry[]) {
  return Object.values(
    models.reduce<Record<string, ModelCatalogEntry>>((result, model) => {
      result[model.id] = result[model.id] ?? model
      return result
    }, {}),
  )
}

function buildComparisonDetailSections(models: readonly ComparisonModel[]): ComparisonDetailSection[] {
  return [
    {
      title: "Overview",
      rows: [
        comparisonDetailRow("Author", models.map(providerDetailCell)),
        comparisonDetailRow(
          "Context length",
          models.map((model) => limitCell(model.catalog?.limit?.context)),
          "higher",
        ),
        comparisonDetailRow(
          "Reasoning",
          models.map((model) => booleanDetailCell(model.catalog?.reasoning)),
          "higher",
        ),
        comparisonDetailRow(
          "Input modalities",
          models.map((model) => textCell(formatCatalogModalities(model.catalog?.modalities.input ?? []))),
        ),
        comparisonDetailRow(
          "Output modalities",
          models.map((model) => textCell(formatCatalogModalities(model.catalog?.modalities.output ?? []))),
        ),
        comparisonDetailRow("Providers", models.map(providerDetailCell)),
      ],
    },
    {
      title: "Pricing",
      rows: [
        comparisonDetailRow(
          "Input",
          models.map((model) => priceCell(model.catalog?.cost?.input)),
          "lower",
        ),
        comparisonDetailRow(
          "Output",
          models.map((model) => priceCell(model.catalog?.cost?.output)),
          "lower",
        ),
        comparisonDetailRow(
          "Cached input",
          models.map((model) => priceCell(model.catalog?.cost?.cacheRead)),
          "lower",
        ),
      ],
    },
    {
      title: "Momentum",
      badge: "Last 2 mo",
      rows: [
        comparisonDetailRow(
          "Unique users",
          models.map((model) => usageMetricCell(model.stats?.totals.uniqueUsers)),
          "higher",
        ),
        comparisonDetailRow(
          "Completed sessions",
          models.map((model) => usageMetricCell(model.stats?.totals.sessions, "integer")),
          "higher",
        ),
        comparisonDetailRow(
          "Token share",
          models.map((model) => percentCell(model.stats?.tokenShare)),
          "higher",
        ),
        comparisonDetailRow(
          "Tokens",
          models.map((model) => tokenCell(model.stats?.totals.tokens, model.stats?.tokenChange)),
          "higher",
        ),
      ],
      usage: models.map((model) => model.stats?.usage ?? []),
    },
    {
      title: "Retention",
      badge: "Week 1",
      rows: [
        comparisonDetailRow(
          "Returning users",
          models.map((model) => retentionCell(model.stats?.weeklyRetention)),
          "higher",
        ),
      ],
    },
  ]
}

function comparisonDetailRow(
  label: string,
  cells: ComparisonDetailCell[],
  direction?: ComparisonDirection,
): ComparisonDetailRow {
  return { label, direction, cells }
}

function bestDetailCellIndex(row: ComparisonDetailRow) {
  if (!row.direction) return undefined
  const scored = row.cells.flatMap((cell, index) => (cell.score === undefined ? [] : [{ index, score: cell.score }]))
  if (scored.length < 2) return undefined
  const score =
    row.direction === "higher"
      ? Math.max(...scored.map((cell) => cell.score))
      : Math.min(...scored.map((cell) => cell.score))
  const best = scored.filter((cell) => cell.score === score)
  return best.length === 1 ? best[0].index : undefined
}

function buildRelatedPairs(
  catalog: ModelCatalog | undefined,
  first: ComparisonModel,
  second: ComparisonModel,
): ComparisonPair[] {
  const current = [comparisonRef(first), comparisonRef(second)] as const
  const alternatives = (catalog?.models ?? [])
    .filter((model) => model.id !== first.catalog?.id && model.id !== second.catalog?.id)
    .slice(0, 4)
    .map(modelRefFromCatalog)

  return uniqueComparisonPairs(
    alternatives.slice(0, 3).flatMap((model, index) => [
      { first: current[0], second: model, detail: index === 0 ? "Nearby alternative" : "Related comparison" },
      { first: current[1], second: model, detail: index === 0 ? "Nearby alternative" : "Related comparison" },
    ]),
  ).slice(0, 6)
}

function comparisonRef(model: ComparisonModel): ComparisonModelRef {
  return {
    name: model.name,
    lab: model.lab,
    slug: model.slug,
    labName: model.labName,
    metric: model.stats ? `#${model.stats.rank}` : "Catalog",
  }
}

function comparisonModelLabel(model: ComparisonModel) {
  return model.labName ? `${model.name} from ${model.labName}` : model.name
}

function providerDetailCell(model: ComparisonModel): ComparisonDetailCell {
  if (!model.labName) return textCell("")
  return linkedTextCell(model.stats?.author ?? model.labName ?? "", labHref(model.lab))
}

function textCell(value: string): ComparisonDetailCell {
  return { value }
}

function linkedTextCell(value: string, href: string): ComparisonDetailCell {
  return { value, href }
}

function booleanDetailCell(value: boolean | undefined): ComparisonDetailCell {
  if (value === undefined) return { value: "Unknown" }
  return { value: value ? "True" : "False", kind: "boolean", score: value ? 1 : 0 }
}

function limitCell(value: number | undefined): ComparisonDetailCell {
  return value === undefined ? { value: "Unknown" } : { value: formatTokens(value), score: value }
}

function priceCell(value: number | undefined): ComparisonDetailCell {
  return value === undefined ? { value: "Unknown" } : { value: formatModelPrice(value), unit: "/ 1M", score: value }
}

function usageMetricCell(value: number | undefined, format: "compact" | "integer" = "compact"): ComparisonDetailCell {
  if (value === undefined) return { value: "No usage" }
  return { value: format === "integer" ? formatInteger(value) : formatTokens(value), score: value }
}

function percentCell(value: number | undefined): ComparisonDetailCell {
  return value === undefined ? { value: "No usage" } : { value: formatPercent(value), score: value }
}

function retentionCell(value: RetentionEntry | null | undefined): ComparisonDetailCell {
  if (!value || value.rank === null) return { value: "Pending" }
  return {
    value: formatPercent(value.rate),
    unit: `${formatTokens(value.eligibleUserWeeks)} user-weeks`,
    score: value.rate,
  }
}

function tokenCell(value: number | undefined, trend: number | undefined): ComparisonDetailCell {
  if (value === undefined) return { value: "No usage" }
  return { value: formatTokens(value), score: value, trend }
}

function labHref(lab: string) {
  return `${import.meta.env.BASE_URL}${catalogSlug(lab)}`
}

function modelSearchText(model: ModelCatalogEntry) {
  return `${model.name} ${formatCatalogLabName(model.lab)} ${model.id}`.toLowerCase()
}

function isFreeModel(model: ModelCatalogEntry) {
  return model.cost?.input === 0 && model.cost.output === 0
}

function modelHref(model: ModelCatalogEntry) {
  return `${import.meta.env.BASE_URL}${model.lab}/${model.slug}`
}

function formatModelUrl(model: ModelCatalogEntry) {
  return `.../${model.slug}`
}

function formatParamName(value: string) {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim()
}

function formatCatalogLimit(value: number | undefined) {
  return value === undefined ? "Unknown" : formatTokens(value)
}

function formatCatalogUnitPrice(value: number | undefined) {
  if (value === undefined) return "Unknown"
  return `${formatModelPrice(value)} / 1M`
}

function formatModelPrice(value: number) {
  if (value > 0 && value < 0.01) return `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`
  return formatMoney(value)
}

function formatCatalogModalities(values: string[]) {
  if (values.length === 0) return "Unknown"
  return values
    .map((value) => value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()))
    .join(", ")
}

function formatCatalogDate(value: string | undefined) {
  if (!value) return "Unknown"
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(value)
  if (!match) return value
  const year = Number(match[1])
  const month = match[2] ? Number(match[2]) - 1 : 0
  const day = match[3] ? Number(match[3]) : 1
  return new Intl.DateTimeFormat("en", {
    month: match[2] ? "short" : undefined,
    day: match[3] ? "numeric" : undefined,
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month, day)))
}

function formatUsageDate(value: string | undefined) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(date).toUpperCase()
}

function formatTokens(value: number) {
  if (value >= 1_000_000_000_000)
    return `${trimNumber(value / 1_000_000_000_000, value >= 10_000_000_000_000 ? 0 : 1)}T`
  if (value >= 1_000_000_000) return `${trimNumber(value / 1_000_000_000, value >= 10_000_000_000 ? 0 : 1)}B`
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000, value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${trimNumber(value / 1_000, value >= 10_000 ? 0 : 1)}K`
  return String(Math.round(value))
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en").format(value)
}

function formatPercent(value: number) {
  return `${trimNumber(value, Math.abs(value) >= 10 ? 1 : 2)}%`
}

function formatMoney(value: number) {
  if (value >= 1_000_000) return `$${trimNumber(value / 1_000_000, value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `$${trimNumber(value / 1_000, value >= 10_000 ? 0 : 1)}K`
  return `$${value.toFixed(value >= 10 ? 0 : 2)}`
}

function trimNumber(value: number, digits: number) {
  return Number(value.toFixed(digits)).toLocaleString("en")
}

function getProviderIconId(provider: string) {
  const id = provider.toLowerCase().replace(/[^a-z0-9]+/g, "")
  if (id === "moonshot") return "moonshotai"
  if (id === "zhipu") return "zhipuai"
  return id
}

function ChevronDownIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path d="M4.75 6.25L8 9.5L11.25 6.25" stroke="currentColor" stroke-width="1.5" />
    </svg>
  )
}
