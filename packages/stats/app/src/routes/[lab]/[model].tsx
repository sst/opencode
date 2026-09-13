import { Meta, Title } from "@solidjs/meta"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { scaleSqrt } from "d3-scale"
import countryCodesSource from "i18n-iso-countries/codes.json?raw"
import {
  getStatsModelData,
  type CountryEntry,
  type ModelPeerEntry,
  type ModelUsagePoint,
  type StatsModelData,
} from "@opencode-ai/stats-core/domain/home"
import { statModel } from "@opencode-ai/stats-core/domain/model-normalization"
import { createAsync, query, useParams } from "@solidjs/router"
import { createMemo, createSignal, createUniqueId, For, onMount, Show, type JSX } from "solid-js"
import { getRequestEvent } from "solid-js/web"
import { LocaleLinks } from "../../component/locale-links"
import { useI18n } from "../../context/i18n"
import { useLanguage } from "../../context/language"
import { localizedUrl } from "../../lib/language"
import {
  findModelCatalogEntry,
  formatCatalogLabName,
  isKnownCatalogLab,
  loadModelCatalog,
  type ModelCatalogEntry,
} from "../model-catalog"
import { SectionHeading } from "../section-heading"
import { runStatsEffect } from "../../stats-runtime"
import { setStatsPageCacheHeaders } from "../stats-cache"
import {
  ComparisonCardsSection,
  modelRefFromCatalog,
  uniqueComparisonPairs,
  type ComparisonModelRef,
} from "../compare-cards"
import { BreadcrumbSelect } from "../breadcrumb-select"
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
} from "../stats-shell"

const statsUnfurlPath = "banner.png"
const glmFlashCatalogId = "zhipuai/glm-5.3-flash"
const glmFlashModel = "glm-5.3-flash"
const shortMonths = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const

type IsoCountryCode = readonly [string, string, string]
type ModelCatalogOption = Pick<ModelCatalogEntry, "id" | "lab" | "slug" | "name">
type ModelPageCatalog = {
  entry: ModelCatalogEntry | null
  labs: { id: string; name: string }[]
  labModels: ModelCatalogOption[]
}
type StatsModelPageData = StatsModelData
type ModelPageData = { catalog: ModelPageCatalog; stats: StatsModelPageData | null }

const countryNumericIds = new Map(
  (JSON.parse(countryCodesSource) as IsoCountryCode[]).map((country) => [country[0], country[2]] as const),
)

const getModelPageData = query(async (labParam: string, modelParam: string) => {
  "use server"
  const catalog = await loadModelCatalog()
  const entry = findModelCatalogEntry(catalog, modelParam, labParam) ?? null
  const lab = entry?.lab ?? labParam
  const model = entry?.slug ?? modelParam
  const stats = lab && model ? await runStatsEffect(getStatsModelData(model, lab)) : null
  return {
    catalog: {
      entry,
      labs: catalog.labs.map((item) => ({ id: item.id, name: item.name })),
      labModels:
        catalog.labs
          .find((item) => item.id === (entry?.lab ?? providerSlug(labParam)))
          ?.models.map((item) => ({ id: item.id, lab: item.lab, slug: item.slug, name: item.name })) ?? [],
    },
    stats,
  } satisfies ModelPageData
}, "getStatsModelPageData")

export default function StatsModel() {
  const i18n = useI18n()
  const language = useLanguage()
  const event = getRequestEvent()
  setStatsPageCacheHeaders(event?.response.headers)
  const params = useParams()
  const labParam = createMemo(() => params.lab ?? "")
  const modelParam = createMemo(() => params.model ?? "")
  const page = createAsync(() => getModelPageData(labParam(), modelParam()))
  const catalogEntry = createMemo(() => page()?.catalog.entry)
  const stats = createMemo(() => page()?.stats)
  const githubStars = createAsync(() => getGitHubStars())
  const [themePreference, setThemePreference] = createSignal<ThemePreference>("system")
  const canonicalModel = createMemo(() => statModel(stats()?.model ?? modelParam(), undefined))
  const modelName = createMemo(
    () => catalogEntry()?.name ?? publicModelName(canonicalModel()) ?? i18n.t("model.fallback"),
  )
  const lab = createMemo(() => catalogEntry()?.lab ?? stats()?.provider ?? labParam())
  const catalogLabs = createMemo(() => page()?.catalog.labs.map((item) => item.id) ?? [])
  const labName = createMemo(() => (isKnownCatalogLab(lab(), catalogLabs()) ? formatCatalogLabName(lab()) : undefined))
  const formerName = createMemo(() => formerModelName(canonicalModel()))
  const searchModelName = createMemo(() => (formerName() ? `${modelName()} (formerly ${formerName()})` : modelName()))
  const modelTitle = createMemo(() => i18n.t("model.title", { model: searchModelName() }))
  const modelDescription = createMemo(() => i18n.t("model.description", { model: searchModelName() }))
  const modelPath = createMemo(() => {
    const fallback = formerName()
      ? glmFlashCatalogId
      : [labParam(), stats()?.slug ?? canonicalModel()].filter((part) => part.length > 0).join("/")
    return `/data/${catalogEntry()?.id ?? fallback}`
  })
  const modelUrl = createMemo(() => localizedUrl(language.locale(), modelPath()))
  const statsUnfurlUrl = new URL(statsUnfurlPath, localizedUrl("en", "/data/")).toString()
  const modelHeaderLinks = createMemo<readonly HeaderLink[]>(() => [
    { href: "#overview", label: i18n.t("nav.overview") },
    { href: "#momentum", label: i18n.t("model.momentum") },
    { href: "#usage", label: i18n.t("nav.usage") },
    { href: "#unique-users", label: i18n.t("model.uniqueUsers") },
    { href: "#efficiency", label: i18n.t("nav.efficiency") },
    { href: "#geo-breakdown", label: i18n.t("nav.geoBreakdown") },
    { href: "#peers", label: i18n.t("nav.peers") },
  ])
  const modelFooterLinks = createMemo<readonly HeaderLink[]>(() => [
    { href: import.meta.env.BASE_URL, label: i18n.t("nav.dataHome") },
    { href: `${import.meta.env.BASE_URL}#top-models`, label: i18n.t("nav.topModels") },
    { href: `${import.meta.env.BASE_URL}#session-cost`, label: i18n.t("nav.sessionCost") },
    { href: `${import.meta.env.BASE_URL}#token-cost`, label: i18n.t("nav.tokenCost") },
    { href: `${import.meta.env.BASE_URL}#cache-ratio`, label: i18n.t("nav.cacheRatio") },
    { href: `${import.meta.env.BASE_URL}#market-share`, label: i18n.t("nav.marketShare") },
    { href: `${import.meta.env.BASE_URL}#geo-breakdown`, label: i18n.t("nav.geoBreakdown") },
  ])
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
    <main data-page="stats" data-theme={themePreference()}>
      <Title>{modelTitle()}</Title>
      <Meta name="description" content={modelDescription()} />
      <LocaleLinks path={modelPath()} />
      <Meta property="og:type" content="website" />
      <Meta property="og:site_name" content="OpenCode" />
      <Meta property="og:title" content={modelTitle()} />
      <Meta property="og:description" content={modelDescription()} />
      <Meta property="og:url" content={modelUrl()} />
      <Meta property="og:image" content={statsUnfurlUrl} />
      <Meta property="og:image:type" content="image/png" />
      <Meta property="og:image:width" content="1200" />
      <Meta property="og:image:height" content="630" />
      <Meta property="og:image:alt" content={i18n.t("app.unfurlAlt")} />
      <Meta name="twitter:card" content="summary_large_image" />
      <Meta name="twitter:title" content={modelTitle()} />
      <Meta name="twitter:description" content={modelDescription()} />
      <Meta name="twitter:image" content={statsUnfurlUrl} />
      <Meta name="twitter:image:alt" content={i18n.t("app.unfurlAlt")} />
      <Header
        githubStars={githubStars() ?? githubLink.fallbackStars}
        links={modelHeaderLinks()}
        brandHref={import.meta.env.BASE_URL}
      />
      <div data-component="container">
        <div data-component="content">
          <Show when={page() !== undefined} fallback={<ModelLoading />}>
            <Show when={catalogEntry() || stats()} fallback={<ModelNotFound lab={labParam()} model={modelParam()} />}>
              <>
                <ModelHero
                  data={stats() ?? null}
                  catalog={catalogEntry() ?? null}
                  catalogData={page()?.catalog ?? null}
                  labName={labName()}
                  formerName={formerName()}
                />
                <ModelOverview catalog={catalogEntry() ?? null} />
                <ModelMomentumSection data={stats() ?? null} />
                <ModelUsageSection data={stats() ?? null} />
                <ModelUniqueUsersSection data={stats() ?? null} />
                <ModelEfficiencySection data={stats() ?? null} catalog={catalogEntry() ?? null} />
                <ModelGeoBreakdownSection data={stats()?.country ?? []} />
                <ModelPeersSection data={stats() ?? null} catalogLabs={catalogLabs()} />
                <ComparisonCardsSection
                  pairs={modelComparisonPairs(
                    page()?.catalog.labModels,
                    catalogLabs(),
                    catalogEntry() ?? null,
                    stats() ?? null,
                  )}
                  title="Compare This Model"
                  description="Other models to compare with this one."
                  variant="featured"
                />
              </>
            </Show>
          </Show>
        </div>
        <Footer
          themePreference={themePreference()}
          onThemePreferenceChange={updateThemePreference}
          links={modelFooterLinks()}
          bridge={{ href: "#model-comparison", label: "MODEL COMPARISONS" }}
        />
      </div>
    </main>
  )
}

