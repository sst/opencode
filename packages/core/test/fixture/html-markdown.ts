import { writeSync } from "node:fs"
import { convertHTMLToMarkdown } from "../../src/tool/html-markdown"

const html = await Bun.stdin.text()
// Flush readiness before entering a conversion that may block the child event loop.
writeSync(1, "ready\n")
await Bun.write(Bun.stdout, convertHTMLToMarkdown(html))
