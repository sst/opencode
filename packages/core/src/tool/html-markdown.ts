import { Parser } from "htmlparser2"

const omitted = new Set(["script", "style", "noscript", "iframe", "object", "embed", "meta", "link", "template"])
const blocks = new Set([
  "address",
  "article",
  "aside",
  "details",
  "dialog",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "main",
  "nav",
  "p",
  "section",
  "summary",
])

type Frame = {
  suppressed: boolean
  link?: { href: string; title?: string }
  suspendedLink?: Frame["link"]
  marker?: { index: number; block: number; leadingSpace?: boolean; previous?: Frame["marker"] }
  code?: { inline: boolean; text: string; language?: string }
  linkCode?: NonNullable<Frame["code"]>
  resumedCode?: NonNullable<Frame["code"]>
  list?: { ordered: boolean; next: number; previous?: Frame["list"] }
  item?: { indent: string; previous?: Frame["item"] }
  table?: {
    start: number
    rows: string[][]
    row?: string[]
    caption?: string
    fallback: boolean
    previous?: Frame["table"]
  }
  cell?: { start: number }
  caption?: { start: number }
  details?: { open: boolean; summary: boolean; previous?: Frame["details"] }
}

type Chunk = string | { raw: string }

export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024
const CONTENT_BYTES = MAX_MARKDOWN_BYTES - 64 * 1024

