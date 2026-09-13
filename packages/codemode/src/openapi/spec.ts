import { fromSchemaOpenApi3_0, fromSchemaOpenApi3_1 } from "effect/JsonSchema"
import type { JsonSchema } from "../tool.js"
import type {
  Body,
  Document,
  InputField,
  OperationInput,
  Parsed,
  SecurityRequirement,
  SecurityScheme,
} from "./types.js"

export const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"])
const parameterLocations = ["path", "query", "header"] as const
const ignoredHeaderParameters = new Set(["accept", "content-type", "authorization"])

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

export const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

// Spec- and model-controlled keys must not resolve inherited properties.
export const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

const resolvePointer = (root: unknown, ref: string): unknown =>
  ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((item, segment) => (isRecord(item) ? own(item, segment) : undefined), root)

export const resolve = (document: Document, value: unknown): unknown => {
  const next = (current: unknown, seen: ReadonlySet<string>): unknown => {
    if (!isRecord(current)) return current
    const ref = nonEmptyString(own(current, "$ref"))
    if (ref === undefined || !ref.startsWith("#/") || seen.has(ref)) return current
    const target = resolvePointer(document, ref)
    return target === undefined ? current : next(target, new Set([...seen, ref]))
  }
  return next(value, new Set())
}

// Model-facing directional projection: request schemas omit `readOnly` properties,
// response schemas omit `writeOnly` properties, and `required` stays consistent.
// Runtime values pass through unchanged.
type SchemaDirection = "request" | "response"
type SchemaResource = { readonly value: unknown; readonly root: unknown }

const hiddenKeyword = { request: "readOnly", response: "writeOnly" } as const

// Resolves one `$ref` hop so every link of a chain has its own sibling declarations
// inspected; cycles terminate in the callers' cycle solver. Local `$defs`/`definitions`
// pointers resolve against the schema being projected, other pointers rebase onto the target.
const resolveResource = (document: Document, resource: SchemaResource): SchemaResource => {
  if (!isRecord(resource.value)) return resource
  const ref = nonEmptyString(own(resource.value, "$ref"))
  if (ref === undefined || !ref.startsWith("#/")) return resource
  const local = ref.startsWith("#/$defs/") || ref.startsWith("#/definitions/")
  const target = resolvePointer(local ? resource.root : document, ref)
  if (target === undefined) return resource
  return { value: target, root: local ? resource.root : target }
}

// Hidden-ness and hidden names are memoized per schema object and direction so
// diamond-shaped reference graphs stay linear. Documents are assumed immutable once
// projected; a schema reachable under multiple resolution roots reuses the first result.
type Solver<T> = {
  readonly values: Map<unknown, T>
  // Discovery index per schema whose strongly connected component is unresolved.
  readonly pending: Map<unknown, number>
  readonly stack: Array<unknown>
}
type DirectionCache = {
  readonly hidden: Solver<boolean>
  readonly names: Solver<ReadonlySet<string>>
}

const emptyCache = (): DirectionCache => ({
  hidden: { values: new Map(), pending: new Map(), stack: [] },
  names: { values: new Map(), pending: new Map(), stack: [] },
})

const projectionCaches = new WeakMap<Document, Record<SchemaDirection, DirectionCache>>()

const projectionCache = (document: Document, direction: SchemaDirection): DirectionCache => {
  const existing = projectionCaches.get(document)
  if (existing !== undefined) return existing[direction]
  const created = { request: emptyCache(), response: emptyCache() }
  projectionCaches.set(document, created)
  return created[direction]
}

// Tarjan's strongly connected components: cycle members all reach the same
// declarations, so the component root's value is final for every member. Only resolved
// components are cached, keeping results independent of traversal order.
type CycleScope = { lowlink: number }

