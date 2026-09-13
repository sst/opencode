import type {
  FlowchartDiagram,
  FlowchartDirection,
  FlowchartEdge,
  FlowchartEdgeStyle,
  FlowchartNode,
  FlowchartSubgraph,
} from "./types.js"
import { MermaidSyntaxError } from "../diagnostics.js"
import {
  decodeMermaidText,
  firstMeaningfulMermaidLine,
  meaningfulNumberedMermaidLines,
  stripMermaidQuotes as stripQuotes,
} from "../core/mermaid.js"

const DEFAULT_DIRECTION = "TD" satisfies FlowchartDirection
const FLOWCHART_HEADER_RE = /^(flowchart|graph)(?:\s+(TB|TD|BT|LR|RL))?$/i
const ID_RE = "[A-Za-z_][A-Za-z0-9_.-]*"
const SUBGRAPH_RE = /^subgraph\s+(.+)$/i
const SUBGRAPH_WITH_LABEL_RE = new RegExp(`^(${ID_RE})\\s*\\[(.+)\\]$`)
const SUBGRAPH_DIRECTION_RE = /^direction\s+(TB|TD|BT|LR|RL)$/i
const IGNORED_PRESENTATION_RE = /^(?:classDef|class|style|linkStyle)\b/i
const DATABASE_NODE_RE = new RegExp(`^(${ID_RE})\\[\\((.+)\\)\\]$`)
const SUBROUTINE_NODE_RE = new RegExp(`^(${ID_RE})\\[\\[(.+)\\]\\]$`)
const ROUNDED_BRACKET_NODE_RE = new RegExp(`^(${ID_RE})\\(\\[(.+)\\]\\)$`)
const ROUNDED_NODE_RE = new RegExp(`^(${ID_RE})\\((.+)\\)$`)
const DECISION_NODE_RE = new RegExp(`^(${ID_RE})\\{(.+)\\}$`)
const BOX_NODE_RE = new RegExp(`^(${ID_RE})\\[(.+)\\]$`)
const ID_ONLY_RE = new RegExp(`^${ID_RE}$`)
const EXPLICIT_NODE_SHAPE_RE = new RegExp(`^${ID_RE}(?:\\[|\\(|\\{)`)
const CIRCLE_NODE_RE = new RegExp(`^${ID_RE}\\(\\(.+\\)\\)$`)
const MAX_FLOWCHART_LINE_LENGTH = 10_000
const EDGE_OPERATOR_RE =
  /(-\.(?!->)(.+?)\.(?:->|-))|(--|==|-\.)\s+(.+?)\s+(-->|==>|\.->|-\.->|\.-)|(<-->|-->|==>|-\.->|---|~~~)\s*(?:\|([^|]*)\|\s*)?/dg

function normalizeDirection(value?: string): FlowchartDirection {
  const upper = value?.toUpperCase()
  if (upper === "TB" || upper === "TD" || upper === "BT" || upper === "LR" || upper === "RL") return upper
  return DEFAULT_DIRECTION
}

function normalizeSubgraphId(value: string, index: number): string {
  const stripped = stripQuotes(value)
  return ID_ONLY_RE.test(stripped) ? stripped : `subgraph_${index + 1}`
}

function parseSubgraphToken(token: string, index: number): Pick<FlowchartSubgraph, "id" | "label"> {
  const trimmed = token
    .trim()
    .replace(/\s*:::.*$/, "")
    .replace(/;$/, "")
  const withLabel = trimmed.match(SUBGRAPH_WITH_LABEL_RE)
  if (withLabel) {
    return { id: withLabel[1]!, label: stripQuotes(withLabel[2]!) }
  }

  const label = stripQuotes(trimmed)
  return { id: normalizeSubgraphId(trimmed, index), label }
}

