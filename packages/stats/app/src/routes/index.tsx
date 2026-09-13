import { Meta, Title } from "@solidjs/meta"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { scaleSqrt } from "d3-scale"
import countryCodesSource from "i18n-iso-countries/codes.json?raw"
import {
  getStatsHomeData,
  type CacheRatioEntry,
  type CountryEntry,
  type LeaderboardEntry,
  type MarketDay,
  type RetentionEntry,
  type SessionCostEntry,
  type TokenCostEntry,
  type UsagePoint,
} from "@opencode-ai/stats-core/domain/home"
import { createAsync, query } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { getRequestEvent } from "solid-js/web"
import { runStatsEffect } from "../stats-runtime"
import { LocaleLinks } from "../component/locale-links"
import { useI18n } from "../context/i18n"
import { useLanguage } from "../context/language"
import { localizedUrl } from "../lib/language"
import { findModelCatalogEntry, isKnownCatalogLab, loadModelCatalog, type ModelCatalog } from "./model-catalog"
import { SectionHeading } from "./section-heading"
import { setStatsPageCacheHeaders } from "./stats-cache"
import { ComparisonCardsSection, uniqueComparisonPairs, type ComparisonModelRef } from "./compare-cards"
import {
  applyThemePreference,
  Footer,
  getGitHubStars,
  githubLink,
  Header,
  isThemePreference,
  themeStorageKey,
  type ThemePreference,
} from "./stats-shell"

const comparisonPairIndexes = [
  [0, 1, "Top two by recent usage"],
  [0, 2, "Leader vs challenger"],
  [1, 2, "Adjacent leaderboard pair"],
  [2, 3, "Top model alternative"],
] as const
const statsUnfurlPath = "banner.jpg"
const usageColors = [
  "#ed6aff",
  "#a684ff",
  "#7c86ff",
  "#51a2ff",
  "#00d3f2",
  "#00d5be",
  "#00bc7d",
  "#9ae600",
  "#ffb900",
  "#ff8904",
  "#ff6467",
]
const marketColors = ["#ed6aff", "#a684ff", "#7c86ff", "#51a2ff", "#00d3f2", "#00d5be", "#00bc7d", "#9ae600", "#ffb900"]

type UsageRange = "1D" | "1W" | "2W" | "1M" | "2M"
type IsoCountryCode = readonly [string, string, string]

type StatsHomePageData = {
  updatedAt: string | null
  usage: UsagePoint[]
  users: UsagePoint[]
  leaderboard: LeaderboardEntry[]
  market: MarketDay[]
  tokenCost: TokenCostEntry[]
  cacheRatio: CacheRatioEntry[]
  sessionCost: SessionCostEntry[]
  retention: RetentionEntry[]
  country: CountryEntry[]
  catalogLabs: string[]
}

const countryNumericIds = new Map(
  (JSON.parse(countryCodesSource) as IsoCountryCode[]).map((country) => [country[0], country[2]] as const),
)

const getData = query(async () => {
  "use server"
  const [stats, catalog] = await Promise.all([runStatsEffect(getStatsHomeData()), loadModelCatalog()])
  return {
    updatedAt: stats.updatedAt,
    usage: stats.usage.Go["2M"],
    users: stats.users.Go["2M"],
    leaderboard: stats.leaderboard.Go["2M"],
    market: stats.market["2M"],
    tokenCost: priceTokenCostFromCatalog(stats.tokenCost.Go, catalog),
    cacheRatio: stats.cacheRatio.Go,
    sessionCost: stats.sessionCost.Go,
    retention: stats.retention,
    country: stats.country,
    catalogLabs: catalog.labs.map((lab) => lab.id),
  } satisfies StatsHomePageData
}, "getStatsHomeData")

export default function StatsHome() {
  const i18n = useI18n()
  const language = useLanguage()
  const event = getRequestEvent()
  setStatsPageCacheHeaders(event?.response.headers)
  const statsHomeUrl = localizedUrl(language.locale(), "/data/")
  const statsUnfurlUrl = new URL(statsUnfurlPath, localizedUrl("en", "/data/")).toString()
  const data = createAsync(() => getData())
  const githubStars = createAsync(() => getGitHubStars())
  const [themePreference, setThemePreference] = createSignal<ThemePreference>("system")
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
      <Title>{i18n.t("app.title")}</Title>
      <Meta name="description" content={i18n.t("app.description")} />
      <LocaleLinks path="/data/" />
      <Meta property="og:type" content="website" />
      <Meta property="og:site_name" content="OpenCode" />
      <Meta property="og:title" content={i18n.t("app.title")} />
      <Meta property="og:description" content={i18n.t("app.description")} />
      <Meta property="og:url" content={statsHomeUrl} />
      <Meta property="og:image" content={statsUnfurlUrl} />
      <Meta property="og:image:type" content="image/jpeg" />
      <Meta property="og:image:width" content="1200" />
      <Meta property="og:image:height" content="630" />
      <Meta property="og:image:alt" content={i18n.t("app.unfurlAlt")} />
      <Meta name="twitter:card" content="summary_large_image" />
      <Meta name="twitter:title" content={i18n.t("app.title")} />
      <Meta name="twitter:description" content={i18n.t("app.description")} />
      <Meta name="twitter:image" content={statsUnfurlUrl} />
      <Meta name="twitter:image:alt" content={i18n.t("app.unfurlAlt")} />
      <Header githubStars={githubStars() ?? githubLink.fallbackStars} />
      <div data-component="container">
        <div data-component="content">
          <Show when={data()} fallback={<StatsLoading />}>
            {(stats) => (
              <>
                <Hero updatedAt={stats().updatedAt} />
                <TopModelsSection
                  data={stats().usage}
                  leaderboard={stats().leaderboard}
                  catalogLabs={stats().catalogLabs}
                />
                <UniqueUsersSection data={stats().users} />
                <RetentionSection data={stats().retention} />
                <SessionCostSection data={stats().sessionCost} />
                <TokenCostSection data={stats().tokenCost} />
                <CacheRatioSection data={stats().cacheRatio} />
                <MarketShareSection data={stats().market} />
                <GeoBreakdownSection data={stats().country} />
                <ComparisonCardsSection
                  pairs={homeComparisonPairs(stats().leaderboard, stats().catalogLabs)}
                  title="Model Comparisons"
                  description="Popular model pairs from the leaderboard."
                  variant="featured"
                />
              </>
            )}
          </Show>
        </div>
        <Footer
          themePreference={themePreference()}
          onThemePreferenceChange={updateThemePreference}
          bridge={{ href: "#model-comparison", label: "MODEL COMPARISONS" }}
        />
      </div>
    </main>
  )
}