const solveCycles = <T>(
  solver: Solver<T>,
  key: unknown,
  provisional: T,
  scope: CycleScope,
  compute: (inner: CycleScope) => T,
): T => {
  const cached = solver.values.get(key)
  if (cached !== undefined) return cached
  const pending = solver.pending.get(key)
  if (pending !== undefined) {
    scope.lowlink = Math.min(scope.lowlink, pending)
    return provisional
  }
  // Components pop as contiguous stack suffixes, so pending indices stay 0..size-1.
  const index = solver.pending.size
  const base = solver.stack.length
  solver.pending.set(key, index)
  solver.stack.push(key)
  const inner: CycleScope = { lowlink: Infinity }
  const value = compute(inner)
  if (inner.lowlink < index) {
    scope.lowlink = Math.min(scope.lowlink, inner.lowlink)
    return value
  }
  for (const member of solver.stack.splice(base)) {
    solver.pending.delete(member)
    solver.values.set(member, value)
  }
  return value
}

// Most documents have no directional keywords; one cached scan skips projection entirely.
const directionalDocuments = new WeakMap<Document, boolean>()

export const hasDirectionalSchemas = (document: Document): boolean => {
  const cached = directionalDocuments.get(document)
  if (cached !== undefined) return cached
  const contains = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(contains)
    if (!isRecord(value)) return false
    if (own(value, "readOnly") === true || own(value, "writeOnly") === true) return true
    return Object.values(value).some(contains)
  }
  const result = contains(document)
  directionalDocuments.set(document, result)
  return result
}

// OpenAPI 3.1 allows keywords as siblings of `$ref`, so a schema's own declarations
// are inspected before following the reference.
const isHidden = (
  document: Document,
  resource: SchemaResource,
  direction: SchemaDirection,
  scope: CycleScope = { lowlink: Infinity },
): boolean => {
  const value = resource.value
  if (!isRecord(value)) return false
  if (own(value, hiddenKeyword[direction]) === true) return true
  return solveCycles(projectionCache(document, direction).hidden, value, false, scope, (inner) => {
    const target = resolveResource(document, resource)
    return (
      asArray(own(value, "allOf")).some((item) => isHidden(document, { ...resource, value: item }, direction, inner)) ||
      (target.value !== value && isHidden(document, target, direction, inner))
    )
  })
}

// Hidden property names declared by a schema itself or inherited through `$ref` and
// `allOf` composition, so sibling `required` lists stay consistent after projection.
const hiddenNames = (
  document: Document,
  resource: SchemaResource,
  direction: SchemaDirection,
  scope: CycleScope = { lowlink: Infinity },
): ReadonlySet<string> => {
  const value = resource.value
  if (!isRecord(value)) return new Set()
  return solveCycles(projectionCache(document, direction).names, value, new Set(), scope, (inner) => {
    const properties = own(value, "properties")
    const declared = isRecord(properties)
      ? Object.entries(properties)
          .filter(([, property]) => isHidden(document, { ...resource, value: property }, direction))
          .map(([name]) => name)
      : []
    const composed = asArray(own(value, "allOf")).flatMap((item) => [
      ...hiddenNames(document, { ...resource, value: item }, direction, inner),
    ])
    const target = resolveResource(document, resource)
    const referenced = target.value === value ? [] : hiddenNames(document, target, direction, inner)
    return new Set([...declared, ...composed, ...referenced])
  })
}

// `not`/`if`/`contains` subschemas pass through unprojected: they negate or select
// rather than assert, so removing hidden properties would invert their semantics.
const nestedSchemas = new Set([
  "items",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "then",
  "else",
])
const nestedSchemaLists = new Set(["anyOf", "oneOf", "prefixItems"])
const nestedSchemaMaps = new Set(["patternProperties", "dependentSchemas", "$defs", "definitions"])