function parseNodeToken(token: string): FlowchartNode {
  const trimmed = token.trim().replace(/;$/, "")
  const database = trimmed.match(DATABASE_NODE_RE)
  if (database) return { id: database[1]!, label: stripQuotes(database[2]!), shape: "database" }

  const subroutine = trimmed.match(SUBROUTINE_NODE_RE)
  if (subroutine) return { id: subroutine[1]!, label: stripQuotes(subroutine[2]!), shape: "subroutine" }

  const roundedBracket = trimmed.match(ROUNDED_BRACKET_NODE_RE)
  if (roundedBracket) return { id: roundedBracket[1]!, label: stripQuotes(roundedBracket[2]!), shape: "rounded" }

  const rounded = trimmed.match(ROUNDED_NODE_RE)
  if (rounded) return { id: rounded[1]!, label: stripQuotes(rounded[2]!), shape: "rounded" }

  const decision = trimmed.match(DECISION_NODE_RE)
  if (decision) return { id: decision[1]!, label: stripQuotes(decision[2]!), shape: "decision" }

  const box = trimmed.match(BOX_NODE_RE)
  if (box) return { id: box[1]!, label: stripQuotes(box[2]!), shape: "box" }

  return { id: trimmed, label: trimmed, shape: "box" }
}

function isSupportedNodeToken(token: string): boolean {
  const trimmed = stripNodeToken(token)
  if (CIRCLE_NODE_RE.test(trimmed)) return false
  return (
    ID_ONLY_RE.test(trimmed) ||
    DATABASE_NODE_RE.test(trimmed) ||
    SUBROUTINE_NODE_RE.test(trimmed) ||
    ROUNDED_BRACKET_NODE_RE.test(trimmed) ||
    ROUNDED_NODE_RE.test(trimmed) ||
    DECISION_NODE_RE.test(trimmed) ||
    BOX_NODE_RE.test(trimmed)
  )
}

function hasExplicitNodeShape(token: string): boolean {
  return EXPLICIT_NODE_SHAPE_RE.test(token.trim())
}

function ensureNode(nodes: Map<string, FlowchartNode>, token: string): FlowchartNode {
  const node = parseNodeToken(token)
  const existing = nodes.get(node.id)
  if (!existing) {
    nodes.set(node.id, node)
    return node
  }

  if (hasExplicitNodeShape(token)) {
    existing.label = node.label
    existing.shape = node.shape
  }
  return existing
}

function addNodeToSubgraph(subgraph: FlowchartSubgraph | undefined, nodeId: string): void {
  if (!subgraph || subgraph.nodeIds.includes(nodeId)) return
  subgraph.nodeIds.push(nodeId)
}

function stripNodeToken(token: string): string {
  return token
    .replace(/\s*:::.*$/, "")
    .replace(/;$/, "")
    .trim()
}

/** Split an `&`-joined node group, leaving `&` inside labels (brackets or quotes) untouched. */
function splitNodeGroup(token: string): string[] {
  const groups: string[] = []
  const stack: string[] = []
  let quote: '"' | "'" | undefined
  let start = 0
  const closes: Record<string, string> = { "[": "]", "(": ")", "{": "}" }

  for (let index = 0; index < token.length; index++) {
    const character = token[index]!
    if (quote) {
      if (character === quote && token[index - 1] !== "\\") quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character in closes) {
      stack.push(character)
      continue
    }
    if (stack.length > 0 && character === closes[stack.at(-1)!]) {
      stack.pop()
      continue
    }
    if (stack.length === 0 && character === "&") {
      groups.push(token.slice(start, index))
      start = index + 1
    }
  }
  groups.push(token.slice(start))
  return groups
}

function edgeStyleFromArrow(...arrows: string[]): FlowchartEdgeStyle | undefined {
  if (arrows.some((arrow) => arrow.includes("=="))) return "thick"
  if (arrows.some((arrow) => arrow.includes("."))) return "dashed"
  return undefined
}

function createEdge(
  from: string,
  to: string,
  label: string,
  style: FlowchartEdgeStyle | undefined,
  arrowhead: boolean,
  sourceArrowhead: boolean,
): FlowchartEdge {
  const edge: FlowchartEdge = style ? { from, to, label, style } : { from, to, label }
  if (!arrowhead) edge.arrowhead = false
  if (sourceArrowhead) edge.sourceArrowhead = true
  return edge
}

