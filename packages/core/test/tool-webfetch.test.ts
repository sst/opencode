import { describe, expect, test } from "bun:test"
import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { WebFetchTool } from "@opencode/core/tool/plugin/webfetch"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Image } from "@opencode/core/image"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"

const webFetchToolNode = makeLocationNode({
  name: "test/webfetch-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(WebFetchTool.Plugin)),
  deps: [Tool.node, Permission.node, LayerNodePlatform.httpClient],
})

const sessionID = Session.ID.make("ses_webfetch_test")
const webFetchUserAgent =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OpenCode-User/1.0; +https://opencode.ai"
const requests: Array<{ readonly url: string; readonly headers: Record<string, string> }> = []
const assertions: Permission.AssertInput[] = []
let respond = (_request: HttpClientRequest.HttpClientRequest) =>
  Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => requests.push({ url: request.url, headers: request.headers })).pipe(
      Effect.andThen(respond(request)),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    ),
  ),
)
const permission = permissionLayer({ assert: (input) => Effect.sync(() => assertions.push(input)) })
const toolLayer = (replacements: LayerNode.Replacements = []) =>
  AppNodeBuilder.build(LayerNode.group([Tool.node, webFetchToolNode]), [
    Permission.node.replace(permission),
    Image.node.replace(imagePassthrough),
    ...replacements,
  ])
const it = testEffect(toolLayer([LayerNodePlatform.httpClient.replace(http)]))
const live = testEffect(toolLayer())

const reset = () => {
  requests.length = 0
  assertions.length = 0
  respond = () => Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))
}

const call = (input: typeof WebFetchTool.Input.Type, id = "call-webfetch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "webfetch", input },
})