const directionalSchema = (
  document: Document,
  resource: SchemaResource,
  direction: SchemaDirection,
  excluded: ReadonlySet<string> = new Set(),
): unknown => {
  if (!isRecord(resource.value)) return resource.value
  const hidden = new Set([...excluded, ...hiddenNames(document, resource, direction)])
  const project = (item: unknown, inherited: ReadonlySet<string> = new Set()): unknown =>
    directionalSchema(document, { ...resource, value: item }, direction, inherited)
  return Object.fromEntries(
    Object.entries(resource.value).map(([key, item]) => {
      if (key === "properties" && isRecord(item)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(item)
              .filter(([name]) => !hidden.has(name))
              .map(([name, property]) => [name, project(property)]),
          ),
        ]
      }
      if (key === "required" && Array.isArray(item)) {
        return [key, item.filter((name) => typeof name !== "string" || !hidden.has(name))]
      }
      // allOf branches share one object; hidden names apply across every branch.
      if (key === "allOf" && Array.isArray(item)) return [key, item.map((entry) => project(entry, hidden))]
      if (nestedSchemas.has(key)) return [key, project(item)]
      if (nestedSchemaLists.has(key) && Array.isArray(item)) return [key, item.map((entry) => project(entry))]
      if (nestedSchemaMaps.has(key) && isRecord(item)) {
        return [key, Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, project(entry)]))]
      }
      return [key, item]
    }),
  )
}

const normalizeSchema = (document: Document, value: unknown): JsonSchema => {
  if (!isRecord(value)) return {}
  const normalized = nonEmptyString(document.openapi)?.startsWith("3.0")
    ? fromSchemaOpenApi3_0(value)
    : fromSchemaOpenApi3_1(value)
  return Object.keys(normalized.definitions).length === 0
    ? normalized.schema
    : { ...normalized.schema, $defs: normalized.definitions }
}

const projectSchema = (document: Document, value: unknown, direction: SchemaDirection): JsonSchema =>
  normalizeSchema(
    document,
    hasDirectionalSchemas(document) ? directionalSchema(document, { value, root: value }, direction) : value,
  )

export const componentDefinitions = (
  document: Document,
  direction: SchemaDirection,
): Readonly<Record<string, JsonSchema>> => {
  const components = isRecord(document.components) ? document.components : {}
  const schemas = isRecord(components.schemas) ? components.schemas : {}
  return Object.fromEntries(
    Object.entries(schemas).map(([name, value]) => [name, projectSchema(document, value, direction)]),
  )
}

const withDefinitions = (schema: JsonSchema, definitions: Readonly<Record<string, JsonSchema>>): JsonSchema => {
  if (Object.keys(definitions).length === 0) return schema
  const local = isRecord(schema.$defs) ? schema.$defs : {}
  return { ...schema, $defs: { ...definitions, ...local } }
}

const isJsonMediaType = (mediaType: string): boolean => {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase() ?? ""
  return normalized === "application/json" || normalized.endsWith("+json")
}

const isBinaryMediaType = (document: Document, mediaType: string, value: unknown): boolean => {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase() ?? ""
  if (!isJsonMediaType(normalized) && !normalized.startsWith("text/")) return true
  if (!isRecord(value)) return false
  const schema = resolve(document, value.schema)
  return isRecord(schema) && schema.format === "binary"
}

const jsonContent = (
  content: Record<string, unknown>,
): { readonly mediaType: string; readonly schema: unknown } | undefined => {
  const entry = Object.entries(content).find(([mediaType]) => isJsonMediaType(mediaType))
  return entry !== undefined && isRecord(entry[1]) ? { mediaType: entry[0], schema: entry[1].schema } : undefined
}

const isFlattenableObjectBody = (
  schema: unknown,
  requestRequired: boolean,
): schema is Record<string, unknown> & { readonly properties: Record<string, unknown> } =>
  isRecord(schema) &&
  requestRequired &&
  schema.type === "object" &&
  isRecord(schema.properties) &&
  schema.additionalProperties === false &&
  schema.nullable !== true &&
  schema.allOf === undefined &&
  schema.anyOf === undefined &&
  schema.oneOf === undefined

type PlannedField = Omit<InputField, "inputName">