function ModelLoading() {
  const i18n = useI18n()
  const language = useLanguage()
  return (
    <>
      <section id="overview" data-section="model-hero">
        <div data-slot="model-hero-grid">
          <div data-slot="model-hero-copy">
            <a data-slot="model-back-link" href={language.route(import.meta.env.BASE_URL)}>
              {i18n.t("footer.modelData")}
            </a>
            <h1>
              <a data-slot="heading-link" href="#overview">
                {i18n.t("model.loadingTitle")}
              </a>
            </h1>
            <p>{i18n.t("model.loadingDescription")}</p>
          </div>
        </div>
      </section>
      <section data-section="model-panel">
        <ModelEmptyState title={i18n.t("model.loadingTitle")} description={i18n.t("model.loadingProfile")} />
      </section>
    </>
  )
}

function ModelNotFound(props: { lab: string; model: string }) {
  const i18n = useI18n()
  const language = useLanguage()
  return (
    <>
      <section id="overview" data-section="model-hero">
        <div data-slot="model-hero-grid">
          <div data-slot="model-hero-copy">
            <a data-slot="model-back-link" href={language.route(import.meta.env.BASE_URL)}>
              {i18n.t("footer.modelData")}
            </a>
            <h1>
              <a data-slot="heading-link" href="#overview">
                {props.model || i18n.t("model.fallback")}
              </a>
            </h1>
            <p>{i18n.t("model.noMatched", { id: props.lab ? `${props.lab}/${props.model}` : props.model })}</p>
          </div>
        </div>
      </section>
      <section data-section="model-panel">
        <ModelEmptyState title={i18n.t("model.noDataTitle")} description={i18n.t("model.noDataDescription")} />
      </section>
    </>
  )
}

function ModelHero(props: {
  data: StatsModelPageData | null
  catalog: ModelCatalogEntry | null
  catalogData: ModelPageCatalog | null
  labName?: string
  formerName?: string
}) {
  const i18n = useI18n()
  const language = useLanguage()
  const labId = () => props.catalog?.lab ?? props.data?.provider
  const hasLab = () => props.labName !== undefined
  const modelName = () => props.catalog?.name ?? props.data?.model ?? i18n.t("model.fallback")
  const weights = () => props.catalog?.weights[0]
  const labs = () => props.catalogData?.labs ?? []
  const labModels = () => props.catalogData?.labModels ?? (props.catalog ? [props.catalog] : [])
  return (
    <section id="overview" data-section="model-hero">
      <nav data-component="model-hero-breadcrumb" aria-label="Data breadcrumb">
        <a data-slot="model-hero-crumb" href={language.route(import.meta.env.BASE_URL)}>
          Data
        </a>
        <Show when={hasLab()}>
          <span data-slot="model-hero-separator">/</span>
          <Show when={labs().length > 0} fallback={<span data-slot="model-hero-crumb">{props.labName}</span>}>
            <BreadcrumbSelect
              ariaLabel="Choose a lab"
              label={props.labName ?? ""}
              options={labs().map((lab) => ({
                href: language.route(`${import.meta.env.BASE_URL}${lab.id}`),
                label: lab.name,
                value: lab.id,
              }))}
              value={providerSlug(labId() ?? "")}
              variant="model"
            />
          </Show>
        </Show>
        <span data-slot="model-hero-separator">/</span>
        <Show
          when={labModels().length > 0}
          fallback={
            <span data-slot="model-hero-crumb" data-current="true" aria-current="page">
              {modelName()}
            </span>
          }
        >
          <BreadcrumbSelect
            ariaLabel="Choose a model"
            current
            label={modelName()}
            options={labModels().map((model) => ({
              href: language.route(`${import.meta.env.BASE_URL}${model.id}`),
              label: model.name,
              value: model.id,
            }))}
            value={props.catalog?.id ?? ""}
            variant="model"
          />
        </Show>
      </nav>
      <div data-slot="model-hero-title-row">
        <Show when={hasLab()}>
          <span data-slot="model-hero-avatar">
            <ProviderIcon aria-hidden="true" id={getProviderIconId(labId() ?? "")} />
          </span>
        </Show>
        <h1>{modelName()}</h1>
        <div data-slot="model-hero-actions">
          <Show when={props.catalog?.openWeights && weights()}>
            {(weight) => (
              <a data-slot="model-hero-action" href={weight().url} target="_blank" rel="noopener noreferrer">
                <ModelHeroActionIcon kind="weights" />
                <span>Model weights</span>
              </a>
            )}
          </Show>
        </div>
      </div>
      <div data-slot="model-hero-pattern" aria-hidden="true" />
      <Show
        when={props.data}
        fallback={
          <p data-slot="model-hero-state">
            <Show when={props.formerName}>{(name) => <span>{`Formerly ${name()}.`}</span>}</Show>
            <span>Listed</span>
            <span>across the shared model catalog.</span>
          </p>
        }
      >
        {(data) => (
          <p data-slot="model-hero-rankline">
            <Show when={props.formerName}>{(name) => <span>{`Formerly ${name()}.`}</span>}</Show>
            <span>Ranked</span>
            <span data-slot="model-hero-rank-group">
              <span data-slot="model-hero-pill">{formatHeroRank(data().rank)}</span>
              <ModelHeroSparkline data={data()} />
            </span>
            <span>across last week's</span>
            <span data-slot="model-hero-pill">OpenCode</span>
            <span>usage with</span>
            <span data-slot="model-hero-pill">{formatPercent(data().tokenShare)}</span>
            <span>of observed</span>
            <span data-slot="model-hero-pill">2M</span>
            <span>volume.</span>
          </p>
        )}
      </Show>
    </section>
  )
}

