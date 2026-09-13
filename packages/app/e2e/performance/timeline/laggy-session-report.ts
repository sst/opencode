export {}

type Pair = {
  mode: "compact" | "ungrouped"
  samples: { phase: string; firstCorrectObservedMs: number | null; messageRequests: number }[]
}

const directory = Bun.argv[2]
if (!directory) throw new Error("Pass the directory containing session-load pairs")
const pairs = await Promise.all(
  [...new Bun.Glob("{compact,ungrouped}-*.json").scanSync(directory)].map(async (file) => {
    const pair = (await Bun.file(`${directory}/${file}`).json()) as Pair
    const cold = pair.samples.find((sample) => sample.phase === "cold")
    const warm = pair.samples.find((sample) => sample.phase === "warm")
    if (cold?.firstCorrectObservedMs == null || warm?.firstCorrectObservedMs == null)
      throw new Error(`Expected a completed cold/warm pair in ${file}`)
    return {
      mode: pair.mode,
      cold: cold.firstCorrectObservedMs,
      warm: warm.firstCorrectObservedMs,
      requests: warm.messageRequests,
    }
  }),
)
if (!pairs.length) throw new Error(`No session-load pairs found in ${directory}`)

const result = ["compact", "ungrouped"].flatMap((mode) => {
  const selected = pairs.filter((pair) => pair.mode === mode)
  if (!selected.length) return []
  return [
    {
      mode,
      cold: { ...stats(selected.map((pair) => pair.cold)), over50ms: selected.filter((pair) => pair.cold > 50).length },
      warm: { ...stats(selected.map((pair) => pair.warm)), over50ms: selected.filter((pair) => pair.warm > 50).length },
      pairedColdMinusWarm: stats(selected.map((pair) => pair.cold - pair.warm)),
      messageRequestsDuringWarm: selected.reduce((total, pair) => total + pair.requests, 0),
    },
  ]
})
await Bun.write(`${directory}/summary.json`, JSON.stringify(result, null, 2))
console.table(
  result.map((row) => ({
    mode: row.mode,
    pairs: row.cold.n,
    coldMedianMs: Math.round(row.cold.median * 10) / 10,
    coldP95Ms: Math.round(row.cold.p95 * 10) / 10,
    warmMedianMs: Math.round(row.warm.median * 10) / 10,
    warmP95Ms: Math.round(row.warm.p95 * 10) / 10,
    warmMaxMs: Math.round(row.warm.max * 10) / 10,
    pairedDifferenceMs: Math.round(row.pairedColdMinusWarm.median * 10) / 10,
  })),
)

function stats(values: number[]) {
  const sorted = values.toSorted((left, right) => left - right)
  return {
    n: sorted.length,
    median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1)!,
  }
}
