import { describe, expect, test } from "bun:test"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./variant"

describe("model variant", () => {
  test("resolves configured agent variant when model matches", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "openai",
        modelID: "gpt-5.2",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBe("xhigh")
  })

  test("ignores configured variant when model does not match", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBeUndefined()
  })

  test("prefers selected variant over configured variant", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: "high",
      configured: "xhigh",
    })

    expect(value).toBe("high")
  })

  test("lets an explicit default override the configured variant", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })

    expect(value).toBeUndefined()
  })

  test("cycles from configured variant to next", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "high",
    })

    expect(value).toBe("xhigh")
  })

  test("cycles from configured last variant to default", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "xhigh",
    })

    expect(value).toBeUndefined()
  })

  test("cycles from an explicit default to the first variant", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })

    expect(value).toBe("low")
  })

  test("prefers a saved variant to configuration, including explicit Default", () => {
    const input = { variants: ["low", "high"], selected: undefined, configured: "high" }
    expect(resolveModelVariant({ ...input, preferred: "low" })).toBe("low")
    expect(resolveModelVariant({ ...input, preferred: "default" })).toBeUndefined()
    expect(resolveModelVariant({ ...input, preferred: "low", selected: null })).toBeUndefined()
    expect(resolveModelVariant({ ...input, preferred: "low", selected: "high" })).toBe("high")
    expect(cycleModelVariant({ ...input, preferred: "high" })).toBeUndefined()
    expect(cycleModelVariant({ ...input, preferred: "default" })).toBe("low")
  })

  test("normalizes unavailable selections instead of silently applying another variant", () => {
    expect(resolveModelVariant({ variants: ["low"], selected: "high", configured: "low" })).toBeUndefined()
    expect(
      resolveModelVariant({ variants: ["low"], selected: undefined, preferred: "high", configured: "low" }),
    ).toBeUndefined()
    expect(cycleModelVariant({ variants: [], selected: undefined, configured: undefined })).toBeUndefined()
  })
})
