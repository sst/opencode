import { describe, expect, test } from "bun:test"
import { formatCompactionDiagnostics } from "./compaction-diagnostics"

describe("compaction diagnostics", () => {
  test("formats fallback mode and raw cache ratio", () => {
    expect(
      formatCompactionDiagnostics({
        requested: "suffix",
        used: "prepend",
        fallback: "invalid_summary",
        durationMs: 1_250,
        tokens: { cached: 80_000, input: 81_000, output: 500 },
      }),
    ).toEqual({
      mode: "suffix→prepend",
      details: "cache=80000/81000 (98.8%) · duration=1.3s · fallback=invalid_summary",
    })
  })

  test("keeps unavailable cache counters explicit", () => {
    expect(formatCompactionDiagnostics({ requested: "suffix", used: "suffix", tokens: { input: 81_000 } })).toEqual({
      mode: "suffix",
      details: "cache=?/81000",
    })
    expect(formatCompactionDiagnostics({ requested: "suffix", used: "suffix" }).details).toBe("cache=?")
    expect(
      formatCompactionDiagnostics({ requested: "suffix", used: "suffix", tokens: { cached: 80_000 } }).details,
    ).toBe("cache=80000/?")
  })

  test("does not divide by zero", () => {
    expect(
      formatCompactionDiagnostics({ requested: "suffix", used: "suffix", tokens: { cached: 0, input: 0 } }).details,
    ).toBe("cache=0/0")
  })
})
