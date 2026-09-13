import { Marked } from "marked"

export function createMarkdownBase() {
  return new Marked({
    renderer: {
      link({ href, title, text }) {
        const titleAttr = title ? ` title="${title}"` : ""
        return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
      },
    },
  })
}

let smallParser: Marked | undefined

export function parseSmallMarkdown(text: string) {
  // Any possible KaTeX delimiter stays on the worker, including escaped ones.
  if (text.length > 1024 || text.includes("\\(") || text.includes("$$")) return
  // Ordinary prose does not need the block/inline lexer's cold regular expressions.
  // Keep every possible Markdown construct, autolink, and hard break on that lexer.
  if (
    /^[\p{L}\p{N} \t\r\n,.;:!?'"’“”()\-–—…$%]+$/u.test(text) &&
    !/(?:^|[\r\n])(?:[ \t]|\d|[-])| {2}(?:\r\n?|\n)|www\./.test(text)
  ) {
    return text
      .replace(/\r\n?/g, "\n")
      .replace(/^\n+|\n+$/g, "")
      .split(/\n{2,}/)
      .filter(Boolean)
      .map((paragraph) => `<p>${paragraph.replace(/["']/g, (value) => (value === '"' ? "&quot;" : "&#39;"))}</p>\n`)
      .join("")
  }
  const parser = (smallParser ??= createMarkdownBase())
  const paragraphs = text.replace(/\r\n?/g, "\n")
  // Inline formatting in ordinary paragraphs does not need the block lexer.
  // Any possible block opener, HTML, table, or reference definition stays on it.
  if (
    !/[<|]/.test(paragraphs) &&
    !/^(?:[ \t>\d\[\-=]|#{1,6}(?:[ \t]|$)|[`~]{3}|[+*](?:[ \t]|$)|(?:[*_][ \t]*){3,}$)/m.test(paragraphs)
  ) {
    return paragraphs
      .replace(/^\n+|\n+$/g, "")
      .split(/\n{2,}/)
      .filter(Boolean)
      .map((paragraph) => `<p>${parser.parseInline(paragraph, { async: false })}</p>\n`)
      .join("")
  }
  const tokens = parser.lexer(text)
  let code = false
  parser.walkTokens(tokens, (token) => {
    if (token.type === "code") code = true
  })
  if (code) return
  return parser.parser(tokens)
}