function ModelHeroActionIcon(props: { kind: "weights" | "compare" }) {
  if (props.kind === "weights")
    return (
      <svg data-slot="model-hero-action-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none">
        <path d="M5.5 4.5H4.5V11.5H11.5V10.5" stroke="currentColor" stroke-linecap="square" />
        <path d="M8.5 4.5H11.5V7.5" stroke="currentColor" stroke-linecap="square" />
        <path d="M11.25 4.75L7.25 8.75" stroke="currentColor" stroke-linecap="square" />
      </svg>
    )
  return (
    <svg data-slot="model-hero-action-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <rect x="3.5" y="3.5" width="3" height="3" stroke="currentColor" />
      <rect x="9.5" y="3.5" width="3" height="3" stroke="currentColor" />
      <rect x="3.5" y="9.5" width="3" height="3" stroke="currentColor" />
      <rect x="9.5" y="9.5" width="3" height="3" stroke="currentColor" />
    </svg>
  )
}

function ModelHeroSparkline(props: { data: StatsModelPageData }) {
  const values = () => props.data.usage.slice(-14).map((point) => point.tokens)
  return (
    <span data-slot="model-hero-sparkline" aria-hidden="true">
      <svg viewBox="0 0 36 24" fill="none">
        <path d={sparklineAreaPath(values())} fill="currentColor" opacity="0.14" />
        <path d={sparklineLinePath(values())} stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      </svg>
    </span>
  )
}

function ChevronDownIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" />
    </svg>
  )
}

function ModelOverview(props: { catalog: ModelCatalogEntry | null }) {
  const i18n = useI18n()
  const language = useLanguage()
  const specs = createMemo(() => [
    {
      label: i18n.t("model.context"),
      value: formatCatalogLimit(props.catalog?.limit?.context, i18n.t("home.unknown")),
    },
    {
      label: i18n.t("model.output"),
      value: formatCatalogLimit(props.catalog?.limit?.output, i18n.t("home.unknown")),
    },
    {
      label: i18n.t("model.knowledge"),
      value: formatCatalogMonth(props.catalog?.knowledge, language.tag(language.locale()), i18n.t("home.unknown")),
    },
    {
      label: i18n.t("model.release"),
      value: formatCatalogMonth(props.catalog?.releaseDate, language.tag(language.locale()), i18n.t("home.unknown")),
    },
    {
      label: i18n.t("model.inputs"),
      value: formatCatalogModalities(
        props.catalog?.modalities.input ?? [],
        language.tag(language.locale()),
        i18n.t("home.unknown"),
      ),
    },
  ])
  return (
    <section id="model-overview" data-section="model-specs" aria-label={i18n.t("nav.overview")}>
      <For each={specs()}>
        {(spec) => (
          <div data-component="model-spec">
            <span>{spec.label}</span>
            <strong>{spec.value}</strong>
          </div>
        )}
      </For>
    </section>
  )
}

function ModelMomentumSection(props: { data: StatsModelPageData | null }) {
  const i18n = useI18n()
  const language = useLanguage()
  return (
    <section id="momentum" data-section="model-momentum">
      <h2 data-slot="model-momentum-title">
        <a href="#momentum">{i18n.t("model.momentum")}.</a>
        <span>{i18n.t("model.overviewDescription")}</span>
      </h2>
      <div data-slot="model-momentum-pattern" aria-hidden="true" />
      <Show
        when={props.data}
        fallback={
          <ModelEmptyState title={i18n.t("model.noSummaryTitle")} description={i18n.t("model.noSummaryDescription")} />
        }
      >
        {(data) => (
          <>
            <MomentumChart data={data()} locale={language.tag(language.locale())} />
            <div data-slot="model-momentum-metrics">
              <MomentumMetric label={i18n.t("model.uniqueUsers")} value={formatUsers(data().totals.uniqueUsers)} />
              <MomentumMetric
                label={capitalizeLabel(i18n.t("model.completedSessions"))}
                value={formatInteger(data().totals.sessions)}
              />
              <MomentumMetric label={i18n.t("model.tokenShare")} value={formatPercent(data().tokenShare)} />
              <MomentumMetric label="Weekly Retention" value={formatModelRetention(data())} />
              <MomentumMetric
                label="Rank"
                value={formatRankLabel(data().rank)}
                watermark={formatRankLabel(data().rank)}
              />
            </div>
          </>
        )}
      </Show>
    </section>
  )
}

