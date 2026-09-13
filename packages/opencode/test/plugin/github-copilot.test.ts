import { expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { CopilotAuthPlugin } from "@/plugin/github-copilot/copilot"

type ChatHeaders = NonNullable<Hooks["chat.headers"]>

async function hook() {
  const hooks = await CopilotAuthPlugin({
    directory: "",
    project: {} as never,
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost"),
    $: {} as never,
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: {} }),
      },
    } as never,
  })
  return hooks["chat.headers"]!
}

function input(sessionID: string, providerID: string, npm: string) {
  return {
    sessionID,
    agent: "build",
    model: { providerID, api: { npm } },
    message: { id: "msg_test", sessionID },
  } as Parameters<ChatHeaders>[0]
}

test.each([
  ["github-copilot", "@ai-sdk/github-copilot"],
  ["github-copilot", "@ai-sdk/anthropic"],
  ["github-copilot-enterprise", "@ai-sdk/github-copilot"],
  ["github-copilot-enterprise", "@ai-sdk/anthropic"],
])("uses the session ID for %s interaction headers with %s", async (providerID, npm) => {
  const headers = await hook()
  for (const sessionID of ["ses_one", "ses_one", "ses_two"]) {
    const output = { headers: { "x-existing": "preserved" } }
    await headers(input(sessionID, providerID, npm), output)
    expect(output.headers).toMatchObject({
      "X-Interaction-Id": sessionID,
      "x-existing": "preserved",
    })
  }
})

test("does not add interaction headers to other providers", async () => {
  const headers = await hook()
  const output = { headers: { "x-existing": "preserved" } }
  await headers(input("ses_one", "openai", "@ai-sdk/openai"), output)
  expect(output.headers).toEqual({ "x-existing": "preserved" })
})