interface ParsedEdgeOperator {
  index: number
  end: number
  label: string
  style: FlowchartEdgeStyle | undefined
  arrowhead: boolean
  sourceArrowhead: boolean
  orderOnly: boolean
}

function parseEdgeOperators(line: string): ParsedEdgeOperator[] {
  return [...maskNodeLabelOperators(line).matchAll(EDGE_OPERATOR_RE)].map((match) => {
    const inlineDashedArrow = match[1]
    const startArrow = inlineDashedArrow ?? match[3] ?? match[6]!
    const endArrow = inlineDashedArrow ?? match[5] ?? match[6]!
    const labelGroup = match[2] ? 2 : match[4] ? 4 : match[7] ? 7 : undefined
    const labelRange = labelGroup === undefined ? undefined : match.indices?.[labelGroup]
    return {
      index: match.index,
      end: match.index + match[0].length,
      label: stripQuotes(labelRange ? line.slice(labelRange[0], labelRange[1]) : ""),
      style: edgeStyleFromArrow(startArrow, endArrow),
      arrowhead: endArrow === "~~~" || endArrow.endsWith(">"),
      sourceArrowhead: startArrow.startsWith("<"),
      orderOnly: endArrow === "~~~",
    }
  })
}

function maskNodeLabelOperators(line: string): string {
  const characters = line.split("")
  const stack: string[] = []
  let quote: '"' | "'" | undefined
  const closes: Record<string, string> = { "[": "]", "(": ")", "{": "}" }

  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]!
    if (quote) {
      if (character === quote && characters[index - 1] !== "\\") quote = undefined
      else if (/[<>=.-]/.test(character)) characters[index] = " "
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character in closes) {
      stack.push(character)
      continue
    }
    if (stack.length > 0 && character === closes[stack.at(-1)!]) {
      stack.pop()
      continue
    }
    if (stack.length > 0 && /[<>=.-]/.test(character)) characters[index] = " "
  }
  return characters.join("")
}

function hasInternalStatementSeparator(line: string): boolean {
  const stack: string[] = []
  let quote: '"' | "'" | undefined
  let edgeLabel = false
  const closes: Record<string, string> = { "[": "]", "(": ")", "{": "}" }
  const finalIndex = line.trimEnd().length - 1

  for (let index = 0; index < line.length; index++) {
    const character = line[index]!
    if (quote) {
      if (character === quote && line[index - 1] !== "\\") quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character in closes) {
      stack.push(character)
      continue
    }
    if (stack.length > 0 && character === closes[stack.at(-1)!]) {
      stack.pop()
      continue
    }
    if (stack.length === 0 && character === "|") {
      edgeLabel = !edgeLabel
      continue
    }
    if (character === ";" && index < finalIndex && stack.length === 0 && !edgeLabel) return true
  }
  return false
}

export function isMermaidFlowchartDiagram(content: string): boolean {
  return FLOWCHART_HEADER_RE.test(firstMeaningfulMermaidLine(content) ?? "")
}