function MomentumChart(props: { data: StatsModelPageData; locale: string }) {
  const chart = createMemo(() => momentumChart(props.data.usage, props.data.updatedAt))
  const changeState = createMemo(() => (props.data.tokenChange < 0 ? "negative" : "positive"))
  return (
    <div data-component="model-momentum-chart" role="img" aria-label="Recent model token momentum">
      <div data-slot="model-momentum-summary">
        <div data-slot="model-momentum-total">
          <strong>{formatTokens(props.data.totals.tokens)} tokens</strong>
          <span data-state={changeState()}>{formatChange(props.data.tokenChange)}</span>
        </div>
        <p>
          <span>{formatMomentumDate(chart().startDate, props.locale, props.data.updatedAt)}</span>
          <span aria-hidden="true">→</span>
          <span>{formatMomentumDate(chart().endDate, props.locale, props.data.updatedAt)}</span>
        </p>
      </div>
      <div data-slot="model-momentum-plot">
        <svg viewBox="0 0 1200 370" preserveAspectRatio="none" aria-hidden="true">
          <path data-slot="model-momentum-line-muted" d={chart().previousPath} />
          <path data-slot="model-momentum-line-active" d={chart().currentPath} />
          <For each={chart().markers}>
            {(marker) => (
              <rect
                data-slot="model-momentum-marker"
                data-active={marker.active ? "true" : undefined}
                x={marker.x - 3}
                y={marker.y - 3}
                width="6"
                height="6"
              />
            )}
          </For>
        </svg>
        <span data-slot="model-momentum-end" data-state={changeState()} style={chart().endStyle}>
          <i />
          {formatChange(props.data.tokenChange)}
        </span>
      </div>
      <div data-slot="model-momentum-months" aria-hidden="true">
        <For each={momentumMonthLabels(chart().startDate, props.locale, props.data.updatedAt)}>
          {(month) => <span style={{ left: `${month.x}%` }}>{month.label}</span>}
        </For>
      </div>
    </div>
  )
}

function MomentumMetric(props: { label: string; value: string; watermark?: string }) {
  return (
    <div data-component="model-momentum-metric">
      <Show when={props.watermark}>{(watermark) => <em aria-hidden="true">{watermark()}</em>}</Show>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}

function formatModelRetention(data: StatsModelPageData) {
  if (!data.weeklyRetention || data.weeklyRetention.eligibleUserWeeks < 100) return "Pending"
  return formatPercent(data.weeklyRetention.rate)
}

function ModelUsageSection(props: { data: StatsModelPageData | null }) {
  const i18n = useI18n()
  return (
    <ModelTrendSection
      data={props.data}
      id="usage"
      title={i18n.t("nav.usage")}
      description={i18n.t("model.usageDescription")}
      ariaLabel={i18n.t("model.dailyTokenChart")}
      emptyTitle={i18n.t("model.noUsageTitle")}
      emptyDescription={i18n.t("model.noUsageDescription")}
      value={(point) => point.tokens}
      formatValue={formatTokens}
      valueUnit={i18n.t("lab.tokens")}
      rowLabel={i18n.t("lab.dailyTokens")}
      lineTone="muted"
    />
  )
}

function ModelUniqueUsersSection(props: { data: StatsModelPageData | null }) {
  const i18n = useI18n()
  return (
    <ModelTrendSection
      data={props.data}
      id="unique-users"
      title={i18n.t("model.uniqueUsers")}
      description={i18n.t("model.usersDescription")}
      ariaLabel={i18n.t("model.dailyUserChart")}
      emptyTitle={i18n.t("model.noUsersTitle")}
      emptyDescription={i18n.t("model.noUsersDescription")}
      value={(point) => point.users}
      formatValue={formatUsers}
      valueUnit={i18n.t("format.users")}
      rowLabel={i18n.t("model.uniqueUsers")}
      lineTone="active"
      activeLineBaseTone="muted"
      highlightBars={false}
      area
    />
  )
}

function ModelTrendSection(props: {
  data: StatsModelPageData | null
  id: string
  title: string
  description: string
  ariaLabel: string
  emptyTitle: string
  emptyDescription: string
  value: (point: ModelUsagePoint) => number
  formatValue: (value: number) => string
  valueUnit: string
  rowLabel: string
  lineTone: "muted" | "active"
  activeLineBaseTone?: "muted" | "active"
  highlightBars?: boolean
  area?: boolean
}) {
  const activeLineClipId = createUniqueId()
  const activeLineMaskId = createUniqueId()
  const areaGradientId = createUniqueId()
  const [activeIndex, setActiveIndex] = createSignal<number>()
  const highlightBars = createMemo(() => props.highlightBars ?? true)
  const lineScale = 326 / 450
  const areaBottom = 100 / lineScale
  const usage = createMemo(() => props.data?.usage ?? [])
  const valueMax = createMemo(() => Math.max(0, ...usage().map((item) => props.value(item))) || 1)
  const linePoints = createMemo(() =>
    usage().map((point, index) => ({
      point,
      x: modelUsagePointX(index, usage().length),
      y: modelUsageLineY(props.value(point), valueMax()),
    })),
  )
  const linePath = createMemo(() => modelUsageLinePath(linePoints()))
  const areaPath = createMemo(() => modelUsageAreaPath(linePoints(), areaBottom))
  const activeLineBreak = createMemo(() => {
    const index = activeIndex()
    if (index === undefined || linePoints().length < 2) return undefined
    return modelUsageColumnBounds(index, linePoints().length)
  })
  const activeLineClip = createMemo(() => {
    const index = activeIndex()
    if (index === undefined || linePoints().length < 2) return undefined
    return modelUsageColumnInnerBounds(index, linePoints().length)
  })
  const activeTooltip = createMemo(() => {
    const index = activeIndex()
    const point = index === undefined ? undefined : usage()[index]
    if (index === undefined || !point) return undefined
    const bounds = modelUsageColumnBounds(index, usage().length)
    return {
      bounds,
      index,
      point,
      tooltipY: (linePoints()[index]?.y ?? 100) * lineScale,
    }
  })
  const monthTicks = createMemo(() => modelUsageMonthTicks(usage(), props.data?.updatedAt ?? null))

  return (
    <section id={props.id} data-section="model-panel">
      <SectionTitle href={`#${props.id}`} title={props.title} description={props.description} />
      <Show
        when={usage().some((item) => props.value(item) > 0)}
        fallback={<ModelEmptyState title={props.emptyTitle} description={props.emptyDescription} />}
      >
        <div
          data-component="model-usage-chart"
          data-variant="model-trend"
          data-highlight-bars={highlightBars() ? "true" : undefined}
          role="img"
          aria-label={props.ariaLabel}
          style={{ "--model-usage-count": usage().length } as JSX.CSSProperties}
          onPointerLeave={(event) => {
            if (event.pointerType === "touch") return
            setActiveIndex(undefined)
          }}
        >
          <div data-slot="model-trend-plot">
            <Show when={linePath()}>
              {(path) => (
                <>
                  <Show when={props.area && areaPath()}>
                    {(area) => (
                      <svg
                        data-slot="model-trend-area-layer"
                        viewBox={`0 0 100 ${formatUsagePathNumber(areaBottom)}`}
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <defs>
                          <linearGradient id={areaGradientId} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stop-color="var(--model-trend-active)" stop-opacity="0.1" />
                            <stop offset="66%" stop-color="var(--model-trend-active)" stop-opacity="0.045" />
                            <stop offset="100%" stop-color="var(--model-trend-active)" stop-opacity="0" />
                          </linearGradient>
                        </defs>
                        <path data-slot="model-trend-area" d={area()} fill={`url(#${areaGradientId})`} />
                      </svg>
                    )}
                  </Show>
                  <svg
                    data-slot="model-trend-line"
                    data-layer="base"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <Show
                      when={activeLineBreak()}
                      fallback={<path data-slot="model-trend-line-base" data-tone={props.lineTone} d={path()} />}
                    >
                      {(lineBreak) => (
                        <>
                          <defs>
                            <mask id={activeLineMaskId} maskUnits="userSpaceOnUse">
                              <rect x="0" y="-2" width="100" height="104" fill="white" />
                              <rect x={lineBreak().x} y="-2" width={lineBreak().width} height="104" fill="black" />
                            </mask>
                          </defs>
                          <path
                            data-slot="model-trend-line-base"
                            data-tone={props.activeLineBaseTone ?? props.lineTone}
                            d={path()}
                            mask={`url(#${activeLineMaskId})`}
                          />
                        </>
                      )}
                    </Show>
                  </svg>
                  <Show when={activeLineClip()}>
                    {(clip) => (
                      <svg
                        data-slot="model-trend-line"
                        data-layer="active"
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <defs>
                          <clipPath id={activeLineClipId} clipPathUnits="userSpaceOnUse">
                            <rect x={clip().x} y="-2" width={clip().width} height="104" />
                          </clipPath>
                        </defs>
                        <path data-slot="model-trend-line-active" d={path()} clip-path={`url(#${activeLineClipId})`} />
                      </svg>
                    )}
                  </Show>
                </>
              )}
            </Show>
            <Show when={linePoints().at(-1)}>
              {(point) => (
                <span
                  data-slot="model-trend-end-marker"
                  data-tone={props.lineTone}
                  aria-hidden="true"
                  style={
                    {
                      "--model-trend-end-x": `${point().x}%`,
                      "--model-trend-end-top": `${point().y * lineScale}%`,
                    } as JSX.CSSProperties
                  }
                />
              )}
            </Show>
            <div data-slot="model-trend-bars">
              <For each={usage()}>
                {(point, index) => (
                  <div
                    data-slot="model-trend-column"
                    role="button"
                    tabIndex={0}
                    aria-label={`${point.date} ${props.formatValue(props.value(point))} ${props.valueUnit}`}
                    data-active={activeIndex() === index() ? "true" : undefined}
                    data-muted={
                      highlightBars() && activeIndex() !== undefined && activeIndex() !== index() ? "true" : undefined
                    }
                    style={
                      {
                        "--model-trend-token-height": modelUsageStripHeight(props.value(point), valueMax()),
                      } as JSX.CSSProperties
                    }
                    onPointerDown={(event) => {
                      if (event.pointerType !== "touch") return
                      setActiveIndex(index())
                    }}
                    onPointerEnter={() => setActiveIndex(index())}
                    onPointerMove={(event) => {
                      if (event.pointerType === "touch") return
                      setActiveIndex(index())
                    }}
                    onClick={() => setActiveIndex(index())}
                    onFocus={() => setActiveIndex(index())}
                    onBlur={() => setActiveIndex(undefined)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return
                      event.preventDefault()
                      setActiveIndex(index())
                    }}
                  >
                    <div data-slot="model-trend-token-band">
                      <div data-slot="model-trend-token-bar" />
                    </div>
                  </div>
                )}
              </For>
            </div>
            <Show when={activeTooltip()} keyed>
              {(active) => (
                <div
                  data-component="chart-tooltip"
                  data-placement={active.index > usage().length * 0.62 ? "left" : "right"}
                  style={
                    {
                      "--model-trend-tooltip-left": `${active.bounds.x}%`,
                      "--model-trend-tooltip-right": `${active.bounds.x + active.bounds.width}%`,
                      "--model-trend-tooltip-y": `${active.tooltipY}`,
                    } as JSX.CSSProperties
                  }
                >
                  <strong>{formatModelUsageTooltipDate(active.point.date, props.data?.updatedAt ?? null)}</strong>
                  <span>
                    {props.formatValue(props.value(active.point))} {props.valueUnit}
                  </span>
                  <div data-slot="tooltip-divider" />
                  <p>
                    <span data-slot="tooltip-label">
                      <i data-kind={props.lineTone === "active" ? "users" : "tokens"} />
                      <span data-slot="tooltip-name">{props.rowLabel}</span>
                    </span>
                    <b>{props.formatValue(props.value(active.point))}</b>
                  </p>
                </div>
              )}
            </Show>
          </div>
          <div data-slot="model-trend-months" aria-hidden="true">
            <For each={monthTicks()}>
              {(tick) => (
                <span
                  data-align={tick.align}
                  style={{ "--model-trend-month-left": `${tick.left}%` } as JSX.CSSProperties}
                >
                  {tick.label}
                </span>
              )}
            </For>
          </div>
        </div>
      </Show>
    </section>
  )
}