describe("WebFetchTool helpers", () => {
  test("defaults format and rejects invalid timeout controls", () => {
    const decode = Schema.decodeUnknownSync(WebFetchTool.Input)
    expect(decode({ url: "https://example.com" })).toEqual({ url: "https://example.com", format: "markdown" })
    expect(() => decode({ url: "https://example.com", timeout: 0 })).toThrow()
    expect(() => decode({ url: "https://example.com", timeout: WebFetchTool.MAX_TIMEOUT_SECONDS + 1 })).toThrow()
  })

  test("ports HTML text and markdown conversions without active content", () => {
    const html =
      "<h1>Hello</h1><script>bad()</script><p>world <strong>wide</strong> <product-name>today</product-name></p><style>.bad {}</style>"
    expect(WebFetchTool.extractTextFromHTML(html)).toBe("Helloworld wide today")
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("# Hello\n\nworld **wide** today")
  })

  test("renders headings, inline semantics, links, images, breaks, and thematic breaks", () => {
    const html = `<h2>Read <em>this</em></h2><p><a href="https://example.com/a (b)" title="Example">docs</a><br><img src="diagram.png" alt="a ] b"></p><hr><p><del>old</del></p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `## Read *this*\n\n[docs](https://example.com/a%20\\(b\\) "Example")  \n![a \\] b](diagram.png)\n\n---\n\n~~old~~`,
    )
  })

  test("preserves inline and preformatted code verbatim with safe fences", () => {
    const html = `<p>Use <code>say(\`hello\`)</code> now.</p><pre><code class="language-ts">const fence = \`\`\`\n&amp; stays decoded</code></pre>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `Use \`\`say(\`hello\`)\`\` now.\n\n~~~ts\nconst fence = \`\`\`\n& stays decoded\n~~~`,
    )
  })

  test.each([
    ["`x`", "`` `x` ``"],
    ["`x", "`` `x ``"],
    ["x`", "`` x` ``"],
    ["`", "`` ` ``"],
    ["``", "``` `` ```"],
    ["``x`", "``` ``x` ```"],
    ["say(`x`)", "``say(`x`)``"],
    ["a``b`c", "```a``b`c```"],
    ["x", "`x`"],
    [" x ", "`  x  `"],
    [" x", "`  x `"],
    ["x ", "` x  `"],
    ["   ", "`   `"],
    [" ` ", "``  `  ``"],
  ])("preserves inline code boundaries for %j", (content, expected) => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p>Use <code>${content}</code>.</p>`)).toBe(`Use ${expected}.`)
  })

  test.each([
    ["discarded trailing backtick after ASCII", "x`", 7, "``x``"],
    ["discarded trailing backtick after Unicode", "😀`", 10, "``😀``"],
    ["discarded trailing backtick with spare room", "x`", 9, "``x``"],
    ["retained trailing backtick", "x`", 10, "`` x` ``"],
    ["new trailing backtick from an internal run", "x`y", 8, "``x``"],
    ["leading backtick without padding room", "`x", 8, ""],
    ["leading backtick alone fits", "`x", 9, "`` ` ``"],
    ["leading backtick with payload fits", "`x", 10, "`` `x ``"],
    ["all backticks truncated", "``", 11, "``` ` ```"],
    ["all backticks fit", "``", 12, "``` `` ```"],
    ["mixed internal runs truncated", "a``b`c", 11, "```a```"],
    ["Unicode code point cannot fit", "😀`", 9, ""],
    ["ordinary payload cannot fit", "x", 3, ""],
    ["spaces cannot fit", "   ", 4, ""],
    ["space-only prefix fits", "   ", 5, "` `"],
    ["truncated prefix becomes space-only", " x", 6, "` `"],
    ["discarded trailing space", "x ", 5, "`x`"],
  ] as const)("fits inline code to its emitted boundaries: %s", (_name, content, spare, expected) => {
    const prefix = "x".repeat(WebFetchTool.MAX_RESPONSE_BYTES - 64 * 1024 - spare)
    const html = `<p>${prefix}<code>${content}</code></p>`
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(WebFetchTool.MAX_RESPONSE_BYTES)
    const output = WebFetchTool.convertHTMLToMarkdown(html)
    expect(output.slice(0, prefix.length)).toBe(prefix)
    expect(output.slice(prefix.length)).toBe(expected)
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(WebFetchTool.MAX_RESPONSE_BYTES)
  })

  test("keeps nested ordered and unordered lists structurally readable", () => {
    const html = `<ol start="3"><li>alpha<ul><li>nested <strong>item</strong></li></ul></li><li><p>beta first</p><p>beta second</p></li></ol>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `3. alpha\n\n   - nested **item**\n\n4. beta first\n\n   beta second`,
    )
  })

  test("renders blockquotes and tables as readable Markdown", () => {
    const html = `<blockquote><p>quoted <em>text</em></p><ul><li>point</li></ul></blockquote><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>one</td><td><code>1</code></td></tr></tbody></table>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `> quoted *text*\n\n> - point\n\n| Name | Value |\n| --- | --- |\n| one | \`1\` |`,
    )
  })

  test("decodes entities and normalizes prose whitespace without joining words", () => {
    const html = `<p>alpha\n  <span>&amp; beta</span> <unknown>caf&eacute;</unknown>&nbsp;gamma 😀</p><p>delta</p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`alpha & beta café gamma 😀\n\ndelta`)
  })

  test("omits active and fallback content while retaining surrounding prose", () => {
    const html = `<p>before <script><b>bad</b></script><style>bad</style><noscript>bad</noscript><iframe>bad</iframe><object>bad</object><embed src="bad"><meta content="bad"><link href="bad"><template>bad</template> after</p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("before after")
  })

  test("is deterministic and bounded for malformed input across parser chunks", () => {
    const html = `<main><p>${"visible &amp; text ".repeat(4_096)}</main></p></unknown>`
    const first = WebFetchTool.convertHTMLToMarkdown(html)
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(first)
    expect(first.startsWith("visible & text visible & text")).toBe(true)
    expect(first.length).toBeLessThanOrEqual(html.length)
  })

  test("defaults to the production byte budget with room for closing syntax", () => {
    const output = WebFetchTool.convertHTMLToMarkdown("x".repeat(WebFetchTool.MAX_RESPONSE_BYTES))
    expect(WebFetchTool.MAX_RESPONSE_BYTES).toBe(5 * 1024 * 1024)
    expect(output).toHaveLength(WebFetchTool.MAX_RESPONSE_BYTES - 64 * 1024)
  })

  test.each(["x", "\u00e9", "\u{1f600}"])("preserves UTF-8 boundaries at the content limit for %s", (character) => {
    const budget = WebFetchTool.MAX_RESPONSE_BYTES - 64 * 1024
    const fitting = "aa" + character.repeat(Math.floor((budget - 2) / Buffer.byteLength(character)))
    expect(WebFetchTool.convertHTMLToMarkdown(fitting)).toBe(fitting)
    const truncated = WebFetchTool.convertHTMLToMarkdown(fitting + character)
    expect(truncated).toBe(fitting)
    expect(Buffer.byteLength(truncated)).toBe(Buffer.byteLength(fitting))
  })

  test("bounds deeply nested list output and fragmented code fences", () => {
    const lists = `${"<ul><li>item".repeat(2_000)}${"</li></ul>".repeat(2_000)}`
    const quotes = `${"<blockquote><p>item".repeat(2_000)}${"</p></blockquote>".repeat(2_000)}`
    const code = `<pre>${"` x ".repeat(4_096)}</pre>`
    expect(WebFetchTool.convertHTMLToMarkdown(lists).length).toBeLessThan(lists.length * 4)
    expect(WebFetchTool.convertHTMLToMarkdown(quotes).length).toBeLessThan(quotes.length * 4)
    expect(() => WebFetchTool.convertHTMLToMarkdown(code)).not.toThrow()
    expect(
      WebFetchTool.convertHTMLToMarkdown(
        "<div>".repeat(20_000) + "safe<script><b>bad</b>&amp;</script><p>tail &amp;</p>",
      ),
    ).toBe("safe tail &")
  })

  test("escapes prose that would otherwise become Markdown structure", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p># heading</p><p>1. item</p><p>---</p><p>a | b</p>`)).toBe(
      `\\# heading\n\n1\\. item\n\n\\---\n\na \\| b`,
    )
  })

  test("preserves code whitespace and quotes every line of multiline blocks", () => {
    const html = `<blockquote><pre>line  \n\n\nnext</pre><table><tr><td>a|b</td><td>c</td></tr></table></blockquote>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `> \`\`\`\n> line  \n> \n> \n> next\n> \`\`\`\n\n> | a\\|b | c |\n> | --- | --- |`,
    )
  })

  test("keeps nested blockquotes inside their outer quote", () => {
    const html = `<blockquote><p>outer</p><blockquote><p>inner</p></blockquote><p>end</p></blockquote>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`> outer\n>\n> > inner\n>\n> end`)
  })

  test("keeps visible whitespace around inline emphasis", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p>a<strong> b</strong> c a <em>b </em>c</p>`)).toBe(`a **b** c a *b* c`)
    expect(WebFetchTool.convertHTMLToMarkdown(`a<strong> </strong>b a<em> </em>b`)).toBe(`a b a b`)
  })

  test("captures formatting elements inside preformatted content as code only", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<pre><b>x</b><i>y</i><del>z</del></pre>`)).toBe(`\`\`\`\nxyz\n\`\`\``)
  })

  test("normalizes multiline table cells without changing their columns", () => {
    const html = `<table><tr><td>x<br>y</td><td><code>a|b</code></td><td><p>first</p><p>second</p></td></tr></table>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`| x y | \`a\\|b\` | first second |\n| --- | --- | --- |`)
  })

  test("flattens nested tables without corrupting the outer table", () => {
    const html = `<table><tr><th>Parent</th><th>Sibling</th></tr><tr><td>Before<table><tr><th>Key</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>After</td><td>Tail</td></tr></table>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `| Parent | Sibling |\n| --- | --- |\n| Before Key Value A 1 After | Tail |`,
    )
  })

  test("preserves loose text around malformed table rows", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<table>before<tr><td>cell</td></tr>after</table>`)).toBe(
      `before after\n\n| cell |\n| --- |`,
    )
    expect(WebFetchTool.convertHTMLToMarkdown(`<table>alpha</table>`)).toBe(`alpha`)
  })

  test("escapes tilde fences and removes empty emphasis markers", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p>~~~</p><p><strong></strong>content</p><p>~~~</p>`)).toBe(
      `\\~\\~\\~\n\ncontent\n\n\\~\\~\\~`,
    )
  })

  test("does not confuse source NUL text with buffered code", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p>before \u00000\u0000 after</p><pre>code</pre>`)).toBe(
      `before \u00000\u0000 after\n\n\`\`\`\ncode\n\`\`\``,
    )
  })

  test("preserves multiline inline code verbatim", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p><code>first\n\n\nsecond  </code></p>`)).toBe(
      "` first\n\n\nsecond   `",
    )
  })

  test("prefixes inline code at the start of a blockquote line", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<blockquote><code>x</code> y</blockquote>`)).toBe(`> \`x\` y`)
  })

  test("keeps links nested in inline code associated with their text", () => {
    const html = `<dl><dt><code>socket = new <a href="#constructor">WebSocket</a>(url)</code><dd>Creates one.</dl>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `**\` socket = new  \`[\`WebSocket\`](#constructor)\`(url)\`**\n: Creates one.`,
    )
    expect(WebFetchTool.convertHTMLToMarkdown(`<code><a href="#x">x</a></code> after`)).toBe(`[\`x\`](#x) after`)
    expect(
      WebFetchTool.convertHTMLToMarkdown(
        `<dl><dt><code><var>socket</var> = new <code><a href="#constructor">WebSocket</a></code>(<var>url</var>)</code><dd>Creates one.</dl>`,
      ),
    ).toBe(`**\` socket = new  \`[\`WebSocket\`](#constructor)\`(url)\`**\n: Creates one.`)
    expect(WebFetchTool.convertHTMLToMarkdown(`<code>a<a href="/x">b<a href="/y">c</a>d</a>e</code>`)).toBe(
      `\`a\`[\`b\`](\/x)[\`c\`](\/y)\`de\``,
    )
    expect(WebFetchTool.convertHTMLToMarkdown(`<code>a<a href="/x">b</code>c`)).toBe(`\`a\`[\`b\`](\/x)c`)
    expect(WebFetchTool.convertHTMLToMarkdown(`<code>a<a href="/x"><div>b</div>c</a>d</code>`)).toBe(
      `\`a\`[](\/x)\n\n\`bcd\``,
    )
  })

  test("indents nested list continuations and preserves ordered numbering", () => {
    const html = `<ol start="0"><li value="4"><p>first</p><p>continued</p><ul><li><p>nested</p><p>continued nested</p></li></ul></li><li>next</li></ol>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `4. first\n\n   continued\n\n   - nested\n\n     continued nested\n\n5. next`,
    )
  })

  test("renders block content outside link syntax", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<a href="/docs">before<div>block</div>after</a>`)).toBe(
      `[before](/docs)\n\nblock\n\n[after](/docs)`,
    )
  })

  test("recovers nested anchors without unmatched Markdown syntax", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<a href="/a">x<a href="/b">y</a>z</a>`)).toBe(`[x](/a)[y](/b)z`)
  })

  test("keeps emphasis whitespace through neutral wrappers", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<p>a<strong><span> bold</span></strong>c</p>`)).toBe(`a **bold** c`)
  })

  test("flattens preformatted content inside table cells", () => {
    const html = `<table><tr><td><pre>a|b\nnext</pre></td><td><code>x|y</code></td></tr></table>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`| a\\|b next | \`x\\|y\` |\n| --- | --- |`)
  })

  test("preserves Unicode in inline constructs", () => {
    const payload = "😀".repeat(16)
    const cases = [
      [`<strong>${payload}</strong>`, `**${payload}**`],
      [`<a href="/docs">${payload}</a>`, `[${payload}](/docs)`],
      [`<img src="image.png" alt="${payload}">`, `![${payload}](image.png)`],
      [`<code>${payload}</code>`, `\`${payload}\``],
    ] as const
    for (const [html, expected] of cases) {
      expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(expected)
    }
  })

  test("preserves block content and following lists", () => {
    const payload = "x".repeat(256)
    const table = WebFetchTool.convertHTMLToMarkdown(
      `<table><tr><th>Name</th></tr><tr><td>${payload}</td></tr></table>`,
    )
    const list = WebFetchTool.convertHTMLToMarkdown(`<ul><li>${payload}</li></ul><ul><li>next</li></ul>`)
    const code = WebFetchTool.convertHTMLToMarkdown(`<pre>${payload}</pre>`)
    expect(table).toBe(`| Name |\n| --- |\n| ${payload} |`)
    expect(list).toBe(`- ${payload}\n\n- next`)
    expect(code).toBe(`\`\`\`\n${payload}\n\`\`\``)
  })

  test("keeps quoted code with long delimiter runs inside a safe closed fence", () => {
    const payload = `${"`".repeat(32)}${"~".repeat(32)}${"x".repeat(64)}`
    const output = WebFetchTool.convertHTMLToMarkdown(`<blockquote><pre>${payload}</pre></blockquote>`)
    expect(output).toBe(`> ${"`".repeat(33)}\n> ${payload}\n> ${"`".repeat(33)}`)
  })

  test("separates reconstructed tables from adjacent inline and quoted content", () => {
    const html = `intro<table><tr><td>x</td></tr></table>outro<blockquote>quote<table><tr><td>cell</td></tr></table></blockquote><ul><li>item<table><tr><td>cell</td></tr></table></li></ul>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `intro\n\n| x |\n| --- |\n\noutro\n\n> quote\n\n> | cell |\n> | --- |\n\n- item\n\n| cell |\n| --- |`,
    )
  })

  test("keeps multiline quoted code closed before following prose", () => {
    const html = `<blockquote><pre>${"x\n".repeat(16)}</pre></blockquote><p>tail</p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`> \`\`\`\n${"> x\n".repeat(16)}> \`\`\`\n\ntail`)
  })

  test("keeps active content suppressed when depth fallback begins", () => {
    const html = `<object>${"<div>".repeat(10_001)}LEAK${"</div>".repeat(10_001)}</object><p>visible</p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("visible")
  })

  test("keeps visible text after depth fallback begins inside preformatted content", () => {
    const html = `<pre>${"<i>".repeat(10_001)}visible${"</i>".repeat(10_001)}</pre><p>after</p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("visible after")
  })

  test("resumes links around every block structure", () => {
    const html = `<a href="/x">before<blockquote><p>quote</p></blockquote><ul><li>item</li></ul><pre>code</pre><table><tr><td>cell</td></tr></table>after</a>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `[before](/x)\n\n> quote\n\n- item\n\n\`\`\`\ncode\n\`\`\`\n\n| cell |\n| --- |\n\n[after](/x)`,
    )
  })

  test("indents child lists from the actual parent marker width", () => {
    expect(WebFetchTool.convertHTMLToMarkdown(`<ol start="100"><li>outer<ul><li>inner</li></ul></li></ol>`)).toBe(
      `100. outer\n\n     - inner`,
    )
  })

  test("renders captions and definition lists with readable boundaries", () => {
    const html = `<table><caption>Cache modes</caption><tr><th>Name</th><th>Meaning</th></tr><tr><td>A</td><td>Local</td></tr></table><dl><dt>Cache</dt><dd>A local store</dd><dt>Origin</dt><dd>The remote source</dd></dl>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `Cache modes\n\n| Name | Meaning |\n| --- | --- |\n| A | Local |\n\n**Cache**\n: A local store\n\n**Origin**\n: The remote source`,
    )
  })

  test("falls back to row-oriented text for table spans", () => {
    const html = `<table><tr><th colspan="2">Group</th></tr><tr><td>A</td><td rowspan="2">Shared</td></tr><tr><td>B</td></tr></table>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`Group\n\nA | Shared\n\nB`)
  })

  test("suppresses head and hidden subtrees while retaining visible body content", () => {
    const html = `<head><title>noise</title></head><body><p>visible</p><div hidden>hidden</div><div aria-hidden="true">aria</div><div aria-hidden="false">shown</div></body>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`visible\n\nshown`)
  })

  test("preserves pre breaks and normalizes multiline link titles", () => {
    const html = `<pre>first<br>second</pre><p><a href="/x" title="line one\n  line two">link</a></p>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(
      `\`\`\`\nfirst\nsecond\n\`\`\`\n\n[link](/x "line one line two")`,
    )
  })

  test("renders closed and open details according to visibility", () => {
    const html = `<details><summary>Closed</summary><p>secret</p></details><details open><summary>Open</summary><p>visible</p></details>`
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe(`Closed\n\nOpen\n\nvisible`)
  })
})

