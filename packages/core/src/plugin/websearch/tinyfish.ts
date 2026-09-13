export * as WebSearchTinyFish from "./tinyfish.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema, Scope } from "effect"
import { HttpClient } from "effect/unstable/http"
import { App } from "../../app.js"
import { WebSearchMcp } from "./mcp.js"

export const endpoint = "https://agent.tinyfish.ai/mcp"

const McpInput = Schema.Struct({
  query: Schema.String,
})

const McpOutput = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
})

const SearchResponse = Schema.fromJsonString(
  Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        url: Schema.String,
        title: Schema.String,
        snippet: Schema.String,
      }),
    ),
  }),
)
const decodeSearchResponse = Schema.decodeUnknownOption(SearchResponse)

export const Plugin = define<HttpClient.HttpClient | Scope.Scope>({
  id: "opencode.websearch.tinyfish",
  effect: Effect.fn("WebSearchTinyFish.Plugin")(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    yield* ctx.integration.transform((editor) => {
      editor.update("tinyfish", (integration) => (integration.name = "TinyFish"))
      editor.method.update({
        integrationID: "tinyfish",
        method: { type: "key" },
      })
      editor.method.update({
        integrationID: "tinyfish",
        method: { type: "env", names: ["TINYFISH_API_KEY"] },
      })
    })
    yield* ctx.websearch.transform((editor) => {
      editor.add({
        id: "tinyfish",
        name: "TinyFish",
        execute: (input) =>
          Effect.gen(function* () {
            const connection = yield* ctx.integration.connection.active("tinyfish")
            const credential = connection ? yield* ctx.integration.connection.resolve(connection) : undefined
            const result = yield* WebSearchMcp.call(
              http,
              endpoint,
              "search",
              { input: McpInput, output: McpOutput },
              { query: input.query },
              {
                "User-Agent": App.useragent(ctx.app),
                ...(credential?.type === "key"
                  ? { "X-API-Key": credential.key }
                  : { "X-TinyFish-Access-Mode": "keyless" }),
              },
            )
            const content = result?.content.find((item) => item.text)
            const response = content ? Option.getOrUndefined(decodeSearchResponse(content.text)) : undefined
            return (
              response?.results.map((item) => ({
                url: item.url,
                title: item.title,
                ...(item.snippet ? { content: item.snippet } : {}),
                time: {},
              })) ?? []
            )
          }),
      })
    })
  }),
})