function ModelEfficiencySection(props: { data: StatsModelPageData | null; catalog: ModelCatalogEntry | null }) {
  const i18n = useI18n()
  return (
    <section id="efficiency" data-section="model-panel">
      <SectionTitle
        href="#efficiency"
        title={i18n.t("nav.efficiency")}
        description={i18n.t("model.efficiencyDescription")}
      />
      <Show
        when={props.data}
        fallback={
          <ModelEmptyState
            title={i18n.t("model.noEfficiencyTitle")}
            description={i18n.t("model.noEfficiencyDescription")}
          />
        }
      >
        {(data) => (
          <>
            <div data-slot="model-efficiency-pattern" aria-hidden="true" />
            <div data-component="model-efficiency-grid">
              <MetricCard label={i18n.t("model.totalSpendLabel")} value={formatMoney(data().totals.cost)} />
              <MetricCard
                label={i18n.t("model.costInput")}
                value={formatCatalogUnitPrice(props.catalog?.cost?.input)}
              />
              <MetricCard
                label={i18n.t("model.costOutput")}
                value={formatCatalogUnitPrice(props.catalog?.cost?.output)}
              />
              <MetricCard
                label={i18n.t("model.averageCostSession")}
                value={formatSessionCost(data().totals.costPerSession)}
              />
              <MetricCard
                label={i18n.t("model.averageTokensSession")}
                value={formatTokens(data().totals.tokensPerSession)}
              />
              <MetricCard
                label={i18n.t("model.cacheRatio")}
                value={`${formatPercent(data().totals.cacheRatio)} ${i18n.t("model.inputTokens")}`}
              />
            </div>
          </>
        )}
      </Show>
    </section>
  )
}

