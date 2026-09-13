import { describe, expect, test } from "bun:test"
import stringWidth from "string-width"
import { spatialPathClaim } from "../core/spatial.js"
import { expectDiagram } from "../test/diagram.js"
import { renderStateDiagram } from "./diagram.js"
import { createStateDiagramDrawing, drawStateDiagramGrid } from "./drawing.js"
import { createStateDiagramLayout } from "./layout.js"
import { parseMermaidStateDiagram } from "./parser.js"
import { prepareVisibleStateDiagram } from "./visible-model.js"

function expectCompleteStateDiagram(source: string, output = renderStateDiagram(source)): void {
  const diagram = prepareVisibleStateDiagram(parseMermaidStateDiagram(source))
  const layout = createStateDiagramLayout(diagram, { minStateGap: 5 })
  const states = diagram.states.filter((state) => state.kind === "state")
  const stateBounds = states.map((state) => layout.bounds.get(state.id)!)

  for (const text of [
    ...states.map((state) => state.label),
    ...diagram.transitions.map((transition) => transition.label),
    ...diagram.notes.flatMap((note) => note.lines),
  ].filter(Boolean)) {
    expect(output).toContain(text)
  }
  for (const [index, bound] of stateBounds.entries()) {
    for (const other of stateBounds.slice(index + 1)) {
      expect(
        bound.left < other.left + other.width &&
          bound.left + bound.width > other.left &&
          bound.top < other.top + other.height &&
          bound.top + bound.height > other.top,
        `${bound.id} overlaps ${other.id}`,
      ).toBe(false)
    }
  }
  const occupiedByNote = layout.noteBounds.map((note) => {
    const connector = spatialPathClaim(`connector:${note.id}`, note.id, "boundary", note.connector!.points)
    return new Set([
      ...Array.from({ length: note.height }, (_, dy) =>
        Array.from({ length: note.width }, (_, dx) => `${note.left + dx}:${note.top + dy}`),
      ).flat(),
      ...connector.spans.flatMap((span) =>
        Array.from({ length: span.toX - span.fromX + 1 }, (_, dx) => `${span.fromX + dx}:${span.y}`),
      ),
    ])
  })
  for (const [index, occupied] of occupiedByNote.entries()) {
    for (const bound of stateBounds) {
      expect(
        Array.from({ length: bound.height }, (_, dy) =>
          Array.from({ length: bound.width }, (_, dx) => occupied.has(`${bound.left + dx}:${bound.top + dy}`)),
        )
          .flat()
          .some(Boolean),
        `${layout.noteBounds[index]!.id} overlaps ${bound.id}`,
      ).toBe(false)
    }
    for (const other of occupiedByNote.slice(index + 1)) {
      expect([...occupied].some((cell) => other.has(cell))).toBe(false)
    }
  }
}

type ResponsiveStateLabelProfile = "short" | "long" | "unicode"

function responsiveStateChain(direction: "LR" | "RL", profile: ResponsiveStateLabelProfile): string {
  const stateLabel = (id: string) => {
    if (profile === "long") return `${id} deliberate state with a long descriptive label`
    if (profile === "unicode") return `${id} 東京<br/>résumé 🚀`
    return `${id} node`
  }
  const transitionLabel = (id: string) => {
    if (profile === "long") return `${id} transition carrying detailed context`
    if (profile === "unicode") return `${id} 東京<br/>✓ prêt`
    return `${id} edge`
  }
  const ids = ["A", "B", "C", "D", "E"]
  return [
    "stateDiagram-v2",
    `direction ${direction}`,
    ...ids.map((id) => `state "${stateLabel(id)}" as ${id}`),
    "[*] --> A",
    ...ids.slice(0, -1).map((id, index) => `${id} --> ${ids[index + 1]}: ${transitionLabel(`E0${index + 1}`)}`),
    "E --> [*]",
  ].join("\n")
}

function renderedStateDimensions(output: string) {
  const lines = output.split("\n")
  return { width: Math.max(...lines.map((line) => stringWidth(line))), height: lines.length }
}

