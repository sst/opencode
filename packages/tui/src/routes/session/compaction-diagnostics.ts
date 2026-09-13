import type { SessionCompactionDiagnostics } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"

export function formatCompactionDiagnostics(input: SessionCompactionDiagnostics) {
  const mode =
    input.requested && input.used && input.requested !== input.used
      ? `${input.requested}→${input.used}`
      : (input.used ?? input.requested)
  const cache =
    input.tokens?.input === undefined
      ? input.tokens?.cached === undefined
        ? "cache=?"
        : `cache=${input.tokens.cached}/?`
      : input.tokens.cached === undefined
        ? `cache=?/${input.tokens.input}`
        : `cache=${input.tokens.cached}/${input.tokens.input}${ratio(input.tokens.cached, input.tokens.input)}`
  return {
    mode,
    details: [
      cache,
      input.durationMs === undefined ? undefined : `duration=${Locale.duration(input.durationMs)}`,
      input.fallback === undefined ? undefined : `fallback=${input.fallback}`,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" · "),
  }
}

function ratio(cached: number, input: number) {
  if (input <= 0) return ""
  return ` (${Math.round((cached / input) * 1_000) / 10}%)`
}