function ModelGeoBreakdownSection(props: { data: CountryEntry[] }) {
  const i18n = useI18n()
  const [activeCountry, setActiveCountry] = createSignal<string>()
  const data = createMemo(() => props.data)
  const maxTokens = createMemo(() => Math.max(0, ...data().map((country) => country.tokens)) || 1)
  const topCountries = createMemo(() => data().slice(0, 15))

  return (
    <section
      id="geo-breakdown"
      data-section="geo-breakdown"
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return
        setActiveCountry(undefined)
      }}
    >
      <SectionTitle href="#geo-breakdown" title={i18n.t("home.geoTitle")} />
      <Show
        when={data().length > 0}
        fallback={<ModelEmptyState title={i18n.t("model.noGeoTitle")} description={i18n.t("model.noGeoDescription")} />}
      >
        <div data-component="geo-breakdown">
          <GeoCountryList
            data={topCountries()}
            activeCountry={activeCountry()}
            maxTokens={maxTokens()}
            onActiveCountryChange={setActiveCountry}
          />
        </div>
      </Show>
    </section>
  )
}

function GeoCountryList(props: {
  data: CountryEntry[]
  activeCountry: string | undefined
  maxTokens: number
  onActiveCountryChange: (country: string | undefined) => void
}) {
  const i18n = useI18n()
  const language = useLanguage()
  const opacityScale = createMemo(() => scaleSqrt().domain([0, props.maxTokens]).range([0.26, 0.96]).clamp(true))

  return (
    <ol data-component="geo-country-list">
      <For each={props.data}>
        {(country) => (
          <li>
            <button
              type="button"
              data-active={props.activeCountry === country.country ? "true" : undefined}
              style={{ "--geo-row-opacity": String(opacityScale()(country.tokens)) } as JSX.CSSProperties}
              aria-label={`${formatCountryName(country.country, language.tag(language.locale()), i18n)} ${formatGeoTokens(country.tokens)} ${formatGeoShare(country.share)}`}
              onClick={() => props.onActiveCountryChange(country.country)}
              onPointerEnter={() => props.onActiveCountryChange(country.country)}
              onFocus={() => props.onActiveCountryChange(country.country)}
            >
              <span>{String(country.rank).padStart(2, "0")}</span>
              <i />
              <strong>{formatCountryName(country.country, language.tag(language.locale()), i18n)}</strong>
              <em>{formatGeoTokens(country.tokens)}</em>
              <b>{formatGeoShare(country.share)}</b>
            </button>
          </li>
        )}
      </For>
    </ol>
  )
}

function ModelPeersSection(props: { data: StatsModelPageData | null; catalogLabs: readonly string[] }) {
  const i18n = useI18n()
  return (
    <section id="peers" data-section="model-panel">
      <SectionTitle href="#peers" title={i18n.t("nav.peers")} description={i18n.t("model.peersDescription")} />
      <Show
        when={props.data?.peers.length}
        fallback={
          <ModelEmptyState title={i18n.t("model.noPeersTitle")} description={i18n.t("model.noPeersDescription")} />
        }
      >
        <ol data-component="model-peer-list">
          <For each={props.data?.peers ?? []}>
            {(peer) => (
              <PeerRow peer={peer} active={peer.model === props.data?.model} catalogLabs={props.catalogLabs} />
            )}
          </For>
        </ol>
      </Show>
    </section>
  )
}

function MetricCard(props: { label: string; value: string; detail?: string; state?: "positive" | "negative" }) {
  return (
    <article data-component="model-metric" data-state={props.state}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <Show when={props.detail}>{(detail) => <p>{detail()}</p>}</Show>
    </article>
  )
}

function PeerRow(props: { peer: ModelPeerEntry; active: boolean; catalogLabs: readonly string[] }) {
  const language = useLanguage()
  const hasProvider = () => isKnownCatalogLab(props.peer.provider, props.catalogLabs)
  return (
    <li>
      <a
        href={language.route(`${import.meta.env.BASE_URL}${providerSlug(props.peer.provider)}/${props.peer.slug}`)}
        data-active={props.active ? "true" : undefined}
        data-providerless={!hasProvider() ? "true" : undefined}
      >
        <span data-slot="model-peer-rank" aria-label={props.active ? `Rank ${props.peer.rank}` : undefined}>
          <Show when={!props.active}>{String(props.peer.rank).padStart(2, "0")}</Show>
        </span>
        <Show when={hasProvider()}>
          <span data-slot="model-peer-avatar">
            <ProviderIcon aria-hidden="true" id={getProviderIconId(props.peer.author)} />
          </span>
        </Show>
        <span data-slot="model-peer-copy">
          <strong>{props.peer.model}</strong>
          <Show when={hasProvider()}>
            <em>{props.peer.author}</em>
          </Show>
        </span>
        <b>{formatTokens(props.peer.tokens)}</b>
      </a>
    </li>
  )
}

function SectionTitle(props: { href: string; title: string; description?: string }) {
  return <SectionHeading href={props.href} title={props.title} description={props.description} />
}

function ModelEmptyState(props: { title: string; description: string; compact?: boolean }) {
  return (
    <div data-component="empty-state" data-compact={props.compact ? "true" : undefined}>
      <strong>{props.title}</strong>
      <p>{props.description}</p>
    </div>
  )
}

function modelComparisonPairs(
  catalogModels: ModelCatalogOption[] | undefined,
  catalogLabs: readonly string[],
  catalogEntry: ModelCatalogEntry | null,
  data: StatsModelPageData | null,
) {
  const current = modelComparisonRef(catalogEntry, data)
  if (!current) return []
  const peerPairs = (data?.peers ?? [])
    .filter((peer) => peer.model !== data?.model)
    .slice(0, 3)
    .map((peer) => ({
      first: current,
      second: {
        name: peer.model,
        lab: peer.provider,
        slug: peer.slug,
        labName: isKnownCatalogLab(peer.provider, catalogLabs) ? peer.author : undefined,
        metric: `#${peer.rank} / ${formatTokens(peer.tokens)}`,
      },
      detail: "Usage peer",
    }))
  const catalogPairs = (catalogEntry ? (catalogModels ?? []) : [])
    .filter((model) => model.id !== catalogEntry?.id)
    .slice(0, 3)
    .map((model) => ({
      first: current,
      second: modelRefFromCatalog(model),
      detail: "Same lab pair",
    }))
  return uniqueComparisonPairs([...peerPairs, ...catalogPairs])
}