const operationParameters = (
  document: Document,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): Parsed<ReadonlyArray<PlannedField>> => {
  // OpenAPI operation parameters override path parameters with the same location and name.
  const declared = new Map<
    string,
    { readonly name: string; readonly location: string; readonly parameter: Record<string, unknown> }
  >()
  for (const raw of [...asArray(pathItem.parameters), ...asArray(operation.parameters)]) {
    const resolved = resolve(document, raw)
    if (!isRecord(resolved)) return { ok: false, reason: "parameter declaration is invalid or unresolved" }
    const name = nonEmptyString(resolved.name)
    const location = nonEmptyString(resolved.in)
    if (name === undefined || location === undefined)
      return { ok: false, reason: "parameter declaration is missing name or location" }
    declared.set(`${location}:${name}`, { name, location, parameter: resolved })
  }
  const unordered: Array<PlannedField> = []
  for (const item of declared.values()) {
    const name = item.name
    const location = item.location
    const resolved = item.parameter
    if (location === "cookie") return { ok: false, reason: `cookie parameter '${name}' is not supported` }
    if (location !== "path" && location !== "query" && location !== "header") {
      return { ok: false, reason: `parameter '${name}' uses unsupported location '${location}'` }
    }
    if (location === "header" && ignoredHeaderParameters.has(name.toLowerCase())) continue
    if (resolved.schema === undefined && resolved.content === undefined) {
      return { ok: false, reason: `parameter '${name}' declares neither schema nor content` }
    }
    if (resolved.content !== undefined)
      return { ok: false, reason: `parameter '${name}' uses unsupported content encoding` }
    if (resolved.style !== undefined && nonEmptyString(resolved.style) === undefined) {
      return { ok: false, reason: `parameter '${name}' has an invalid style` }
    }
    if (resolved.explode !== undefined && typeof resolved.explode !== "boolean") {
      return { ok: false, reason: `parameter '${name}' has an invalid explode value` }
    }
    if (resolved.allowReserved !== undefined && typeof resolved.allowReserved !== "boolean") {
      return { ok: false, reason: `parameter '${name}' has an invalid allowReserved value` }
    }
    if (resolved.allowReserved === true)
      return { ok: false, reason: `parameter '${name}' uses unsupported allowReserved encoding` }
    const declaredStyle = nonEmptyString(resolved.style) ?? (location === "query" ? "form" : "simple")
    if (location === "query" && declaredStyle !== "form" && declaredStyle !== "deepObject") {
      return { ok: false, reason: `query parameter '${name}' uses unsupported style '${declaredStyle}'` }
    }
    if (location !== "query" && declaredStyle !== "simple") {
      return { ok: false, reason: `${location} parameter '${name}' uses unsupported style '${declaredStyle}'` }
    }
    const style = declaredStyle === "deepObject" ? "deepObject" : declaredStyle === "form" ? "form" : "simple"
    const explode = typeof resolved.explode === "boolean" ? resolved.explode : style === "form"
    if (style === "deepObject" && !explode) {
      return { ok: false, reason: `query parameter '${name}' uses deepObject with explode=false` }
    }
    const base = projectSchema(document, resolved.schema, "request")
    const description = nonEmptyString(resolved.description)
    unordered.push({
      name,
      location,
      required: resolved.required === true || location === "path",
      style,
      explode,
      schema: {
        ...base,
        ...(base.description === undefined && description !== undefined ? { description } : {}),
      },
    })
  }
  return {
    ok: true,
    value: parameterLocations.flatMap((location) => unordered.filter((field) => field.location === location)),
  }
}