export function parseMermaidFlowchartDiagram(content: string): FlowchartDiagram {
  const nodes = new Map<string, FlowchartNode>()
  const edges: FlowchartEdge[] = []
  const subgraphs: FlowchartSubgraph[] = []
  const subgraphStack: Array<{ subgraph: FlowchartSubgraph; lineNumber: number; sourceLine: string }> = []
  let direction: FlowchartDirection = DEFAULT_DIRECTION

  for (const source of meaningfulNumberedMermaidLines(content)) {
    const line = source.text
    if (line.length > MAX_FLOWCHART_LINE_LENGTH) {
      throw new MermaidSyntaxError("flowchart", source.lineNumber, line, "Flowchart statement is too long")
    }
    if (hasInternalStatementSeparator(line)) throw new MermaidSyntaxError("flowchart", source.lineNumber, line)
    const header = line.match(FLOWCHART_HEADER_RE)
    if (header) {
      direction = normalizeDirection(header[2])
      continue
    }

    // Mermaid CSS styling does not apply to terminal theme rendering.
    if (IGNORED_PRESENTATION_RE.test(line)) continue

    const subgraphMatch = line.match(SUBGRAPH_RE)
    if (subgraphMatch) {
      const parsed = parseSubgraphToken(subgraphMatch[1]!, subgraphs.length)
      const subgraph: FlowchartSubgraph = {
        ...parsed,
        nodeIds: [],
        parentId: subgraphStack[subgraphStack.length - 1]?.subgraph.id,
      }
      subgraphs.push(subgraph)
      subgraphStack.push({ subgraph, lineNumber: source.lineNumber, sourceLine: line })
      continue
    }

    if (/^end$/i.test(line)) {
      if (subgraphStack.length === 0) {
        throw new MermaidSyntaxError("flowchart", source.lineNumber, line, 'Unexpected "end" without an open subgraph')
      }
      subgraphStack.pop()
      continue
    }

    const currentSubgraph = subgraphStack[subgraphStack.length - 1]?.subgraph

    const subgraphDirection = line.match(SUBGRAPH_DIRECTION_RE)
    if (subgraphDirection) {
      if (!currentSubgraph) {
        throw new MermaidSyntaxError(
          "flowchart",
          source.lineNumber,
          line,
          'A "direction" statement requires an open subgraph',
        )
      }
      currentSubgraph.direction = normalizeDirection(subgraphDirection[1])
      continue
    }

    const edgeOperators = parseEdgeOperators(line)
    if (edgeOperators.length > 0) {
      // Each chain position may be an `&` group (`A & B --> C`), so endpoints are lists of node tokens.
      const nodeGroups = [
        line.slice(0, edgeOperators[0]!.index),
        ...edgeOperators.map((operator, index) =>
          line.slice(operator.end, edgeOperators[index + 1]?.index ?? line.length),
        ),
      ].map((group) => splitNodeGroup(group).map(stripNodeToken))

      if (nodeGroups.every((group) => group.every((token) => token.length > 0))) {
        const unsupportedEndpoint = nodeGroups.find((group, index) => {
          const orderOnlyEndpoint = edgeOperators[index - 1]?.orderOnly || edgeOperators[index]?.orderOnly
          return group.some(
            (stripped) =>
              !(orderOnlyEndpoint && subgraphs.some((subgraph) => subgraph.id === stripped)) &&
              !isSupportedNodeToken(stripped),
          )
        })
        if (unsupportedEndpoint) throw new MermaidSyntaxError("flowchart", source.lineNumber, line)
        const chainNodeIds = nodeGroups.map((group, index) => {
          const orderOnlyEndpoint = edgeOperators[index - 1]?.orderOnly || edgeOperators[index]?.orderOnly
          return group.map((stripped) => {
            if (orderOnlyEndpoint && subgraphs.some((subgraph) => subgraph.id === stripped)) return stripped
            return ensureNode(nodes, stripped).id
          })
        })
        for (const nodeId of chainNodeIds.flat()) {
          if (nodes.has(nodeId)) addNodeToSubgraph(currentSubgraph, nodeId)
        }
        for (let index = 0; index < edgeOperators.length; index++) {
          const operator = edgeOperators[index]!
          for (const from of chainNodeIds[index]!) {
            for (const to of chainNodeIds[index + 1]!) {
              const edge = createEdge(
                from,
                to,
                operator.label,
                operator.style,
                operator.arrowhead,
                operator.sourceArrowhead,
              )
              edges.push(operator.orderOnly ? { ...edge, orderOnly: true } : edge)
            }
          }
        }
        continue
      }
    }

    const nodeGroup = splitNodeGroup(line)
    if (nodeGroup.every(isSupportedNodeToken)) {
      for (const token of nodeGroup) addNodeToSubgraph(currentSubgraph, ensureNode(nodes, stripNodeToken(token)).id)
      continue
    }

    throw new MermaidSyntaxError("flowchart", source.lineNumber, line)
  }

  const unclosedSubgraph = subgraphStack[subgraphStack.length - 1]
  if (unclosedSubgraph) {
    throw new MermaidSyntaxError(
      "flowchart",
      unclosedSubgraph.lineNumber,
      unclosedSubgraph.sourceLine,
      'Unclosed subgraph; expected "end"',
    )
  }

  return { direction, nodes: [...nodes.values()], edges, subgraphs }
}
