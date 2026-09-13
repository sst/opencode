import { describe, expect, test } from "bun:test"
import { resetSessionModel, syncPromptModel, syncSessionModel } from "./session-model-helpers"

const message = (input?: { agent?: string; model?: { providerID: string; modelID: string; variant?: string } }) => ({
  sessionID: "session",
  agent: input?.agent ?? "build",
  model: input?.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4" },
})

describe("syncSessionModel", () => {
  test("restores the last message through session state", () => {
    const calls: unknown[] = []

    syncSessionModel(
      {
        session: {
          restore(value) {
            calls.push(value)
          },
          reset() {},
        },
      },
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
    )

    expect(calls).toEqual([
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
    ])
  })
})

describe("resetSessionModel", () => {
  test("clears draft session state", () => {
    const calls: string[] = []

    resetSessionModel({
      session: {
        reset() {
          calls.push("reset")
        },
        restore() {},
      },
    })

    expect(calls).toEqual(["reset"])
  })
})

describe("syncPromptModel", () => {
  test("stores the effective session model in prompt state", () => {
    const calls: unknown[] = []

    syncPromptModel(
      {
        model: {
          current: () => ({ id: "claude-sonnet-4", provider: { id: "anthropic" } }),
          variant: { current: () => "high" },
        },
      },
      {
        model: {
          current: () => undefined,
          set: (model) => calls.push(model),
        },
      },
    )

    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }])
  })

  test("does not rewrite an unchanged prompt model", () => {
    const calls: unknown[] = []
    const model = { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }

    syncPromptModel(
      {
        model: {
          current: () => ({ id: model.modelID, provider: { id: model.providerID } }),
          variant: { current: () => model.variant },
        },
      },
      {
        model: {
          current: () => model,
          set: (value) => calls.push(value),
        },
      },
    )

    expect(calls).toEqual([])
  })
})

describe("stale prompt model", () => {
  test("replaces the submission mirror without changing the effective selection", () => {
    const calls: unknown[] = []
    syncPromptModel(
      {
        model: {
          current: () => ({ id: "gpt", provider: { id: "openai" } }),
          variant: {
            current: () => undefined,
          },
        },
      },
      {
        model: {
          current: () => ({ providerID: "anthropic", modelID: "claude", variant: "high" }),
          set: (value) => calls.push(value),
        },
      },
    )

    expect(calls).toEqual([{ providerID: "openai", modelID: "gpt", variant: undefined }])
  })
})