export function convertHTMLToMarkdown(html: string) {
  const output: Chunk[] = []
  const stack: Frame[] = []
  const encoder = new TextEncoder()
  let pendingSpace = false
  let pendingIndent = ""
  let last = ""
  let quoteDepth = 0
  let needsQuotePrefix = false
  let blockCount = 0
  let depth = 0
  let stopped = false
  let outputBytes = 0
  let activeCode: NonNullable<Frame["code"]> | undefined
  let activeLink: Frame["link"] | undefined
  let linkOpen = false
  let activeMarker: Frame["marker"] | undefined
  let activeList: Frame["list"] | undefined
  let activeItem: Frame["item"] | undefined
  let activeTable: NonNullable<Frame["table"]> | undefined
  let activeCell: Frame["cell"] | undefined
  let tableDepth = 0
  let fallbackSuppressedDepth = 0
  let fallbackOmittedDepth = 0
  let activeDetails: Frame["details"] | undefined

  const sliceBytes = (value: string, bytes: number) => {
    if (encoder.encode(value).byteLength <= bytes) return value
    const characters = Array.from(value)
    let low = 0
    let high = characters.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (encoder.encode(characters.slice(0, middle).join("")).byteLength <= bytes) low = middle
      else high = middle - 1
    }
    return characters.slice(0, low).join("")
  }
  const append = (value: string, content = false) => {
    const limit = content ? CONTENT_BYTES : MAX_MARKDOWN_BYTES
    if (!value || outputBytes >= limit) return
    const bytes = encoder.encode(value)
    const remaining = limit - outputBytes
    const next = bytes.byteLength <= remaining ? value : sliceBytes(value, remaining)
    output.push(next)
    outputBytes += bytes.byteLength <= remaining ? bytes.byteLength : encoder.encode(next).byteLength
    last = next.at(-1) ?? last
  }
  const appendRaw = (value: string) => {
    const before = output.length
    append(value)
    if (output.length > before) output[output.length - 1] = { raw: output[output.length - 1] as string }
  }
  const take = (start: number) => {
    const chunks = output.splice(start)
    const value = chunks.map((chunk) => (typeof chunk === "string" ? chunk : chunk.raw)).join("")
    outputBytes -= encoder.encode(value).byteLength
    return value
  }
  const quotePrefix = () => "> ".repeat(Math.min(8, quoteDepth))
  const prefixQuote = () => {
    if (!needsQuotePrefix || quoteDepth === 0 || activeCell) return
    append(quotePrefix())
    needsQuotePrefix = false
  }
  const flushSpace = () => {
    if (!pendingSpace) return
    const marker = activeMarker
    if (marker && output.length === marker.index + 1 && last !== " " && last !== "\n") {
      const value = output[marker.index]
      if (typeof value === "string") output[marker.index] = ` ${value}`
      outputBytes++
      marker.leadingSpace = true
      pendingSpace = false
      return
    }
    if (last && last !== "\n" && last !== " ") append(" ")
    pendingSpace = false
  }
  const inline = (value: string, open = false) => {
    if (open) flushSpace()
    prefixQuote()
    if (pendingIndent) {
      append(pendingIndent)
      pendingIndent = ""
    }
    if (activeLink && !linkOpen) {
      append("[")
      linkOpen = true
    }
    append(value)
  }
  const block = () => {
    if (activeLink && linkOpen) {
      append(`](${destination(activeLink.href)}${title(activeLink.title)})`)
      linkOpen = false
    }
    pendingSpace = false
    append("\n\n")
    blockCount++
    needsQuotePrefix = quoteDepth > 0
    pendingIndent = activeItem?.indent ?? ""
  }
  const suspendLink = (frame: Frame) => {
    if (!activeLink) return
    frame.suspendedLink = activeLink
    block()
    activeLink = undefined
    linkOpen = false
  }
  const text = (value: string) => {
    if (activeCode) {
      activeCode.text += value
      return
    }
    for (const part of value.split(/([\t\n\f\r ]+)/)) {
      if (!part) continue
      if (/^[\t\n\f\r ]+$/.test(part)) {
        pendingSpace = true
        continue
      }
      flushSpace()
      prefixQuote()
      if (pendingIndent) {
        append(pendingIndent)
        pendingIndent = ""
      }
      if (activeLink && !linkOpen) {
        append("[")
        linkOpen = true
      }
      const escaped = part
        .replace(/([\\`*_[\]<>|])/g, "\\$1")
        .replace(/~/g, "\\~")
        .replace(/^([#+-])/, "\\$1")
        .replace(/^(\d+)\./, "$1\\.")
      append(escaped, true)
    }
  }
  const destination = (value: string) => value.replace(/([\\()])/g, "\\$1").replace(/[\t\n\r ]+/g, "%20")
  const title = (value: string | undefined) =>
    value
      ? ` "${value
          .replace(/[\t\n\r ]+/g, " ")
          .trim()
          .replace(/([\\"])/g, "\\$1")}"`
      : ""
  const inlineMarker = (name: string) => {
    if (name === "strong" || name === "b") return "**"
    if (name === "em" || name === "i") return "*"
    if (name === "s" || name === "strike" || name === "del") return "~~"
    return undefined
  }
  const finishCode = (code: NonNullable<Frame["code"]>) => {
    if (code.inline && !code.text) return
    let backticks = 0
    let tildes = 0
    let currentBackticks = 0
    let currentTildes = 0
    for (const character of code.text) {
      currentBackticks = character === "`" ? currentBackticks + 1 : 0
      currentTildes = character === "~" ? currentTildes + 1 : 0
      backticks = Math.max(backticks, currentBackticks)
      tildes = Math.max(tildes, currentTildes)
    }
    if (code.inline) {
      const fence = "`".repeat(Math.max(1, backticks + 1))
      flushSpace()
      prefixQuote()
      const available = Math.max(0, CONTENT_BYTES - outputBytes - fence.length * 2)
      let payload = sliceBytes(code.text, available)
      while (payload) {
        const padding = /^[ `]|[ `]$/.test(payload) && !/^ +$/.test(payload) ? " " : ""
        const bytes = encoder.encode(payload).byteLength
        if (bytes + padding.length * 2 <= available) {
          appendRaw(`${fence}${padding}${payload}${padding}${fence}`)
          return
        }
        // Padding costs at most two bytes, so at most two whole-code-point trims are needed.
        payload = sliceBytes(payload, bytes - 1)
      }
      return
    }
    if (activeCell) {
      text(code.text)
      return
    }
    const marker = backticks <= tildes ? "`" : "~"
    const length = Math.max(3, (marker === "`" ? backticks : tildes) + 1)
    const fence = marker.repeat(length)
    block()
    const prefix = `${fence}${code.language ?? ""}\n`
    const quote = quoteDepth > 0 ? quotePrefix() : ""
    let payload = code.text
    for (;;) {
      const candidate = `${prefix}${payload}${payload.endsWith("\n") ? "" : "\n"}${fence}`
      const value = quote ? candidate.replace(/^/gm, quote) : candidate
      const valueBytes = encoder.encode(value).byteLength
      if (outputBytes + valueBytes <= CONTENT_BYTES) {
        appendRaw(value)
        block()
        return
      }
      // No amount of trimming can make the empty fenced block fit.
      if (!payload) return
      const excess = valueBytes - Math.max(0, CONTENT_BYTES - outputBytes)
      payload = sliceBytes(payload, Math.max(0, encoder.encode(payload).byteLength - Math.ceil(excess)))
    }
  }

  const parser = new Parser({
    onopentag(name, attributes) {
      depth++
      if (depth > 10_000) {
        if (stack.at(-1)?.suppressed) {
          const visibleParent = stack.findLastIndex((frame) => !frame.suppressed)
          fallbackSuppressedDepth = visibleParent + 2
        }
        activeCode = undefined
        stopped = true
      }
      if (stopped) {
        if (omitted.has(name)) fallbackOmittedDepth++
        else pendingSpace = true
        return
      }
      const suppressed = (stack.at(-1)?.suppressed ?? false) || omitted.has(name)
      const frame: Frame = { suppressed }
      const hidden = "hidden" in attributes || attributes["aria-hidden"]?.toLowerCase() === "true" || name === "head"
      const details = activeDetails
      if (hidden || (details && !details.open && !details.summary && name !== "summary")) frame.suppressed = true
      stack.push(frame)
      if (frame.suppressed) return

      if (activeCode && !activeCode.inline) {
        if (name === "br") activeCode.text += "\n"
        if (name === "code" && attributes.class)
          activeCode.language = attributes.class.match(/(?:language-|lang-)([^\s]+)/)?.[1]
        return
      }
      if (name === "details") {
        frame.details = { open: "open" in attributes, summary: false, previous: activeDetails }
        activeDetails = frame.details
        block()
        return
      }
      if (name === "summary") {
        if (details) details.summary = true
        block()
        return
      }
      if (name === "pre") {
        suspendLink(frame)
        frame.code = { inline: false, text: "" }
        activeCode = frame.code
        return
      }
      if (name === "code") {
        if (activeCode?.inline) return
        frame.code = { inline: true, text: "" }
        activeCode = frame.code
        return
      }
      if (/^h[1-6]$/.test(name)) {
        block()
        inline(`${"#".repeat(Number(name[1]))} `)
        return
      }
      if (blocks.has(name)) {
        suspendLink(frame)
        if (name === "p" && last === " ") return
        block()
        return
      }
      if (name === "br") {
        pendingSpace = false
        inline("  \n")
        needsQuotePrefix = quoteDepth > 0
        return
      }
      if (name === "hr") {
        block()
        inline("---")
        block()
        return
      }
      const marker = inlineMarker(name)
      if (marker) {
        inline(marker, true)
        frame.marker = { index: output.length - 1, block: blockCount, previous: activeMarker }
        activeMarker = frame.marker
        return
      }
      if (name === "a") {
        if (activeLink && activeCode?.inline) {
          const parent = stack.findLast(
            (candidate) => candidate.link === activeLink && candidate.linkCode === activeCode,
          )
          if (parent) {
            finishCode(activeCode)
            if (linkOpen) append(`](${destination(activeLink.href)}${title(activeLink.title)})`)
            activeCode = parent.resumedCode
            parent.link = undefined
            parent.linkCode = undefined
            activeLink = undefined
            linkOpen = false
          }
        }
        if (activeCode?.inline) {
          frame.resumedCode = activeCode
          if (activeCode.text) finishCode(activeCode)
          activeCode.text = ""
          activeCode = undefined
          frame.link = { href: attributes.href ?? "", title: attributes.title }
          activeLink = frame.link
          linkOpen = true
          inline("[", true)
          frame.linkCode = { inline: true, text: "" }
          activeCode = frame.linkCode
          return
        }
        if (activeLink) {
          if (linkOpen) append(`](${destination(activeLink.href)}${title(activeLink.title)})`)
          const parent = stack.findLast((candidate) => candidate.link === activeLink)
          if (parent) parent.link = undefined
          activeLink = undefined
          linkOpen = false
        }
        frame.link = { href: attributes.href ?? "", title: attributes.title }
        activeLink = frame.link
        linkOpen = true
        return inline("[", true)
      }
      if (name === "img") {
        const alt = (attributes.alt ?? "").replace(/([\\\]])/g, "\\$1")
        const close = `](${destination(attributes.src ?? "")}${title(attributes.title)})`
        const open = "!["
        const available = CONTENT_BYTES - outputBytes - encoder.encode(open + close).byteLength
        inline(`${open}${sliceBytes(alt, Math.max(0, available))}${close}`, true)
        return
      }
      if (name === "blockquote") {
        suspendLink(frame)
        block()
        quoteDepth++
        needsQuotePrefix = true
        return
      }
      if (name === "ul" || name === "ol") {
        suspendLink(frame)
        const start = Number.parseInt(attributes.start ?? "1")
        frame.list = { ordered: name === "ol", next: Number.isNaN(start) ? 1 : start, previous: activeList }
        activeList = frame.list
        block()
        return
      }
      if (name === "li") {
        block()
        const value = Number.parseInt(attributes.value ?? "")
        if (activeList?.ordered && !Number.isNaN(value)) activeList.next = value
        const marker = activeList?.ordered ? `${activeList.next++}.` : "-"
        const prefix = `${(activeItem?.indent ?? "").slice(0, 24)}${marker} `
        frame.item = { indent: " ".repeat(prefix.length), previous: activeItem }
        activeItem = frame.item
        pendingIndent = ""
        inline(prefix)
        return
      }
      if (name === "table") {
        suspendLink(frame)
        tableDepth++
        if (tableDepth === 1) {
          block()
          frame.table = { start: output.length, rows: [], fallback: false, previous: activeTable }
          activeTable = frame.table
        } else pendingSpace = true
        return
      }
      if (name === "tr") {
        if (tableDepth !== 1) {
          pendingSpace = true
          return
        }
        if (activeTable) activeTable.row = []
        return
      }
      if (name === "th" || name === "td") {
        if (tableDepth !== 1) {
          pendingSpace = true
          return
        }
        if (attributes.colspan || attributes.rowspan) activeTable!.fallback = true
        frame.cell = { start: output.length }
        activeCell = frame.cell
        return
      }
      if (name === "caption") {
        frame.caption = { start: output.length }
        return
      }
      if (name === "dt") {
        block()
        inline("**")
        return
      }
      if (name === "dd") {
        inline("\n: ")
        return
      }
    },
    ontext(value) {
      if (stopped) {
        if (fallbackSuppressedDepth === 0 && fallbackOmittedDepth === 0) text(value)
        return
      }
      if (stack.at(-1)?.suppressed) return
      text(value)
    },
    onclosetag(name) {
      depth--
      if (stopped) {
        if (fallbackOmittedDepth > 0 && omitted.has(name)) fallbackOmittedDepth--
        if (fallbackSuppressedDepth > 0 && depth < fallbackSuppressedDepth) fallbackSuppressedDepth = 0
        return
      }
      const frame = stack.pop()
      if (!frame || frame.suppressed) return
      if (frame.linkCode) {
        if (activeLink !== frame.link || !linkOpen) {
          frame.resumedCode!.text += frame.linkCode.text
          activeCode = frame.resumedCode
          if (activeLink === frame.link) activeLink = undefined
          linkOpen = false
          return
        }
        activeCode = undefined
        finishCode(frame.linkCode)
        if (frame.link && linkOpen) append(`](${destination(frame.link.href)}${title(frame.link.title)})`)
        activeLink = undefined
        linkOpen = false
        activeCode = frame.resumedCode
        return
      }
      if (activeCode && !activeCode.inline && !frame.code) return
      if (frame.code) {
        activeCode = undefined
        finishCode(frame.code)
        if (frame.suspendedLink) activeLink = frame.suspendedLink
        return
      }
      if (name === "summary") {
        if (activeDetails) activeDetails.summary = false
        return block()
      }
      if (name === "details") {
        activeDetails = frame.details?.previous
        return block()
      }
      if (name === "dt") {
        inline("**")
        return
      }
      if (name === "dd") return block()
      const marker = inlineMarker(name)
      if (marker) {
        const trailingSpace = pendingSpace
        pendingSpace = false
        if (frame.marker) activeMarker = frame.marker.previous
        if (frame.marker && (frame.marker.block !== blockCount || output.length === frame.marker.index + 1)) {
          output[frame.marker.index] = ""
          pendingSpace = trailingSpace || frame.marker.leadingSpace === true
          return
        }
        inline(marker)
        pendingSpace = trailingSpace || frame.marker?.leadingSpace === true
        return
      }
      if (name === "a") {
        if (frame.link && (activeLink === frame.link || !activeLink)) {
          activeLink = frame.link
          if (linkOpen || (last && last !== "\n"))
            append(`](${destination(frame.link.href)}${title(frame.link.title)})`)
          linkOpen = false
          activeLink = undefined
        }
        return
      }
      if (/^h[1-6]$/.test(name) || blocks.has(name)) {
        block()
        if (frame.suspendedLink) activeLink = frame.suspendedLink
        return
      }
      if (name === "blockquote") {
        quoteDepth--
        block()
        if (frame.suspendedLink) activeLink = frame.suspendedLink
        return
      }
      if (name === "li") {
        activeItem = frame.item?.previous
        return block()
      }
      if (name === "ul" || name === "ol") {
        activeList = frame.list?.previous
        block()
        if (frame.suspendedLink) activeLink = frame.suspendedLink
        return
      }
      if ((name === "th" || name === "td") && tableDepth === 1) {
        activeCell = undefined
        if (frame.cell) {
          const value = take(frame.cell.start)
            .replace(/[\t\r\n ]+/g, " ")
            .trim()
            .replace(/(?<!\\)\|/g, "\\|")
          activeTable?.row?.push(value)
        }
        return
      }
      if (name === "tr") {
        if (tableDepth !== 1) return
        if (activeTable?.row) activeTable.rows.push(activeTable.row)
        if (activeTable) activeTable.row = undefined
        pendingSpace = true
        return
      }
      if (name === "caption" && frame.caption && activeTable) {
        activeTable.caption = take(frame.caption.start)
          .replace(/[\t\r\n ]+/g, " ")
          .trim()
        return
      }
      if (name === "table") {
        tableDepth--
        if (tableDepth === 0) {
          const table = frame.table
          activeTable = table?.previous
          if (table) {
            const loose = take(table.start)
              .replace(/[\t\r\n ]+/g, " ")
              .trim()
            const width = table.rows[0]?.length ?? 0
            const rectangular = width > 0 && table.rows.every((row) => row.length === width)
            if (loose) {
              append(loose)
              block()
            }
            if (table.caption) {
              append(table.caption)
              block()
            }
            if (!table.fallback && rectangular) {
              const prefix = `${quoteDepth > 0 ? quotePrefix() : ""}${pendingIndent}`
              pendingIndent = ""
              append(`${prefix}| ${table.rows[0].join(" | ")} |\n${prefix}|${" --- |".repeat(width)}`)
              for (const row of table.rows.slice(1)) append(`\n${prefix}| ${row.join(" | ")} |`)
            } else {
              for (const [index, row] of table.rows.entries()) {
                if (index > 0) block()
                append(row.join(" | "))
              }
            }
          }
          block()
          if (frame.suspendedLink) activeLink = frame.suspendedLink
          return
        }
        pendingSpace = true
      }
    },
  })
  for (let index = 0; index < html.length; index += 64 * 1024) parser.write(html.slice(index, index + 64 * 1024))
  parser.end()

  const normalized: string[] = []
  let pendingText = ""
  const flushText = () => {
    if (!pendingText) return
    const lines = pendingText
      .replace(/[ \t]+\n/g, (space) => (space.startsWith("  ") ? "  \n" : "\n"))
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
    normalized.push(
      lines
        .map((line, index) => {
          if (line) return line
          const before = lines[index - 1]?.match(/^(?:> )+/)?.[0]
          const after = lines[index + 1]?.match(/^(?:> )+/)?.[0]
          if (!before || !after || before.length === after.length) return line
          return "> ".repeat(Math.min(before.length, after.length) / 2).trimEnd()
        })
        .join("\n"),
    )
    pendingText = ""
  }
  for (const chunk of output) {
    if (typeof chunk !== "string") {
      flushText()
      normalized.push(chunk.raw)
      continue
    }
    pendingText += chunk
  }
  flushText()
  return sliceBytes(normalized.join("").trim(), MAX_MARKDOWN_BYTES)
}