describe("StateDiagram", () => {
  test("detects and parses Mermaid state diagrams", () => {
    const diagram = parseMermaidStateDiagram(`
stateDiagram-v2
  %% request lifecycle
  direction LR
  [*] --> Idle
  Idle --> Loading: submit
  Loading --> Success: done
  Success --> [*]
`)

    expect(diagram.direction).toBe("LR")
    expect(diagram.states).toEqual([
      { id: "__start", label: "●", kind: "start" },
      { id: "Idle", label: "Idle", kind: "state" },
      { id: "Loading", label: "Loading", kind: "state" },
      { id: "Success", label: "Success", kind: "state" },
      { id: "__end", label: "◎", kind: "end" },
    ])
    expect(diagram.transitions).toEqual([
      { from: "__start", to: "Idle", label: "" },
      { from: "Idle", to: "Loading", label: "submit" },
      { from: "Loading", to: "Success", label: "done" },
      { from: "Success", to: "__end", label: "" },
    ])
  })

  test("parses quoted state aliases", () => {
    const diagram = parseMermaidStateDiagram(`
stateDiagram-v2
  state "Waiting<br/>for Payment" as WaitingPayment
  [*] --> WaitingPayment
`)

    expect(diagram.states).toContainEqual({
      id: "WaitingPayment",
      label: "Waiting<br/>for Payment",
      kind: "state",
    })
  })

  test("decodes HTML entities in state, transition, and note labels", () => {
    const diagram = parseMermaidStateDiagram(`stateDiagram-v2
  state "Ready &amp; waiting" as Ready
  Ready --> Done: elapsed &lt;3s
  note right of Done: result &#x2265; 1`)

    expect(diagram.states.find((state) => state.id === "Ready")?.label).toBe("Ready & waiting")
    expect(diagram.transitions[0]?.label).toBe("elapsed <3s")
    expect(diagram.notes[0]?.lines).toEqual(["result ≥ 1"])
  })

  test("parses choice pseudo-states", () => {
    const diagram = parseMermaidStateDiagram(`
stateDiagram-v2
  [*] --> Decision
  state Decision <<choice>>
  Decision --> Accepted: yes
`)

    expect(diagram.states).toContainEqual({ id: "Decision", label: "", kind: "choice" })
  })

  test("parses composite states and notes", () => {
    const diagram = parseMermaidStateDiagram(`
stateDiagram-v2
  state Authenticated {
    [*] --> Idle
    Idle --> Editing: open
  }
  note right of Editing
    Draft changes
  end note
`)

    expect(diagram.composites).toContainEqual({ id: "Authenticated", label: "Authenticated" })
    expect(diagram.states).toContainEqual({
      id: "Idle",
      label: "Idle",
      kind: "state",
      parentId: "Authenticated",
    })
    expect(diagram.states).toContainEqual({
      id: "Authenticated.__start",
      label: "●",
      kind: "start",
      parentId: "Authenticated",
    })
    expect(diagram.notes).toEqual([{ target: "Editing", position: "right", lines: ["Draft changes"] }])
  })

  test("renders a horizontal state diagram", () => {
    const output = renderStateDiagram(`
stateDiagram-v2
  direction LR
  [*] --> Idle
  Idle --> Loading: submit
  Loading --> Success: done
  Success --> [*]
`)

    expectDiagram(output).toEqualDiagram(`
                    ╭──────╮   submit    ╭─────────╮    done     ╭─────────╮
      ●────────────▶│ Idle ├────────────▶│ Loading ├────────────▶│ Success ├────────────▶◎
                    ╰──────╯             ╰─────────╯             ╰─────────╯
    `)
  })

  test("renders reverse horizontal direction from right to left", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction RL
  A --> B`)
    const labelRow = output.split("\n").find((line) => line.includes(" A ") && line.includes(" B "))!

    expect(labelRow.indexOf("B")).toBeLessThan(labelRow.indexOf("A"))
    expect(output).toContain("◀")
  })

  test("renders reverse vertical direction from bottom to top", () => {
    const source = `stateDiagram-v2
  direction BT
  A --> B`
    const drawing = createStateDiagramDrawing(parseMermaidStateDiagram(source))

    expect(drawing.layout.bounds.get("A")!.top).toBeGreaterThan(drawing.layout.bounds.get("B")!.top)
    expect(drawing.grid.toString({ trimTop: true, trimBottom: true })).toContain("▲")
  })

  test.each(
    (["LR", "RL"] as const).flatMap((direction) =>
      (["short", "long", "unicode"] as const).flatMap((profile) =>
        ([60, 80, 120] as const).map((layoutMaxWidth) => [direction, profile, layoutMaxWidth] as const),
      ),
    ),
  )("folds responsive %s %s chains at %d columns", (direction, profile, layoutMaxWidth) => {
    const source = responsiveStateChain(direction, profile)
    const horizontal = renderStateDiagram(source)
    const responsive = renderStateDiagram(source, { layoutMaxWidth })
    const vertical = renderStateDiagram(source, { direction: direction === "RL" ? "BT" : "TB" })

    expect(renderedStateDimensions(horizontal).width).toBeGreaterThan(layoutMaxWidth)
    expect(responsive).toBe(vertical)
    expect(renderedStateDimensions(responsive).width).toBeLessThan(renderedStateDimensions(horizontal).width)
    for (const content of ["A", "B", "C", "D", "E", "E01", "E02", "E03", "E04"]) {
      expect(responsive).toContain(content)
    }
  })

  test.each(["LR", "RL"] as const)("keeps the narrower %s orientation for broad ranks", (direction) => {
    const source = `stateDiagram-v2
  direction ${direction}
${Array.from({ length: 8 }, (_, index) => `  A --> B${index}`).join("\n")}`
    const horizontal = renderStateDiagram(source)
    const vertical = renderStateDiagram(source, { direction: direction === "RL" ? "BT" : "TB" })
    const responsive = renderStateDiagram(source, { layoutMaxWidth: 60 })

    expect(renderedStateDimensions(horizontal).width).toBeLessThan(renderedStateDimensions(vertical).width)
    expect(responsive).toBe(horizontal)
  })

  test("falls back before allocating an oversized horizontal canvas", () => {
    const ids = Array.from({ length: 301 }, (_, index) => `S${index}`)
    const label = "transition label carrying enough context to make the horizontal canvas too large"
    const source = `stateDiagram-v2
  direction LR
${ids
  .slice(0, -1)
  .map((id, index) => `  ${id} --> ${ids[index + 1]}: ${label}`)
  .join("\n")}`
    const output = renderStateDiagram(source, { layoutMaxWidth: 80 })

    expect(output).toContain("S0")
    expect(output).toContain("S300")
    expect(renderedStateDimensions(output).width).toBeLessThanOrEqual(stringWidth(label) + 8)
  })

  test.each(["TB", "TD", "BT"] as const)("preserves explicit %s layouts under a narrow width target", (direction) => {
    const source = `stateDiagram-v2
  direction ${direction}
  A --> B: next`

    expect(renderStateDiagram(source, { layoutMaxWidth: 1 })).toBe(renderStateDiagram(source))
  })

  test.each([
    ["TB", 120],
    ["LR", 40],
  ] as const)(
    "renders same-rank transitions between nested composite states from %s at %d columns",
    (direction, width) => {
      const diagram = parseMermaidStateDiagram(`stateDiagram-v2
direction ${direction}
A --> B
A --> C
state D {
  state E {
    B --> F
  }
  B --> C
}`)

      const drawing = createStateDiagramDrawing(diagram, { layoutMaxWidth: width })
      const output = drawing.grid.toString({
        trimTop: true,
        trimBottom: true,
      })

      expect(drawing.diagram.direction).toBe("TB")
      for (const state of ["A", "B", "C", "D", "E", "F"]) expect(output).toContain(state)
    },
  )

  test("preserves horizontal layouts that fit or have no finite width target", () => {
    const source = `stateDiagram-v2
  direction LR
  A --> B`
    const output = renderStateDiagram(source)

    expect(renderStateDiagram(source, { layoutMaxWidth: 120 })).toBe(output)
    expect(renderStateDiagram(source, { layoutMaxWidth: Number.POSITIVE_INFINITY })).toBe(output)
  })

  test("treats a single irreducibly wide state as soft overflow", () => {
    const label = "界".repeat(40)
    const output = renderStateDiagram(
      `stateDiagram-v2
  direction LR
  state "${label}" as Wide`,
      { layoutMaxWidth: 60 },
    )

    expect(renderedStateDimensions(output).width).toBeGreaterThan(60)
    expect(output).toContain(label)
  })

  test("does not mutate a parsed diagram when rendering with a direction override", () => {
    const diagram = parseMermaidStateDiagram(`stateDiagram-v2
  direction LR
  A --> B`)

    drawStateDiagramGrid(diagram, { direction: "RL" })

    expect(diagram.direction).toBe("LR")
  })

  test("places right-to-left transition labels between intact frames", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction RL
  A --> B: reopen after a very detailed reviewer comment`)

    expect(output).toContain("╭───╮")
    expect(output.match(/╭───╮/g)?.length).toBe(2)
    expect(output).toContain("reopen after a very detailed reviewer comment")
  })

  test("keeps Unicode state labels inside their measured frame", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction LR
  state "界" as Wide`)
    const widths = output.split("\n").map((line) => stringWidth(line))

    expect(new Set(widths).size).toBe(1)
    expect(output).toContain("界")
  })

  test("reserves horizontal room for long transition labels", () => {
    const label = "this transition label is much wider than the route"
    const output = renderStateDiagram(`stateDiagram-v2
  direction LR
  A --> B: ${label}`)
    const labelRow = output.split("\n").find((line) => line.includes(label))!

    expect(labelRow.match(/╭───╮/g)?.length).toBe(2)
  })

  test("renders every line of multiline transition labels", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction LR
  A --> B: first<br/>second`)

    expect(output).toContain("first")
    expect(output).toContain("second")
  })

  test("keeps reciprocal multiline transition labels clear of routes", () => {
    const output = renderStateDiagram(`stateDiagram-v2
    [*] --> Running: create from base image
    Running --> Dormant: 📸 suspend hook fires<br/>(WE must call it on idle)
    Dormant --> Running: wake from snapshot image<br/>(apt installs restored!)
    Running --> Lost: 💥 sandbox dies BEFORE hook fires<br/>(crash, our bug, race)
    Lost --> Running: wake from LAST snapshot<br/>⚠ files since then GONE`)
    const labelLines = [
      "create from base image",
      "📸 suspend hook fires",
      "(WE must call it on idle)",
      "wake from snapshot image",
      "(apt installs restored!)",
      "💥 sandbox dies BEFORE hook fires",
      "(crash, our bug, race)",
      "wake from LAST snapshot",
      "⚠ files since then GONE",
    ]

    for (const line of labelLines) expect(output.split(line)).toHaveLength(2)
    expect(output).toMatchInlineSnapshot(`
      "  create from base image ╭─────────╮
      ●───────────────────────▶│ Running │
                               ╰──┬──────╯
                                ▲ │   ▲        💥 sandbox dies BEFORE hook fires
                       ╭────────┼─┴───┼───────╮(crash, our bug, race)
                       ▼   ╭────┼─────╯       ▼
                    ╭──────┴──╮ │           ╭──────╮
                    │ Dormant │ │           │ Lost │
                    ╰─────────╯ │           ╰───┬──╯
                                │               │
       📸 suspend hook fires    │               │ wake from LAST snapshot
       (WE must call it on idle)│               │ ⚠ files since then GONE
                                ╰───────────────╯
                            wake from snapshot image
                            (apt installs restored!)"
    `)
  })

  test("renders a vertical state diagram", () => {
    const output = renderStateDiagram(`
stateDiagram-v2
  direction TB
  [*] --> Cart
  Cart --> Payment: checkout
  Payment --> Complete
`)

    expect(output).toMatchInlineSnapshot(`
      "      ●
            │
            │
            │
            ▼
        ╭──────╮
        │ Cart │
        ╰───┬──╯
            │
            │ checkout
            │
            ▼
       ╭─────────╮
       │ Payment │
       ╰────┬────╯
            │
            │
            │
            ▼
      ╭──────────╮
      │ Complete │
      ╰──────────╯"
    `)
  })

  test("renders branched and backward transitions visibly", () => {
    const output = renderStateDiagram(`
stateDiagram-v2
  direction LR
  [*] --> Idle
  Idle --> Loading: submit
  Loading --> Success: 200 OK
  Loading --> Error: timeout
  Error --> Loading: retry
  Success --> [*]
`)

    expect(output).toMatchInlineSnapshot(`
      "              ╭──────╮   submit    ╭─────────╮   200 OK    ╭─────────╮
      ●────────────▶│ Idle ├────────────▶│ Loading ├────────────▶│ Success ├────────────▶◎
                    ╰──────╯             ╰──┬──────╯             ╰─────────╯
                                            │   ▲
                                   timeout  │   │
                                            ▼   │  retry
                                          ╭─────┴─╮
                                          │ Error │
                                          ╰───────╯"
    `)
  })

  test("captures converging labeled branches with long state names", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  [*] --> Waiting
  state "Waiting for surface and workspace" as Waiting
  state "Surface bound only" as Surface
  state "Workspace bound only" as Workspace
  state "Ready with queued input" as Ready
  state "Agent activity requested" as Active
  Waiting --> Surface: InteractionSurfaceBound
  Waiting --> Workspace: WorkspaceBound
  Surface --> Ready: WorkspaceBound
  Workspace --> Ready: InteractionSurfaceBound
  Ready --> Active: AgentActivityRequested`)

    expect(output).toMatchInlineSnapshot(`
      "              ╭───────────────────────────────────╮ InteractionSurfaceBound ╭────────────────────╮ WorkspaceBound ╭─────────────────────────╮ AgentActivityRequested ╭──────────────────────────╮
      ●────────────▶│ Waiting for surface and workspace ├────────────────────────▶│ Surface bound only ├───────────────▶│ Ready with queued input ├───────────────────────▶│ Agent activity requested │
                    ╰───────────────┬───────────────────╯                         ╰────────────────────╯                ╰─────────────────────────╯                        ╰──────────────────────────╯
                                    │ WorkspaceBound                                                                                   ▲
                                    ╰──────────────────────────────────────────────────────╮                                           │
                                                                                           │           InteractionSurfaceBound         │
                                                                                           ▼   ╭───────────────────────────────────────╯
                                                                                 ╭─────────────┴────────╮
                                                                                 │ Workspace bound only │
                                                                                 ╰──────────────────────╯"
    `)
  })

  test("keeps raised note connectors off outgoing transitions", () => {
    const output = renderStateDiagram(`
stateDiagram-v2
  direction LR
  [*] --> Idle
  Idle --> Loading: submit
  Loading --> Success: 200 OK
  Loading --> Error: timeout
  note right of Loading : waiting for response
  Error --> Loading: retry
  Success --> [*]
`)

    expect(output).toMatchInlineSnapshot(`
      "                                                  ╔══════════════════════╗
                                                    ╔═══╣ waiting for response ║
                                                    ║   ╚══════════════════════╝
                                                    ║
                                                    ║
                    ╭──────╮   submit    ╭─────────╮   200 OK    ╭─────────╮
      ●────────────▶│ Idle ├────────────▶│ Loading ├────────────▶│ Success ├────────────▶◎
                    ╰──────╯             ╰──┬──────╯             ╰─────────╯
                                            │   ▲
                                   timeout  │   │
                                            ▼   │  retry
                                          ╭─────┴─╮
                                          │ Error │
                                          ╰───────╯"
    `)
  })

  test("places a composite note above an occupied right side", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  [*] --> Processing

  state Processing {
    [*] --> Validate
    Validate --> Decision
    state Decision <<choice>>
    Decision --> Accepted: valid
    Decision --> Rejected: invalid
    Accepted --> [*]
    Rejected --> [*]
  }

  note right of Processing
    Validation and routing happen
    inside this composite state.
  end note

  Processing --> Complete
  Complete --> [*]`)
    const lines = output.split("\n")
    const noteBottom = lines.findIndex((line) => line.includes("╚═══════════════════════════════╝"))
    const completeRow = lines.findIndex((line) => line.includes(" Complete "))

    expect(noteBottom).toBeGreaterThanOrEqual(0)
    expect(noteBottom).toBeLessThan(completeRow)
    expect(lines.slice(noteBottom + 1, completeRow).every((line) => !line.includes("Complete"))).toBe(true)
    expect(lines).toHaveLength(20)
  })

  test("renders configurable line arrowheads", () => {
    const output = renderStateDiagram(
      `
stateDiagram-v2
  direction LR
  [*] --> Idle
  Idle --> Loading: submit
`,
      { arrowHeadStyle: "line" },
    )

    expect(output).toContain("→")
    expect(output).not.toContain("▶")
  })

  test("renders self transitions and choice branches", () => {
    const output = renderStateDiagram(`
stateDiagram-v2
  direction LR
  state Decision <<choice>>
  [*] --> Editing
  Editing --> Editing: type
  Editing --> Decision: submit
  Decision --> Saved: ok
  Decision --> Error: fail
  Error --> Editing: retry
`)

    expect(output).toMatchInlineSnapshot(`
      "              ╭─────────╮   submit          ok      ╭───────╮
      ●────────────▶│ Editing ├────────────▶◆────────────▶│ Saved │
                    ╰──┬──────╯             │             ╰───────╯
                     ▲ │    ▲ type          │ fail
                     │ ╰────╯               │
                     │                      ▼
                     │                  ╭───────╮
                     │                  │ Error │
                     │                  ╰───┬───╯
                     │                      │
                     │                      │
                     │        retry         │
                     ╰──────────────────────╯"
    `)
  })

  test("connects lower routed branches into choice junctions", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction LR
  state Decision <<choice>>
  [*] --> Fork
  Fork --> Upper
  Fork --> Lower
  Upper --> Decision
  Lower --> Decision
  Decision --> Done
  Done --> [*]`)

    expect(output).toContain("Upper ├────────────▶◆────────────▶│ Done")
  })

  test("renders self transitions as loops in vertical diagrams", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction TB
  Working --> Working: retry`)

    expectDiagram(output).toEqualDiagram(`
      ╭─────────╮
      │ Working │
      ╰──┬──────╯
         │    ▲ retry
         ╰────╯
    `)
  })

  test("renders self transitions from choice pseudo-states", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction LR
  state Decision <<choice>>
  Decision --> Decision: reconsider`)

    expect(output).toContain("◆")
    expect(output).toContain("reconsider")
    expect(output.split("\n").filter((line) => line.trim())).toHaveLength(3)
  })

  test.each(["LR", "RL"] as const)("trims leading rows from standalone %s choices", (direction) => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction ${direction}
  state Decision <<choice>>`)

    expect(output).toBe("◆")
  })

  test("renders parallel transitions without losing labels", () => {
    const horizontal = renderStateDiagram(`stateDiagram-v2
  direction LR
  A --> B: first
  A --> B: second`)
    const vertical = renderStateDiagram(`stateDiagram-v2
  direction TB
  A --> B: first
  A --> B: second`)

    expect(horizontal).toContain("first")
    expect(horizontal).toContain("second")
    expect(vertical).toContain("first")
    expect(vertical).toContain("second")
  })

  test("renders cyclic same-rank vertical parallels with a note", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction TD
  state "Node S13_0" as S13_0
  state "Node S13_1" as S13_1
  state "Node S13_2" as S13_2
  state "Node S13_3" as S13_3
  state "Node S13_4" as S13_4
  S13_0 --> S13_1: state_edge_13_0
  S13_1 --> S13_2: state_edge_13_1
  S13_2 --> S13_3: state_edge_13_2
  S13_3 --> S13_4: state_edge_13_3
  S13_0 --> S13_2: state_edge_13_4
  S13_4 --> S13_1: state_edge_13_5
  S13_2 --> S13_0: state_edge_13_6
  S13_1 --> S13_2: state_edge_13_7
  S13_3 --> S13_2: state_edge_13_8
  S13_3 --> S13_0: state_edge_13_9
  S13_0 --> S13_0: state_edge_13_10
  note left of S13_0: state_note_13_0`)

    for (const index of [0, 1, 2, 3, 4]) expect(output).toContain(`Node S13_${index}`)
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) expect(output).toContain(`state_edge_13_${index}`)
    expect(output).toContain("state_note_13_0")
  })

  test("preserves every state in a routed multi-note vertical graph", () => {
    const source = `stateDiagram-v2
  direction TD
  state "Node S21_0" as S21_0
  state "Node S21_1" as S21_1
  state "Node S21_2" as S21_2
  state "Node S21_3" as S21_3
  state "Node S21_4" as S21_4
  state "Node S21_5" as S21_5
  S21_0 --> S21_1: state_edge_21_0
  S21_1 --> S21_2: state_edge_21_1
  S21_2 --> S21_3: state_edge_21_2
  S21_3 --> S21_4: state_edge_21_3
  S21_4 --> S21_5: state_edge_21_4
  S21_4 --> S21_5: state_edge_21_5
  S21_2 --> S21_4: state_edge_21_6
  S21_3 --> S21_1: state_edge_21_7
  note right of S21_1: state_note_21_0
  note left of S21_0: state_note_21_1
  note left of S21_4: state_note_21_2`
    const output = renderStateDiagram(source)

    for (const index of [0, 1, 2, 3, 4, 5]) expect(output).toContain(`Node S21_${index}`)
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) expect(output).toContain(`state_edge_21_${index}`)
    for (const index of [0, 1, 2]) expect(output).toContain(`state_note_21_${index}`)
    expectCompleteStateDiagram(source, output)
  })

  test("renders every note in a cyclic vertical graph", () => {
    const source = `stateDiagram-v2
  direction TB
  state "Node S27_0" as S27_0
  state "Node S27_1" as S27_1
  state "Node S27_2" as S27_2
  state "Node S27_3" as S27_3
  state "Node S27_4" as S27_4
  state "Node S27_5" as S27_5
  S27_0 --> S27_1: state_edge_27_0
  S27_1 --> S27_2: state_edge_27_1
  S27_2 --> S27_3: state_edge_27_2
  S27_3 --> S27_4: state_edge_27_3
  S27_4 --> S27_5: state_edge_27_4
  S27_1 --> S27_0: state_edge_27_5
  S27_5 --> S27_1: state_edge_27_6
  S27_2 --> S27_1: state_edge_27_7
  S27_1 --> S27_5: state_edge_27_8
  note left of S27_5: state_note_27_0
  note right of S27_0: state_note_27_1
  note left of S27_3: state_note_27_2`
    const output = renderStateDiagram(source)

    for (const index of [0, 1, 2, 3, 4, 5]) expect(output).toContain(`Node S27_${index}`)
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) expect(output).toContain(`state_edge_27_${index}`)
    for (const index of [0, 1, 2]) expect(output).toContain(`state_note_27_${index}`)
    expectCompleteStateDiagram(source, output)
  })

  test("places exhausted notes on deterministic exterior lanes", () => {
    const source = `stateDiagram-v2
  direction TD
  state "Node S33_0" as S33_0
  state "Node S33_1" as S33_1
  state "Node S33_2" as S33_2
  state "Node S33_3" as S33_3
  state "Node S33_4" as S33_4
  state "Node S33_5" as S33_5
  state "Node S33_6" as S33_6
  S33_0 --> S33_1: state_edge_33_0
  S33_1 --> S33_2: state_edge_33_1
  S33_2 --> S33_3: state_edge_33_2
  S33_3 --> S33_4: state_edge_33_3
  S33_4 --> S33_5: state_edge_33_4
  S33_5 --> S33_6: state_edge_33_5
  S33_6 --> S33_4: state_edge_33_6
  S33_2 --> S33_4: state_edge_33_7
  S33_3 --> S33_3: state_edge_33_8
  note left of S33_2: state_note_33_0
  note left of S33_6: state_note_33_1`
    const output = renderStateDiagram(source)
    const exhaustedBudget = { remaining: 0 }
    const layout = createStateDiagramLayout(prepareVisibleStateDiagram(parseMermaidStateDiagram(source)), {
      minStateGap: 5,
      searchBudget: exhaustedBudget,
    })

    for (const index of [0, 1, 2, 3, 4, 5, 6]) expect(output).toContain(`Node S33_${index}`)
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) expect(output).toContain(`state_edge_33_${index}`)
    for (const index of [0, 1]) expect(output).toContain(`state_note_33_${index}`)
    expect(layout.noteBounds).toHaveLength(2)
    expect(exhaustedBudget.remaining).toBe(0)
    expectCompleteStateDiagram(source, output)
  })

  test("separates reciprocal RL branches sharing a parallel lane", () => {
    const source = `stateDiagram-v2
  direction RL
  state "Node S237_0" as S237_0
  state "Node S237_1" as S237_1
  state "Node S237_2" as S237_2
  state "Node S237_3" as S237_3
  state "Node S237_4" as S237_4
  state "Node S237_5" as S237_5
  S237_0 --> S237_1: state_edge_237_0
  S237_1 --> S237_2: state_edge_237_1
  S237_2 --> S237_3: state_edge_237_2
  S237_3 --> S237_4: state_edge_237_3
  S237_4 --> S237_5: state_edge_237_4
  S237_1 --> S237_5: state_edge_237_5
  S237_4 --> S237_5: state_edge_237_6
  S237_4 --> S237_0: state_edge_237_7
  S237_0 --> S237_4: state_edge_237_8
  note right of S237_1: state_note_237_0
  note left of S237_5: state_note_237_1
  note right of S237_2: state_note_237_2`
    const output = renderStateDiagram(source)

    for (const index of [0, 1, 2, 3, 4, 5]) expect(output).toContain(`Node S237_${index}`)
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) expect(output).toContain(`state_edge_237_${index}`)
    for (const index of [0, 1, 2]) expect(output).toContain(`state_note_237_${index}`)
    expectCompleteStateDiagram(source, output)
  })

  test("separates labels on four parallel vertical transitions", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction TB
  A --> B: one
  A --> B: two
  A --> B: three
  A --> B: four`)

    expect(output).not.toContain("twothree")
    for (const label of ["one", "two", "three", "four"]) {
      expect(output.match(new RegExp(label, "g"))).toHaveLength(1)
    }
  })

  test("grows parallel vertical diagrams by the maximum label width rather than their sum", () => {
    const render = (labels: readonly string[]) =>
      renderStateDiagram(`stateDiagram-v2
  direction TB
${labels.map((label) => `  A --> B: ${label}`).join("\n")}`)
    const shortLabels = ["one", "two", "three"]
    const longLabels = [
      "alpha route label that is deliberately long",
      "beta route label that is deliberately long",
      "gamma route label that is deliberately long",
    ]
    const width = (output: string) => Math.max(...output.split("\n").map((line) => stringWidth(line)))
    const labelGrowth =
      Math.max(...longLabels.map((label) => stringWidth(label))) -
      Math.max(...shortLabels.map((label) => stringWidth(label)))

    expect(width(render(longLabels)) - width(render(shortLabels))).toBeLessThanOrEqual(labelGrowth + 2)
  })

  test("keeps audited parallel labels clear of frames and rails", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction TB
  A --> B: alpha route label that is deliberately long
  A --> B: beta route label that is deliberately long
  A --> B: gamma route label that is deliberately long`)

    expect(output).toMatchInlineSnapshot(`
      "╭───╮ alpha route label that is deliberately long
      │ A ├───┬──╮
      ╰─┬─╯   │  │ gamma route label that is deliberately long
        │     │  │
        │     │  │ beta route label that is deliberately long
        │     │  │
        ▼     │  │
      ╭───╮   │  │
      │ B │◀──┴──╯
      ╰───╯"
    `)
  })

  test("keeps audited repeated self-transition lanes distinct and readable", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction LR
  A --> A: one
  A --> A: two
  A --> A: three`)

    expect(output).toMatchInlineSnapshot(`
      "╭───╮
      │ A │
      ╰─┬─╯
        │  ▲   ▲   ▲
        ├──╯   │   │
        │      │   │
        │ one  │   │
        ├──────╯   │
        │          │
        │     two  │ three
        ╰──────────╯"
    `)
  })

  test("expands composites around self-transition labels without engulfing external states", () => {
    const source = `stateDiagram-v2
  direction LR
  state Outer {
    A --> A: loop-0
    A --> A: loop-1
    A --> A: loop-2
  }
  A --> C`
    const drawing = createStateDiagramDrawing(parseMermaidStateDiagram(source))
    const outer = drawing.layout.compositeBounds.get("Outer")!
    const external = drawing.layout.bounds.get("C")!
    const output = drawing.grid.toString({ trimTop: true, trimBottom: true })

    expect(
      external.left < outer.left + outer.width &&
        external.left + external.width > outer.left &&
        external.top < outer.top + outer.height &&
        external.top + external.height > outer.top,
    ).toBe(false)
    for (const plan of drawing.transitionPlans.filter(
      (plan) => plan.route.transition.from === plan.route.transition.to,
    )) {
      expect(plan.label).toBeDefined()
      expect(plan.label!.x).toBeGreaterThan(outer.left)
      expect(plan.label!.y).toBeGreaterThan(outer.top)
      expect(plan.label!.x + Math.max(...plan.label!.lines.map((line) => stringWidth(line)))).toBeLessThan(
        outer.left + outer.width,
      )
      expect(plan.label!.y + plan.label!.lines.length).toBeLessThan(outer.top + outer.height)
    }
    for (const label of ["loop-0", "loop-1", "loop-2"]) expect(output.match(new RegExp(label, "g"))).toHaveLength(1)
  })

  test("keeps audited nested note connectors direct and inside every frame", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction TB
  state Outer {
    state Inner {
      A --> B: down
      B --> A: up
      note right of B: note
    }
  }`)

    expect(output).toMatchInlineSnapshot(`
      "╭─ Outer ───────────────╮
      │                       │
      │ ╭─ Inner ───────────╮ │
      │ │                   │ │
      │ │ ╭───╮             │ │
      │ │▶│ A │             │ │
      │ ││╰─┬─╯             │ │
      │ ││  │               │ │
      │ ││  │ down          │ │
      │ ││  │               │ │
      │ ││  ▼               │ │
      │ ││╭───╮    ╔══════╗ │ │
      │ │╰┤ B │════╣ note ║ │ │
      │ │ ╰───╯    ╚══════╝ │ │
      │ │up                 │ │
      │ ╰───────────────────╯ │
      │                       │
      ╰───────────────────────╯"
    `)
  })

  test("leaves frame gaps where external transitions cross nested composite boundaries", () => {
    const drawing = createStateDiagramDrawing(
      parseMermaidStateDiagram(`stateDiagram-v2
  direction LR
  state Session {
    [*] --> Open
    state Open {
      [*] --> Clean
    }
  }
  [*] --> Session: hydrate`),
    )
    const hydrate = drawing.transitionPlans.find((plan) => plan.route.transition.label === "hydrate")!
    const crossings = hydrate.cells.filter((cell) =>
      [...drawing.layout.compositeBounds.values()].some((bounds) => {
        const right = bounds.left + bounds.width - 1
        const bottom = bounds.top + bounds.height - 1
        return (
          ((cell.x === bounds.left || cell.x === right) && cell.y >= bounds.top && cell.y <= bottom) ||
          ((cell.y === bounds.top || cell.y === bottom) && cell.x >= bounds.left && cell.x <= right)
        )
      }),
    )

    expect(crossings).toHaveLength(2)
    for (const cell of crossings) expect(drawing.grid.getCell(cell.x, cell.y)?.char).toBe("─")
  })

  test("keeps explicit choices visible in choice-only cycles", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction TB
  state One <<choice>>
  state Two <<choice>>
  state Three <<choice>>
  One --> Two: clockwise
  Two --> Three: clockwise
  Three --> One: clockwise`)

    expect(output.match(/◆/g)).toHaveLength(3)
  })

  test("routes dense horizontal transitions around unrelated states", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction LR
  A --> B: ab
  A --> C: ac
  A --> D: ad
  B --> A: ba
  B --> C: bc
  B --> D: bd
  C --> A: ca
  C --> B: cb
  C --> D: cd
  D --> A: da
  D --> B: db
  D --> C: dc`)

    for (const state of ["A", "B", "C", "D"]) expect(output.match(new RegExp(state, "g"))).toHaveLength(1)
  })

  test("keeps dense vertical fan routes out of sibling states", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction TB
  state "Alpha" as A
  state "Beta" as B
  state "Gamma store" as C
  state "Delta notifier" as D
  A --> B
  A --> C
  A --> D
  B --> A: back
  B --> D: across`)

    for (const text of ["Alpha", "Beta", "Gamma store", "Delta notifier", "back", "across"]) {
      expect(output).toContain(text)
    }
  })

  test("routes parallel transitions around vertically offset states", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  A --> B: first<br/>line two
  A --> B: second<br/>another line
  B --> A: return<br/>with details`)

    expect(output).toContain(" A ")
    expect(output).toContain("│ B │")
    expect(output).toContain("first")
    expect(output).toContain("second")
    expect(output).toContain("return")
  })

  test("keeps independent overlapping feedback labels and paths distinct", () => {
    const content = (direction: "LR" | "RL") => `stateDiagram-v2
  direction ${direction}
  A --> B: advance
  B --> C: continue
  C --> D: finish
  C --> A: reset A
  D --> B: reset B`

    for (const direction of ["LR", "RL"] as const) {
      const output = renderStateDiagram(content(direction))
      expect(output).toContain("reset A")
      expect(output).toContain("reset B")
      expect(output).not.toContain("res│t")
    }
  })

  test("keeps independent internal feedback paths inside their composite frame", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction LR
  state Runtime {
    A --> B: advance
    B --> C: continue
    C --> D: finish
    C --> A: reset A
    D --> B: reset B
  }`)
    const lines = output.split("\n")
    const frameTop = lines.findIndex((line) => line.includes("Runtime"))
    const upperFeedback = lines.findIndex((line) => line.includes("reset B"))

    expect(upperFeedback).toBeGreaterThan(frameTop)
    expect(output).toContain("reset A")
    expect(output).not.toContain("res│t")
  })

  test("places notes away from independent feedback corridors", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction LR
  A --> B: advance
  B --> C: continue
  C --> D: finish
  C --> A: reset A
  D --> B: reset B
  note right of B : note beside B`)

    expect(output).toContain("note beside B")
    expect(output).toContain("reset B")
    expect(output).not.toContain("╭─║")
    expect(output).not.toContain("║──")
  })

  test("places notes away from transition routes and labels", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction LR
  A --> B: proceed only after validation
  note left of B: blocking note`)

    expect(output).toContain("proceed only after validation")
    expect(output).toContain("blocking note")
    expect(output.match(/ A | B /g)).toHaveLength(2)
    expect(output).toMatch(/[╠╣]═/)
  })

  test("keeps adjacent note connectors out of other notes", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction LR
  A --> B: advance
  B --> C: continue
  note right of B: first note
  note right of B: second note
  note left of C: left note`)

    for (const text of ["advance", "continue", "first note", "second note", "left note"]) {
      expect(output).toContain(text)
    }
    expect(output).not.toContain("╝═════╗")
  })

  test("keeps note connectors out of vertical loop and transition labels", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction TB
  state "Processing Ω<br/>phase two" as Processing
  state "Result ≥ threshold" as Result
  Ready --> Processing: first
  Ready --> Processing: duplicate
  Processing --> Ready: restore
  Processing --> Processing: heartbeat
  Processing --> Result: result ≥ 1
  Result --> Ready: reopen
  note right of Processing: Unicode note 界`)

    for (const text of ["heartbeat", "result ≥ 1", "Unicode note 界"]) {
      expect(output).toContain(text)
    }
    expect(output).not.toContain("hea║tbeat")
    expect(output).not.toContain("result║≥ 1")
  })

  test("keeps nested state labels clear of note connectors", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction LR
  state "Open document" as Open {
    [*] --> Clean: load
    Clean --> Dirty: edit
    Dirty --> Clean: save
  }
  note right of Dirty: unsaved changes`)

    for (const text of ["Open document", "Clean", "Dirty", "load", "edit", "save", "unsaved changes"]) {
      expect(output).toContain(text)
    }
  })

  test("keeps duplicate feedback labels away from an independent return path", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction LR
  A --> B
  B --> C
  C --> D
  C --> A: ca
  D --> B: db1
  D --> B: db2`)

    expect(output).toContain("ca")
    expect(output).toContain("db1")
    expect(output).toContain("db2")
    expect(output).not.toContain("c│")
  })

  test("renders composite state containers", () => {
    const output = renderStateDiagram(`
stateDiagram-v2
  direction LR
  state Authenticated {
    [*] --> Idle
    Idle --> Editing: open
    Editing --> [*]: save
  }
`)

    expect(output).toMatchInlineSnapshot(`
      "╭─ Authenticated ──────────────────────────────────────────────╮
      │                                                              │
      │               ╭──────╮    open     ╭─────────╮    save       │
      │ ─────────────▶│ Idle ├────────────▶│ Editing ├────────────── │
      │               ╰──────╯             ╰─────────╯               │
      │                                                              │
      ╰──────────────────────────────────────────────────────────────╯"
    `)
  })

  test("routes transitions entering and leaving composite states through scoped markers", () => {
    const content = `
stateDiagram-v2
  direction LR
  [*] --> Authenticated: login
  state Authenticated {
    [*] --> Idle
    Idle --> Editing: open
    Editing --> [*]: save
  }
  Authenticated --> [*]: logout
`
    const diagram = parseMermaidStateDiagram(content)
    const output = renderStateDiagram(content)

    expect(diagram.transitions).toContainEqual({
      from: "__start",
      to: "Authenticated.__start",
      label: "login",
    })
    expect(diagram.transitions).toContainEqual({
      from: "Authenticated.__end",
      to: "__end",
      label: "logout",
    })
    expect(output).toMatchInlineSnapshot(`
      "            ╭─ Authenticated ──────────────────╮
                  │                                  │ save
          login   │ ╭──────╮    open     ╭─────────╮ │ logout
      ●────────────▶│ Idle ├────────────▶│ Editing ├────────────▶◎
                  │ ╰──────╯             ╰─────────╯ │
                  │                                  │
                  ╰──────────────────────────────────╯"
    `)
  })

  test("keeps nested composite entry and exit routes within the outer frame height", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  state Session {
    [*] --> Open
    state Open {
      [*] --> Clean
      Clean --> Dirty: edit
      Dirty --> Clean: save
    }
    note right of Open: document lifecycle
    Open --> [*]: close
  }
  [*] --> Session
    Session --> [*]`)
    const lines = output.split("\n")
    const outerFrameTop = lines.find((line) => line.includes("Session"))!
    const frameLeft = outerFrameTop.indexOf("╭")
    const frameRight = outerFrameTop.lastIndexOf("╮")
    const outerFrameBottom = lines.findIndex((line) => line[frameLeft] === "╰" && line[frameRight] === "╯")
    const startColumn = lines.find((line) => line.includes("●"))!.indexOf("●")
    const endColumn = lines.find((line) => line.includes("◎"))!.indexOf("◎")

    expect(outerFrameBottom).toBeGreaterThan(0)
    expect(startColumn).toBeLessThan(frameLeft)
    expect(endColumn).toBeGreaterThan(frameRight)
    expect(lines.slice(outerFrameBottom + 1).every((line) => line.trim() === "")).toBe(true)
    expect(output).toContain("Open")
    expect(output).toContain("document lifecycle")
    expect(output).toContain("close")
  })

  test("renders notes attached to states", () => {
    const output = renderStateDiagram(`
stateDiagram-v2
  direction LR
  [*] --> Idle
  Idle --> Loading: submit
  note right of Loading : waits for response
`)

    expect(output).toMatchInlineSnapshot(`
      "              ╭──────╮   submit    ╭─────────╮    ╔════════════════════╗
      ●────────────▶│ Idle ├────────────▶│ Loading │════╣ waits for response ║
                    ╰──────╯             ╰─────────╯    ╚════════════════════╝"
    `)
  })

  test("keeps composite-to-choice elbows connected", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  [*] --> Authenticated
  state Authenticated {
    [*] --> Editing
    Editing --> Ready
  }
  note right of Editing
    Draft changes
  end note
  Authenticated --> Decision
  state Decision <<choice>>
  Decision --> [*]`)

    expect(output).toContain("╰─────────────▼")
    expect(output).toContain("◆────────────▶◎")
  })

  test("keeps vertical branch labels from overwriting state labels", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction TB
  state "Branch root" as Root
  state "Upper branch" as Upper
  state "Lower branch" as Lower
  state "Merged branch" as Merge
  Root --> Upper: branch-up
  Root --> Lower: branch-down
  Upper --> Merge: merge-up
  Lower --> Merge: merge-down
  Merge --> Root: branch-feedback`)

    for (const text of [
      "Branch root",
      "Upper branch",
      "Lower branch",
      "Merged branch",
      "branch-up",
      "branch-down",
      "merge-up",
      "merge-down",
      "branch-feedback",
    ]) {
      expect(output).toContain(text)
    }
  })

  test("routes vertical branch feedback around sibling state bodies", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  direction TB
  [*] --> Root
  Root --> A
  Root --> B
  A --> Merge
  B --> Merge
  Merge --> A: retry`)

    for (const state of ["Root", "A", "B", "Merge"]) {
      expect(output.match(new RegExp(`\\b${state}\\b`, "g"))).toHaveLength(1)
    }
    expect(output).toContain("│ B │")
    expect(output).toContain("retry")
  })

  test("keeps lifecycle states intact around branches and feedback", () => {
    const output = renderStateDiagram(`stateDiagram-v2
  [*] --> Idle
  Idle --> MailboxPending: enqueue + setAlarm
  MailboxPending --> PromptSubmitted: drain mailbox
  PromptSubmitted --> Polling: prompt admitted
  Polling --> Polling: execution still active
  Polling --> Completed: terminal log event
  Polling --> Polling: retry after transient failure
  Completed --> Idle: final Slack projection
  Idle --> Expired: 30 days inactive
  Expired --> [*]: delete SQLite state`)

    for (const state of ["Idle", "MailboxPending", "PromptSubmitted", "Polling", "Completed", "Expired"]) {
      expect(output.match(new RegExp(state, "g"))).toHaveLength(1)
    }
  })

  test("keeps composite titles intact under reciprocal composite routes", () => {
    const source = `stateDiagram-v2
  direction LR
  state FirstGroup {
    [*] --> FirstInner
    FirstInner --> [*]: first-out
  }
  state SecondGroup {
    [*] --> SecondInner
    SecondInner --> [*]: second-out
  }
  FirstGroup --> SecondGroup: group-next
    SecondGroup --> FirstGroup: group-back`

    for (const direction of ["LR", "TB"] as const) {
      const drawing = createStateDiagramDrawing(parseMermaidStateDiagram(source), { direction })
      const output = drawing.grid.toString({ trimTop: true, trimBottom: true })
      for (const id of ["FirstGroup", "SecondGroup"]) {
        const bounds = drawing.layout.compositeBounds.get(id)!
        const right = bounds.left + bounds.width - 1
        const bottom = bounds.top + bounds.height - 1
        const boundaryStyles = [
          ...Array.from({ length: bounds.height - 2 }, (_, offset) => [
            drawing.grid.getCell(bounds.left, bounds.top + offset + 1)?.style,
            drawing.grid.getCell(right, bounds.top + offset + 1)?.style,
          ]).flat(),
          ...Array.from(
            { length: bounds.width - 2 },
            (_, offset) => drawing.grid.getCell(bounds.left + offset + 1, bottom)?.style,
          ),
        ]

        expect(output.match(new RegExp(id, "g"))).toHaveLength(1)
        expect(
          boundaryStyles.every(
            (style) => style === "composite" || style === "transition" || style?.startsWith("stateDepartureRamp"),
          ),
        ).toBe(true)
      }
    }
  })
})
