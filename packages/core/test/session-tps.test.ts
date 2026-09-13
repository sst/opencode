import { describe, expect, test } from "bun:test"
import {
  calculateTPS,
  DEFAULT_MIN_TPS_ELAPSED_MS,
  getMessageTPS,
  stampFirstToken,
  type TimestampMetrics,
} from "../src/session/tokens"

const validMessage = {
  finish: "stop",
  tokens: { output: 100, reasoning: 50 },
  time: { created: 1000, firstToken: 1100, completed: 2100 },
}

describe("getMessageTPS", () => {
  test("calculates rounded output and reasoning tokens per second", () => {
    expect(getMessageTPS(validMessage)?.rate).toBe(150)
  })

  test("returns no value for summary messages", () => {
    expect(getMessageTPS({ ...validMessage, summary: true })).toBeUndefined()
  })

  test("returns no value when finish is missing", () => {
    expect(getMessageTPS({ ...validMessage, finish: undefined })).toBeUndefined()
  })

  test("returns no value when finish is null", () => {
    expect(getMessageTPS({ ...validMessage, finish: null })).toBeUndefined()
  })

  test("calculates tokens per second for tool-call finishes", () => {
    expect(getMessageTPS({ ...validMessage, finish: "tool-calls" })?.rate).toBe(150)
  })

  test("calculates tokens per second for unknown finishes", () => {
    expect(getMessageTPS({ ...validMessage, finish: "unknown" })?.rate).toBe(150)
  })

  test("returns no value for error finishes", () => {
    expect(getMessageTPS({ ...validMessage, finish: "error" })).toBeUndefined()
  })

  test("returns no value when token total is zero", () => {
    expect(getMessageTPS({ ...validMessage, tokens: { output: 0, reasoning: 0 } })).toBeUndefined()
  })

  test("returns no value when token total is negative", () => {
    expect(getMessageTPS({ ...validMessage, tokens: { output: -1, reasoning: 0 } })).toBeUndefined()
  })

  test("returns no value when first token timestamp is missing", () => {
    expect(getMessageTPS({ ...validMessage, time: { created: 1000, completed: 2100 } })).toBeUndefined()
  })

  test("returns no value when completion timestamp is missing", () => {
    expect(getMessageTPS({ ...validMessage, time: { created: 1000, firstToken: 1100 } })).toBeUndefined()
  })

  test("returns no value when elapsed time is below 250 milliseconds", () => {
    expect(
      getMessageTPS({
        ...validMessage,
        time: {
          ...validMessage.time,
          completed: validMessage.time.firstToken! + DEFAULT_MIN_TPS_ELAPSED_MS - 1,
        },
      }),
    ).toBeUndefined()
  })

  test("accepts elapsed time at the 250 millisecond threshold", () => {
    expect(
      getMessageTPS({
        ...validMessage,
        time: {
          ...validMessage.time,
          completed: validMessage.time.firstToken! + DEFAULT_MIN_TPS_ELAPSED_MS,
        },
      })?.rate,
    ).toBe(600)
  })
})

describe("calculateTPS", () => {
  test("rounds fractional rates to the nearest integer", () => {
    expect(calculateTPS(100, 327)?.rate).toBe(306)
  })

  test("rejects zero and negative token totals", () => {
    expect(calculateTPS(0, 1000)).toBeUndefined()
    expect(calculateTPS(-1, 1000)).toBeUndefined()
  })

  test("rejects elapsed time below the configured threshold", () => {
    expect(calculateTPS(100, 249)).toBeUndefined()
  })
})

describe("stampFirstToken", () => {
  test("stamps the first event and preserves it for later deltas", () => {
    const time: TimestampMetrics = { created: 1000 }

    expect(stampFirstToken(time, 1100)).toBe(1100)
    expect(stampFirstToken(time, 1200)).toBe(1100)
    expect(time.firstToken).toBe(1100)
  })
})
