import { describe, expect, test } from "bun:test"
import type { ConfigEntry } from "@opencode/client/promise"
import { configuredLanguageServers } from "./project-lsp"

const global: ConfigEntry = {
  type: "document",
  path: "/config/opencode.json",
  info: {
    lsp: {
      typescript: { command: ["typescript-language-server", "--stdio"], extensions: [".ts", ".tsx"] },
      eslint: { disabled: true },
    },
  },
}

describe("configuredLanguageServers", () => {
  test("merges inherited entries and project overrides by name", () => {
    expect(
      configuredLanguageServers([
        global,
        { type: "directory", path: "/project/.opencode" },
        {
          type: "document",
          path: "/project/opencode.jsonc",
          info: {
            lsp: {
              typescript: { disabled: true },
              eslint: { command: ["eslint-lsp"], disabled: false, extensions: [".js"] },
              rust: { command: ["rust-analyzer"], extensions: [".rs"] },
            },
          },
        },
      ]),
    ).toEqual({
      disabled: false,
      servers: [
        { name: "eslint", disabled: false, extensions: [".js"] },
        { name: "rust", disabled: false, extensions: [".rs"] },
        { name: "typescript", disabled: true, extensions: [".ts", ".tsx"] },
      ],
    })
  })

  test("does not invent servers for omitted or boolean-only configuration", () => {
    expect(configuredLanguageServers([])).toEqual({ disabled: false, servers: [] })
    expect(configuredLanguageServers([global, { type: "document", info: { lsp: false } }])).toEqual({
      disabled: true,
      servers: [],
    })
    expect(configuredLanguageServers([global, { type: "document", info: { lsp: true } }])).toEqual({
      disabled: false,
      servers: [],
    })
  })

  test("allows named configuration after a disabled parent without reviving earlier entries", () => {
    expect(
      configuredLanguageServers([
        global,
        { type: "document", info: { lsp: false } },
        { type: "document", info: { lsp: { custom: { command: ["custom-lsp"] } } } },
      ]),
    ).toEqual({ disabled: false, servers: [{ name: "custom", disabled: false, extensions: [] }] })
  })
})