function Hero(props: { updatedAt: string | null }) {
  const i18n = useI18n()
  const language = useLanguage()
  const [timeZone, setTimeZone] = createSignal("UTC")
  const [previousTimeZone, setPreviousTimeZone] = createSignal("UTC")
  const [isTicking, setIsTicking] = createSignal(false)
  const updatedAtParts = (timeZone: string) =>
    props.updatedAt
      ? formatUpdatedAtParts(props.updatedAt, timeZone, language.tag(language.locale()), i18n.t("home.justNow"))
      : { date: i18n.t("home.noRows"), time: "" }
  const previousUpdatedAt = createMemo(() => updatedAtParts(previousTimeZone()))
  const currentUpdatedAt = createMemo(() => updatedAtParts(timeZone()))
  const currentUpdatedLabel = createMemo(() =>
    props.updatedAt ? `${i18n.t("home.updated")} ${formatUpdatedAtLabel(currentUpdatedAt())}` : i18n.t("home.noRows"),
  )
  const isDateTicking = createMemo(() => isTicking() && previousUpdatedAt().date !== currentUpdatedAt().date)
  const isTimeTicking = createMemo(() => isTicking() && previousUpdatedAt().time !== currentUpdatedAt().time)

  onMount(() => {
    if (!props.updatedAt) return
    const nextTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    if (nextTimeZone === "UTC") return
    if (
      formatUpdatedAtLabel(
        formatUpdatedAtParts(props.updatedAt, nextTimeZone, language.tag(language.locale()), i18n.t("home.justNow")),
      ) === formatUpdatedAtLabel(updatedAtParts("UTC"))
    )
      return
    const timeouts: number[] = []
    timeouts.push(
      window.setTimeout(() => {
        setPreviousTimeZone(timeZone())
        setTimeZone(nextTimeZone)
        setIsTicking(true)
        timeouts.push(
          window.setTimeout(() => {
            setPreviousTimeZone(nextTimeZone)
            setIsTicking(false)
          }, 720),
        )
      }, 480),
    )
    onCleanup(() => timeouts.forEach((timeout) => window.clearTimeout(timeout)))
  })

  return (
    <section data-section="hero">
      <p data-slot="hero-meta" role="status" aria-atomic="true">
        <span data-slot="visually-hidden">{currentUpdatedLabel()}</span>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M13 13H3V3H13V13ZM6.46777 6.81641V7.81641H7.5791V11.3721H8.5791V6.81641H6.46777ZM7.30078 4.62891V5.62891H8.85645V4.62891H7.30078Z"
            fill="currentColor"
          />
        </svg>
        {props.updatedAt ? (
          <>
            <span data-slot="hero-meta-label" aria-hidden="true">
              {i18n.t("home.updated")}
            </span>
            <span data-slot="hero-meta-time" aria-hidden="true">
              <HeroMetaTickerPart
                previous={previousUpdatedAt().date}
                current={currentUpdatedAt().date}
                ticking={isDateTicking()}
              />
              <span data-slot="hero-meta-separator">,</span>
              <HeroMetaTickerPart
                previous={previousUpdatedAt().time}
                current={currentUpdatedAt().time}
                ticking={isTimeTicking()}
              />
            </span>
          </>
        ) : (
          <span data-slot="hero-meta-empty">{i18n.t("home.noRows")}</span>
        )}
      </p>
      <div data-slot="hero-canvas">
        <div data-slot="hero-pattern" aria-hidden="true" />
        <h1>
          <a data-slot="heading-link" href="#overview">
            {i18n.t("footer.modelData")}
          </a>
        </h1>
        <p data-slot="hero-copy">{i18n.t("home.heroCopy")}</p>
      </div>
    </section>
  )
}

function HeroMetaTickerPart(props: { previous: string; current: string; ticking: boolean }) {
  return (
    <span data-slot="hero-meta-ticker" data-ticking={props.ticking}>
      <span data-slot="hero-meta-ticker-track">
        <span data-slot="hero-meta-ticker-item">{props.previous}</span>
        <span data-slot="hero-meta-ticker-item">{props.current}</span>
      </span>
    </span>
  )
}

function StatsLoading() {
  const i18n = useI18n()
  return (
    <>
      <Hero updatedAt={null} />
      <ChartSection id="top-models" title={i18n.t("home.usageTitle")}>
        <EmptyState title={i18n.t("home.loadingTitle")} description={i18n.t("home.loadingDescription")} />
      </ChartSection>
    </>
  )
}

function ChartSection(props: {
  id?: string
  title: string
  description?: string
  controls?: JSX.Element
  children: JSX.Element
}) {
  return (
    <section id={props.id} data-section="chart">
      <div data-slot="section-header">
        <div>
          <h2>
            <Show when={props.id} fallback={props.title}>
              {(id) => (
                <a data-slot="heading-link" href={`#${id()}`}>
                  {props.title}
                </a>
              )}
            </Show>
          </h2>
          {props.description && <p>{props.description}</p>}
        </div>
        {props.controls}
      </div>
      {props.children}
    </section>
  )
}

function SectionTitle(props: { id: string; title: string; description?: string }) {
  return <SectionHeading href={`#${props.id}`} title={props.title} description={props.description} />
}

function SectionBridge(props: { label: string; href: string }) {
  const i18n = useI18n()
  return (
    <a data-component="section-bridge" href={props.href}>
      <span>{i18n.t("bridge.learnMore")}</span>
      <i />
      <strong>{props.label}</strong>
      <b>▸</b>
    </a>
  )
}

function EmptyState(props: { title: string; description: string }) {
  return (
    <div data-component="empty-state">
      <strong>{props.title}</strong>
      <p>{props.description}</p>
    </div>
  )
}

function formatUpdatedAtParts(value: string, timeZone: string, locale: string, fallback: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { date: fallback, time: "" }
  return {
    date: new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      timeZone,
    }).format(date),
    time: new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(date),
  }
}

function formatUpdatedAtLabel(value: { date: string; time: string }) {
  if (!value.time) return value.date
  return `${value.date}, ${value.time}`
}

function TopModelsSection(props: {
  data: UsagePoint[]
  leaderboard: LeaderboardEntry[]
  catalogLabs: readonly string[]
}) {
  const i18n = useI18n()
  const [activeModel, setActiveModel] = createSignal<string>()

  return (
    <section id="top-models" data-section="top-models">
      <SectionHeading
        as="h2"
        slot="top-models-title"
        href="#top-models"
        title={i18n.t("nav.topModels")}
        description={i18n.t("home.topModelsDescription")}
      />
      <Show
        when={props.data.some((item) => usageTotal(item) > 0)}
        fallback={<EmptyState title={i18n.t("home.noUsageTitle")} description={i18n.t("home.noUsageDescription")} />}
      >
        <TopModelsChart data={props.data} range="2M" activeModel={activeModel()} onActiveModelChange={setActiveModel} />
      </Show>
      <Show
        when={props.leaderboard.length > 0}
        fallback={
          <EmptyState title={i18n.t("home.noLeaderboardTitle")} description={i18n.t("home.noLeaderboardDescription")} />
        }
      >
        <Leaderboard
          data={props.leaderboard}
          activeModel={activeModel()}
          onActiveModelChange={setActiveModel}
          catalogLabs={props.catalogLabs}
        />
      </Show>
    </section>
  )
}