const operationBody = (
  document: Document,
  operation: Record<string, unknown>,
): Parsed<{ readonly fields: ReadonlyArray<PlannedField>; readonly body: Body | undefined }> => {
  const resolved = resolve(document, operation.requestBody)
  if (!isRecord(resolved)) return { ok: true, value: { fields: [], body: undefined } }
  const content = isRecord(resolved.content) ? resolved.content : {}
  const selected = jsonContent(content)
  if (selected === undefined) {
    return {
      ok: false,
      reason: `request body has no JSON content (declared: ${Object.keys(content).join(", ") || "none"})`,
    }
  }
  const resolvedSchema = resolve(document, selected.schema)
  const schema = hasDirectionalSchemas(document)
    ? directionalSchema(document, { value: resolvedSchema, root: resolvedSchema }, "request")
    : resolvedSchema
  const required = resolved.required === true
  if (!isFlattenableObjectBody(schema, required)) {
    return {
      ok: true,
      value: {
        fields: [
          {
            name: "body",
            location: "body",
            required,
            schema: projectSchema(document, selected.schema, "request"),
            style: undefined,
            explode: undefined,
          },
        ],
        body: { required, mode: "value", mediaType: selected.mediaType },
      },
    }
  }
  const requiredProperties = new Set(
    Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [],
  )
  return {
    ok: true,
    value: {
      // Field schemas were already projected with the body as resolution root; a second
      // directional pass rooted at the field would misresolve shadowed local $defs.
      fields: Object.entries(schema.properties).map(([name, value]) => ({
        name,
        location: "body" as const,
        required: required && requiredProperties.has(name),
        schema: normalizeSchema(document, value),
        style: undefined,
        explode: undefined,
      })),
      body: { required, mode: "object", mediaType: selected.mediaType },
    },
  }
}

export const operationInput = (
  document: Document,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): Parsed<OperationInput> => {
  const parameters = operationParameters(document, pathItem, operation)
  if (!parameters.ok) return parameters
  const requestBody = operationBody(document, operation)
  if (!requestBody.ok) return requestBody
  const fields = [...parameters.value, ...requestBody.value.fields]

  const conflicts = new Set(
    [...Map.groupBy(fields, (field) => field.name)].filter(([, matches]) => matches.length > 1).map(([name]) => name),
  )
  const used = new Set<string>()
  return {
    ok: true,
    value: {
      fields: fields.map((field) => {
        const base = conflicts.has(field.name) ? `${field.location}_${field.name}` : field.name
        const next = (index: number): string => {
          const candidate = index === 1 ? base : `${base}_${index}`
          return used.has(candidate) ? next(index + 1) : candidate
        }
        const inputName = next(1)
        used.add(inputName)
        return { ...field, inputName }
      }),
      body: requestBody.value.body,
    },
  }
}

export const inputSchema = (
  fields: ReadonlyArray<InputField>,
  definitions: Readonly<Record<string, JsonSchema>>,
): JsonSchema => {
  const required = fields.filter((field) => field.required).map((field) => field.inputName)
  return withDefinitions(
    {
      type: "object",
      properties: Object.fromEntries(fields.map((field) => [field.inputName, field.schema])),
      ...(required.length === 0 ? {} : { required }),
    },
    definitions,
  )
}

const successfulResponses = (
  document: Document,
  operation: Record<string, unknown>,
): Parsed<ReadonlyArray<Record<string, unknown>>> => {
  if (!isRecord(operation.responses)) return { ok: true, value: [] }
  const entries = Object.entries(operation.responses)
  const selected = [
    ...entries.filter(([status]) => /^2\d\d$/.test(status)).sort(([a], [b]) => a.localeCompare(b)),
    ...entries.filter(([status]) => status.toUpperCase() === "2XX"),
  ]
  const responses: Array<Record<string, unknown>> = []
  for (const [, value] of selected) {
    const resolved = resolve(document, value)
    if (!isRecord(resolved) || nonEmptyString(resolved.$ref) !== undefined) {
      return { ok: false, reason: "successful response declaration is invalid or unresolved" }
    }
    responses.push(resolved)
  }
  return { ok: true, value: responses }
}

