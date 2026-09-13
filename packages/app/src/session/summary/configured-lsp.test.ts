import { expect, test } from "bun:test"
import { configuredLsps } from "./configured-lsp"

test("lists configured LSP names with project overrides and no inferred built-ins", () => {
  expect(
    configuredLsps([
      {
        type: "document",
        info: {
          lsp: {
            typescript: { command: ["typescript-language-server", "--stdio"] },
            rust: { command: ["rust-analyzer"] },
          },
        },
      },
      {
        type: "document",
        info: {
          lsp: {
            typescript: { disabled: true },
            eslint: { command: ["vscode-eslint-language-server", "--stdio"] },
          },
        },
      },
    ]),
  ).toEqual(["eslint", "rust"])
  expect(configuredLsps([{ type: "document", info: { lsp: true } }])).toEqual([])
})

test("a later whole-LSP setting clears earlier names", () => {
  expect(
    configuredLsps([
      { type: "document", info: { lsp: { rust: { command: ["rust-analyzer"] } } } },
      { type: "document", info: { lsp: false } },
      { type: "document", info: { lsp: { custom: { command: ["custom-lsp"] } } } },
    ]),
  ).toEqual(["custom"])
})
