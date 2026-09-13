import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import type { ModelCatalogBenchmark, ModelCatalogEntry } from "./model-catalog"

const radarRingCount = 5
const radarColors = ["#294bdb", "#159447", "#d24a3b", "#8a4fd2", "#b47400", "#008c95"] as const
const codingBenchmarkPattern = /(swe|aider|code|coding|nl2repo)/
const reasoningBenchmarkPattern = /(gpqa|humanity|last exam|reasoning|aime|hmmt|math|mmlu|mrcr|charxiv|cti realm)/
const toolUseBenchmarkPattern = /(terminal bench|claw eval|tau ?(?:bench|2|3))/

export type ComparisonRadarModel = {
  name: string
  labName?: string
  catalog: ModelCatalogEntry | null
}

type ComparisonRadarProps = {
  models: readonly ComparisonRadarModel[]
  catalogModels: readonly ModelCatalogEntry[]
}

type RadarAxis = {
  label: string
  description: string
  score: (model: ModelCatalogEntry) => number | undefined
}

type RadarPoint = {
  x: number
  y: number
}

export function ComparisonRadar(props: ComparisonRadarProps) {
  const [activeAxis, setActiveAxis] = createSignal<number>()
  const axes = createMemo(() => buildRadarAxes(props.catalogModels))
  const series = createMemo(() =>
    props.models.map((model, index) => ({
      name: model.name,
      labName: model.labName,
      color: radarColors[index % radarColors.length],
      scores: axes().map((axis) => (model.catalog ? axis.score(model.catalog) : undefined)),
    })),
  )
  const accessibleDescription = createMemo(() =>
    series()
      .map(
        (model) =>
          `${model.name}: ${axes()
            .map((axis, index) => `${axis.label} ${formatRadarScore(model.scores[index])}`)
            .join(", ")}`,
      )
      .join(". "),
  )
  const clearActiveAxis = (index: number) => setActiveAxis((active) => (active === index ? undefined : active))

  return (
    <section data-section="compare-radar" aria-label="Model capabilities">
      <ol data-slot="compare-radar-legend">
        <For each={series()}>
          {(model) => (
            <li>
              <i style={{ background: model.color }} aria-hidden="true" />
              <span>
                <strong>{model.name}</strong>
                <Show when={model.labName}>{(name) => <small>{name()}</small>}</Show>
              </span>
            </li>
          )}
        </For>
      </ol>
      <div data-slot="compare-radar-chart" role="img" aria-label={accessibleDescription()}>
        <div data-slot="compare-radar-plot" aria-hidden="true">
          <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
            <g data-slot="compare-radar-grid">
              <For each={Array.from({ length: radarRingCount })}>
                {(_, index) => (
                  <polygon points={radarPolygonPoints(axes().length, ((index() + 1) / radarRingCount) * 100)} />
                )}
              </For>
              <For each={axes()}>
                {(_, index) => {
                  const point = () => radarPoint(index(), axes().length, 100)
                  return <line x1="50" y1="50" x2={point().x} y2={point().y} />
                }}
              </For>
            </g>
            <For each={series()}>
              {(model) => (
                <g data-slot="compare-radar-series" style={{ color: model.color }}>
                  <polygon data-slot="compare-radar-area" points={radarSeriesPolygon(model.scores)} />
                  <For each={model.scores}>
                    {(score, index) => {
                      const point = () => radarPoint(index(), axes().length, score ?? 0)
                      return (
                        <>
                          <circle data-slot="compare-radar-point" cx={point().x} cy={point().y} r="0.95" />
                          <circle
                            data-slot="compare-radar-point-hit"
                            cx={point().x}
                            cy={point().y}
                            r="3"
                            onMouseEnter={() => setActiveAxis(index())}
                            onMouseLeave={() => clearActiveAxis(index())}
                          />
                        </>
                      )
                    }}
                  </For>
                </g>
              )}
            </For>
          </svg>
        </div>
        <For each={axes()}>
          {(axis, index) => (
            <span
              data-slot="compare-radar-axis"
              data-active={activeAxis() === index() ? "true" : undefined}
              style={radarAxisStyle(index(), axes().length)}
              tabIndex="0"
              aria-label={`${axis.label}. ${axis.description}`}
              onMouseEnter={() => setActiveAxis(index())}
              onMouseLeave={() => clearActiveAxis(index())}
              onFocus={() => setActiveAxis(index())}
              onBlur={() => clearActiveAxis(index())}
              onKeyDown={(event) => {
                if (event.key === "Escape") event.currentTarget.blur()
              }}
            >
              <span data-slot="compare-radar-axis-label">{axis.label}</span>
            </span>
          )}
        </For>
        <Show when={activeAxis() !== undefined}>
          <div
            data-slot="compare-radar-tooltip"
            role="tooltip"
            style={radarTooltipStyle(activeAxis() ?? 0, axes().length)}
          >
            <strong>{axes()[activeAxis() ?? 0]?.label}</strong>
            <p>{axes()[activeAxis() ?? 0]?.description}</p>
          </div>
        </Show>
      </div>
      <div data-slot="compare-radar-data">
        <table>
          <caption>Normalized model capability scores</caption>
          <thead>
            <tr>
              <th>Model</th>
              <For each={axes()}>{(axis) => <th>{axis.label}</th>}</For>
            </tr>
          </thead>
          <tbody>
            <For each={series()}>
              {(model) => (
                <tr>
                  <th>{model.name}</th>
                  <For each={model.scores}>{(score) => <td>{formatRadarScore(score)}</td>}</For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  )
}

function buildRadarAxes(catalogModels: readonly ModelCatalogEntry[]): RadarAxis[] {
  const benchmarks = benchmarkScoreGroups(catalogModels)
  const toolUseBenchmarks = benchmarkScoreGroups(catalogModels, true)
  const costs = catalogModels.flatMap((model) => {
    const cost = modelCost(model)
    return cost === undefined ? [] : [cost]
  })
  const contexts = catalogModels.flatMap((model) => (model.limit?.context === undefined ? [] : [model.limit.context]))
  const multimodalMaximum = Math.max(...catalogModels.map(multimodalFeatureCount), 0)

  // Speed and safety stay out until the catalog exposes comparable values for them.
  return [
    {
      label: "Reasoning",
      description: "Ability to solve complex, multi-step problems. Based on reasoning benchmarks when available.",
      score: (model) =>
        benchmarkPercentile(model, benchmarks, reasoningBenchmarkPattern) ?? (model.reasoning ? 100 : 0),
    },
    {
      label: "Coding",
      description: "Performance on software engineering and coding benchmarks.",
      score: (model) => benchmarkPercentile(model, benchmarks, codingBenchmarkPattern),
    },
    {
      label: "Cost efficiency",
      description: "Relative input and output pricing. Lower-cost models score higher.",
      score: (model) => {
        const cost = modelCost(model)
        if (cost === undefined) return
        if (cost === 0) return 100
        return percentileScore(cost, costs, "lower")
      },
    },
    {
      label: "Context window",
      description: "How much input the model can process at once. Larger context windows score higher.",
      score: (model) => {
        const context = model.limit?.context
        if (context === undefined) return
        return percentileScore(context, contexts, "higher")
      },
    },
    {
      label: "Multimodal",
      description: "Support for non-text input and output, including images, audio, and video.",
      score: (model) => {
        if (multimodalMaximum === 0) return
        return (multimodalFeatureCount(model) / multimodalMaximum) * 100
      },
    },
    {
      label: "Tool use",
      description: "Performance on agent benchmarks including Terminal-Bench, Tau3, and Claw-Eval.",
      score: (model) =>
        benchmarkPercentile(model, toolUseBenchmarks, toolUseBenchmarkPattern, {
          aggregate: "average",
          includeHarness: true,
        }),
    },
  ]
}

function benchmarkScoreGroups(catalogModels: readonly ModelCatalogEntry[], includeHarness = false) {
  return catalogModels.reduce<Map<string, number[]>>((groups, model) => {
    model.benchmarks
      .reduce<Map<string, number>>((scores, benchmark) => {
        const key = benchmarkKey(benchmark, includeHarness)
        scores.set(key, Math.max(scores.get(key) ?? -Infinity, benchmark.score))
        return scores
      }, new Map())
      .forEach((score, key) => {
        groups.set(key, [...(groups.get(key) ?? []), score])
      })
    return groups
  }, new Map())
}

function benchmarkKey(benchmark: ModelCatalogBenchmark, includeHarness: boolean) {
  const name = normalizeBenchmarkName(benchmark.name)
  const version = normalizeBenchmarkName(benchmark.version ?? "")
  const versioned = version && !name.endsWith(version) ? `${name} ${version}` : name
  if (!includeHarness) return versioned
  const harness = normalizeBenchmarkName(benchmark.harness ?? benchmark.variant ?? "")
  return harness ? `${versioned} | ${harness}` : versioned
}

function benchmarkPercentile(
  model: ModelCatalogEntry,
  benchmarks: Map<string, number[]>,
  pattern: RegExp,
  options?: { aggregate?: "average" | "best"; includeHarness?: boolean },
) {
  const scores = Object.entries(
    model.benchmarks.reduce<Record<string, number>>((result, benchmark) => {
      const key = benchmarkKey(benchmark, options?.includeHarness ?? false)
      if (!pattern.test(key)) return result
      result[key] = Math.max(result[key] ?? -Infinity, benchmark.score)
      return result
    }, {}),
  ).flatMap(([key, score]) => {
    const values = benchmarks.get(key)
    const percentile = values ? percentileScore(score, values, "higher") : undefined
    return percentile === undefined ? [] : [percentile]
  })
  if (scores.length === 0) return
  if (options?.aggregate === "average") return scores.reduce((sum, score) => sum + score, 0) / scores.length
  // Benchmark coverage varies by model, so additional published results should not lower a model's score.
  return Math.max(...scores)
}

function normalizeBenchmarkName(value: string) {
  return value
    .toLowerCase()
    .replace(/\u03c4/g, "tau")
    .replace(/\u00b2/g, "2")
    .replace(/\u00b3/g, "3")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function modelCost(model: ModelCatalogEntry) {
  if (!model.cost) return
  return model.cost.input + model.cost.output
}

function multimodalFeatureCount(model: ModelCatalogEntry) {
  return new Set([
    ...model.modalities.input.filter((modality) => modality !== "text").map((modality) => `input:${modality}`),
    ...model.modalities.output.filter((modality) => modality !== "text").map((modality) => `output:${modality}`),
    ...(model.attachment ? ["attachment"] : []),
  ]).size
}

function percentileScore(value: number, values: number[], direction: "higher" | "lower") {
  const finite = values.filter(Number.isFinite)
  if (!Number.isFinite(value) || finite.length < 2) return
  const below = finite.filter((candidate) => candidate < value).length
  const equal = finite.filter((candidate) => candidate === value).length
  const percentile = ((below + (equal - 1) / 2) / (finite.length - 1)) * 100
  return direction === "higher" ? percentile : 100 - percentile
}

function radarPoint(index: number, count: number, score: number): RadarPoint {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / count
  const radius = Math.max(0, Math.min(100, score)) / 2
  return {
    x: roundRadarCoordinate(50 + Math.cos(angle) * radius),
    y: roundRadarCoordinate(50 + Math.sin(angle) * radius),
  }
}

function radarPolygonPoints(count: number, score: number) {
  return Array.from({ length: count })
    .map((_, index) => radarPoint(index, count, score))
    .map((point) => `${point.x},${point.y}`)
    .join(" ")
}

function radarSeriesPolygon(scores: (number | undefined)[]) {
  return scores
    .map((score, index) => radarPoint(index, scores.length, score ?? 0))
    .map((point) => `${point.x},${point.y}`)
    .join(" ")
}

function radarAxisStyle(index: number, count: number) {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / count
  const horizontal = Math.cos(angle)
  return {
    "--compare-radar-axis-x": `${roundRadarCoordinate(50 + horizontal * 42)}%`,
    "--compare-radar-axis-mobile-x": `${roundRadarCoordinate(50 + horizontal * 36)}%`,
    "--compare-radar-axis-y": `${roundRadarCoordinate(50 + Math.sin(angle) * 42)}%`,
    "--compare-radar-axis-translate-x": horizontal > 0.25 ? "0%" : horizontal < -0.25 ? "-100%" : "-50%",
  } as JSX.CSSProperties
}

function radarTooltipStyle(index: number, count: number) {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / count
  return {
    "--compare-radar-tooltip-x": `${roundRadarCoordinate(50 + Math.cos(angle) * 42)}%`,
    "--compare-radar-tooltip-y": `${roundRadarCoordinate(50 + Math.sin(angle) * 42)}%`,
    "--compare-radar-tooltip-translate-y": Math.sin(angle) < -0.9 ? "20px" : "calc(-100% - 12px)",
  } as JSX.CSSProperties
}

function roundRadarCoordinate(value: number) {
  return Math.round(value * 1000) / 1000
}

function formatRadarScore(score: number | undefined) {
  return score === undefined ? "No data" : `${Math.round(score)}/100`
}