export const operationOutput = (
  document: Document,
  operation: Record<string, unknown>,
  definitions: Readonly<Record<string, JsonSchema>>,
): Parsed<JsonSchema | undefined> => {
  if (operation["x-websocket"] === true) return { ok: false, reason: "WebSocket operations are not supported" }
  const responses = successfulResponses(document, operation)
  if (!responses.ok) return responses
  const streams = responses.value.some(
    (response) =>
      isRecord(response.content) &&
      Object.keys(response.content).some(
        (mediaType) => mediaType.split(";")[0]?.trim().toLowerCase() === "text/event-stream",
      ),
  )
  if (streams) return { ok: false, reason: "SSE operations are not supported" }
  const binary = responses.value.some(
    (response) =>
      isRecord(response.content) &&
      Object.entries(response.content).some(([mediaType, value]) => isBinaryMediaType(document, mediaType, value)),
  )
  if (binary) return { ok: false, reason: "binary responses are not supported" }

  const outcomes: Array<JsonSchema> = []
  for (const response of responses.value) {
    if (response.content !== undefined && !isRecord(response.content)) return { ok: true, value: undefined }
    const content = isRecord(response.content) ? response.content : {}
    if (Object.keys(content).length === 0) {
      outcomes.push({ type: "null" })
      continue
    }
    for (const [mediaType, value] of Object.entries(content)) {
      if (!isJsonMediaType(mediaType)) {
        outcomes.push({ type: "string" })
        continue
      }
      if (!isRecord(value) || value.schema === undefined) return { ok: true, value: undefined }
      outcomes.push(projectSchema(document, value.schema, "response"))
    }
  }
  if (outcomes.length === 0) return { ok: true, value: undefined }
  return {
    ok: true,
    value: withDefinitions(outcomes.length === 1 ? (outcomes[0] ?? {}) : { anyOf: outcomes }, definitions),
  }
}

const sanitizeOperationSegment = (raw: string): string => {
  return (
    raw
      .replaceAll(/[^A-Za-z0-9_$]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^([0-9])/, "_$1") || "operation"
  )
}

