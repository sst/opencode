import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk"
import { describe, expect, test } from "bun:test"
import {
  alternateValue,
  createAcpFixture,
  expectOk,
  flattenSelectOptions,
  initialize,
  newSession,
  requireSelectOption,
  selectConfigOption,
} from "./subprocess"

describe("acp config option subprocess", () => {
  test('model option is listed with category "model"', async () => {
    await using fixture = await createAcpFixture()
    const acp = fixture.spawn()
    await initialize(acp)
    const model = requireSelectOption((await newSession(acp, fixture.home)).configOptions, "model")

    expect(model.category).toBe("model")
    expect(model.currentValue).toBe("test/test-model")
    expect(flattenSelectOptions(model).length).toBeGreaterThanOrEqual(2)
  }, 60_000)

  test("model switch updates currentValue", async () => {
    await using fixture = await createAcpFixture()
    const acp = fixture.spawn()
    await initialize(acp)
    const session = await newSession(acp, fixture.home)
    const model = requireSelectOption(session.configOptions, "model")
    const nextModel = flattenSelectOptions(model).find((option) => option.value === "test/second-model")?.value
    expect(nextModel).toBe("test/second-model")

    const updated = expectOk(
      await acp.request<SetSessionConfigOptionResponse>("session/set_config_option", {
        sessionId: session.sessionId,
        configId: "model",
        value: nextModel,
      }),
    )

    expect(selectConfigOption(updated.configOptions, "model")?.currentValue).toBe(nextModel)
  }, 60_000)

  test('effort option is listed with category "thought_level" when selected model supports variants', async () => {
    await using fixture = await createAcpFixture()
    const acp = fixture.spawn()
    await initialize(acp)
    const effort = requireSelectOption((await newSession(acp, fixture.home)).configOptions, "effort")

    expect(effort.category).toBe("thought_level")
    expect(effort.currentValue).toBe("default")
    expect(flattenSelectOptions(effort).map((option) => option.value)).toEqual(["low", "high", "default"])
  }, 60_000)

  test("effort survives model synchronization and can be reset to default", async () => {
    await using fixture = await createAcpFixture()
    const acp = fixture.spawn()
    await initialize(acp)
    const session = await newSession(acp, fixture.home)
    const nextEffort = alternateValue(requireSelectOption(session.configOptions, "effort"))

    const updated = expectOk(
      await acp.request<SetSessionConfigOptionResponse>("session/set_config_option", {
        sessionId: session.sessionId,
        configId: "effort",
        value: nextEffort,
      }),
    )

    expect(selectConfigOption(updated.configOptions, "effort")?.currentValue).toBe(nextEffort)

    const synchronized = expectOk(
      await acp.request<SetSessionConfigOptionResponse>("session/set_config_option", {
        sessionId: session.sessionId,
        configId: "model",
        value: requireSelectOption(session.configOptions, "model").currentValue,
      }),
    )
    expect(selectConfigOption(synchronized.configOptions, "effort")?.currentValue).toBe(nextEffort)

    const reset = expectOk(
      await acp.request<SetSessionConfigOptionResponse>("session/set_config_option", {
        sessionId: session.sessionId,
        configId: "effort",
        value: "default",
      }),
    )
    expect(selectConfigOption(reset.configOptions, "effort")?.currentValue).toBe("default")
  }, 60_000)
})
