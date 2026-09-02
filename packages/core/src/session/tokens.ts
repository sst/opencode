export const DEFAULT_MIN_TPS_ELAPSED_MS = 250
export const DEFAULT_INCLUDE_REASONING = true

export interface TokenMetrics {
  output: number
  reasoning: number
}

export interface TimestampMetrics {
  created: number
  firstToken?: number
  completed?: number
}

export interface TPSResult {
  rate: number
  totalTokens: number
  elapsedMs: number
  isValid: boolean
}

export function stampFirstToken(time: TimestampMetrics, now: number): number {
  if (time.firstToken === undefined) time.firstToken = now
  return time.firstToken
}

export function totalGeneratedTokens(tokens: TokenMetrics, includeReasoning = DEFAULT_INCLUDE_REASONING): number {
  return tokens.output + (includeReasoning ? tokens.reasoning : 0)
}

type TPSMessage = {
  summary?: boolean
  finish?: string | null
  tokens: TokenMetrics
  time: TimestampMetrics
}

function tpsInputs(msg: TPSMessage): { totalTokens: number; elapsedMs: number } | undefined {
  if (msg.summary) return undefined
  if (!msg.finish) return undefined
  if (msg.finish === "error") return undefined

  const totalTokens = totalGeneratedTokens(msg.tokens)
  if (totalTokens <= 0) return undefined
  const { firstToken, completed } = msg.time
  if (firstToken === undefined || completed === undefined) return undefined

  return { totalTokens, elapsedMs: completed - firstToken }
}

export function calculateTPS(
  totalTokens: number,
  elapsedMs: number,
  minElapsedMs = DEFAULT_MIN_TPS_ELAPSED_MS,
): TPSResult | undefined {
  if (totalTokens <= 0) return undefined
  if (elapsedMs < minElapsedMs) return undefined

  const rate = totalTokens / (elapsedMs / 1000)
  if (!Number.isFinite(rate) || rate < 0) return undefined

  return {
    rate: Math.round(rate),
    totalTokens,
    elapsedMs,
    isValid: true,
  }
}

export function formatTPS(result: TPSResult): string {
  return `${result.rate.toLocaleString()} tok/s`
}

export function getMessageTPS(msg: {
  summary?: boolean
  finish?: string | null
  tokens: TokenMetrics
  time: TimestampMetrics
}): TPSResult | undefined {
  const inputs = tpsInputs(msg)
  if (!inputs) return undefined
  return calculateTPS(inputs.totalTokens, inputs.elapsedMs)
}