const fallbackOperationId = (method: string, path: string): string =>
  [
    method,
    ...path
      .split("/")
      .filter((part) => part !== "")
      .flatMap((part) => (part.startsWith("{") && part.endsWith("}") ? ["by", part.slice(1, -1)] : [part]))
      .flatMap((part) => part.split(/[^A-Za-z0-9]+/).filter((word) => word !== "")),
  ]
    .map((word, index) => {
      const lower = word.toLowerCase()
      return index === 0 ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`
    })
    .join("")

export const operationPath = (
  method: string,
  path: string,
  operation: Record<string, unknown>,
  used: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const raw = nonEmptyString(operation.operationId)
  const segments = (raw === undefined ? [fallbackOperationId(method, path)] : raw.split(".")).map(
    sanitizeOperationSegment,
  )
  if (isOperationPathAvailable(segments, used, namespaces)) return segments
  const conflict = segments.slice(0, -1).findIndex((_, index) => used.has(segments.slice(0, index + 1).join(".")))
  if (conflict >= 0 && conflict + 1 < segments.length) {
    const collapsed = segments.flatMap((segment, index) => {
      if (index === conflict) {
        const next = segments[index + 1] ?? ""
        return [`${segment}${next.charAt(0).toUpperCase()}${next.slice(1)}`]
      }
      return index === conflict + 1 ? [] : [segment]
    })
    if (isOperationPathAvailable(collapsed, used, namespaces)) return collapsed
  }
  const fallback = segments.join("_")
  const next = (index: number): string => {
    const candidate = `${fallback}_${index}`
    return isOperationPathAvailable([candidate], used, namespaces) ? candidate : next(index + 1)
  }
  return [next(2)]
}

const isOperationPathAvailable = (
  segments: ReadonlyArray<string>,
  used: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): boolean => {
  const key = segments.join(".")
  if (used.has(key) || namespaces.has(key)) return false
  return segments.slice(0, -1).every((_, index) => !used.has(segments.slice(0, index + 1).join(".")))
}

export const specServerUrl = (source: Record<string, unknown>): Parsed<string> => {
  const server = asArray(source.servers).find(isRecord)
  const url = server === undefined ? undefined : nonEmptyString(server.url)
  if (url === undefined) return { ok: false, reason: "spec declares no servers; pass baseUrl" }
  if (/\{[^{}]+\}/.test(url)) {
    return { ok: false, reason: `server URL '${url}' is not an absolute URL; pass baseUrl` }
  }
  return validateBaseUrl(url)
}

export const validateBaseUrl = (value: string): Parsed<string> => {
  if (!/^https?:\/\//i.test(value)) return { ok: false, reason: `server URL '${value}' is not an absolute HTTP(S) URL` }
  const url = URL.parse(value)
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return { ok: false, reason: `server URL '${value}' is not an absolute HTTP(S) URL` }
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, reason: `server URL '${value}' contains an unsupported query string or fragment` }
  }
  return { ok: true, value }
}

export const securityRequirements = (value: unknown): Parsed<ReadonlyArray<SecurityRequirement>> => {
  if (value === undefined) return { ok: true, value: [] }
  if (!Array.isArray(value)) return { ok: false, reason: "security declaration is not an array" }
  const requirements: Array<SecurityRequirement> = []
  for (const item of value) {
    if (!isRecord(item)) return { ok: false, reason: "security requirement is not an object" }
    const requirement = Object.create(null) as Record<string, ReadonlyArray<string>>
    for (const [name, scopes] of Object.entries(item)) {
      if (!Array.isArray(scopes)) return { ok: false, reason: "security requirement scopes are not string arrays" }
      const parsed = scopes.filter((scope): scope is string => typeof scope === "string")
      if (parsed.length !== scopes.length) {
        return { ok: false, reason: "security requirement scopes are not string arrays" }
      }
      requirement[name] = parsed
    }
    requirements.push(requirement)
  }
  return { ok: true, value: requirements }
}

export const operationSecurityRequirements = (
  value: unknown,
  defaults: Parsed<ReadonlyArray<SecurityRequirement>>,
  schemes: Readonly<Record<string, SecurityScheme>>,
): Parsed<ReadonlyArray<SecurityRequirement>> => {
  const parsed = value === undefined ? defaults : securityRequirements(value)
  if (!parsed.ok) return parsed
  const supported = parsed.value.filter((requirement) =>
    Object.keys(requirement).every((name) => {
      const scheme = own(schemes, name)
      return scheme !== undefined && !(scheme.type === "apiKey" && scheme.in === "cookie")
    }),
  )
  if (parsed.value.length === 0 || supported.length > 0) return { ok: true, value: supported }

  const names = [...new Set(parsed.value.flatMap((requirement) => Object.keys(requirement)))]
  const cookieScheme = names.find((name) => {
    const definition = own(schemes, name)
    return definition?.type === "apiKey" && definition.in === "cookie"
  })
  return {
    ok: false,
    reason:
      cookieScheme === undefined
        ? `security requirement references missing or malformed scheme: ${names.join(", ")}`
        : `cookie authentication '${cookieScheme}' is not supported`,
  }
}

export const securitySchemes = (document: Document): Readonly<Record<string, SecurityScheme>> => {
  const components = isRecord(document.components) ? document.components : {}
  const declared = isRecord(components.securitySchemes) ? components.securitySchemes : {}
  return Object.fromEntries(
    Object.entries(declared).flatMap<readonly [string, SecurityScheme]>(([name, value]) => {
      const resolved = resolve(document, value)
      if (!isRecord(resolved)) return []
      const type = nonEmptyString(resolved.type)
      if (type === "apiKey") {
        const carrier = nonEmptyString(resolved.in)
        const parameter = nonEmptyString(resolved.name)
        if (parameter === undefined || (carrier !== "header" && carrier !== "query" && carrier !== "cookie")) return []
        return [[name, { type, name: parameter, in: carrier }] as const]
      }
      if (type === "http") {
        const scheme = nonEmptyString(resolved.scheme)?.toLowerCase()
        return scheme === undefined ? [] : [[name, { type, scheme }] as const]
      }
      if (type === "oauth2" || type === "openIdConnect") return [[name, { type }] as const]
      return []
    }),
  )
}
