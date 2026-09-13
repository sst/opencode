import { describe, expect, test } from "bun:test"
import {
  buildConfigOptions,
  buildEffortSelectOption,
  buildModeSelectOption,
  buildModelSelectOption,
  formatCurrentModelId,
  formatVariantName,
  parseModelSelection,
  type ConfigOptionProvider,
} from "@/acp/config-option"

const providers: ConfigOptionProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude/sonnet-4": {
        id: "claude/sonnet-4",
        name: "Claude Sonnet 4",
        variants: {
          default: {},
          high: {},
          "very-high": {},
        },
      },
      "claude-haiku": {
        id: "claude-haiku",
        name: "Claude Haiku",
      },
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        variants: {
          minimal: {},
          low: {},
        },
      },
    },
  },
]

describe("acp config options", () => {
  test("builds the model select option with ACP verifier category", () => {
    expect(
      buildModelSelectOption({
        providers,
        currentModel: { providerID: "anthropic", modelID: "claude/sonnet-4" },
        currentVariant: "high",
      }),
    ).toEqual({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "anthropic/claude/sonnet-4",
      options: [
        { value: "anthropic/claude-haiku", name: "Anthropic/Claude Haiku" },
        { value: "anthropic/claude/sonnet-4", name: "Anthropic/Claude Sonnet 4" },
        { value: "openai/gpt-5", name: "OpenAI/GPT-5" },
      ],
    })
  })

  test("includes variant ids in the model option only when requested", () => {
    const option = buildModelSelectOption({
      providers,
      currentModel: { providerID: "anthropic", modelID: "claude/sonnet-4" },
      currentVariant: "high",
      includeVariants: true,
    })

    expect(option.currentValue).toBe("anthropic/claude/sonnet-4/high")
    if (option.type !== "select") throw new Error("expected select option")
    expect(option.options).toContainEqual({
      value: "anthropic/claude/sonnet-4/high",
      name: "Anthropic/Claude Sonnet 4 (High)",
    })
    expect(option.options).not.toContainEqual({
      value: "anthropic/claude/sonnet-4/default",
      name: "Anthropic/Claude Sonnet 4 (Default)",
    })
  })

  test("builds effort option from variants and falls back to default when current variant is invalid", () => {
    expect(buildEffortSelectOption({ variants: ["low", "default", "high"], currentVariant: "missing" })).toEqual({
      id: "effort",
      name: "Effort",
      description: "Available effort levels for this model",
      category: "thought_level",
      type: "select",
      currentValue: "default",
      options: [
        { value: "low", name: "Low" },
        { value: "default", name: "Default" },
        { value: "high", name: "High" },
      ],
    })
  })

  test("effort fallback uses the first variant when default is absent", () => {
    expect(buildEffortSelectOption({ variants: ["minimal", "low"], currentVariant: "missing" })?.currentValue).toBe(
      "minimal",
    )
  })

  test("omits effort option when there are no variants", () => {
    expect(buildEffortSelectOption({ variants: [] })).toBeUndefined()
  })

  test("exposes an explicit default even when the provider only lists named variants", () => {
    expect(buildEffortSelectOption({ variants: ["low", "medium"], currentVariant: "default" })).toMatchObject({
      currentValue: "default",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "default", name: "Default" },
      ],
    })
  })

  test("builds the mode select option with descriptions when present", () => {
    expect(
      buildModeSelectOption({
        currentModeId: "build",
        modes: [
          { id: "build", name: "Build", description: "Make code changes" },
          { id: "plan", name: "Plan" },
        ],
      }),
    ).toEqual({
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: "build",
      options: [
        { value: "build", name: "Build", description: "Make code changes" },
        { value: "plan", name: "Plan" },
      ],
    })
  })

  test("builds full config options with model, effort, and mode in stable order", () => {
    const options = buildConfigOptions({
      providers,
      currentModel: { providerID: "anthropic", modelID: "claude/sonnet-4" },
      currentVariant: "very-high",
      modes: [
        { id: "build", name: "Build" },
        { id: "plan", name: "Plan" },
      ],
      currentModeId: "plan",
    })

    expect(options.map((option) => option.id)).toEqual(["model", "effort", "mode"])
    expect(options.map((option) => option.category)).toEqual(["model", "thought_level", "mode"])
    expect(options[1]?.currentValue).toBe("very-high")
  })

  test("full config options omit effort for models without variants", () => {
    expect(
      buildConfigOptions({
        providers,
        currentModel: { providerID: "anthropic", modelID: "claude-haiku" },
      }).map((option) => option.id),
    ).toEqual(["model"])
  })

  test("parses provider/model selections", () => {
    expect(parseModelSelection("openai/gpt-5", providers)).toEqual({
      model: { providerID: "openai", modelID: "gpt-5" },
    })
  })

  test("parses provider/model/variant selections when the base model exposes that variant", () => {
    expect(parseModelSelection("openai/gpt-5/low", providers)).toEqual({
      model: { providerID: "openai", modelID: "gpt-5" },
      variant: "low",
    })
  })

  test("prefers exact slash-containing model ids before treating the tail as a variant", () => {
    expect(parseModelSelection("anthropic/claude/sonnet-4", providers)).toEqual({
      model: { providerID: "anthropic", modelID: "claude/sonnet-4" },
    })
  })

  test("parses trailing variants for slash-containing model ids", () => {
    expect(parseModelSelection("anthropic/claude/sonnet-4/high", providers)).toEqual({
      model: { providerID: "anthropic", modelID: "claude/sonnet-4" },
      variant: "high",
    })
  })

  test("keeps unknown trailing segments in the model id when they are not valid variants", () => {
    expect(parseModelSelection("anthropic/claude/sonnet-4/missing", providers)).toEqual({
      model: { providerID: "anthropic", modelID: "claude/sonnet-4/missing" },
    })
  })

  test("formats current model ids with and without selected variants", () => {
    expect(
      formatCurrentModelId({
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "low",
        variants: ["minimal", "low"],
      }),
    ).toBe("openai/gpt-5")
    expect(
      formatCurrentModelId({
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "low",
        variants: ["minimal", "low"],
        includeVariant: true,
      }),
    ).toBe("openai/gpt-5/low")
  })

  test("formats current model ids with variant fallback", () => {
    expect(
      formatCurrentModelId({
        model: { providerID: "anthropic", modelID: "claude/sonnet-4" },
        variant: "missing",
        variants: ["default", "high"],
        includeVariant: true,
      }),
    ).toBe("anthropic/claude/sonnet-4/default")
  })

  test("formats variant names for display", () => {
    expect(formatVariantName("very_high-effort")).toBe("Very High Effort")
  })
})
