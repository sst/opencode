import { describe, expect, test } from "bun:test"
import { MermaidSyntaxError } from "../diagnostics.js"
import { renderGitGraphDiagram } from "../gitgraph/diagram.js"
import { parseMermaidFlowchartDiagram } from "../flowchart/parser.js"
import { parseMermaidSequenceDiagram } from "../sequence/parser.js"
import { parseMermaidStateDiagram } from "../state/parser.js"
import { renderTimelineDiagram } from "../timeline/diagram.js"
import { renderSequenceDiagram } from "../sequence/diagram.js"

describe("parser diagnostics", () => {
  test("ignores flowchart presentation directives that do not change terminal structure", () => {
    const diagram = parseMermaidFlowchartDiagram(`flowchart LR
  A[Start] --> B[Done]
  classDef highlight fill:#fff
  class A highlight
  style B fill:#000
  linkStyle 0 stroke:#fff`)

    expect(diagram.nodes.map((node) => node.id)).toEqual(["A", "B"])
    expect(diagram.edges).toHaveLength(1)
  })

  test("reports unsupported structural flowchart statements with source location", () => {
    expect(() =>
      parseMermaidFlowchartDiagram(`flowchart LR
  A[Start] --> B[Done]
  A --o B`),
    ).toThrow('Unsupported syntax in flowchart diagram at line 3: "A --o B"')
  })

  test("does not partially parse unsupported flowchart syntax", () => {
    for (const statement of ["A & --> C", "A((Start)) --> B", "A-->B; B-->C"]) {
      expect(() => parseMermaidFlowchartDiagram(`flowchart LR\n  ${statement}`)).toThrow(MermaidSyntaxError)
    }
  })

  test("does not treat arrows inside flowchart node labels as edges", () => {
    const diagram = parseMermaidFlowchartDiagram(`flowchart LR
  A["send --> receive"] --> B`)

    expect(diagram.nodes.map((node) => node.id)).toEqual(["A", "B"])
    expect(diagram.nodes[0]?.label).toBe("send --> receive")
    expect(diagram.edges).toHaveLength(1)
  })

  test("rejects pathological flowchart statements before parsing edge operators", () => {
    const statement = "-.a".repeat(4_000)
    expect(() => parseMermaidFlowchartDiagram(`flowchart LR\n${statement}`)).toThrow("Flowchart statement is too long")
  })

  test("exposes structured syntax errors through top-level rendering", () => {
    try {
      renderSequenceDiagram(`sequenceDiagram
  A->>B: request
  opt retry`)
      throw new Error("expected render to reject unsupported syntax")
    } catch (error) {
      expect(error).toBeInstanceOf(MermaidSyntaxError)
      if (!(error instanceof MermaidSyntaxError)) return
      expect(error.kind).toBe("sequence")
      expect(error.lineNumber).toBe(3)
      expect(error.sourceLine).toBe("opt retry")
    }
  })

  test("rejects unsupported bidirectional sequence arrows without phantom participants", () => {
    for (const message of ["A<<->>B: hello", "A<<-->>B: hello"]) {
      expect(() => parseMermaidSequenceDiagram(`sequenceDiagram\n  ${message}`)).toThrow(MermaidSyntaxError)
    }
  })

  test("rejects chained sequence and state transitions instead of creating phantom endpoints", () => {
    expect(() => parseMermaidSequenceDiagram("sequenceDiagram\n  A->>B->>C: hello")).toThrow(MermaidSyntaxError)
    expect(() => parseMermaidStateDiagram("stateDiagram-v2\n  A-->B-->C")).toThrow(MermaidSyntaxError)
  })

  test("reports unclosed state constructs at their opening line", () => {
    expect(() =>
      parseMermaidStateDiagram(`stateDiagram-v2
  state Running {
    [*] --> Ready`),
    ).toThrow('Unclosed composite state; expected "}" in state diagram at line 2: "state Running {"')
  })

  test("reports unsupported state statements", () => {
    expect(() => parseMermaidStateDiagram(`stateDiagram-v2\n  hide empty description`)).toThrow(
      'Unsupported syntax in state diagram at line 2: "hide empty description"',
    )
  })

  test("rejects unsupported composite-local state directions", () => {
    expect(() =>
      parseMermaidStateDiagram(`stateDiagram-v2
  direction LR
  state Parent {
    direction TB
    A --> B
  }`),
    ).toThrow("Composite-local direction is not supported")
  })

  test("reports malformed sequence block endings", () => {
    expect(() =>
      parseMermaidSequenceDiagram(`sequenceDiagram
  end`),
    ).toThrow('Unexpected "end" without an open block in sequence diagram at line 2: "end"')
  })

  test("reports malformed timeline continuations with timeline diagnostics", () => {
    expect(() => renderTimelineDiagram("timeline\n  : orphan event")).toThrow(
      'Timeline continuation requires a preceding period in timeline diagram at line 2: ": orphan event"',
    )
  })

  test("reports unsupported GitGraph operations with source diagnostics", () => {
    expect(() => renderGitGraphDiagram("gitGraph\n  cherry-pick id: missing")).toThrow(
      'Cherry-pick is not supported in gitGraph diagram at line 2: "cherry-pick id: missing"',
    )
  })

  test("does not attach else through an unclosed nested sequence block", () => {
    expect(() =>
      parseMermaidSequenceDiagram(`sequenceDiagram
  alt available
    loop retry
  else fallback`),
    ).toThrow('Unexpected "else" without an open "alt" block in sequence diagram at line 4: "else fallback"')
  })
})
