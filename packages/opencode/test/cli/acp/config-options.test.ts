import { describe, expect } from "bun:test"
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { expectOk, flattenSelectOptions, selectConfigOption } from "./acp-test-client"
import {
  createAcpClient,
  expectAlternateValue,
  expectSelectOption,
  initialize,
  newSession,
  verifierConfig,
} from "./helpers"

describe("opencode acp config option subprocess", () => {
  cliIt.live(
    'model option is listed with category "model"',
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const model = expectSelectOption((yield* newSession(acp, home)).configOptions, "model")

        expect(model.category).toBe("model")
        expect(model.currentValue).toBe("test/test-model")
        expect(flattenSelectOptions(model).length).toBeGreaterThanOrEqual(2)
      }),
    60_000,
  )

  cliIt.live(
    "model switch updates currentValue",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        const model = expectSelectOption(session.configOptions, "model")
        const nextModel = flattenSelectOptions(model).find((option) => option.value === "test/second-model")?.value
        expect(nextModel).toBe("test/second-model")

        const updated = expectOk(
          yield* acp.request<SetSessionConfigOptionResponse>("session/set_config_option", {
            sessionId: session.sessionId,
            configId: "model",
            value: nextModel,
          }),
        )

        expect(selectConfigOption(updated.configOptions, "model")?.currentValue).toBe(nextModel)
      }),
    60_000,
  )

  cliIt.live(
    'effort option is listed with category "thought_level" when selected model supports variants',
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const effort = expectSelectOption((yield* newSession(acp, home)).configOptions, "effort")

        expect(effort.category).toBe("thought_level")
        expect(effort.currentValue).toBe("low")
        expect(flattenSelectOptions(effort).map((option) => option.value)).toEqual(["low", "high", "default"])
      }),
    60_000,
  )

  cliIt.live(
    "effort switch updates currentValue",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        const nextEffort = expectAlternateValue(expectSelectOption(session.configOptions, "effort"))

        const updated = expectOk(
          yield* acp.request<SetSessionConfigOptionResponse>("session/set_config_option", {
            sessionId: session.sessionId,
            configId: "effort",
            value: nextEffort,
          }),
        )

        expect(selectConfigOption(updated.configOptions, "effort")?.currentValue).toBe(nextEffort)
      }),
    60_000,
  )
})
