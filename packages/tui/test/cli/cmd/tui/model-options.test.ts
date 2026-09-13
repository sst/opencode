import { describe, expect, test } from "bun:test"
import { go } from "fuzzysort"
import { modelPriceLabel, prioritizeFavorites, sortModelOptions } from "../../../../src/component/dialog-model"

describe("prioritizeFavorites", () => {
  test("uses the favorite order captured when the dialog opened", () => {
    const prioritized = prioritizeFavorites(
      [
        { title: "Best match", value: { providerID: "test", modelID: "best" } },
        { title: "Favorite match", value: { providerID: "test", modelID: "favorite" } },
        { title: "Second best match", value: { providerID: "test", modelID: "second-best" } },
        { title: "Second favorite match", value: { providerID: "test", modelID: "second-favorite" } },
      ],
      new Set(["test/favorite", "test/second-favorite"]),
    )

    expect(prioritized.map((model) => model.title)).toEqual([
      "Favorite match",
      "Second favorite match",
      "Best match",
      "Second best match",
    ])
  })
})

describe("sortModelOptions", () => {
  test.each(["browse", "search", "provider"])("orders %s results free-first, then newest-first", (mode) => {
    const options = [
      { providerID: "opencode", title: "Claude Haiku 3", releaseDate: 1 },
      { providerID: "anthropic", title: "Claude Haiku 4.5", releaseDate: 2 },
      { providerID: "anthropic", title: "Claude Haiku Free", releaseDate: 0, footer: "Free" },
    ].map((item) => ({ ...item, providerID: mode === "provider" ? "anthropic" : item.providerID }))
    const matches = mode === "search" ? go("haik", options, { key: "title" }).map((item) => item.obj) : options
    expect(sortModelOptions(matches, mode === "provider").map((item) => item.title)).toEqual([
      "Claude Haiku Free",
      "Claude Haiku 4.5",
      "Claude Haiku 3",
    ])
  })

  test("orders OpenCode Go before Zen and other providers", () => {
    const sorted = sortModelOptions([
      { providerID: "openai", providerName: "OpenAI", releaseDate: 3, title: "GPT 5" },
      { providerID: "opencode", providerName: "OpenCode Zen", releaseDate: 1, title: "Claude Sonnet 4" },
      { providerID: "anthropic", providerName: "Anthropic", releaseDate: 2, title: "Claude Opus 4" },
      { providerID: "opencode-go", providerName: "OpenCode Go", releaseDate: 0, title: "Kimi K3" },
    ])

    expect(sorted.map((model) => model.title)).toEqual(["Kimi K3", "Claude Sonnet 4", "Claude Opus 4", "GPT 5"])
  })

  test("keeps ungrouped results free-first regardless of OpenCode provider", () => {
    const sorted = sortModelOptions(
      [
        { providerID: "opencode-go", releaseDate: 3, title: "Go model" },
        { providerID: "opencode", releaseDate: 1, title: "Free Zen model", footer: "Free" },
        { providerID: "anthropic", releaseDate: 4, title: "Anthropic model" },
      ],
      false,
    )

    expect(sorted.map((model) => model.title)).toEqual(["Free Zen model", "Anthropic model", "Go model"])
  })

  test("orders provider groups by provider name and models by newest release", () => {
    const sorted = sortModelOptions([
      { providerID: "google", providerName: "Google", releaseDate: 5, title: "Gemini 2.5 Pro" },
      { providerID: "anthropic", providerName: "Anthropic", releaseDate: 4, title: "Claude Sonnet 4" },
      { providerID: "anthropic", providerName: "Anthropic", releaseDate: 6, title: "Claude Opus 4" },
      { providerID: "openai", providerName: "OpenAI", releaseDate: 7, title: "GPT 5" },
    ])

    expect(sorted.map((model) => model.title)).toEqual(["Claude Opus 4", "Claude Sonnet 4", "Gemini 2.5 Pro", "GPT 5"])
  })

  test("falls back to title when release dates match within a provider", () => {
    const sorted = sortModelOptions([
      { providerID: "anthropic", providerName: "Anthropic", releaseDate: 5, title: "Claude Sonnet 4" },
      { providerID: "anthropic", providerName: "Anthropic", releaseDate: 5, title: "Claude Opus 4" },
    ])

    expect(sorted.map((model) => model.title)).toEqual(["Claude Opus 4", "Claude Sonnet 4"])
  })
})

describe("organization route options", () => {
  test("shows variable pricing even when an empty or zero price is supplied", () => {
    expect(modelPriceLabel({ providerID: "opencode-routes-org_first", cost: [] })).toBe("Variable")
    expect(modelPriceLabel({ providerID: "opencode-routes-org_first", cost: [{ input: 0 }] })).toBe("Variable")
    expect(modelPriceLabel({ providerID: "opencode", cost: [{ input: 0 }] })).toBe("Free")
    expect(modelPriceLabel({ providerID: "opencode", cost: [] })).toBeUndefined()
    expect(modelPriceLabel({ providerID: "anthropic", cost: [{ input: 3 }] })).toBeUndefined()
  })

  test("keeps favorites isolated when organizations have the same route key", () => {
    const first = { value: { providerID: "opencode-routes-org_first", modelID: "route_1" } }
    const second = { value: { providerID: "opencode-routes-org_second", modelID: "route_1" } }
    expect(prioritizeFavorites([second, first], new Set(["opencode-routes-org_first/route_1"]))).toEqual([
      first,
      second,
    ])
  })
})