function modelComparisonRef(
  catalogEntry: ModelCatalogEntry | null,
  data: StatsModelPageData | null,
): ComparisonModelRef | undefined {
  if (catalogEntry) return modelRefFromCatalog(catalogEntry)
  if (!data) return undefined
  return {
    name: data.model,
    lab: data.provider,
    slug: data.slug,
    labName: undefined,
    metric: `#${data.rank}`,
  }
}

function getProviderIconId(author: string) {
  if (author === "MiniMax") return "minimax"
  if (author === "Moonshot") return "moonshotai"
  if (author === "Zhipu") return "zhipuai"
  return author.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function countryNumericId(country: string) {
  return countryNumericIds.get(country.toUpperCase())?.padStart(3, "0")
}

function formatCountryName(country: string, locale: string, i18n: ReturnType<typeof useI18n>) {
  const code = country.toUpperCase()
  if (code === "ZZ") return i18n.t("home.unknown")
  if (!countryNumericId(code)) return code
  return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code
}

function formatGeoTokens(value: number) {
  return formatTokens(value * 1_000_000_000_000)
}

function formatGeoShare(value: number) {
  return `${value.toFixed(value > 0 && value < 1 ? 1 : 0)}%`
}

function momentumChart(data: ModelUsagePoint[], updatedAt: string | null) {
  const fallbackDate = updatedAt ? formatMomentumDateLabel(updatedAt) : "JAN 1"
  const points =
    data.length > 1 ? data : [data[0] ?? emptyUsagePoint(fallbackDate), data[0] ?? emptyUsagePoint(fallbackDate)]
  const max = Math.max(1, ...points.map((point) => point.tokens))
  const split = Math.max(1, Math.floor((points.length - 1) / 2))
  const coordinates = points.map((point, index) => ({
    date: point.date,
    tokens: point.tokens,
    x: (index / Math.max(1, points.length - 1)) * 1200,
    y: 364 - (point.tokens / max) * 364,
  }))
  const end = coordinates[coordinates.length - 1]
  return {
    startDate: coordinates[0].date,
    endDate: end.date,
    previousPath: smoothLinePath(coordinates.slice(0, split + 1)),
    currentPath: smoothLinePath(coordinates.slice(split)),
    markers: [
      { ...coordinates[0], active: false },
      { ...coordinates[split], active: true },
      { ...end, active: true },
    ],
    endStyle: {
      "--momentum-end-x": `${Math.min(94, Math.max(0, ((end.x + 8) / 1200) * 100))}%`,
      "--momentum-end-y": `${Math.min(96, Math.max(0, ((end.y - 7) / 370) * 100))}%`,
    } as JSX.CSSProperties,
  }
}

function emptyUsagePoint(date: string): ModelUsagePoint {
  return { date, tokens: 0, users: 0, sessions: 0, cost: 0 }
}

function smoothLinePath(points: { x: number; y: number }[]) {
  if (points.length === 0) return ""
  if (points.length === 1) return `M${formatSparklinePoint(points[0].x)} ${formatSparklinePoint(points[0].y)}`
  return points
    .map((point, index) => {
      if (index === 0) return `M${formatSparklinePoint(point.x)} ${formatSparklinePoint(point.y)}`
      const previous = points[index - 1]
      const next = points[index + 1] ?? point
      const beforePrevious = points[index - 2] ?? previous
      const controlStart = {
        x: previous.x + (point.x - beforePrevious.x) / 6,
        y: previous.y + (point.y - beforePrevious.y) / 6,
      }
      const controlEnd = {
        x: point.x - (next.x - previous.x) / 6,
        y: point.y - (next.y - previous.y) / 6,
      }
      return `C${formatSparklinePoint(controlStart.x)} ${formatSparklinePoint(controlStart.y)} ${formatSparklinePoint(controlEnd.x)} ${formatSparklinePoint(controlEnd.y)} ${formatSparklinePoint(point.x)} ${formatSparklinePoint(point.y)}`
    })
    .join(" ")
}

function momentumMonthLabels(startDate: string, locale: string, updatedAt: string | null) {
  const start = parseMomentumDate(startDate, updatedAt)
  const first = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1))
  return Array.from({ length: 5 }, (_, index) => {
    const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + index, 1))
    return {
      label: new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(date).toUpperCase(),
      x: index === 4 ? 98 : index * 24.5,
    }
  })
}

function formatMomentumDate(date: string, locale: string, updatedAt: string | null) {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(parseMomentumDate(date, updatedAt))
    .toUpperCase()
}

function parseMomentumDate(date: string, updatedAt: string | null): Date {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))

  const label = /^([A-Za-z]{3})\s+(\d{1,2})$/.exec(date.trim())
  const month = label ? shortMonths.findIndex((item) => item.toLowerCase() === label[1].toLowerCase()) : -1
  if (!label || month < 0) return new Date(Date.UTC(1970, 0, 1))

  const anchor = updatedAt ? parseMomentumDate(updatedAt, null) : new Date(Date.UTC(1970, 0, 1))
  const year = month > anchor.getUTCMonth() + 1 ? anchor.getUTCFullYear() - 1 : anchor.getUTCFullYear()
  return new Date(Date.UTC(year, month, Number(label[2])))
}

function formatMomentumDateLabel(date: string) {
  const parsed = parseMomentumDate(date, null)
  if (parsed.getUTCFullYear() === 1970) return "JAN 1"
  return `${shortMonths[parsed.getUTCMonth()]} ${parsed.getUTCDate()}`
}

function modelUsageStripHeight(value: number, max: number) {
  if (value <= 0 || max <= 0) return "0px"
  return `max(2px, ${(value / max) * 100}%)`
}

function modelUsageLineY(value: number, max: number) {
  if (value <= 0 || max <= 0) return 100
  return Math.max(0, 100 - (value / max) * 100)
}

function modelUsagePointX(index: number, count: number) {
  if (count <= 1) return 50
  return ((index + 0.5) / count) * 100
}

function modelUsageColumnBounds(index: number, count: number) {
  if (count <= 0) return { x: 0, width: 100 }
  return { x: (index / count) * 100, width: 100 / count }
}

function modelUsageColumnInnerBounds(index: number, count: number) {
  const bounds = modelUsageColumnBounds(index, count)
  const inset = Math.min(bounds.width * 0.1, 0.24)
  return { x: bounds.x + inset, width: Math.max(0.001, bounds.width - inset * 2) }
}

type ModelUsageLinePoint = { x: number; y: number }