describe("WebFetchTool registration", () => {
  it.effect("registers and fetches an ordinary hostname HTTP URL without rewriting it", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      const url = "http://example.com/public"

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["webfetch", "execute"])
      expect(yield* executeTool(registry, call({ url, format: "text", timeout: 4 }))).toEqual({
        status: "completed",
        output: { url, contentType: "text/plain", format: "text", output: "hello" },
        content: [{ type: "text", text: "hello" }],
        metadata: { contentType: "text/plain" },
      })
      expect(assertions).toMatchObject([
        { sessionID, action: "webfetch", resources: [url], save: ["*"], metadata: { url, format: "text", timeout: 4 } },
      ])
      expect(requests).toMatchObject([
        {
          url,
          headers: {
            accept: "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
            "accept-language": "en-US,en;q=0.9",
            "user-agent": webFetchUserAgent,
          },
        },
      ])
      expect(requests[0]?.headers).not.toHaveProperty("sec-fetch-mode")
    }),
  )

  it.effect("accepts localhost URLs with the same requested-URL permission check", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      const url = "http://localhost/private"

      expect(yield* executeTool(registry, call({ url, format: "text" }))).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "hello" }],
      })
      expect(assertions).toMatchObject([
        { sessionID, action: "webfetch", resources: [url], save: ["*"], metadata: { url, format: "text" } },
      ])
      expect(requests.map((request) => request.url)).toEqual([url])
    }),
  )

  live.effect("follows redirects while approving only the requested URL", () => {
    const received: Array<Record<string, string | null>> = []
    return Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => {
            received.push({
              accept: request.headers.get("accept"),
              "accept-language": request.headers.get("accept-language"),
              "sec-fetch-mode": request.headers.get("sec-fetch-mode"),
              "user-agent": request.headers.get("user-agent"),
            })
            if (new URL(request.url).pathname === "/redirect")
              return new Response("", { status: 302, headers: { location: "/target" } })
            return new Response("redirected", { headers: { "content-type": "text/plain" } })
          },
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          reset()
          const registry = yield* Tool.Service
          const url = new URL("/redirect", server.url).toString()

          expect(yield* executeTool(registry, call({ url, format: "text" }))).toMatchObject({
            status: "completed",
            content: [{ type: "text", text: "redirected" }],
          })
          expect(assertions).toMatchObject([
            { sessionID, action: "webfetch", resources: [url], save: ["*"], metadata: { url, format: "text" } },
          ])
          expect(received).toEqual(
            Array.from({ length: 2 }, () => ({
              accept: "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
              "accept-language": "en-US,en;q=0.9",
              "sec-fetch-mode": null,
              "user-agent": webFetchUserAgent,
            })),
          )
        }),
      (server) => Effect.promise(() => server.stop(true)),
    )
  })

  it.effect("rejects non-HTTP schemes before permission or transport", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service

      // toSessionError unwraps the "Unable to fetch <url>" ToolFailure to its cause message.
      expect(yield* executeTool(registry, call({ url: "file:///etc/passwd", format: "text" }))).toEqual({
        status: "error",
        error: { type: "unknown", message: "URL must use http:// or https://" },
      })
      expect(assertions).toEqual([])
      expect(requests).toEqual([])
    }),
  )

  it.effect("converts HTML to requested markdown and text", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<h1>Hello</h1><p>world</p><script>bad()</script>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        )
      const registry = yield* Tool.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "markdown" }))).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "# Hello\n\nworld" }],
      })
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "text" }))).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "Helloworld" }],
      })
    }),
  )

  it.effect("converts deeply nested HTML without overflowing", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<div>".repeat(10_000) + "content" + "</div>".repeat(10_000), {
            headers: { "content-type": "text/html" },
          }),
        )
      const registry = yield* Tool.Service
      const url = "https://1.1.1.1/deep-html"

      expect(yield* executeTool(registry, call({ url, format: "markdown" }))).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "content" }],
      })
    }),
  )

  it.effect("rejects declared and streamed oversized bodies", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      respond = () =>
        Effect.succeed(
          new Response("small", {
            headers: { "content-type": "text/plain", "content-length": String(WebFetchTool.MAX_RESPONSE_BYTES + 1) },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/declared", format: "text" }))).toEqual({
        status: "error",
        error: {
          type: "unknown",
          message: `Response too large (exceeds ${WebFetchTool.MAX_RESPONSE_BYTES} byte limit)`,
        },
      })

      respond = () =>
        Effect.succeed(
          new Response("x".repeat(WebFetchTool.MAX_RESPONSE_BYTES + 1), { headers: { "content-type": "text/plain" } }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/streamed", format: "text" }))).toEqual({
        status: "error",
        error: {
          type: "unknown",
          message: `Response too large (exceeds ${WebFetchTool.MAX_RESPONSE_BYTES} byte limit)`,
        },
      })
    }),
  )

  it.effect("keeps images and files unsupported until typed outcomes can carry attachments", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* Tool.Service
      respond = () => Effect.succeed(new Response("png", { headers: { "content-type": "image/png" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/image", format: "html" }))).toEqual({
        status: "error",
        error: { type: "unknown", message: "Unsupported fetched image content type: image/png" },
      })

      respond = () => Effect.succeed(new Response("pdf", { headers: { "content-type": "application/pdf" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/file", format: "html" }))).toEqual({
        status: "error",
        error: { type: "unknown", message: "Unsupported fetched file content type: application/pdf" },
      })
    }),
  )

  it.effect("retries Cloudflare challenges with an honest user agent", () =>
    Effect.gen(function* () {
      reset()
      let count = 0
      respond = () =>
        Effect.succeed(
          ++count === 1
            ? new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } })
            : new Response("ok", { headers: { "content-type": "text/plain" } }),
        )
      const registry = yield* Tool.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "text" }))).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "ok" }],
      })
      expect(requests).toHaveLength(2)
      expect(requests[0]?.headers["user-agent"]).toBe(webFetchUserAgent)
      expect(requests[1]?.headers["user-agent"]).toBe("opencode")
    }),
  )

  it.effect("does not retry ordinary 403 responses", () =>
    Effect.gen(function* () {
      reset()
      respond = () => Effect.succeed(new Response("forbidden", { status: 403 }))
      const registry = yield* Tool.Service
      const url = "https://example.com/forbidden"

      expect(yield* executeTool(registry, call({ url, format: "text" }))).toEqual({
        status: "error",
        error: { type: "unknown", message: `StatusCode: non 2xx status code (403 GET ${url})` },
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.headers["user-agent"]).toBe(webFetchUserAgent)
    }),
  )

  it.effect("times out stalled requests", () =>
    Effect.gen(function* () {
      reset()
      respond = () => Effect.never
      const registry = yield* Tool.Service
      const fiber = yield* executeTool(
        registry,
        call({ url: "https://1.1.1.1/slow", format: "text", timeout: 1 }),
      ).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(1))

      expect(yield* Fiber.join(fiber)).toEqual({
        status: "error",
        error: { type: "unknown", message: "Request timed out" },
      })
    }),
  )
})
