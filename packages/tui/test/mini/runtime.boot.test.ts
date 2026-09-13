import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { OpenCode } from "@opencode/client/promise"
import { resolveMiniSettings, resolveModelInfo, resolveRunTuiConfig } from "../../src/mini/runtime.boot"
import { catalogModel, catalogProvider } from "./fixture/catalog"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

describe("run runtime boot", () => {
  afterEach(() => {
    mock.restore()
  })

  test("falls back to default tui keymap config when config load fails", async () => {
    const result = await resolveRunTuiConfig(Promise.reject(new Error("boom")))

    expect(result.keybinds.get("leader")?.[0]?.key).toBe("ctrl+x")
    expect(result.leader.timeout).toBe(2000)
    expect(result.keybinds.get("command.palette.show")?.[0]?.key).toBe("ctrl+p")
    expect(result.keybinds.get("variant.cycle")?.[0]?.key).toBe("ctrl+t")
    expect(result.keybinds.get("session.interrupt")?.[0]?.key).toBe("escape")
    expect(result.keybinds.get("prompt.history.previous")?.[0]?.key).toBe("up")
    expect(result.keybinds.get("prompt.history.next")?.[0]?.key).toBe("down")
    expect(result.keybinds.get("prompt.clear")?.[0]?.key).toBe("ctrl+c")
    expect(result.keybinds.get("app.clear")?.[0]?.key).toBe("ctrl+l")
    expect(result.keybinds.get("input.submit")?.[0]?.key).toBe("return")
    expect(result.keybinds.get("input.newline")?.[0]?.key).toBe("shift+return,ctrl+return,alt+return,ctrl+j")
    expect(result.keybinds.get("prompt.queue")?.[0]?.key).toBe("<leader>return")
  })

  test("preserves shared config while resolving independent Mini defaults", async () => {
    const result = await resolveRunTuiConfig(
      createTuiResolvedConfig({
        theme: { mode: "light" },
        leader: { timeout: 450 },
        cursor: { style: "underline", blinking: false },
      }),
    )

    expect(result.theme).toEqual({ mode: "light" })
    expect(result.leader.timeout).toBe(450)
    expect(result.cursor).toEqual({ style: "underline", blinking: false })
    expect(resolveMiniSettings(result)).toEqual({
      thinking: "show",
      tools: "hide",
      shell_output: "hide",
      turn_summary: "show",
      footer: "show",
      splash: "show",
      work_spinner: "block-soft-slide",
      mono: false,
    })
    expect(
      resolveMiniSettings({
        mini: {
          thinking: "show",
          tools: "hide",
          shell_output: "show",
          turn_summary: "hide",
          footer: "hide",
          splash: "hide",
          work_spinner: "block-low-comet",
          mono: true,
        },
      }),
    ).toEqual({
      thinking: "show",
      tools: "hide",
      shell_output: "show",
      turn_summary: "hide",
      footer: "hide",
      splash: "hide",
      work_spinner: "block-low-comet",
      mono: true,
    })
  })

  test("loads v2 providers and models for model selector data", async () => {
    const sdk = OpenCode.make({ baseUrl: "https://opencode.test" })
    const location = { directory: "/workspace", project: { id: "proj_1", directory: "/workspace" } }
    const providerList = spyOn(sdk.provider, "list").mockResolvedValue({
      location,
      data: [catalogProvider("openai", "OpenAI")],
    } as never)
    spyOn(sdk.model, "list").mockResolvedValue({
      location,
      data: [catalogModel({ id: "gpt-5", providerID: "openai", variants: ["high", "minimal"] })],
    } as never)

    await expect(resolveModelInfo(sdk, { directory: "/workspace" })).resolves.toEqual({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5": {
              name: "gpt-5",
              cost: {
                input: 0,
              },
              limit: {
                context: 128_000,
              },
              status: "active",
              variants: {
                high: {},
                minimal: {},
              },
            },
          },
        },
      ],
    })
    expect(providerList).toHaveBeenCalledWith({
      location: {
        directory: "/workspace",
      },
    })
  })
})
