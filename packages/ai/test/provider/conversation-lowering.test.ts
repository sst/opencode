import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message } from "../../src/index.js"
import { OpenAI } from "../../src/providers.js"
import { OpenResponses } from "../../src/protocols/open-responses.js"
import { it } from "../lib/effect.js"

it.effect("conversation lowering excludes generation settings and tool definitions", () =>
  Effect.gen(function* () {
    const body = yield* OpenResponses.lowerConversation(
      LLM.request({
        model: OpenAI.configure({ apiKey: "test" }).responses("fixture"),
        system: "Keep the context",
        messages: [Message.user("hello"), Message.assistant("hi")],
        generation: { maxTokens: 100, temperature: 0.5 },
        providerOptions: { store: false },
        tools: [{ name: "unsupported", description: "Generation only", inputSchema: {}, native: { unsupported: {} } }],
      }),
      { id: "open-responses", name: "Open Responses" },
    )
    expect(body).toEqual({
      model: "fixture",
      instructions: "Keep the context",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi" }] },
      ],
    })
  }),
)
