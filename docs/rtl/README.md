# Native BiDi / RTL support in the OpenCode TUI

Arabic, Persian, Urdu and Hebrew text now renders correctly in the native TUI —
in the **prompt input** and in **assistant output** — implementing the Unicode
Bidirectional Algorithm (UAX #9) at the application rendering layer, with no
terminal-side BiDi requirement and no destructive text rewriting.

> العربية: [README.ar.md](./README.ar.md)

## What works

- **Arabic-only text** reads naturally right-to-left and is right-aligned.
- **Mixed Arabic + English** keeps embedded English (`npm`, `API`, identifiers)
  in natural bidi flow.
- **LTR islands stay LTR**: code spans, filenames, paths, URLs, commands,
  package names and numbers are directionally isolated with LRI/PDI.
- **Code always stays LTR**: fenced code blocks, tables and diffs keep the stock
  renderer and are never reordered.
- **Wrapping** is grapheme- and width-aware; wrapped RTL continuation lines stay
  right-aligned and in the correct visual order.
- **The prompt caret is bidi-aware**: arrow keys move visually; typing, paste,
  undo and the stored value remain logical Unicode.
- **Copy/paste is untouched**: selection returns the original logical text,
  never visual-order or control characters.

## Fonts

The TUI cannot select fonts — the terminal does. Keep your monospaced font and
make sure an Arabic-capable font is available as a fallback in your terminal
settings (for example `"face": "Cascadia Mono, Cairo, Segoe UI"` in Windows
Terminal), then restart the terminal.

## Install (Windows, from this repository)

```powershell
# 1) install workspace dependencies
bun install

# 2) build a single-platform native binary
bun run --cwd packages/opencode script/build.ts --single --skip-install --skip-embed-web-ui

# 3) run it
.\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe
```

To replace an existing npm install (keep a backup of the original binary):

```powershell
$new    = ".\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe"
$stable = "$env:APPDATA\npm\node_modules\opencode-ai\bin\opencode.exe"
Copy-Item $stable "$stable.original-backup" -Force
Copy-Item $new $stable -Force
```

## Architecture

The TUI is `@opentui/solid` over `@opentui/core@0.4.5`. Text layout, wrapping,
shaping and cell painting in OpenTUI all happen in a **native Zig library**
(`bufferDrawTextBufferView` / `drawEditorView`) that has no BiDi support and no
JS fallback. The published package ships bundled JS, so this change does **not**
patch OpenTUI; it subclasses its public renderables and overrides only the paint
and caret entry points:

| Piece | File |
| --- | --- |
| UAX #9 engine wrapper, grapheme model, wrapping, isolates, cursor maps | `packages/tui/src/util/bidi.ts` |
| Prompt input (`BidiTextareaRenderable extends TextareaRenderable`) | `packages/tui/src/component/bidi-textarea.ts` |
| Assistant markdown (`renderNode` hook for paragraphs/headings) | `packages/tui/src/component/bidi-markdown.ts` |
| User message echo (`BidiTextRenderable extends TextRenderable`) | `packages/tui/src/component/bidi-text.ts` |
| Element registration (`extend({ bidi_text, bidi_textarea })`) | `packages/tui/src/component/bidi-elements.ts` |

Wiring:

- `packages/tui/src/component/prompt/index.tsx` — `<textarea>` → `<bidi_textarea>`
- `packages/tui/src/routes/session/index.tsx` — `<markdown renderNode={bidiMarkdownRenderNode}>`
  and user echo `<text>` → `<bidi_text>`

### Direction detection

Per paragraph, a strong-RTL script probe runs first (Hebrew, Arabic, Syriac,
Thaana, NKo, Mandaic, presentation forms). If found, `bidi-js` resolves embedding
levels and the paragraph base direction via UAX #9 P2/P3 (first strong
character, isolates honored). A paragraph is never classified RTL just because
it contains an English identifier; English-only content takes the stock path
bit-for-bit.

### Isolation instead of rewriting

`bidi-js` is wrapped in LRI/PDI for LTR islands (URLs, `a/b.c` paths, dotted and
dashed identifiers, numbers, markdown code spans). Isolates exist only in a
layout-only augmented stream — they are never painted and never stored, so
selection/copy return pristine logical text.

### Wrapping

Grapheme segmentation via `Intl.Segmenter`; cell widths via `Bun.stringWidth`
(newlines count as one width unit, matching the textarea offset convention).
Wrapped **logical** text is synced into the native text buffer so measurement,
selection and copy keep working, then each visual line is reordered
independently with UAX #9 L2 flip segments; RTL lines align to the right edge,
LTR lines to the left.

### Caret mapping

Each line stores `boundaryCols` (logical boundary → visual column) and
`logicalWidths` (logical boundary → logical width). Logical cursor → boundary →
visual caret; caret motion walks visual columns monotonically across line edges;
shift-selection reuses the native logical selection machinery.

## Dependency

[`bidi-js@1.1.0`](https://www.npmjs.com/package/bidi-js) — MIT, pure JS, no
runtime dependencies, verified against the Unicode bidi conformance suite. It
provides the UAX #9 primitives (`getEmbeddingLevels`, `getReorderSegments`,
mirroring); all rendering policy lives in this repository.

## Tests

```bash
bun test --cwd packages/tui ./test/util/bidi.test.ts
bun test --cwd packages/tui ./test/component/bidi-render.test.tsx
bun test --cwd packages/tui ./test/component/bidi-mixed.test.tsx
bun test --cwd packages/tui ./test/bidi-e2e.test.tsx
bun test --cwd packages/tui ./test/bidi-dialogs-e2e.test.tsx
bun run --cwd packages/tui typecheck
```

- `test/util/bidi.test.ts` — engine: detection, ordering, isolates, wrapping,
  cursor round-trips.
- `test/component/bidi-render.test.tsx` — real OpenTUI test renderer: RTL
  painting, right alignment, code LTR, English-identical-to-stock, caret, copy.
- `test/component/bidi-mixed.test.tsx` — mixed-direction paragraphs: code
  spans, commands, dotted identifiers, spaced Windows paths, URLs, versions,
  key:line references, bold markers, lists, links, tables of punctuation,
  tashkeel preservation, wrapping around LTR tokens.
- `test/bidi-e2e.test.tsx` — boots the real app, types Arabic with real key
  presses, streams a real assistant message.

## Known limitations

- Arabic glyph **shaping** is left to the terminal/font; this change controls
  order, direction and alignment, which is what a cell-grid renderer can own.
- Markdown `conceal` (hidden backticks) may drop per-span colors in a brief
  streaming window; order always stays correct.
- Markdown tables keep the stock grid renderer: Arabic inside table cells
  renders in logical order, left-aligned. Tables are a data surface; reflowing
  them per direction would break column alignment and copy/paste.
- Diff hunks keep code structure; Arabic prose inside added/removed lines
  follows paragraph direction while signs and line numbers stay put.
- List markers (`-`, `1.`) stay on the left edge; item content follows
  paragraph direction.
- `Home`/`End`/word-jump keep logical-offset semantics (native behavior).
- Mouse click positioning in the prompt keeps native behavior; keyboard motion
  is fully bidi-aware.
