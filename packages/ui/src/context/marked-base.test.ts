import { expect, test } from "bun:test"
import { createMarkdownBase, parseSmallMarkdown } from "./marked-base"

test.each([
  "Plain response.",
  "The grade cost $0.5664, and the original run is preserved.",
  "The issue is fixed: all 13 queries succeeded.",
  "Completion is 100%…",
  "https://example.com",
  "Plain response.   ",
  "Plain response.\t",
  "\nPlain response.\n",
  "\u00a0Plain response.\u00a0",
  "A paragraph\r---",
  "A paragraph  \rwith a hard break.",
  "We can—Code Mode would be useful.\n\nI’ll enable the read-only tools.",
  "A paragraph\nwith a soft break.",
  "A paragraph\r\n\r\nAnother paragraph.",
  "A paragraph\n\n\nAnother paragraph.\n",
  "Quotes: \"yes\" and 'no'.",
  "She said \"yes\" and 'no'.",
  "日本語の文章。",
  "Простой текст.",
  "١. العربية",
  "Hello & goodbye <world>.",
  "A paragraph  \nwith a hard break.",
  "Title\n---",
  "- A list\n- Another item",
  "1. A list\n2. Another item",
  "www.example.com",
  "Bold **text** and `code`.",
  "**Done.** The judge made **13 evidence queries**.",
  "The tool is `candidate_evidence`.\n\nIt can query messages.",
  "***Strong emphasis*** and _emphasis_.",
  "A [link](https://example.com) and ![image](./image.png).",
  "A reference [link][id].\n\n[id]: https://example.com",
  "A paragraph\n# Heading",
  "### Heading",
  "####### Paragraph",
  "***",
  "_ _ _",
  "**",
  "*",
  "+ Item",
  "> Quote",
  "A paragraph\n---",
  "A paragraph\n===",
  "a | b\n--- | ---\nc | d",
  "<div>HTML</div>",
  "A paragraph\n    with indentation.",
  "~~Struck~~ text and www.example.com.",
  "A **bold\nsoft break**.",
  "An escaped \\*asterisk\\*.",
  "    indented code",
  "\n    indented code",
  "   ",
])("preserves the Markdown parser's meaning for %j", (text) => {
  const expected = createMarkdownBase().parse(text, { async: false })
  if (text.includes("indented code")) {
    expect(parseSmallMarkdown(text)).toBeUndefined()
    return
  }
  expect(parseSmallMarkdown(text)).toBe(expected)
})

test("keeps code blocks, math, and large messages on the worker path", () => {
  expect(parseSmallMarkdown("```ts\nconst value = 1\n```")).toBeUndefined()
  expect(parseSmallMarkdown("~~~ts\nconst value = 1\n~~~")).toBeUndefined()
  expect(parseSmallMarkdown("\\(x + y\\)")).toBeUndefined()
  expect(parseSmallMarkdown("$$x + y$$")).toBeUndefined()
  expect(parseSmallMarkdown("a".repeat(1025))).toBeUndefined()
})