function modelUsageLinePath(points: ModelUsageLinePoint[]) {
  if (points.length === 0) return ""
  if (points.length === 1) return `M ${formatUsagePathNumber(points[0].x)} ${formatUsagePathNumber(points[0].y)}`

  return points.slice(0, -1).reduce(
    (path, point, index) => {
      const next = points[index + 1]
      const previous = points[index - 1] ?? point
      const afterNext = points[index + 2] ?? next
      const controlA = {
        x: point.x + (next.x - previous.x) / 6,
        y: clampUsagePercent(point.y + (next.y - previous.y) / 6),
      }
      const controlB = {
        x: next.x - (afterNext.x - point.x) / 6,
        y: clampUsagePercent(next.y - (afterNext.y - point.y) / 6),
      }
      return `${path} C ${formatUsagePathNumber(controlA.x)} ${formatUsagePathNumber(controlA.y)}, ${formatUsagePathNumber(controlB.x)} ${formatUsagePathNumber(controlB.y)}, ${formatUsagePathNumber(next.x)} ${formatUsagePathNumber(next.y)}`
    },
    `M ${formatUsagePathNumber(points[0].x)} ${formatUsagePathNumber(points[0].y)}`,
  )
}

function modelUsageAreaPath(points: ModelUsageLinePoint[], bottom: number) {
  const path = modelUsageLinePath(points)
  if (!path || points.length === 0) return ""
  const first = points[0]
  const last = points[points.length - 1]
  return `${path} L ${formatUsagePathNumber(last.x)} ${formatUsagePathNumber(bottom)} L ${formatUsagePathNumber(first.x)} ${formatUsagePathNumber(bottom)} Z`
}

function formatUsagePathNumber(value: number) {
  return Number(value.toFixed(3))
}

function clampUsagePercent(value: number) {
  return Math.max(0, Math.min(100, value))
}

function modelUsageMonthTicks(points: ModelUsagePoint[], updatedAt: string | null) {
  const seen = new Set<string>()
  return points.flatMap((point, index) => {
    const parsed = parseMomentumDate(point.date, updatedAt)
    const label = shortMonths[parsed.getUTCMonth()]
    if (!label || seen.has(label)) return []
    seen.add(label)
    return [
      {
        label,
        left: modelUsagePointX(index, points.length),
        align: index === 0 ? "start" : index >= points.length - 2 ? "end" : "center",
      },
    ]
  })
}

function formatModelUsageTooltipDate(value: string, updatedAt: string | null) {
  const date = parseMomentumDate(value, updatedAt)
  if (date.getUTCFullYear() === 1970) return value
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)
}

function formatRankLabel(rank: number | null) {
  if (rank === null) return "--"
  return `#${String(rank).padStart(2, "0")}`
}

function capitalizeLabel(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function formatRankMove(change: number) {
  if (change > 0) return `+${change}`
  return `${change}`
}

function formatHeroRank(rank: number | null) {
  if (rank === null) return "--"
  return String(rank).padStart(2, "0")
}

function sparklineLinePath(values: number[]) {
  return sparklinePoints(values)
    .map(
      (point, index) => `${index === 0 ? "M" : "L"}${formatSparklinePoint(point.x)} ${formatSparklinePoint(point.y)}`,
    )
    .join(" ")
}

function sparklineAreaPath(values: number[]) {
  const points = sparklinePoints(values)
  return `M${formatSparklinePoint(points[0].x)} 18 ${points
    .map((point) => `L${formatSparklinePoint(point.x)} ${formatSparklinePoint(point.y)}`)
    .join(" ")} L${formatSparklinePoint(points[points.length - 1].x)} 18 Z`
}

function sparklinePoints(values: number[]) {
  const normalized = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0]
  const min = Math.min(...normalized)
  const max = Math.max(...normalized)
  return normalized.map((value, index) => ({
    x: 8 + (index / Math.max(1, normalized.length - 1)) * 20,
    y: min === max ? 12 : 18 - ((value - min) / (max - min)) * 12,
  }))
}

function formatSparklinePoint(value: number) {
  return Number(value.toFixed(2)).toString()
}

function formatModelRankMoveLabel(data: StatsModelPageData, i18n: ReturnType<typeof useI18n>) {
  if (data.rank === null) return i18n.t("model.noUsageLastWeek")
  if (data.previousRank === null) return i18n.t("model.newThisWeek")
  const change = data.previousRank - data.rank
  if (change === 0) return i18n.t("model.sameAsPreviousWeek")
  return i18n.t("model.vsPreviousWeek", { change: formatRankMove(change) })
}

function formatTokens(value: number) {
  if (value >= 1_000_000_000_000)
    return `${trimNumber(value / 1_000_000_000_000, value >= 10_000_000_000_000 ? 0 : 1)}T`
  if (value >= 1_000_000_000) return `${trimNumber(value / 1_000_000_000, value >= 10_000_000_000 ? 0 : 1)}B`
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000, value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${trimNumber(value / 1_000, value >= 10_000 ? 0 : 1)}K`
  return String(Math.round(value))
}

function formatCatalogLimit(value: number | undefined, unknown: string) {
  return value === undefined ? unknown : formatTokens(value)
}

function formatCatalogMonth(value: string | undefined, locale: string, unknown: string) {
  if (!value) return unknown
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(value)
  if (!match) return value
  return new Intl.DateTimeFormat(locale, {
    month: match[2] ? "short" : undefined,
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(Number(match[1]), match[2] ? Number(match[2]) - 1 : 0, 1)))
}

function formatCatalogModalities(values: string[], locale: string, unknown: string) {
  if (values.length === 0) return unknown
  const labels = values.map((value) => value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()))
  if (labels.length === 1) return labels[0] ?? unknown
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(labels)
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en").format(value)
}

function formatUsers(value: number) {
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000, value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${trimNumber(value / 1_000, value >= 10_000 ? 0 : 1)}K`
  return formatInteger(Math.round(value))
}

function formatPercent(value: number) {
  return `${value.toFixed(value > 0 && value < 10 ? 1 : 0)}%`
}

function formatMoney(value: number) {
  if (value >= 1_000_000) return `$${trimNumber(value / 1_000_000, value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `$${trimNumber(value / 1_000, value >= 10_000 ? 0 : 1)}K`
  return `$${value.toFixed(value >= 10 ? 0 : 2)}`
}

function formatCatalogUnitPrice(value: number | undefined) {
  if (value === undefined) return "-"
  return `${formatModelPrice(value)} / 1M`
}

function formatModelPrice(value: number) {
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`
  return formatMoney(value)
}

function formatSessionCost(value: number) {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`
}

function formatChange(value: number) {
  if (value > 0) return `+${value}%`
  return `${value}%`
}

function trimNumber(value: number, digits: number) {
  return Number(value.toFixed(digits)).toLocaleString("en")
}

function providerSlug(provider: string) {
  return provider
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
}

function formerModelName(model: string) {
  return statModel(model, undefined) === glmFlashModel ? "ox-alpha" : undefined
}

function publicModelName(model: string) {
  if (model === "unknown") return undefined
  if (model === glmFlashModel) return "GLM-5.3-Flash"
  return model
}