function TopModelsChart(props: {
  data: UsagePoint[]
  range: UsageRange
  metric?: "tokens" | "users"
  ariaLabel?: string
  activeModel: string | undefined
  onActiveModelChange: (model: string | undefined) => void
}) {
  const i18n = useI18n()
  let chartRef: HTMLDivElement | undefined
  const [activeIndex, setActiveIndex] = createSignal<number>()
  const maxTotal = createMemo(() => getTopModelsMaxTotal(props.data))
  const segmentOrder = createMemo(() => getTopModelsSegmentOrder(props.data))
  const activePoint = createMemo(() => props.data[activeIndex() ?? -1])
  const metric = createMemo(() => props.metric ?? "tokens")

  createEffect(() => scrollDenseChartToEnd(chartRef, props.range, props.data.length))

  return (
    <div
      ref={chartRef}
      data-component="top-models-chart"
      data-range={props.range}
      data-metric={metric()}
      data-dense-labels={isDenseColumnRange(props.range) ? "true" : undefined}
      role="img"
      aria-label={props.ariaLabel ?? i18n.t("home.stackedUsageChart")}
      style={{ "--top-models-count": props.data.length } as JSX.CSSProperties}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return
        setActiveIndex(undefined)
        props.onActiveModelChange(undefined)
      }}
    >
      <div data-slot="top-models-axis" aria-hidden="true">
        <For each={props.data}>
          {(day, index) => (
            <div
              data-active={activeIndex() === index() ? "true" : undefined}
              data-label-hidden={isColumnLabelHidden(index(), props.data.length) ? "true" : undefined}
              data-mobile-hidden={isTopModelsMobileAxisHidden(index(), props.data.length) ? "true" : undefined}
            >
              <span data-slot="axis-label">
                <span data-slot="axis-total">{formatUsageChartValue(usageTotal(day), metric())}</span>
                <span data-slot="axis-date">
                  <span data-slot="axis-date-full">{day.date}</span>
                  <span data-slot="axis-date-mobile">{formatTopModelsMobileDate(day.date, props.range)}</span>
                </span>
              </span>
            </div>
          )}
        </For>
      </div>
      <div
        data-slot="top-models-bars"
        onPointerLeave={(event) => {
          if (event.pointerType === "touch") return
          setActiveIndex(undefined)
          props.onActiveModelChange(undefined)
        }}
      >
        <For each={props.data}>
          {(day, dayIndex) => (
            <div
              data-slot="top-models-bar"
              role="button"
              tabIndex={0}
              aria-label={`${day.date} ${formatUsageChartValue(usageTotal(day), metric())} ${usageChartTotalLabel(metric(), i18n)}`}
              data-active={activeIndex() === dayIndex() ? "true" : undefined}
              data-muted={activeIndex() !== undefined && activeIndex() !== dayIndex() ? "true" : undefined}
              style={{ "--top-models-bar-height": `${getTopModelsBarHeight(usageTotal(day), maxTotal())}%` }}
              onPointerDown={(event) => {
                if (event.pointerType !== "touch") return
                setActiveIndex(dayIndex())
                props.onActiveModelChange(undefined)
              }}
              onPointerEnter={(event) => {
                setActiveIndex(dayIndex())
                if (isTopModelsBlankHover(event.currentTarget, event.clientY)) props.onActiveModelChange(undefined)
              }}
              onPointerMove={(event) => {
                if (event.pointerType === "touch") return
                setActiveIndex(dayIndex())
                if (isTopModelsBlankHover(event.currentTarget, event.clientY)) props.onActiveModelChange(undefined)
              }}
              onClick={() => {
                setActiveIndex(dayIndex())
                props.onActiveModelChange(undefined)
              }}
              onFocus={() => {
                setActiveIndex(dayIndex())
                props.onActiveModelChange(undefined)
              }}
              onBlur={() => {
                setActiveIndex(undefined)
                props.onActiveModelChange(undefined)
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                setActiveIndex(dayIndex())
                props.onActiveModelChange(undefined)
              }}
            >
              <div
                data-slot="top-models-stack"
                style={{ "grid-template-rows": getTopModelsSegmentRows(day, segmentOrder()) }}
              >
                <For each={stackedTopModelsSegments(day, segmentOrder())}>
                  {(item) => (
                    <i
                      data-series={item.index}
                      data-model={item.segment.model}
                      data-active={props.activeModel === item.segment.model ? "true" : undefined}
                      style={{
                        background: getTopModelsSegmentColor(
                          item.segment.model,
                          item.index,
                          segmentOrder(),
                          activeIndex() !== undefined && activeIndex() !== dayIndex(),
                          props.activeModel,
                        ),
                      }}
                      onPointerEnter={(event) => {
                        event.stopPropagation()
                        setActiveIndex(dayIndex())
                        props.onActiveModelChange(item.segment.model)
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation()
                        setActiveIndex(dayIndex())
                        props.onActiveModelChange(item.segment.model)
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        setActiveIndex(dayIndex())
                        props.onActiveModelChange(item.segment.model)
                      }}
                    />
                  )}
                </For>
              </div>
              <Show when={activeIndex() === dayIndex() && activePoint()}>
                {(point) => (
                  <div
                    data-component="chart-tooltip"
                    data-placement={dayIndex() > props.data.length * 0.62 ? "left" : "right"}
                  >
                    <strong>{point().date}</strong>
                    <Show when={metric() === "tokens"}>
                      <span>
                        {formatUsageChartValue(usageTotal(point()), metric())} {usageChartTotalLabel(metric(), i18n)}
                      </span>
                    </Show>
                    <Show when={metric() === "tokens"}>
                      <div data-slot="tooltip-divider" />
                    </Show>
                    <For each={visibleTopModelsSegments(point())}>
                      {(item) => (
                        <p
                          data-active={props.activeModel === item.segment.model ? "true" : undefined}
                          data-muted={
                            props.activeModel !== undefined && props.activeModel !== item.segment.model
                              ? "true"
                              : undefined
                          }
                        >
                          <span data-slot="tooltip-label">
                            <i
                              style={{
                                background: getRankColor(item.segment.model, item.index, segmentOrder(), usageColors),
                              }}
                            />
                            <span data-slot="tooltip-name">{item.segment.model}</span>
                          </span>
                          <b>{formatUsageChartValue(item.segment.value, metric())}</b>
                        </p>
                      )}
                    </For>
                  </div>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function UniqueUsersSection(props: { data: UsagePoint[] }) {
  const i18n = useI18n()
  const [activeModel, setActiveModel] = createSignal<string>()

  return (
    <section id="unique-users" data-section="unique-users">
      <SectionBridge label={i18n.t("nav.topModels").toUpperCase()} href="#top-models" />
      <SectionTitle
        id="unique-users"
        title={i18n.t("home.uniqueUsersTitle")}
        description={i18n.t("home.uniqueUsersDescription")}
      />
      <Show
        when={props.data.some((item) => usageTotal(item) > 0)}
        fallback={
          <EmptyState title={i18n.t("home.noUserDataTitle")} description={i18n.t("home.noUserDataDescription")} />
        }
      >
        <TopModelsChart
          data={props.data}
          range="2M"
          metric="users"
          ariaLabel={i18n.t("home.uniqueUsersChart")}
          activeModel={activeModel()}
          onActiveModelChange={setActiveModel}
        />
      </Show>
    </section>
  )
}

function RetentionSection(props: { data: RetentionEntry[] }) {
  const language = useLanguage()
  const [activeIndex, setActiveIndex] = createSignal(0)

  return (
    <section id="retention" data-section="retention">
      <SectionTitle id="retention" title="Weekly Retention" description="Weekly users returning the next week." />
      <Show
        when={props.data.length > 0}
        fallback={
          <EmptyState
            title="No retention data"
            description="Retention appears after a complete return week is available."
          />
        }
      >
        <div data-component="retention-chart">
          <div data-slot="retention-heading" aria-hidden="true">
            <span>Rank</span>
            <strong>Model</strong>
            <i>Retention</i>
            <b>Rate</b>
            <em>Eligible</em>
          </div>
          <ol>
            <For each={props.data}>
              {(item, index) => (
                <li>
                  <a
                    data-active={activeIndex() === index() ? "true" : undefined}
                    href={language.route(
                      `${import.meta.env.BASE_URL}${modelSlug(item.provider)}/${modelSlug(item.model)}`,
                    )}
                    onPointerEnter={() => setActiveIndex(index())}
                    onFocus={() => setActiveIndex(index())}
                    onClick={() => setActiveIndex(index())}
                    aria-label={`${item.model}, ${formatRetentionRate(item.rate)} weekly retention, ${formatUsers(item.eligibleUserWeeks)} eligible user-weeks`}
                  >
                    <span>{item.rank === null ? "–" : String(item.rank).padStart(2, "0")}</span>
                    <strong>{item.model}</strong>
                    <RetentionMarker rate={item.rate} active={activeIndex() === index()} />
                    <b>{formatRetentionRate(item.rate)}</b>
                    <em>{formatUsers(item.eligibleUserWeeks)}</em>
                  </a>
                </li>
              )}
            </For>
          </ol>
        </div>
      </Show>
    </section>
  )
}

function RetentionMarker(props: { rate: number; active: boolean }) {
  const fill = createMemo(() => Math.min(100, Math.max(0, props.rate)))
  return (
    <i
      data-component="retention-marker"
      data-active={props.active ? "true" : undefined}
      style={{ "--retention-position": `${fill()}%` } as JSX.CSSProperties}
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
      <span />
      <em />
    </i>
  )
}

function formatRetentionRate(value: number) {
  return `${value.toFixed(1)}%`
}

function isTopModelsBlankHover(bar: HTMLElement, clientY: number) {
  const stack = bar.querySelector<HTMLElement>('[data-slot="top-models-stack"]')
  if (!stack) return true
  return clientY < stack.getBoundingClientRect().top - 6
}

function getTopModelsBarHeight(total: number, max: number) {
  if (total <= 0) return 0
  return Math.max(2, Math.min(100, (total / max) * 100))
}

function getTopModelsMaxTotal(data: UsagePoint[]) {
  const max = Math.max(0, ...data.map((item) => usageTotal(item)))
  if (max === 0) return 1
  if (data.length === 1) return max * 1.75
  return max
}

function getTopModelsSegmentRows(point: UsagePoint, order: Map<string, number>) {
  const total = usageTotal(point)
  if (total <= 0) return ""
  return stackedTopModelsSegments(point, order)
    .map((item) => `${(item.segment.value / total) * 100}%`)
    .join(" ")
}

function visibleTopModelsSegments(point: UsagePoint) {
  return point.segments.map((segment, index) => ({ segment, index })).filter((item) => item.segment.value > 0)
}

function stackedTopModelsSegments(point: UsagePoint, order: Map<string, number>) {
  return visibleTopModelsSegments(point)
    .slice()
    .sort((a, b) => (order.get(b.segment.model) ?? b.index) - (order.get(a.segment.model) ?? a.index))
}

function getTopModelsSegmentOrder(data: UsagePoint[]) {
  return new Map(
    data.find((point) => point.segments.length > 0)?.segments.map((segment, index) => [segment.model, index]) ?? [],
  )
}

function getTopModelsSegmentColor(
  model: string,
  index: number,
  order: Map<string, number>,
  muted: boolean,
  activeModel: string | undefined,
) {
  if (activeModel !== undefined)
    return activeModel === model ? getRankColor(model, index, order, usageColors) : "var(--stats-layer-2)"
  if (muted) return "var(--stats-layer-2)"
  return getRankColor(model, index, order, usageColors)
}

function isTopModelsMobileAxisHidden(index: number, count: number) {
  return count > 7 && index % 2 === 1
}

function isColumnLabelHidden(index: number, count: number) {
  if (count <= 20) return false
  const interval = Math.ceil(count / 8)
  return index !== count - 1 && index % interval !== 0
}

function isDenseColumnRange(range: UsageRange) {
  return range === "1M" || range === "2M"
}

function scrollDenseChartToEnd(element: HTMLDivElement | undefined, range: UsageRange, count: number) {
  if (!element || count <= 0 || !isDenseColumnRange(range) || typeof window === "undefined") return
  window.requestAnimationFrame(() => {
    element.scrollLeft = Number.MAX_SAFE_INTEGER
  })
}

function formatTopModelsMobileDate(label: string, range: UsageRange) {
  if (range === "1M" || range === "2M") return label.split(" - ")[0] ?? label
  return label
}

function usageTotal(point: UsagePoint) {
  return point.segments.reduce((sum, item) => sum + item.value, 0)
}

function formatTokens(value: number) {
  if (value >= 1) return `${value.toFixed(value >= 10 ? 0 : 1)}T`
  return `${Math.round(value * 1000)}B`
}

function formatUsageChartValue(value: number, metric: "tokens" | "users") {
  if (metric === "users") return formatUsers(value)
  return formatTokens(value)
}

function usageChartTotalLabel(metric: "tokens" | "users", i18n: ReturnType<typeof useI18n>) {
  if (metric === "users") return i18n.t("home.modelUsers")
  return i18n.t("home.total")
}

function formatUsers(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return new Intl.NumberFormat("en").format(Math.round(value))
}

function Leaderboard(props: {
  data: LeaderboardEntry[]
  activeModel: string | undefined
  onActiveModelChange: (model: string | undefined) => void
  catalogLabs: readonly string[]
}) {
  const featured = createMemo(() => props.data.slice(0, 3))
  const compact = createMemo(() => props.data.slice(3))

  return (
    <div id="leaderboard" data-component="leaderboard">
      <div data-slot="leaderboard-featured">
        <For each={featured()}>
          {(entry) => (
            <LeaderboardCard
              entry={entry}
              size="featured"
              active={props.activeModel === entry.model}
              onActiveModelChange={props.onActiveModelChange}
              catalogLabs={props.catalogLabs}
            />
          )}
        </For>
      </div>
      <div data-slot="leaderboard-pattern" aria-hidden="true" />
      <div data-slot="leaderboard-compact">
        <For each={compact()}>
          {(entry) => (
            <LeaderboardCard
              entry={entry}
              size="compact"
              active={props.activeModel === entry.model}
              onActiveModelChange={props.onActiveModelChange}
              catalogLabs={props.catalogLabs}
            />
          )}
        </For>
      </div>
      <div data-slot="leaderboard-mobile">
        <For each={props.data}>
          {(entry) => (
            <LeaderboardCard
              entry={entry}
              size="featured"
              active={props.activeModel === entry.model}
              onActiveModelChange={props.onActiveModelChange}
              catalogLabs={props.catalogLabs}
            />
          )}
        </For>
      </div>
    </div>
  )
}

function LeaderboardCard(props: {
  entry: LeaderboardEntry
  size: "featured" | "compact"
  active: boolean
  onActiveModelChange: (model: string | undefined) => void
  catalogLabs: readonly string[]
}) {
  const i18n = useI18n()
  const language = useLanguage()
  const hasProvider = () => isKnownCatalogLab(props.entry.provider, props.catalogLabs)
  return (
    <a
      data-component="leader-card"
      data-size={props.size}
      data-active={props.active ? "true" : undefined}
      href={language.route(
        `${import.meta.env.BASE_URL}${modelSlug(props.entry.provider)}/${modelSlug(props.entry.model)}`,
      )}
      onPointerEnter={() => props.onActiveModelChange(props.entry.model)}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return
        props.onActiveModelChange(undefined)
      }}
      onFocus={() => props.onActiveModelChange(props.entry.model)}
      onBlur={() => props.onActiveModelChange(undefined)}
      onClick={() => props.onActiveModelChange(props.entry.model)}
    >
      <span data-slot="rank">{String(props.entry.rank).padStart(2, "0")}</span>
      <Show when={hasProvider()}>
        <ProviderIcon data-slot="leader-watermark" aria-hidden="true" id={getProviderIconId(props.entry.author)} />
      </Show>
      <div data-slot="leader-body">
        <Show when={hasProvider()}>
          <ProviderIcon data-slot="leader-avatar" aria-hidden="true" id={getProviderIconId(props.entry.author)} />
        </Show>
        <div data-slot="leader-copy">
          <div>
            <strong>{props.entry.model}</strong>
            <span>{formatBillions(props.entry.tokens)}</span>
          </div>
          <div>
            <Show when={hasProvider()} fallback={<span />}>
              <span>{props.entry.author}</span>
            </Show>
            <span
              data-slot="delta"
              data-new={props.entry.change === null ? "true" : undefined}
              data-negative={props.entry.change !== null && props.entry.change < 0 ? "true" : undefined}
            >
              {formatChange(props.entry.change, i18n)}
            </span>
          </div>
        </div>
      </div>
    </a>
  )
}

function getProviderIconId(author: string) {
  if (author === "MiniMax") return "minimax"
  if (author === "Moonshot") return "moonshotai"
  if (author === "Zhipu") return "zhipuai"
  return author.toLowerCase()
}

function formatBillions(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}T`
  return `${value}B`
}

function formatChange(value: number | null, i18n: ReturnType<typeof useI18n>) {
  if (value === null) return i18n.t("home.new")
  if (value > 0) return `+${value}%`
  return `${value}%`
}

function MarketShareSection(props: { data: MarketDay[] }) {
  const i18n = useI18n()
  const [activeIndex, setActiveIndex] = createSignal(2)
  const [activeAuthor, setActiveAuthor] = createSignal<string>()
  const [inspecting, setInspecting] = createSignal(false)
  const authorOrder = createMemo(() => getMarketAuthorOrder(props.data))
  const selectedIndex = createMemo(() => Math.min(activeIndex(), Math.max(props.data.length - 1, 0)))
  const today = createMemo(() => props.data[props.data.length - 1])

  return (
    <section
      id="market-share"
      data-section="market-share"
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return
        setActiveAuthor(undefined)
        setInspecting(false)
      }}
    >
      <SectionBridge label={i18n.t("nav.cacheRatio").toUpperCase()} href="#cache-ratio" />
      <SectionTitle
        id="market-share"
        title={i18n.t("home.marketShareTitle")}
        description={i18n.t("home.marketShareDescription")}
      />
      <Show
        when={today()}
        fallback={<EmptyState title={i18n.t("home.noMarketTitle")} description={i18n.t("home.noMarketDescription")} />}
      >
        {(day) => (
          <>
            <MarketShare
              data={props.data}
              range="2M"
              authorOrder={authorOrder()}
              activeIndex={selectedIndex()}
              activeAuthor={activeAuthor()}
              inspecting={inspecting()}
              onActiveIndexChange={(index) => {
                setActiveIndex(index)
                setInspecting(true)
              }}
              onActiveAuthorChange={setActiveAuthor}
              onInspectingChange={setInspecting}
            />
            <MarketShareList
              data={rankedMarketAuthors(day())}
              authorOrder={authorOrder()}
              activeAuthor={activeAuthor()}
              onActiveAuthorChange={setActiveAuthor}
            />
          </>
        )}
      </Show>
      <div data-slot="market-footer">
        <p>
          <span>[*]</span>
          <strong>{formatMarketDate(today(), i18n.t("home.noData"))}</strong>
        </p>
      </div>
    </section>
  )
}

function MarketShare(props: {
  data: MarketDay[]
  range: UsageRange
  authorOrder: Map<string, number>
  activeIndex: number
  activeAuthor: string | undefined
  inspecting: boolean
  onActiveIndexChange: (index: number) => void
  onActiveAuthorChange: (author: string | undefined) => void
  onInspectingChange: (inspecting: boolean) => void
}) {
  const i18n = useI18n()
  let chartRef: HTMLDivElement | undefined
  const inspectDay = (index: number) => {
    props.onActiveIndexChange(index)
    props.onActiveAuthorChange(undefined)
  }

  createEffect(() => scrollDenseChartToEnd(chartRef, props.range, props.data.length))

  return (
    <div
      ref={chartRef}
      data-component="market-share"
      data-range={props.range}
      data-dense-labels={isDenseColumnRange(props.range) ? "true" : undefined}
      role="img"
      aria-label={i18n.t("home.marketChart")}
      style={{ "--market-count": props.data.length } as JSX.CSSProperties}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return
        props.onInspectingChange(false)
      }}
    >
      <div data-slot="market-labels">
        <For each={props.data}>
          {(day, index) => (
            <button
              type="button"
              aria-label={`${day.date} ${formatTrillions(day.total)}`}
              data-active={props.inspecting && props.activeIndex === index() ? "true" : undefined}
              data-label-hidden={isColumnLabelHidden(index(), props.data.length) ? "true" : undefined}
              data-mobile-hidden={isMarketMobileLabelHidden(index(), props.data.length) ? "true" : undefined}
              aria-describedby={props.inspecting && props.activeIndex === index() ? "market-share-tooltip" : undefined}
              onBlur={() => props.onInspectingChange(false)}
              onClick={() => inspectDay(index())}
              onFocus={() => inspectDay(index())}
              onPointerEnter={() => inspectDay(index())}
            >
              <span data-slot="market-axis-label">
                <span data-slot="market-total">{formatTrillions(day.total)}</span>
                <span data-slot="market-date">
                  <span data-slot="market-date-full">{day.date}</span>
                  <span data-slot="market-date-mobile">{formatMarketMobileDate(day.date)}</span>
                </span>
              </span>
            </button>
          )}
        </For>
      </div>
      <div data-slot="market-bars">
        <For each={props.data}>
          {(day, index) => (
            <button
              type="button"
              aria-label={`${day.date} ${formatTrillions(day.total)}`}
              data-active={props.inspecting && props.activeIndex === index() ? "true" : undefined}
              aria-describedby={props.inspecting && props.activeIndex === index() ? "market-share-tooltip" : undefined}
              onBlur={() => props.onInspectingChange(false)}
              onClick={() => inspectDay(index())}
              onFocus={() => inspectDay(index())}
              onPointerEnter={() => inspectDay(index())}
            >
              <For each={stackedMarketAuthors(day, props.authorOrder)}>
                {(item) => (
                  <span
                    data-author={item.author.author}
                    data-active={props.activeAuthor === item.author.author ? "true" : undefined}
                    data-muted={
                      props.activeAuthor !== undefined && props.activeAuthor !== item.author.author ? "true" : undefined
                    }
                    style={{
                      "background-color": getMarketSegmentColor(
                        item.author.author,
                        getRankColor(item.author.author, item.index, props.authorOrder, marketColors),
                        props.activeAuthor,
                      ),
                      "flex-grow": item.author.share,
                    }}
                    onPointerEnter={(event) => {
                      event.stopPropagation()
                      props.onActiveIndexChange(index())
                      props.onActiveAuthorChange(item.author.author)
                    }}
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      props.onActiveIndexChange(index())
                      props.onActiveAuthorChange(item.author.author)
                    }}
                    onClick={(event) => {
                      event.stopPropagation()
                      props.onActiveIndexChange(index())
                      props.onActiveAuthorChange(item.author.author)
                    }}
                  />
                )}
              </For>
            </button>
          )}
        </For>
      </div>
      <Show when={props.inspecting ? props.data[props.activeIndex] : undefined} keyed>
        {(day) => (
          <div
            id="market-share-tooltip"
            data-component="chart-tooltip"
            data-placement={props.activeIndex > props.data.length * 0.62 ? "left" : "right"}
            role="tooltip"
            style={
              {
                "--market-tooltip-left": `${((props.activeIndex + 0.5) / props.data.length) * 100}%`,
                "--market-tooltip-right": `${100 - ((props.activeIndex + 0.5) / props.data.length) * 100}%`,
              } as JSX.CSSProperties
            }
          >
            <strong>{day.date}</strong>
            <span>
              {formatTrillions(day.total)} {i18n.t("home.total")}
            </span>
            <div data-slot="tooltip-divider" />
            <For each={rankedMarketAuthors(day)}>
              {(item, index) => (
                <p
                  data-active={props.activeAuthor === item.author ? "true" : undefined}
                  data-muted={
                    props.activeAuthor !== undefined && props.activeAuthor !== item.author ? "true" : undefined
                  }
                >
                  <span data-slot="tooltip-label">
                    <i style={{ background: getRankColor(item.author, index(), props.authorOrder, marketColors) }} />
                    <span data-slot="tooltip-name">{item.author}</span>
                  </span>
                  <em>{formatTrillions(item.tokens)}</em>
                  <b>{item.share.toFixed(1)}%</b>
                </p>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  )
}

function MarketShareList(props: {
  data: MarketDay["authors"]
  authorOrder: Map<string, number>
  activeAuthor: string | undefined
  onActiveAuthorChange: (author: string) => void
}) {
  const language = useLanguage()
  return (
    <ol data-component="market-share-list">
      <For each={props.data}>
        {(item, index) => {
          const content = () => (
            <>
              <span>{String(index() + 1).padStart(2, "0")}</span>
              <i style={{ background: getRankColor(item.author, index(), props.authorOrder, marketColors) }} />
              <strong>{item.author}</strong>
              <em>{formatTrillions(item.tokens)}</em>
              <b>{item.share.toFixed(1)}%</b>
            </>
          )
          const href = () =>
            item.author === "Other" ? undefined : language.route(`${import.meta.env.BASE_URL}${modelSlug(item.author)}`)
          return (
            <li
              data-active={props.activeAuthor === item.author ? "true" : undefined}
              onPointerEnter={() => props.onActiveAuthorChange(item.author)}
            >
              <Show
                when={href()}
                fallback={
                  <button
                    type="button"
                    onClick={() => props.onActiveAuthorChange(item.author)}
                    onFocus={() => props.onActiveAuthorChange(item.author)}
                  >
                    {content()}
                  </button>
                }
              >
                {(href) => (
                  <a
                    href={href()}
                    onClick={() => props.onActiveAuthorChange(item.author)}
                    onFocus={() => props.onActiveAuthorChange(item.author)}
                  >
                    {content()}
                  </a>
                )}
              </Show>
            </li>
          )
        }}
      </For>
    </ol>
  )
}

function GeoBreakdownSection(props: { data: CountryEntry[] }) {
  const i18n = useI18n()
  const [activeCountry, setActiveCountry] = createSignal<string>()
  const maxTokens = createMemo(() => Math.max(0, ...props.data.map((country) => country.tokens)) || 1)
  const topCountries = createMemo(() => props.data.slice(0, 15))

  return (
    <section
      id="geo-breakdown"
      data-section="geo-breakdown"
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return
        setActiveCountry(undefined)
      }}
    >
      <SectionBridge label={i18n.t("nav.marketShare").toUpperCase()} href="#market-share" />
      <SectionTitle id="geo-breakdown" title={i18n.t("home.geoTitle")} />
      <Show
        when={props.data.length > 0}
        fallback={<EmptyState title={i18n.t("home.noGeoTitle")} description={i18n.t("home.noGeoDescription")} />}
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
              onClick={() => props.onActiveCountryChange(country.country)}
              onPointerEnter={() => props.onActiveCountryChange(country.country)}
              onFocus={() => props.onActiveCountryChange(country.country)}
            >
              <span>{String(country.rank).padStart(2, "0")}</span>
              <i />
              <strong>
                {formatCountryName(country.country, language.tag(language.locale()), i18n.t("home.unknown"))}
              </strong>
              <em>{formatGeoTokens(country.tokens)}</em>
              <b>{formatGeoShare(country.share)}</b>
            </button>
          </li>
        )}
      </For>
    </ol>
  )
}

function countryNumericId(country: string) {
  return countryNumericIds.get(country.toUpperCase())?.padStart(3, "0")
}

function formatCountryName(country: string, locale: string, unknown: string) {
  const code = country.toUpperCase()
  if (code === "ZZ") return unknown
  if (!countryNumericId(code)) return code
  return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code
}

function formatGeoTokens(value: number) {
  return formatTrillions(value)
}

function formatGeoShare(value: number) {
  return `${value.toFixed(value > 0 && value < 1 ? 1 : 0)}%`
}

function getMarketSegmentColor(author: string, color: string, activeAuthor: string | undefined) {
  if (!activeAuthor) return color
  if (activeAuthor === author) return color
  return "var(--stats-bar-idle)"
}

function rankedMarketAuthors(day: MarketDay) {
  return day.authors.toSorted((a, b) => b.tokens - a.tokens || a.author.localeCompare(b.author))
}

function stackedMarketAuthors(day: MarketDay, order: Map<string, number>) {
  return day.authors
    .map((author, index) => ({ author, index }))
    .slice()
    .sort((a, b) => (order.get(b.author.author) ?? b.index) - (order.get(a.author.author) ?? a.index))
}

function getMarketAuthorOrder(data: MarketDay[]) {
  return getRankOrder(
    data.flatMap((day) => day.authors.map((author, index) => ({ key: author.author, value: author.tokens, index }))),
  )
}

function getRankOrder(items: { key: string; value: number; index: number }[]) {
  return new Map<string, number>(
    Object.values(
      items.reduce<Record<string, { key: string; value: number; index: number }>>((result, item) => {
        result[item.key] = {
          key: item.key,
          value: (result[item.key]?.value ?? 0) + item.value,
          index: Math.min(result[item.key]?.index ?? item.index, item.index),
        }
        return result
      }, {}),
    )
      .toSorted((a, b) => b.value - a.value || a.index - b.index || a.key.localeCompare(b.key))
      .map((item, index) => [item.key, index] as const),
  )
}

function getRankColor(key: string, fallbackIndex: number, order: Map<string, number>, colors: readonly string[]) {
  return colors[order.get(key) ?? fallbackIndex] ?? "var(--stats-text)"
}

function isMarketMobileLabelHidden(index: number, count: number) {
  return count > 7 && index % 2 === 1
}

function formatMarketMobileDate(label: string) {
  return marketDateParts(label).start
}

function formatTrillions(value: number) {
  if (value === 0) return "0"
  if (value < 0.001) return `${Number((value * 1_000_000).toFixed(value >= 0.00001 ? 0 : 1))}M`
  if (value < 1) return `${Number((value * 1_000).toFixed(value >= 0.01 ? 0 : 1))}B`
  return `${value.toFixed(value >= 10 ? 0 : 1)}T`
}

function formatMarketDate(day: MarketDay | undefined, fallback: string) {
  if (!day) return fallback
  return formatMarketDateLabel(day.date)
}

function formatMarketDateLabel(label: string) {
  const parts = marketDateParts(label)
  const year = new Date().getFullYear()
  if (parts.start === parts.end) return `${parts.start} ${year}`
  return `${parts.start} ${year} → ${parts.end} ${year}`
}

function marketDateParts(label: string) {
  const [start, end] = label.split(" - ")
  return { start: start ?? label, end: end ?? start ?? label }
}

function TokenCostSection(props: { data: TokenCostEntry[] }) {
  const i18n = useI18n()
  const [activeIndex, setActiveIndex] = createSignal(2)
  const visible = createMemo(() => props.data.slice(0, 13))
  const selectedIndex = createMemo(() => Math.min(activeIndex(), Math.max(visible().length - 1, 0)))

  return (
    <section id="token-cost" data-section="token-cost">
      <SectionBridge label={i18n.t("nav.sessionCost").toUpperCase()} href="#session-cost" />
      <SectionTitle
        id="token-cost"
        title={i18n.t("home.tokenCostTitle")}
        description={i18n.t("home.tokenCostDescription")}
      />
      <Show
        when={visible().length > 0}
        fallback={
          <EmptyState title={i18n.t("home.noTokenCostTitle")} description={i18n.t("home.noTokenCostDescription")} />
        }
      >
        <TokenCostChart data={visible()} activeIndex={selectedIndex()} onActiveIndexChange={setActiveIndex} />
      </Show>
    </section>
  )
}

function TokenCostChart(props: {
  data: TokenCostEntry[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
}) {
  const i18n = useI18n()
  const max = createMemo(() => Math.max(0, ...props.data.map((item) => item.total)) || 1)
  const active = createMemo(() => props.data[props.activeIndex] ?? props.data[0])

  return (
    <div data-component="token-cost">
      <For each={props.data}>
        {(item, index) => (
          <button
            type="button"
            data-component="token-row"
            data-active={props.activeIndex === index() ? "true" : undefined}
            onClick={() => props.onActiveIndexChange(index())}
            onPointerEnter={() => props.onActiveIndexChange(index())}
          >
            <strong>{formatDollars(item.total)}</strong>
            <span>{item.model}</span>
            <MetricBar value={item.total} max={max()} active={props.activeIndex === index()} />
          </button>
        )}
      </For>
      <Show when={active()}>
        {(item) => (
          <div data-component="token-tooltip" style={{ top: `${props.activeIndex * 36 + 2}px` }}>
            <p>
              <span>{i18n.t("chart.input")}</span>
              <strong>{formatDollars(item().input)}</strong>
            </p>
            <p>
              <span>{i18n.t("chart.output")}</span>
              <strong>{formatDollars(item().output)}</strong>
            </p>
            <p>
              <span>{i18n.t("chart.cached")}</span>
              <strong>{formatDollars(item().cached)}</strong>
            </p>
          </div>
        )}
      </Show>
    </div>
  )
}

function CacheRatioSection(props: { data: CacheRatioEntry[] }) {
  const i18n = useI18n()
  const [activeIndex, setActiveIndex] = createSignal(2)
  const visible = createMemo(() => props.data.slice(0, 16))
  const selectedIndex = createMemo(() => Math.min(activeIndex(), Math.max(visible().length - 1, 0)))

  return (
    <section id="cache-ratio" data-section="cache-ratio">
      <SectionBridge label={i18n.t("nav.tokenCost").toUpperCase()} href="#token-cost" />
      <SectionTitle
        id="cache-ratio"
        title={i18n.t("home.cacheRatioTitle")}
        description={i18n.t("home.cacheRatioDescription")}
      />
      <Show
        when={visible().length > 0}
        fallback={<EmptyState title={i18n.t("home.noCacheTitle")} description={i18n.t("home.noCacheDescription")} />}
      >
        <CacheRatioChart data={visible()} activeIndex={selectedIndex()} onActiveIndexChange={setActiveIndex} />
      </Show>
    </section>
  )
}

function CacheRatioChart(props: {
  data: CacheRatioEntry[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
}) {
  const i18n = useI18n()
  const active = createMemo(() => props.data[props.activeIndex] ?? props.data[0])

  return (
    <div data-component="cache-ratio" data-variant="marker">
      <div data-slot="cache-ratio-heading" aria-hidden="true">
        <strong>{i18n.t("chart.ratio")}</strong>
        <span>{i18n.t("chart.model")}</span>
        <b>0-100%</b>
      </div>
      <div data-slot="cache-ratio-rows">
        <For each={props.data}>
          {(item, index) => (
            <button
              type="button"
              data-component="cache-ratio-row"
              data-active={props.activeIndex === index() ? "true" : undefined}
              onClick={() => props.onActiveIndexChange(index())}
              onPointerEnter={() => props.onActiveIndexChange(index())}
            >
              <strong>{formatRatio(item.ratio)}</strong>
              <span>{item.model}</span>
              <CacheRatioMarker ratio={item.ratio} active={props.activeIndex === index()} />
            </button>
          )}
        </For>
      </div>
      <Show when={active()}>
        {(item) => (
          <div
            data-component="token-tooltip"
            data-variant="cache-ratio"
            style={{ top: `${props.activeIndex * 36 + 28}px` }}
          >
            <p>
              <span>{i18n.t("chart.cacheRatio")}</span>
              <strong>{formatRatio(item().ratio)}</strong>
            </p>
            <p>
              <span>{i18n.t("chart.cached")}</span>
              <strong>{formatBillions(item().cached)}</strong>
            </p>
            <p>
              <span>{i18n.t("chart.uncached")}</span>
              <strong>{formatBillions(item().uncached)}</strong>
            </p>
          </div>
        )}
      </Show>
    </div>
  )
}

function CacheRatioMarker(props: { ratio: number; active: boolean }) {
  const fill = createMemo(() => Math.min(100, Math.max(0, props.ratio)))
  return (
    <i
      data-component="cache-ratio-marker"
      data-active={props.active ? "true" : undefined}
      style={{ "--cache-ratio-fill": `${fill()}%` } as JSX.CSSProperties}
    >
      <em />
    </i>
  )
}

function formatRatio(value: number) {
  return `${value.toFixed(value > 0 && value < 10 ? 1 : 0)}%`
}

function formatDollars(value: number) {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`
}

function MetricBar(props: { value: number; max: number; active: boolean }) {
  const fill = createMemo(() => Math.min(1, Math.max(props.value / props.max, props.value > 0 ? 0.03 : 0)))
  return (
    <i
      data-component="metric-bar"
      data-active={props.active ? "true" : undefined}
      style={{ "--metric-bar-fill": `${fill() * 100}%` } as JSX.CSSProperties}
    >
      <b />
      <em />
    </i>
  )
}

function SessionCostSection(props: { data: SessionCostEntry[] }) {
  const i18n = useI18n()
  const [activeIndex, setActiveIndex] = createSignal(2)
  const visible = createMemo(() => props.data.slice(0, 16))
  const selectedIndex = createMemo(() => Math.min(activeIndex(), Math.max(visible().length - 1, 0)))

  return (
    <section id="session-cost" data-section="session-cost">
      <SectionBridge label={i18n.t("nav.topModels").toUpperCase()} href="#top-models" />
      <SectionTitle
        id="session-cost"
        title={i18n.t("home.sessionCostTitle")}
        description={i18n.t("home.sessionCostDescription")}
      />
      <Show
        when={visible().length > 0}
        fallback={
          <EmptyState title={i18n.t("home.noSessionCostTitle")} description={i18n.t("home.noSessionCostDescription")} />
        }
      >
        <SessionCostChart data={visible()} activeIndex={selectedIndex()} onActiveIndexChange={setActiveIndex} />
      </Show>
    </section>
  )
}

function SessionCostChart(props: {
  data: SessionCostEntry[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
}) {
  const i18n = useI18n()
  const maxCost = createMemo(() => Math.max(0, ...props.data.map((item) => item.cost)) || 1)
  const maxTokens = createMemo(() => Math.max(0, ...props.data.map((item) => item.tokens)) || 1)
  const active = createMemo(() => props.data[props.activeIndex] ?? props.data[0])

  return (
    <div data-component="session-cost">
      <div data-slot="session-heading">
        <strong aria-hidden="true" />
        <span aria-hidden="true" />
        <p>{i18n.t("chart.costPerSession")}</p>
        <p>{i18n.t("chart.tokensPerSession")}</p>
      </div>
      <For each={props.data}>
        {(item, index) => (
          <button
            type="button"
            data-component="token-row"
            data-variant="session"
            data-active={props.activeIndex === index() ? "true" : undefined}
            onClick={() => props.onActiveIndexChange(index())}
            onPointerEnter={() => props.onActiveIndexChange(index())}
          >
            <strong>{formatSessionCost(item.cost)}</strong>
            <span>{item.model}</span>
            <MetricBar value={item.cost} max={maxCost()} active={props.activeIndex === index()} />
            <MetricBar value={item.tokens} max={maxTokens()} active={props.activeIndex === index()} />
          </button>
        )}
      </For>
      <Show when={active()}>
        {(item) => (
          <div
            data-component="token-tooltip"
            data-variant="session"
            style={{ top: `${props.activeIndex * 36 + 28}px` }}
          >
            <p>
              <span>{i18n.t("chart.costSession")}</span>
              <strong>{formatSessionCost(item().cost)}</strong>
            </p>
            <p>
              <span>{i18n.t("chart.tokensSession")}</span>
              <strong>{formatTokenCount(item().tokens)}</strong>
            </p>
          </div>
        )}
      </Show>
    </div>
  )
}

function formatTokenCount(value: number) {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  return `${Math.round(value / 1_000)}K`
}

function priceTokenCostFromCatalog(data: TokenCostEntry[], catalog: ModelCatalog | null) {
  if (!catalog) return data
  return data
    .flatMap((item) => {
      const cost = catalogModelCost(catalog, item.model)
      if (!cost) return []
      return [
        {
          ...item,
          total: cost.output,
          input: cost.input,
          output: cost.output,
          cached: cost.cacheRead ?? cost.input,
        },
      ]
    })
    .toSorted((a, b) => a.total - b.total || a.model.localeCompare(b.model))
}

function catalogModelCost(catalog: ModelCatalog, model: string) {
  return findModelCatalogEntry(catalog, model)?.cost
}

function formatSessionCost(value: number) {
  return `$${value.toFixed(4)}`
}

function homeComparisonPairs(leaderboard: LeaderboardEntry[], catalogLabs: readonly string[]) {
  return uniqueComparisonPairs(
    comparisonPairIndexes.flatMap(([firstIndex, secondIndex, detail]) => {
      const first = leaderboard[firstIndex]
      const second = leaderboard[secondIndex]
      return first && second
        ? [{ first: leaderboardRef(first, catalogLabs), second: leaderboardRef(second, catalogLabs), detail }]
        : []
    }),
  )
}

function leaderboardRef(entry: LeaderboardEntry, catalogLabs: readonly string[]): ComparisonModelRef {
  return {
    name: entry.model,
    lab: entry.provider,
    slug: modelSlug(entry.model),
    labName: isKnownCatalogLab(entry.provider, catalogLabs) ? entry.author : undefined,
    metric: `#${entry.rank} / ${formatBillions(entry.tokens)}`,
  }
}

function modelSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
}
