import { describe, expect, test } from "bun:test"
import { ZenData } from "../src/model"

const base = {
  zenModels: {
    "gpt-5.6-sol": {
      name: "GPT-5.6 Sol",
      cost: { input: 2, output: 10 },
      costMultiplier: 1,
      providers: [{ id: "openai", model: "gpt-5.6-sol" }],
    },
  },
  liteModels: {},
  providers: { openai: { api: "https://api.openai.com/v1", apiKey: "test" } },
}

const entry = (data: ReturnType<typeof ZenData.validate>) => {
  const value = data.zenModels["gpt-5.6-sol"]
  return Array.isArray(value) ? value[0] : value
}

describe("ZenData cost200K threshold", () => {
  test("defaults to 200_000 when not configured", () => {
    const data = ZenData.validate({
      ...base,
      zenModels: {
        "gpt-5.6-sol": {
          ...base.zenModels["gpt-5.6-sol"],
          // The secret arrives as parsed JSON in production, so untyped here too.
          cost200K: JSON.parse('{"input":4,"output":15}'),
        },
      },
    })
    expect(entry(data).cost200K?.threshold).toBe(200_000)
  })

  test("accepts an explicit 272_000 threshold", () => {
    const data = ZenData.validate({
      ...base,
      zenModels: {
        "gpt-5.6-sol": {
          ...base.zenModels["gpt-5.6-sol"],
          cost200K: { input: 4, output: 15, threshold: 272_000 },
        },
      },
    })
    expect(entry(data).cost200K?.threshold).toBe(272_000)
  })
})
