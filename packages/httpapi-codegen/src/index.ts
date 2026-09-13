import { isAbsolute, join } from "node:path"
import { Context, Effect, FileSystem, PlatformError, Schema, SchemaAST, SchemaRepresentation } from "effect"
import { HttpMethod, type HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { format } from "prettier"

export type InputField = {
  readonly name: string
  readonly source: "params" | "query" | "headers" | "payload"
}

export type OperationInputField = {
  readonly name: string
  readonly source: InputField["source"] | "wildcard"
}

export type Operation = {
  readonly group: string
  readonly name: string
  readonly input: ReadonlyArray<OperationInputField>
  readonly inputMode: "none" | "optional" | "required"
  readonly success: "value" | "void" | "stream"
  readonly errors: ReadonlyArray<string>
}

export type Output = {
  readonly operations: ReadonlyArray<Operation>
  readonly files: ReadonlyArray<{
    readonly path: string
    readonly content: string
  }>
}

export type Contract = {
  readonly groups: ReadonlyArray<Group>
}

export type EffectTypeReference = {
  readonly schema: Schema.Top
  readonly name: string
  readonly import: string
}

export type EffectOutputType = {
  readonly name: string
  readonly import: string
}

type ResolvedEffectTypeReference = Omit<EffectTypeReference, "schema"> & {
  readonly ast: SchemaAST.AST
  readonly type: string | undefined
}

export class GenerationError extends Schema.TaggedError<GenerationError>()("GenerationError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export type Endpoint = {
  readonly group: string
  readonly sourceGroup: string
  readonly topLevel: boolean
  readonly endpoint: HttpApiEndpoint.Top
  readonly params: Schema.Top | undefined
  readonly query: Schema.Top | undefined
  readonly headers: Schema.Top | undefined
  readonly payloads: ReadonlyArray<Schema.Top>
  readonly operation: Operation
  readonly clientPath: readonly [string, ...Array<string>]
  readonly input: ReadonlyArray<InputField & { readonly optional: boolean }>
  readonly unwrapData: boolean
  readonly errors: ReadonlyArray<{ readonly status: number; readonly schema: Schema.Top }>
  readonly successes: ReadonlyArray<Schema.Top>
  readonly effectPortable: boolean
}

export type Group = {
  readonly identifier: string
  readonly sourceIdentifier: string
  readonly module: string
  readonly endpoints: ReadonlyArray<Endpoint>
}

type Slot = {
  readonly name: string
  readonly schema: Schema.Top
}

type PromiseInputField =
  | (InputField & { readonly optional: boolean })
  | { readonly name: string; readonly source: "wildcard"; readonly optional: false }

const resolveHttpApiStatus = SchemaAST.resolveAt<number>("httpApiStatus")
const resolveHttpApiEncoding = SchemaAST.resolveAt<HttpApiSchema.Encoding>("~httpApiEncoding")
const Manifest = Schema.fromJsonString(Schema.Array(Schema.String))
const manifestName = ".httpapi-codegen.json"

export function compile<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  options?: {
    readonly groupNames?: Readonly<Record<string, string>>
    readonly omitEndpoints?: ReadonlySet<string>
  },
): Contract {
  const endpoints: Array<Endpoint> = []
  const portable = new Map<SchemaAST.AST, boolean>()

  HttpApi.reflect(api, {
    onGroup() {},
    onEndpoint({ endpoint, errors, group, middleware }) {
      if (options?.omitEndpoints?.has(endpoint.identifier)) return
      const groupName = options?.groupNames?.[group.identifier] ?? group.identifier
      const name = `${groupName}.${endpoint.identifier}`
      const required = Array.from(middleware).find((item) => item.requiredForClient)
      if (required !== undefined) {
        throw new GenerationError({ reason: `Client middleware requires adapter: ${required.key}` })
      }

      const successSchemas = Array.from(endpoint.success)
      if (successSchemas.length === 0) successSchemas.push(HttpApiSchema.NoContent)
      if (successSchemas.length > 1) throw new GenerationError({ reason: `Multiple success schemas: ${name}` })

      const params = normalizeTransport(endpoint.params, "params", endpoint, name)
      const query = normalizeTransport(endpoint.query, "query", endpoint, name)
      const headers = normalizeTransport(endpoint.headers, "headers", endpoint, name)
      const sourcePayloads = Array.from(endpoint.payload.values()).flatMap(({ schemas }) => schemas)
      if (sourcePayloads.length > 1) {
        throw new GenerationError({ reason: `Multiple payload schemas: ${name}` })
      }
      const payloads = sourcePayloads.map((schema) => normalizeTransport(schema, "payload", endpoint, name)!)
      const success = normalizeTransport(successSchemas[0], "success", endpoint, name)!
      // Sort by status so output does not churn when middleware changes the declaration order.
      const errorSchemas = Array.from(errors)
        .toSorted(([a], [b]) => a - b)
        .flatMap(([status, schemas]) =>
          schemas.map((schema) => ({ status, ...normalizeTransport(schema, "error", endpoint, name)! })),
        )
      const inputs = [
        ...inputFields(params?.schema, "params", name),
        ...inputFields(query?.schema, "query", name),
        ...inputFields(headers?.schema, "headers", name),
        ...payloads.flatMap((item) => inputFields(item.schema, "payload", name)),
      ]
      const names = new Map<string, InputField["source"]>()
      for (const field of inputs) {
        const existing = names.get(field.name)
        if (existing !== undefined) {
          if (field.source === "payload" && payloads[0] !== undefined && !isFlattenableStruct(payloads[0].schema)) {
            throw new GenerationError({
              reason: `Opaque payload field collision: ${name}.payload conflicts with ${existing}.${field.name}`,
            })
          }
          throw new GenerationError({ reason: `Input field collision: ${field.name}` })
        }
        names.set(field.name, field.source)
      }

      const schemaPaths: Array<readonly [string, Schema.Top]> = [
        ...(params === undefined ? [] : [[`${name}.params`, params.schema] as const]),
        ...(query === undefined ? [] : [[`${name}.query`, query.schema] as const]),
        ...(headers === undefined ? [] : [[`${name}.headers`, headers.schema] as const]),
        ...payloads.map((item) => [`${name}.payload`, item.schema] as const),
        ...responseSchemas(success.schema, `${name}.success`),
        ...errorSchemas.map((item) => [`${name}.error.${item.status}`, item.schema] as const),
      ]
      const effectPortable =
        [params, query, headers, ...payloads, success, ...errorSchemas].every(
          (item) => item?.effectPortable !== false,
        ) && streamEffectPortable(success.schema)
      if (effectPortable) {
        for (const [path, schema] of schemaPaths) assertPortable(schema, path, portable)
      }

      const clientPath = clientEndpointPath(
        group.identifier,
        Context.getOrElse(endpoint.annotations, OpenApi.Identifier, () =>
          group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
        ),
      )
      endpoints.push({
        group: groupName,
        sourceGroup: group.identifier,
        topLevel: group.topLevel,
        endpoint,
        params: params?.schema,
        query: query?.schema,
        headers: headers?.schema,
        payloads: payloads.map((item) => item.schema),
        input: inputs,
        clientPath,
        unwrapData: isDataEnvelope(success.schema),
        successes: [success.schema],
        errors: errorSchemas.map((item) => ({ status: item.status, schema: item.schema })),
        effectPortable,
        operation: {
          group: groupName,
          name: clientPath.join("."),
          input: inputs.map(({ name, source }) => ({ name, source })),
          inputMode: inputs.length === 0 ? "none" : inputs.every((field) => field.optional) ? "optional" : "required",
          success: isStreamSchema(success.schema)
            ? "stream"
            : HttpApiSchema.isNoContent(success.schema.ast)
              ? "void"
              : "value",
          errors: [
            ...new Set([
              ...errorSchemas.flatMap((item) => {
                const identifier = SchemaAST.resolveIdentifier(item.schema.ast)
                return identifier === undefined ? [] : [identifier]
              }),
              "ClientError",
            ]),
          ],
        },
      })
    },
  })

  const modules = new Set(["client", "client-error", "index"])
  const groups = Array.from(
    Map.groupBy(endpoints, (endpoint) => endpoint.group),
    ([identifier, endpoints]) => {
      if (new Set(endpoints.map((endpoint) => endpoint.sourceGroup)).size > 1) {
        throw new GenerationError({ reason: `Client group name collision: ${identifier}` })
      }
      // Module names derive from the group identifier so unrelated groups never rename.
      const sanitized = identifier.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
      const reserved = /^(aux|client|client-error|con|index|nul|prn|com[1-9]|lpt[1-9])$/i.test(sanitized)
      const module = sanitized === "" || reserved ? `group-${sanitized}` : sanitized
      if (modules.has(module.toLowerCase())) {
        throw new GenerationError({ reason: `Client module name collision: ${module}` })
      }
      modules.add(module.toLowerCase())
      return { identifier, sourceIdentifier: endpoints[0].sourceGroup, module, endpoints }
    },
  )
  const publicNames = new Set<string>()
  const groupTypeNames = new Set<string>()
  const endpointTypeNames = new Set<string>()
  const operationKeys = new Set<string>()
  for (const group of groups) {
    if (group.identifier === "__proto__") {
      throw new GenerationError({ reason: "Client group name cannot be __proto__" })
    }
    const groupTypeName = identifierPart(group.identifier)
    if (groupTypeNames.has(groupTypeName)) {
      throw new GenerationError({ reason: `Client group type collision: ${groupTypeName}` })
    }
    groupTypeNames.add(groupTypeName)
    assertUniqueClientPaths(
      group.endpoints.map((endpoint) => endpoint.clientPath),
      (path) => `Client endpoint name collision: ${group.identifier}.${path.join(".")}`,
    )
    const typeNames = new Set<string>()
    for (const endpoint of group.endpoints) {
      const operationKey = clientOperationKey(group, endpoint)
      if (operationKeys.has(operationKey)) {
        throw new GenerationError({ reason: `Client operation key collision: ${operationKey}` })
      }
      operationKeys.add(operationKey)
      const name = endpoint.clientPath.map(identifierPart).join("")
      const endpointTypeName = `${groupTypeName}${name}`
      if (endpointTypeNames.has(endpointTypeName)) {
        throw new GenerationError({ reason: `Client endpoint type collision: ${endpointTypeName}` })
      }
      endpointTypeNames.add(endpointTypeName)
      if (typeNames.has(name)) {
        throw new GenerationError({ reason: `Client endpoint type collision: ${group.identifier}.${name}` })
      }
      typeNames.add(name)
    }
    const paths = group.endpoints[0]?.topLevel
      ? [...new Set(group.endpoints.map((item) => item.clientPath[0]))].map((name) => [name])
      : [[group.identifier]]
    for (const path of paths) {
      const key = path.join("\0")
      for (const existing of publicNames) {
        if (existing === key || existing.startsWith(`${key}\0`) || key.startsWith(`${existing}\0`)) {
          throw new GenerationError({ reason: `Client name collision: ${path.join(".")}` })
        }
      }
      publicNames.add(key)
    }
  }
  return {
    groups,
  }
}

export function emitEffect(contract: Contract): Output {
  const endpoint = contract.groups.flatMap((group) => group.endpoints).find((endpoint) => !endpoint.effectPortable)
  if (endpoint !== undefined) {
    throw new GenerationError({
      reason: `Effect schema requires authoritative import: ${endpoint.group}.${endpoint.endpoint.identifier}`,
    })
  }
  return { operations: operations(contract.groups), files: renderEffectFiles(contract.groups) }
}

export function emitEffectImported(
  contract: Contract,
  options:
    | { readonly module: string; readonly api: string; readonly shapeModule?: string }
    | { readonly module: string; readonly group: string; readonly shapeModule?: string }
    | {
        readonly module: string
        readonly endpoints: Readonly<Record<string, string>>
        readonly shapeModule?: string
      },
): Output {
  return {
    operations: operations(contract.groups),
    files: renderImportedEffectFiles(contract.groups, options),
  }
}

export function emitEffectShape(
  contract: Contract,
  options?: {
    readonly typeReferences?: ReadonlyArray<EffectTypeReference>
    readonly outputTypes?: Readonly<Record<string, EffectOutputType>>
  },
): Output {
  return {
    operations: operations(contract.groups),
    files: [
      {
        path: "api.ts",
        content: renderEffectShape(contract.groups, options?.typeReferences ?? [], options?.outputTypes),
      },
    ],
  }
}

export function emitPromise(
  contract: Contract,
  options?: {
    readonly outputTypes?: Readonly<Record<string, { readonly name: string; readonly import: string }>>
    readonly mutableOutputs?: boolean
  },
): Output {
  const groups = contract.groups
  for (const group of groups) {
    for (const endpoint of group.endpoints) assertPromiseEndpoint(endpoint)
  }
  return {
    operations: promiseOperations(groups),
    files: [
      { path: "types.ts", content: renderPromiseTypes(groups, options?.outputTypes, options?.mutableOutputs ?? false) },
      {
        path: "client-error.ts",
        content: `export type ClientErrorReason = "Transport" | "UnexpectedStatus" | "UnsupportedContentType" | "MalformedResponse" | "SseEventTooLarge"\n\nexport class ClientError extends Error {\n  override readonly name = "ClientError"\n  constructor(readonly reason: ClientErrorReason, options?: ErrorOptions) {\n    super(reason, options)\n  }\n}\n`,
      },
      {
        path: "client.ts",
        content: normalizePromiseClientContent(renderPromiseClient(groups), groups),
      },
      {
        path: "index.ts",
        content:
          'export { ClientError, type ClientErrorReason } from "./client-error.js"\nexport * as OpenCode from "./client.js"\nexport * from "./types.js"\n',
      },
    ],
  }
}

function renderEffectShape(
  groups: ReadonlyArray<Group>,
  typeReferences: ReadonlyArray<EffectTypeReference>,
  outputTypes?: Readonly<Record<string, EffectOutputType>>,
) {
  const references = effectTypeReferences(typeReferences)
  const imports = new Set<string>()
  const externalNames = new Set([
    "AppApi",
    "Effect",
    "Stream",
    ...typeReferences.flatMap((reference) => reference.name.match(/^[A-Za-z_$][A-Za-z0-9_$]*/) ?? []),
    ...Object.values(outputTypes ?? {}).flatMap((output) => output.name.match(/^[A-Za-z_$][A-Za-z0-9_$]*/) ?? []),
  ])
  const generatedNames = groups.flatMap((group) => [
    groupShapeName(group),
    ...group.endpoints.flatMap((endpoint) => [
      ...(endpoint.operation.inputMode === "none" ? [] : [`${endpointTypeName(group, endpoint)}Input`]),
      `${endpointTypeName(group, endpoint)}Output`,
      groupShapeTypeName(group, endpoint),
    ]),
  ])
  const collision = generatedNames.find((name) => externalNames.has(name))
  if (collision !== undefined) {
    throw new GenerationError({ reason: `Generated Effect type collides with imported type: ${collision}` })
  }
  const endpointTypes = groups.map((group) => {
    const endpoints = group.endpoints.map((endpoint) => {
      const prefix = endpointTypeName(group, endpoint)
      const input = endpoint.input
        .map((field) => {
          const schema = effectInputSchema(endpoint, field)
          if (schema === undefined) {
            throw new GenerationError({
              reason: `Missing Effect input schema: ${endpoint.group}.${endpoint.endpoint.identifier}.${field.name}`,
            })
          }
          return `readonly ${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${effectType(schema, references, imports)}`
        })
        .join("; ")
      const inputType = endpoint.operation.inputMode === "none" ? "" : `export type ${prefix}Input = { ${input} }`
      const output = effectOutputSchema(endpoint)
      const override = outputTypes?.[clientOperationKey(group, endpoint)]
      if (override !== undefined) imports.add(override.import)
      const outputType = `export type ${prefix}Output = ${override?.name ?? (output === undefined ? "void" : effectType(output, references, imports))}`
      return [
        endpoint.operation.inputMode === "none" ? "" : inputType,
        outputType,
        `export type ${groupShapeTypeName(group, endpoint)}<E = never> = (${endpoint.operation.inputMode === "none" ? "" : `input${endpoint.operation.inputMode === "optional" ? "?" : ""}: ${prefix}Input`}) => ${endpoint.operation.success === "stream" ? `Stream.Stream<${prefix}Output, E>` : `Effect.Effect<${prefix}Output, E>`}`,
      ]
        .filter(Boolean)
        .join("\n")
    })
    const methods = renderClientTree(
      group.endpoints,
      (endpoint) => `${groupShapeTypeName(group, endpoint)}<E>`,
      (name, value) => `readonly ${JSON.stringify(name)}: ${value}`,
      "\n",
    )
    return `${endpoints.join("\n\n")}\n\nexport interface ${groupShapeName(group)}<E = never> {\n${methods}\n}`
  })
  const clientFields = groups.flatMap((group) =>
    group.endpoints[0]?.topLevel
      ? [
          renderClientTree(
            group.endpoints,
            (endpoint) => `${groupShapeTypeName(group, endpoint)}<E>`,
            (name, value) => `readonly ${JSON.stringify(name)}: ${value}`,
            "\n",
          ),
        ]
      : [`readonly ${JSON.stringify(group.identifier)}: ${groupShapeName(group)}<E>`],
  )
  return `// Generated by @opencode/httpapi-codegen. Do not edit.
import type { Effect, Stream } from "effect"
${[...imports].join("\n")}

${endpointTypes.join("\n\n")}

export interface AppApi<E = never> {
${clientFields.join("\n")}
}
`
}

function effectTypeReferences(input: ReadonlyArray<EffectTypeReference>) {
  const names = new Map<string, ResolvedEffectTypeReference>()
  const asts = new Map<SchemaAST.AST, ResolvedEffectTypeReference>()
  const brands = new Map<string, ResolvedEffectTypeReference>()
  for (const reference of input) {
    const document = SchemaRepresentation.toCodeDocument(
      SchemaRepresentation.toRepresentations([codegenAst(Schema.toType(reference.schema).ast)]),
    )
    const name = document.codes[0]?.Type
    const type =
      name === undefined
        ? undefined
        : (document.references.nonRecursives.find((item) => item.$ref === name)?.code.Type ?? name)
    const value = { name: reference.name, import: reference.import, ast: reference.schema.ast, type }
    if (type?.includes("Brand.Brand<") && !brands.has(type)) brands.set(type, value)
    if (SchemaAST.resolveIdentifier(reference.schema.ast) !== undefined || type?.includes("Brand.Brand<")) {
      asts.set(reference.schema.ast, value)
      asts.set(Schema.toType(reference.schema).ast, value)
    }
    if (name === undefined || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue
    const previous = names.get(name)
    if (previous !== undefined) {
      if (previous.ast !== reference.schema.ast) {
        throw new GenerationError({ reason: `Conflicting Effect type reference: ${name}` })
      }
      continue
    }
    names.set(name, value)
  }
  return { names, asts, brands }
}

function effectType(schema: Schema.Top, references: ReturnType<typeof effectTypeReferences>, imports: Set<string>) {
  const projected = Schema.toType(schema)
  const direct = references.asts.get(schema.ast) ?? references.asts.get(projected.ast)
  if (direct !== undefined) {
    imports.add(direct.import)
    return direct.name
  }
  const document = SchemaRepresentation.toCodeDocument(
    SchemaRepresentation.toRepresentations([codegenAst(projected.ast)]),
  )
  const source = new Map(document.references.nonRecursives.map((reference) => [reference.$ref, reference.code.Type]))
  const expand = (type: string, seen = new Set<string>()): string => {
    for (const [name, value] of source) {
      const pattern = new RegExp(
        `(?<![A-Za-z0-9_$.'\"])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$.'\"])`,
        "g",
      )
      if (!pattern.test(type)) continue
      // Optional/encoded occurrences can acquire a numeric suffix. Reuse the named
      // type only when its definition matches; a suffix can also denote a different shape.
      const candidate = references.names.get(name.replace(/_\d+$/, ""))
      const reference = references.names.get(name) ?? (candidate?.type === value ? candidate : undefined)
      if (reference !== undefined) {
        imports.add(reference.import)
        type = type.replace(pattern, reference.name)
        continue
      }
      if (seen.has(name)) continue
      type = type.replace(pattern, `(${expand(value, new Set([...seen, name]))})`)
    }
    return type
  }
  let type = expand(document.codes[0].Type)
  for (const [brand, reference] of references.brands) {
    if (!type.includes(brand)) continue
    imports.add(reference.import)
    type = type.replaceAll(brand, reference.name)
  }
  if (type.includes("Brand.Brand<")) imports.add('import type { Brand } from "effect"')
  if (type.includes("DateTime.")) imports.add('import type { DateTime } from "effect"')
  if (type.includes("Schema.")) imports.add('import type { Schema } from "effect"')
  return type
}

function effectInputSchema(endpoint: Endpoint, field: InputField): Schema.Top | undefined {
  const schema =
    field.source === "params"
      ? endpoint.params
      : field.source === "query"
        ? endpoint.query
        : field.source === "headers"
          ? endpoint.headers
          : endpoint.payloads[0]
  if (schema === undefined) return undefined
  if (isOpaquePayload(endpoint) && field.source === "payload") return schema
  const ast = Schema.toType(schema).ast
  if (!SchemaAST.isObjects(ast)) return undefined
  const property = ast.propertySignatures.find((property) => property.name === field.name)
  return property === undefined ? undefined : Schema.make<Schema.Top>(property.type)
}

function effectOutputSchema(endpoint: Endpoint): Schema.Top | undefined {
  const schema = endpoint.successes[0]
  if (HttpApiSchema.isNoContent(schema.ast)) return undefined
  if (isStreamSchema(schema)) {
    if (schema._tag === "StreamUint8Array") return Schema.Uint8Array
    return schema.sseMode === "data" ? streamDataSchema(schema) : Schema.make<Schema.Top>(schema.events.ast)
  }
  if (!endpoint.unwrapData) return schema
  const ast = Schema.toType(schema).ast
  if (!SchemaAST.isObjects(ast)) return undefined
  const data = ast.propertySignatures.find((property) => property.name === "data")
  return data === undefined ? undefined : Schema.make<Schema.Top>(data.type)
}

function groupShapeName(group: Group) {
  return `${identifierPart(group.identifier)}Api`
}

// Generated symbol names derive from group and endpoint identity, never from traversal
// position, so adding an endpoint or group cannot rename unrelated generated code.
// Uniqueness is validated by compile (groupTypeNames/endpointTypeNames).
function groupTypeName(group: Group) {
  return identifierPart(group.identifier)
}

function endpointTypeName(group: Group, endpoint: Endpoint) {
  return `${groupTypeName(group)}${endpoint.clientPath.map(identifierPart).join("")}`
}

function endpointAdapterName(group: Group, endpoint: Endpoint) {
  return `Endpoint${endpointTypeName(group, endpoint)}`
}

function groupShapeTypeName(group: Group, endpoint: Endpoint) {
  return `${endpointTypeName(group, endpoint)}Operation`
}

function assertPromiseEndpoint(endpoint: Endpoint) {
  const name = `${endpoint.group}.${endpoint.endpoint.identifier}`
  const payload = endpoint.payloads[0]
  const payloadEncoding = payload === undefined ? undefined : resolveHttpApiEncoding(payload.ast)
  if (
    payload !== undefined &&
    (payloadEncoding?._tag ?? (HttpMethod.hasBody(endpoint.endpoint.method) ? "Json" : "FormUrlEncoded")) !== "Json"
  ) {
    throw new GenerationError({ reason: `Unsupported Promise payload encoding: ${name}` })
  }
  const success = endpoint.successes[0]
  if (isStreamSchema(success)) {
    if (
      success._tag !== "StreamSse" ||
      success.sseMode !== "data" ||
      !SchemaAST.isNever(Schema.toType(success.error).ast)
    ) {
      throw new GenerationError({ reason: `Unsupported Promise stream: ${name}` })
    }
  } else if (!HttpApiSchema.isNoContent(success.ast)) {
    const encoding = resolveHttpApiEncoding(success.ast)?._tag ?? "Json"
    if (encoding !== "Json" && encoding !== "Uint8Array") {
      throw new GenerationError({ reason: `Unsupported Promise success encoding: ${name}` })
    }
  }
  for (const error of endpoint.errors) {
    if (declaredErrorFields(error.schema) === undefined) {
      throw new GenerationError({ reason: `Promise error must have a literal discriminator: ${name}` })
    }
    if ((resolveHttpApiEncoding(error.schema.ast)?._tag ?? "Json") !== "Json") {
      throw new GenerationError({ reason: `Unsupported Promise error encoding: ${name}` })
    }
  }
}

function operations(groups: ReadonlyArray<Group>) {
  return groups.flatMap((group) => group.endpoints.map((endpoint) => endpoint.operation))
}

function promiseOperations(groups: ReadonlyArray<Group>) {
  return groups.flatMap((group) =>
    group.endpoints.map((endpoint) => ({
      ...endpoint.operation,
      input: promiseInput(endpoint).map(({ name, source }) => ({ name, source })),
      inputMode: promiseInputMode(endpoint),
    })),
  )
}

function renderEffectFiles(groups: ReadonlyArray<Group>): Output["files"] {
  return [
    ...groups.map((group) => ({ path: `${group.module}.ts`, content: renderGroup(group) })),
    {
      path: "client-error.ts",
      content:
        'import { Schema } from "effect"\n\nexport class ClientError extends Schema.TaggedError<ClientError>()("ClientError", {\n  cause: Schema.Defect(),\n}) {}\n',
    },
    { path: "client.ts", content: renderClient(groups) },
    {
      path: "index.ts",
      content: 'export { ClientError } from "./client-error.js"\nexport * as OpenCode from "./client.js"\n',
    },
  ]
}

function renderImportedEffectFiles(
  groups: ReadonlyArray<Group>,
  options:
    | { readonly module: string; readonly api: string; readonly shapeModule?: string }
    | { readonly module: string; readonly group: string; readonly shapeModule?: string }
    | {
        readonly module: string
        readonly endpoints: Readonly<Record<string, string>>
        readonly shapeModule?: string
      },
): Output["files"] {
  const adapters = groups.map((group) => {
    const rawGroup = group.endpoints[0]?.topLevel ? "RawClient" : `RawClient[${JSON.stringify(group.sourceIdentifier)}]`
    const methods = group.endpoints.map((item) => {
      const prefix = endpointTypeName(group, item)
      const adapter = endpointAdapterName(group, item)
      const schemaBySource = {
        params: item.params,
        query: item.query,
        headers: item.headers,
        payload: item.payloads[0],
      }
      const request = (["params", "query", "headers", "payload"] as const)
        .map((source) =>
          renderEffectRequestPart(
            item.input,
            item.operation.inputMode,
            source,
            isOpaquePayload(item),
            schemaBySource[source] !== undefined,
          ),
        )
        .filter((part): part is string => part !== undefined)
        .join(", ")
      const input = item.input
        .map(
          (field) =>
            `readonly ${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${prefix}Request[${JSON.stringify(field.source)}]${isOpaquePayload(item) && field.source === "payload" ? "" : `[${JSON.stringify(field.name)}]`}`,
        )
        .join("; ")
      const argument =
        item.operation.inputMode === "none"
          ? ""
          : `input${item.operation.inputMode === "optional" ? "?" : ""}: ${prefix}Input`
      // HttpApiClient distributes union payloads into union request objects, while rebuilding a flattened input
      // produces one object containing a union value. The shapes are equivalent but TypeScript cannot correlate them.
      const rawCall = `raw[${JSON.stringify(item.endpoint.identifier)}]({ ${request} }${isOpaquePayload(item) ? ` as ${prefix}Request` : ""})`
      const mapped = `${rawCall}.pipe(Effect.mapError(mapClientError)${item.unwrapData ? ", Effect.map((value) => value.data)" : ""})`
      const result =
        item.operation.success === "stream"
          ? `Stream.unwrap(${rawCall}.pipe(Effect.mapError(mapClientError), Effect.map((stream) => stream.pipe(Stream.mapError(mapClientError)))))`
          : mapped
      const output =
        options.shapeModule === undefined
          ? result
          : `${item.operation.success === "stream" ? "preserveStream" : "preserveEffect"}<${prefix}Output>()(${result})`
      const declarations =
        options.shapeModule === undefined && item.operation.inputMode !== "none"
          ? `type ${prefix}Request = Parameters<${rawGroup}[${JSON.stringify(item.endpoint.identifier)}]>[0]\ntype ${prefix}Input = { ${input} }\n`
          : isOpaquePayload(item)
            ? `type ${prefix}Request = Parameters<${rawGroup}[${JSON.stringify(item.endpoint.identifier)}]>[0]\n`
            : ""
      return `${declarations}const ${adapter} = (raw: ${rawGroup}) => (${argument}) => ${output}`
    })
    const fields = renderClientTree(
      group.endpoints,
      (item) => `${endpointAdapterName(group, item)}(raw)`,
      (name, value) => `${JSON.stringify(name)}: ${value}`,
      ", ",
    )
    return `${methods.join("\n\n")}\n\nconst adaptGroup${groupTypeName(group)} = (raw: ${rawGroup}) => ({ ${fields} })`
  })
  const fields = groups.flatMap((group) =>
    group.endpoints[0]?.topLevel
      ? [`...adaptGroup${groupTypeName(group)}(raw)`]
      : [
          `${JSON.stringify(group.identifier)}: adaptGroup${groupTypeName(group)}(raw[${JSON.stringify(group.sourceIdentifier)}])`,
        ],
  )
  const usesStream = groups.some((group) => group.endpoints.some((item) => item.operation.success === "stream"))
  const imported = "api" in options
  const projection = imported
    ? undefined
    : "group" in options
      ? renderImportedGroup(options.group)
      : renderImportedProjection(groups, options.endpoints)
  const api = imported ? options.api : "Api"
  const adapterNames = new Set(
    groups.flatMap((group) => group.endpoints.map((endpoint) => endpointAdapterName(group, endpoint))),
  )
  const adapterCollision = (projection?.imports ?? [api]).find((name) => adapterNames.has(name))
  if (adapterCollision !== undefined) {
    throw new GenerationError({
      reason: `Generated Effect adapter collides with imported endpoint: ${adapterCollision}`,
    })
  }
  const imports =
    projection === undefined
      ? `import { ${api} } from ${JSON.stringify(options.module)}`
      : `import { HttpApi, HttpApiClient${"endpoints" in options ? ", HttpApiGroup" : ""} } from "effect/unstable/httpapi"\nimport { ${projection.imports.join(", ")} } from ${JSON.stringify(options.module)}`
  const httpApiImport = projection === undefined ? 'import { HttpApiClient } from "effect/unstable/httpapi"\n' : ""
  const shapeTypes = groups.flatMap((group) =>
    group.endpoints.flatMap((endpoint) => [
      ...(endpoint.operation.inputMode === "none" ? [] : [`${endpointTypeName(group, endpoint)}Input`]),
      `${endpointTypeName(group, endpoint)}Output`,
    ]),
  )
  const shapeImport =
    options.shapeModule === undefined
      ? ""
      : `import type { ${shapeTypes.join(", ")} } from ${JSON.stringify(options.shapeModule)}\n`
  const preserve =
    options.shapeModule === undefined
      ? ""
      : `const preserveEffect = <A>() => <E, R>(effect: Effect.Effect<A, E, R>) => effect\n${usesStream ? "const preserveStream = <A>() => <E, R>(stream: Stream.Stream<A, E, R>) => stream\n" : ""}\n`
  const client = `// Generated by @opencode/httpapi-codegen. Do not edit.\nimport { Effect${usesStream ? ", Stream" : ""}, Schema } from "effect"\nimport { Sse } from "effect/unstable/encoding"\nimport { HttpClientError } from "effect/unstable/http"\n${httpApiImport}${imports}\n${shapeImport}import { ClientError } from "./client-error.js"\n\n${projection?.source ?? ""}type RawClient = HttpApiClient.ForApi<typeof ${api}>\n\nconst mapClientError = <E>(error: E) => HttpClientError.isHttpClientError(error) || Schema.isSchemaError(error) || Sse.Retry.is(error) ? new ClientError({ cause: error }) : error\n\n${preserve}${adapters.join("\n\n")}\n\nconst adaptClient = (raw: RawClient) => ({ ${fields.join(", ")} })\n\nexport const make = (options?: { readonly baseUrl?: URL | string }) => HttpApiClient.make(${api}, options).pipe(Effect.map(adaptClient))\n`
  return [
    {
      path: "client-error.ts",
      content:
        'import { Schema } from "effect"\n\nexport class ClientError extends Schema.TaggedError<ClientError>()("ClientError", {\n  cause: Schema.Defect(),\n}) {}\n',
    },
    { path: "client.ts", content: client },
    {
      path: "index.ts",
      content: 'export { ClientError } from "./client-error.js"\nexport * as OpenCode from "./client.js"\n',
    },
  ]
}

function renderImportedGroup(group: string) {
  return {
    imports: [group],
    source: `const Api = HttpApi.make("generated").add(${group})\n\n`,
  }
}

function renderImportedProjection(groups: ReadonlyArray<Group>, endpoints: Readonly<Record<string, string>>) {
  const imports = groups.flatMap((group) =>
    group.endpoints.map((endpoint) => {
      const name = endpoints[`${group.identifier}.${endpoint.endpoint.identifier}`]
      if (name === undefined) {
        throw new GenerationError({
          reason: `Missing imported endpoint: ${group.identifier}.${endpoint.endpoint.identifier}`,
        })
      }
      return name
    }),
  )
  const source = `const Api = HttpApi.make("generated").${groups
    .map((group) => {
      const options = group.endpoints[0]?.topLevel ? ", { topLevel: true }" : ""
      return `add(HttpApiGroup.make(${JSON.stringify(group.identifier)}${options})${group.endpoints.map((endpoint) => `.add(${endpoints[`${group.identifier}.${endpoint.endpoint.identifier}`]})`).join("")})`
    })
    .join(".")}\n\n`
  return { imports: [...new Set(imports)], source }
}

function renderPromiseTypes(
  groups: ReadonlyArray<Group>,
  outputTypes?: Readonly<Record<string, { readonly name: string; readonly import: string }>>,
  mutableOutputs = false,
) {
  const types = new Map<SchemaAST.AST, string>()
  const typeOf = (schema: Schema.Top, decoded = false) => {
    const projected = decoded ? Schema.toType(schema) : Schema.toEncoded(schema)
    const cached = types.get(projected.ast)
    if (cached !== undefined) return cached
    const type = structuralType(projected)
    types.set(projected.ast, type)
    return type
  }
  const outputMarkers = new Map<SchemaAST.AST, string>()
  const outputSchemas: Array<Schema.Top> = []
  const outputTypeOf = (schema: Schema.Top) => {
    const projected = Schema.toEncoded(schema)
    const cached = outputMarkers.get(projected.ast)
    if (cached !== undefined) return cached
    const marker = `__PROMISE_TYPE_${outputSchemas.length}__`
    outputSchemas.push(projected)
    outputMarkers.set(projected.ast, marker)
    return marker
  }
  const errors = new Map(
    groups.flatMap((group) =>
      group.endpoints.flatMap((endpoint) =>
        endpoint.errors.flatMap((error) => {
          const tagged = declaredErrorFields(error.schema)
          return tagged === undefined ? [] : [[tagged.tag, tagged] as const]
        }),
      ),
    ),
  )
  const errorTypes = Array.from(errors.values()).map((error) => {
    const fields = error.fields
      .map(([name, schema, optional]) => `readonly ${JSON.stringify(name)}${optional ? "?" : ""}: ${typeOf(schema)}`)
      .join("; ")
    return `export type ${error.identifier} = { readonly ${JSON.stringify(error.key)}: ${JSON.stringify(error.tag)}; ${fields} }\nexport const is${error.identifier} = (value: unknown): value is ${error.identifier} => typeof value === "object" && value !== null && ${JSON.stringify(error.key)} in value && value[${JSON.stringify(error.key)}] === ${JSON.stringify(error.tag)}`
  })
  const operations = groups
    .flatMap((group) =>
      group.endpoints.flatMap((endpoint) => {
        const prefix = promiseTypePrefix(group.identifier, endpoint.clientPath)
        const schemas = {
          params: endpoint.params,
          query: endpoint.query,
          headers: endpoint.headers,
          payload: endpoint.payloads[0],
        }
        const input = promiseInput(endpoint)
          .map((field) => {
            if (field.source === "wildcard") return `readonly ${JSON.stringify(field.name)}: string`
            const schema = schemas[field.source]
            if (schema === undefined)
              throw new GenerationError({ reason: `Missing input schema: ${prefix}.${field.name}` })
            return `readonly ${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${isOpaquePayload(endpoint) && field.source === "payload" ? typeOf(schema) : `(${typeOf(schema, field.source === "query")})[${JSON.stringify(field.name)}]`}`
          })
          .join("; ")
        const successSchema = endpoint.successes[0]
        const success =
          outputTypes?.[clientOperationKey(group, endpoint)]?.name ??
          outputTypeOf(
            isStreamSchema(successSchema) && successSchema._tag === "StreamSse"
              ? successSchema.sseMode === "data"
                ? streamEncodedDataSchema(successSchema)
                : Schema.make<Schema.Top>(successSchema.events.ast)
              : successSchema,
          )
        return [
          ...(promiseInputMode(endpoint) === "none" ? [] : [`export type ${prefix}Input = { ${input} }`]),
          `export type ${prefix}Output = ${endpoint.unwrapData ? `(${success})["data"]` : success}`,
        ]
      }),
    )
    .join("\n\n")
  const reservedNames = new Set([
    "ClientError",
    "JsonValue",
    ...errors.keys(),
    ...groups.flatMap((group) =>
      group.endpoints.flatMap((endpoint) => {
        const prefix = promiseTypePrefix(group.identifier, endpoint.clientPath)
        return [`${prefix}Input`, `${prefix}Output`]
      }),
    ),
    ...Object.values(outputTypes ?? {}).map((output) => output.name),
  ])
  const rendered = structuralTypes(outputSchemas, mutableOutputs, reservedNames)
  const resolve = (source: string) =>
    rendered.types.reduce((result, type, index) => result.replaceAll(`__PROMISE_TYPE_${index}__`, type), source)
  const resolvedErrors = errorTypes.map(resolve)
  const resolvedOperations = resolve(operations)
  const json = [...rendered.definitions, ...resolvedErrors, resolvedOperations].some((type) =>
    type.includes("JsonValue"),
  )
    ? `export type JsonValue = null | boolean | number | string | ${mutableOutputs ? "Array<JsonValue> | { [key: string]: JsonValue }" : "ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue }"}`
    : ""
  const imports = [...new Set(Object.values(outputTypes ?? {}).map((override) => override.import))]
  return [...imports, json, ...rendered.definitions, ...resolvedErrors, resolvedOperations].filter(Boolean).join("\n\n")
}

function mutableType(type: string) {
  return type.replaceAll("ReadonlyArray<", "Array<").replaceAll(/\breadonly\s+/g, "")
}

function renderPromiseClient(groups: ReadonlyArray<Group>) {
  const imports = groups.flatMap((group) =>
    group.endpoints.flatMap((endpoint) => {
      const prefix = promiseTypePrefix(group.identifier, endpoint.clientPath)
      return [...(promiseInputMode(endpoint) === "none" ? [] : [`${prefix}Input`]), `${prefix}Output`]
    }),
  )
  const fields = groups.map((group) => {
    const methods = group.endpoints.map((endpoint) => {
      const prefix = promiseTypePrefix(group.identifier, endpoint.clientPath)
      const inputMode = promiseInputMode(endpoint)
      const argument =
        inputMode === "none"
          ? "requestOptions?: RequestOptions"
          : `input${inputMode === "optional" ? "?" : ""}: ${prefix}Input, requestOptions?: RequestOptions`
      const path = promisePath(endpoint.endpoint.path, endpoint.input, promiseWildcardInput(endpoint))
      const access = (name: string) => `input${inputMode === "optional" ? "?." : ""}[${JSON.stringify(name)}]`
      const part = (source: InputField["source"]) => {
        const inputs = endpoint.input.filter((field) => field.source === source)
        return inputs.length === 0
          ? source === "payload" && endpoint.payloads.length > 0
            ? "{ }"
            : undefined
          : isOpaquePayload(endpoint) && source === "payload"
            ? access(inputs[0].name)
            : `{ ${inputs.map((field) => `${JSON.stringify(field.name)}: ${access(field.name)}`).join(", ")} }`
      }
      const parts = [
        endpoint.query === undefined ? undefined : `query: ${part("query")}`,
        endpoint.headers === undefined ? undefined : `headers: ${part("headers")}`,
        endpoint.payloads.length === 0 ? undefined : `body: ${part("payload")}`,
      ].filter((value): value is string => value !== undefined)
      const declaredStatuses = [...new Set(endpoint.errors.map((error) => error.status))]
      const descriptor = `{ method: ${JSON.stringify(endpoint.endpoint.method)}, path: ${path}${parts.length === 0 ? "" : `, ${parts.join(", ")}`}, successStatus: ${resolveHttpApiStatus(endpoint.successes[0].ast) ?? 200}, declaredStatuses: [${declaredStatuses.join(", ")}], empty: ${endpoint.operation.success === "void"}${isBinarySchema(endpoint.successes[0]) ? ", binary: true" : ""} }`
      if (endpoint.operation.success === "stream") {
        const success = endpoint.successes[0]
        if (!isStreamSchema(success) || success._tag !== "StreamSse" || success.sseMode !== "data") {
          throw new GenerationError({
            reason: `Promise stream emission is not implemented: ${group.identifier}.${endpoint.endpoint.identifier}`,
          })
        }
        return `(${argument}): AsyncIterable<${prefix}Output> => sse<${prefix}Output>(${descriptor}, requestOptions)`
      }
      const unwrap = endpoint.unwrapData ? ".then((value) => value.data)" : ""
      return `(${argument}) => request<${endpoint.unwrapData ? `{ readonly data: ${prefix}Output }` : `${prefix}Output`}>(${descriptor}, requestOptions)${unwrap}`
    })
    const fields = renderClientTree(
      group.endpoints,
      (_endpoint, endpointIndex) => methods[endpointIndex],
      (name, value) => `${JSON.stringify(name)}: ${value}`,
      ", ",
    )
    if (group.endpoints[0]?.topLevel) return fields
    return `${JSON.stringify(group.identifier)}: { ${fields} }`
  })
  return `import type { ${imports.join(", ")} } from "./types.js"\nimport { ClientError } from "./client-error.js"\n\nexport interface ClientOptions {\n  readonly baseUrl: string\n  readonly fetch?: typeof globalThis.fetch\n  readonly headers?: RequestInit["headers"]\n}\n\nexport interface RequestOptions {\n  readonly signal?: AbortSignal\n  readonly headers?: RequestInit["headers"]\n  /** Reports every chunk a streaming response receives, including keepalive comments that yield no event. */\n  readonly onActivity?: () => void\n}\n\ninterface RequestDescriptor {\n  readonly method: string\n  readonly path: string\n  readonly query?: Record<string, unknown>\n  readonly headers?: Record<string, unknown>\n  readonly body?: unknown\n  readonly successStatus: number\n  readonly declaredStatuses: ReadonlyArray<number>\n  readonly empty: boolean\n}\n\nconst maxSseEventBytes = 16 * 1024 * 1024\n\nexport function make(options: ClientOptions) {\n  const fetch = options.fetch ?? globalThis.fetch\n\n  const prepare = (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {\n    const url = new URL(descriptor.path, options.baseUrl)\n    for (const [key, value] of Object.entries(descriptor.query ?? {})) appendQuery(url.searchParams, key, value)\n    const headers = new Headers(options.headers)\n    for (const [key, value] of Object.entries(descriptor.headers ?? {})) {\n      if (value !== undefined && value !== null) headers.set(key, String(value))\n    }\n    for (const [key, value] of new Headers(requestOptions?.headers)) headers.set(key, value)\n    if (descriptor.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")\n    return {\n      url,\n      init: {\n        method: descriptor.method,\n        signal: requestOptions?.signal,\n        headers,\n        body: descriptor.body === undefined ? undefined : JSON.stringify(descriptor.body),\n      } satisfies RequestInit,\n    }\n  }\n\n  const execute = async (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {\n    try {\n      const prepared = prepare(descriptor, requestOptions)\n      return await fetch(prepared.url, prepared.init)\n    } catch (cause) {\n      throw new ClientError("Transport", { cause })\n    }\n  }\n\n  const responseError = async (response: Response, descriptor: RequestDescriptor): Promise<never> => {\n    if (descriptor.declaredStatuses.includes(response.status)) throw await json(response)\n    try {\n      await response.body?.cancel()\n    } catch {}\n    throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })\n  }\n\n  const request = async <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): Promise<A> => {\n    const response = await execute(descriptor, requestOptions)\n    if (response.status !== descriptor.successStatus) return responseError(response, descriptor)\n    if (descriptor.empty) {\n      try {\n        await response.body?.cancel()\n      } catch {}\n      return undefined as A\n    }\n    return await json(response) as A\n  }\n\n  const sse = <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): AsyncIterable<A> => ({\n    async *[Symbol.asyncIterator]() {\n      const response = await execute(descriptor, requestOptions)\n      if (response.status !== descriptor.successStatus) await responseError(response, descriptor)\n      if (!isContentType(response, "text/event-stream")) {\n        try {\n          await response.body?.cancel()\n        } catch {}\n        throw new ClientError("UnsupportedContentType")\n      }\n      if (response.body === null) throw new ClientError("MalformedResponse")\n      const reader = response.body.getReader()\n      const decoder = new TextDecoder()\n      let buffer = ""\n      try {\n        while (true) {\n          let next: ReadableStreamReadResult<Uint8Array>\n          try {\n            next = await reader.read()\n          } catch (cause) {\n            throw new ClientError("Transport", { cause })\n          }\n          if (!next.done) requestOptions?.onActivity?.()\n          buffer += decoder.decode(next.value, { stream: !next.done })\n          if (buffer.length > maxSseEventBytes) throw new ClientError("SseEventTooLarge")\n          const trailingCarriageReturn = !next.done && buffer.endsWith("\\r")\n          if (trailingCarriageReturn) buffer = buffer.slice(0, -1)\n          buffer = buffer.replaceAll("\\r\\n", "\\n").replaceAll("\\r", "\\n")\n          if (trailingCarriageReturn) buffer += "\\r"\n          if (next.done && buffer !== "") buffer += "\\n\\n"\n          let boundary = buffer.indexOf("\\n\\n")\n          while (boundary >= 0) {\n            const block = buffer.slice(0, boundary)\n            buffer = buffer.slice(boundary + 2)\n            const data = block.split("\\n").flatMap((line) => line.startsWith("data:") ? [line.slice(5).trimStart()] : []).join("\\n")\n            if (data !== "") {\n              try {\n                yield JSON.parse(data) as A\n              } catch (cause) {\n                throw new ClientError("MalformedResponse", { cause })\n              }\n            }\n            boundary = buffer.indexOf("\\n\\n")\n          }\n          if (next.done) return\n        }\n      } finally {\n        try {\n          await reader.cancel()\n        } catch {}\n        reader.releaseLock()\n      }\n    },\n  })\n\n  return { ${fields.join(", ")} }\n}\n\nfunction appendQuery(params: URLSearchParams, key: string, value: unknown): void {\n  if (value === undefined) return\n  if (value === null) {\n    params.append(key, "null")\n    return\n  }\n  if (Array.isArray(value)) {\n    for (const item of value) appendQuery(params, key, item)\n    return\n  }\n  if (typeof value === "object") {\n    for (const [child, item] of Object.entries(value)) appendQuery(params, \`\${key}[\${child}]\`, item)\n    return\n  }\n  params.append(key, String(value))\n}\n\nasync function json(response: Response): Promise<unknown> {\n  if (!isContentType(response, "application/json") && !response.headers.get("content-type")?.includes("+json")) {\n    try {\n      await response.body?.cancel()\n    } catch {}\n    throw new ClientError("UnsupportedContentType")\n  }\n  let text: string\n  try {\n    text = await response.text()\n  } catch (cause) {\n    throw new ClientError("Transport", { cause })\n  }\n  if (text === "") throw new ClientError("MalformedResponse")\n  try {\n    return JSON.parse(text)\n  } catch (cause) {\n    throw new ClientError("MalformedResponse", { cause })\n  }\n}\n\nfunction isContentType(response: Response, expected: string) {\n  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected\n}\n`
}

function promiseTypePrefix(group: string, path: ReadonlyArray<string>) {
  return `${identifierPart(group)}${path.map(identifierPart).join("")}`
}

function clientOperationKey(group: Group, endpoint: Endpoint) {
  return [group.identifier, ...endpoint.clientPath].join(".")
}

function clientEndpointPath(group: string, name: string) {
  const parts = name.split(".")
  if (parts[0] === "v2") parts.shift()
  const index = parts.lastIndexOf(group.slice(group.lastIndexOf(".") + 1))
  const result = index < 0 ? parts : parts.slice(index + 1)
  if (result.length === 0 || result.some((part) => part.length === 0)) {
    throw new GenerationError({ reason: "Client endpoint path must contain non-empty names" })
  }
  if (result.some((part) => part === "__proto__")) {
    throw new GenerationError({ reason: "Client endpoint path cannot contain __proto__" })
  }
  return result as [string, ...Array<string>]
}

function assertUniqueClientPaths(
  paths: ReadonlyArray<ReadonlyArray<string>>,
  reason: (path: ReadonlyArray<string>) => string,
) {
  const seen = new Set<string>()
  for (const path of paths) {
    const key = path.join("\0")
    for (const existing of seen) {
      if (existing === key || existing.startsWith(`${key}\0`) || key.startsWith(`${existing}\0`)) {
        throw new GenerationError({ reason: reason(path) })
      }
    }
    seen.add(key)
  }
}

function renderClientTree(
  endpoints: ReadonlyArray<Endpoint>,
  leaf: (endpoint: Endpoint, index: number) => string,
  field: (name: string, value: string) => string,
  separator: string,
) {
  type Node = { endpoint?: { readonly value: Endpoint; readonly index: number }; readonly children: Map<string, Node> }
  const root: Node = { children: new Map() }
  endpoints.forEach((endpoint, index) => {
    const node = endpoint.clientPath.reduce((parent, name) => {
      const child: Node = parent.children.get(name) ?? { children: new Map() }
      parent.children.set(name, child)
      return child
    }, root)
    node.endpoint = { value: endpoint, index }
  })
  const render = (node: Node): string =>
    Array.from(node.children, ([name, child]) =>
      field(
        name,
        child.endpoint === undefined ? `{ ${render(child)} }` : leaf(child.endpoint.value, child.endpoint.index),
      ),
    ).join(separator)
  return render(root)
}

function identifierPart(value: string) {
  const identifier = value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("")
  return /^[A-Za-z_$]/.test(identifier) ? identifier : `_${identifier}`
}

function structuralTypes(schemas: ReadonlyArray<Schema.Top>, mutable: boolean, reservedNames: ReadonlySet<string>) {
  if (schemas.length === 0) return { types: [], definitions: [] }
  const representations = SchemaRepresentation.toRepresentations(
    promiseTypeAsts(schemas) as [SchemaAST.AST, ...Array<SchemaAST.AST>],
  )
  const document = SchemaRepresentation.toCodeDocument(representations)
  if (
    document.artifacts.some(
      (artifact) =>
        artifact._tag !== "Import" || artifact.importDeclaration !== 'import type * as Brand from "effect/Brand"',
    ) ||
    Object.keys(document.references.recursives).length > 0
  ) {
    throw new GenerationError({ reason: "Referenced Promise types are not implemented" })
  }
  const anonymous = new Set(
    Object.entries(representations.references)
      .filter(([, reference]) => {
        if (!("annotations" in reference) || reference.annotations === undefined) return true
        return reference.annotations.identifier === undefined && reference.annotations["~identifier"] === undefined
      })
      .map(([name]) => name),
  )
  const anonymousTypes = new Map(
    document.references.nonRecursives
      .filter((reference) => anonymous.has(reference.$ref))
      .map((reference) => [reference.$ref, reference.code.Type]),
  )
  const inlineAnonymous = (type: string, seen = new Set<string>()): string => {
    for (const [reference, value] of anonymousTypes) {
      const pattern = `(?<![A-Za-z0-9_$.'"])${reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$.'"])`
      if (!new RegExp(pattern).test(type)) continue
      if (seen.has(reference)) {
        throw new GenerationError({ reason: `Recursive Promise types are not implemented: ${reference}` })
      }
      type = type.replaceAll(new RegExp(pattern, "g"), `(${inlineAnonymous(value, new Set([...seen, reference]))})`)
    }
    return type
  }
  const names = new Map<string, string>()
  const usedNames = new Set(reservedNames)
  const references = document.references.nonRecursives.filter((reference) => !anonymous.has(reference.$ref))
  const referenceNames = new Set(references.map((reference) => reference.$ref))
  for (const reference of references) {
    const seed = identifierPart(reference.$ref)
    const name = uniqueTypeName(seed, usedNames)
    names.set(reference.$ref, name)
    usedNames.add(name)
  }
  const render = (type: string) => {
    for (const [reference, name] of names) {
      const pattern = `(?<![A-Za-z0-9_$.'"])${reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$.'"])`
      type = type.replace(new RegExp(pattern, "g"), name)
    }
    const output = type
      .replaceAll(/ & Brand\.Brand<"[^"]+">/g, "")
      .replaceAll("Schema.Json", "JsonValue")
      .replaceAll(/(?<!["'])\bunknown\b(?!["'])/g, "any")
    return mutable ? mutableType(preserveStringSuggestions(output)) : preserveStringSuggestions(output)
  }
  const equivalent = new Map<string, string>()
  for (const reference of references) {
    const base = reference.$ref.replace(/_\d+$/, "")
    const identifier = referenceNames.has(base) ? base : reference.$ref
    const key = `${identifier}\0${render(inlineAnonymous(reference.code.Type))}`
    const existing = equivalent.get(key)
    if (existing !== undefined) {
      names.set(reference.$ref, existing)
      continue
    }
    const name = names.get(reference.$ref)
    if (name === undefined) throw new GenerationError({ reason: `Missing Promise type name: ${reference.$ref}` })
    equivalent.set(key, name)
  }
  const emitted = new Set<string>()
  return {
    types: document.codes.map((code) => render(inlineAnonymous(code.Type))),
    definitions: references.flatMap((reference) => {
      const name = names.get(reference.$ref)
      if (name === undefined) throw new GenerationError({ reason: `Missing Promise type name: ${reference.$ref}` })
      if (emitted.has(name)) return []
      emitted.add(name)
      return [`export type ${name} = ${render(inlineAnonymous(reference.code.Type))}`]
    }),
  }
}

function uniqueTypeName(seed: string, used: ReadonlySet<string>, suffix = 1): string {
  const name = suffix === 1 ? seed : `${seed}${suffix}`
  return used.has(name) ? uniqueTypeName(seed, used, suffix + 1) : name
}

function structuralType(schema: Schema.Top) {
  const document = SchemaRepresentation.toCodeDocument(SchemaRepresentation.toRepresentations([promiseTypeAst(schema)]))
  if (
    document.artifacts.some(
      (artifact) =>
        artifact._tag !== "Import" || artifact.importDeclaration !== 'import type * as Brand from "effect/Brand"',
    ) ||
    Object.keys(document.references.recursives).length > 0
  ) {
    throw new GenerationError({ reason: "Referenced Promise types are not implemented" })
  }
  const references = new Map(
    document.references.nonRecursives.map((reference) => [reference.$ref, reference.code.Type]),
  )
  const expand = (type: string, seen = new Set<string>()): string => {
    for (const [reference, value] of references) {
      const pattern = `(?<![A-Za-z0-9_$.'"])${reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$.'"])`
      if (!new RegExp(pattern).test(type)) continue
      if (seen.has(reference)) {
        throw new GenerationError({ reason: `Recursive Promise types are not implemented: ${reference}` })
      }
      type = type.replace(new RegExp(pattern, "g"), `(${expand(value, new Set([...seen, reference]))})`)
    }
    return type
  }
  return preserveStringSuggestions(
    expand(document.codes[0].Type)
      .replaceAll(/ & Brand\.Brand<"[^"]+">/g, "")
      .replaceAll("Schema.Json", "JsonValue"),
  )
}

function promiseTypeAst(schema: Schema.Top) {
  return codegenAst(schema.ast)
}

function promiseTypeAsts(schemas: ReadonlyArray<Schema.Top>) {
  return codegenAsts(schemas.map((schema) => schema.ast))
}

function codegenAst(root: SchemaAST.AST) {
  return codegenAsts([root])[0]
}

function codegenAsts(roots: ReadonlyArray<SchemaAST.AST>) {
  const cache = new WeakMap<SchemaAST.AST, SchemaAST.AST>()
  const references = new Map<string, SchemaAST.AST>()
  const recur = (ast: SchemaAST.AST): SchemaAST.AST => {
    const cached = cache.get(ast)
    if (cached !== undefined) return cached
    const identifier = SchemaAST.resolveIdentifier(ast)
    const output = normalize(ast)
    const referenceKey =
      identifier === undefined
        ? undefined
        : `${identifier}\0${ast.context?.isOptional === true}\0${ast.context?.isMutable === true}\0${representationEncoding(output)}`
    const reference = referenceKey === undefined ? undefined : references.get(referenceKey)
    if (reference !== undefined) {
      cache.set(ast, reference)
      return reference
    }
    cache.set(ast, output)
    if (referenceKey !== undefined) references.set(referenceKey, output)
    return output
  }
  const normalize = (ast: SchemaAST.AST): SchemaAST.AST => {
    if (SchemaAST.isDeclaration(ast) && ast.annotations?.toCode === undefined) {
      const representation = ast.annotations?.representation
      if (
        typeof representation === "object" &&
        representation !== null &&
        "id" in representation &&
        representation.id === "effect/schema/Json"
      ) {
        return Schema.Json.ast
      }
      if (ast.annotations?.["~constructor"] !== undefined && ast.typeParameters[0] !== undefined) {
        const identifier = SchemaAST.resolveIdentifier(ast)
        const fields = recur(ast.typeParameters[0])
        if (identifier === undefined) return fields
        return Schema.make<Schema.Top>(fields).annotate({ identifier }).ast
      }
    }
    if (!("recur" in ast) || typeof ast.recur !== "function") return ast
    return ast.recur(recur)
  }
  return roots.map(recur)
}

function preserveStringSuggestions(type: string) {
  return type.replaceAll(/((?:"(?:\\.|[^"\\])*"\s*\|\s*)+)string\b/g, "$1(string & {})")
}

function normalizePromiseClientContent(content: string, groups: ReadonlyArray<Group>) {
  const endpoints = groups.flatMap((group) => group.endpoints)
  const usesBinary = endpoints.some((endpoint) => isBinarySchema(endpoint.successes[0]))
  const usesWildcard = endpoints.some((endpoint) => promiseWildcardInput(endpoint) !== undefined)

  const sseReady = replaceOne(content, "let next: ReadableStreamReadResult<Uint8Array>", "let next")
  const binaryReady = usesBinary
    ? replaceOne(
        replaceOne(sseReady, "readonly empty: boolean\n}", "readonly empty: boolean\n  readonly binary?: true\n}"),
        "if (descriptor.empty) {",
        "if (descriptor.binary) return new Uint8Array(await response.arrayBuffer()) as A\n    if (descriptor.empty) {",
      )
    : sseReady
  return usesWildcard
    ? replaceOne(
        binaryReady,
        "function appendQuery(params: URLSearchParams, key: string, value: unknown): void {",
        'function encodePath(value: string): string {\n  return value.split("/").map(encodeURIComponent).join("/")\n}\n\nfunction appendQuery(params: URLSearchParams, key: string, value: unknown): void {',
      )
    : binaryReady
}

function replaceOne(input: string, search: string, replacement: string) {
  if (!input.includes(search))
    throw new GenerationError({ reason: `Missing Promise client template marker: ${search}` })
  return input.replace(search, replacement)
}

function promiseInput(endpoint: Endpoint): ReadonlyArray<PromiseInputField> {
  const wildcard = promiseWildcardInput(endpoint)
  if (wildcard === undefined) return endpoint.input
  return [...endpoint.input, wildcard]
}

function promiseInputMode(endpoint: Endpoint): Operation["inputMode"] {
  const input = promiseInput(endpoint)
  if (input.length === 0) return "none"
  return input.every((field) => field.optional) ? "optional" : "required"
}

function promiseWildcardInput(endpoint: Endpoint): PromiseInputField | undefined {
  if (!endpoint.endpoint.path.includes("*")) return undefined
  if (endpoint.endpoint.path.indexOf("*") !== endpoint.endpoint.path.lastIndexOf("*")) {
    throw new GenerationError({ reason: `Unsupported Promise path wildcard: ${endpoint.endpoint.path}` })
  }
  if (!endpoint.endpoint.path.endsWith("*")) {
    throw new GenerationError({ reason: `Unsupported Promise path wildcard: ${endpoint.endpoint.path}` })
  }
  const name = endpoint.input.some((field) => field.name === "path") ? "wildcard" : "path"
  return { name, source: "wildcard", optional: false }
}

function isBinarySchema(schema: Schema.Top) {
  return (resolveHttpApiEncoding(schema.ast)?._tag ?? "Json") === "Uint8Array"
}

function promisePath(path: string, input: ReadonlyArray<InputField>, wildcard?: PromiseInputField) {
  const fields = new Set(input.filter((field) => field.source === "params").map((field) => field.name))
  const segments = (wildcard === undefined ? path : path.slice(0, -1))
    .split(/(:[A-Za-z_][A-Za-z0-9_]*)/g)
    .filter(Boolean)
  const template = segments
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replaceAll("`", "\\`")
      const name = segment.slice(1)
      if (!fields.has(name)) throw new GenerationError({ reason: `Missing path parameter: ${name}` })
      return `\${encodeURIComponent(input.${name})}`
    })
    .join("")
  return `\`${template}${wildcard === undefined ? "" : `\${encodePath(input.${wildcard.name})}`}\``
}

function normalizeTransport(
  schema: Schema.Top | undefined,
  source: InputField["source"] | "success" | "error",
  endpoint: HttpApiEndpoint.Top,
  operation: string,
) {
  if (schema === undefined) return undefined
  if (isStreamSchema(schema)) return { schema, effectPortable: true } as const
  if (!metadataPortable(schema.ast, new Set())) {
    throw new GenerationError({ reason: `Unportable schema: ${operation}.${source}` })
  }
  const decoded = Schema.toType(schema)
  if (!isPathInput(endpoint.path)) {
    throw new GenerationError({ reason: `Invalid endpoint path: ${operation}` })
  }
  const rebuilt =
    source === "params"
      ? HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
          params: decoded,
          success: Schema.String,
        })
      : source === "query"
        ? HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
            query: decoded,
            success: Schema.String,
          })
        : source === "headers"
          ? HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
              headers: decoded,
              success: Schema.String,
            })
          : source === "payload"
            ? HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
                payload: decoded,
                success: Schema.String,
              })
            : source === "success"
              ? HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, { success: decoded })
              : HttpApiEndpoint.make(endpoint.method)(endpoint.identifier, endpoint.path, {
                  success: Schema.String,
                  error: decoded,
                })
  const normalized =
    source === "params"
      ? rebuilt.params
      : source === "query"
        ? rebuilt.query
        : source === "headers"
          ? rebuilt.headers
          : source === "payload"
            ? Array.from(rebuilt.payload.values())[0]?.schemas[0]
            : source === "success"
              ? Array.from(rebuilt.success)[0]
              : Array.from(rebuilt.error)[0]
  if (normalized === undefined) throw new GenerationError({ reason: `Unportable schema: ${operation}.${source}` })
  if (!sameEncoding(schema.ast, normalized.ast)) return { schema, effectPortable: false } as const
  return { schema: decoded, effectPortable: true } as const
}

function isPathInput(path: string): path is HttpRouter.PathInput {
  return path === "*" || path.startsWith("/")
}

const encodings = new WeakMap<SchemaAST.AST, string>()

function sameEncoding(left: SchemaAST.AST, right: SchemaAST.AST): boolean {
  if (!sameRuntimeEncoding(left, right)) return false
  return sameRepresentation(left, right)
}

function sameRepresentation(left: SchemaAST.AST, right: SchemaAST.AST): boolean {
  return representationEncoding(left) === representationEncoding(right)
}

function representationEncoding(ast: SchemaAST.AST) {
  const cached = encodings.get(ast)
  if (cached !== undefined) return cached
  const encoded = JSON.stringify(SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(ast)))
  encodings.set(ast, encoded)
  return encoded
}

function sameRuntimeEncoding(left: SchemaAST.AST, right: SchemaAST.AST): boolean {
  if (left._tag !== right._tag || left.encoding?.length !== right.encoding?.length) return false
  if (
    left.encoding?.some((link, index) => {
      const other = right.encoding?.[index]
      return other === undefined || !sameRuntimeEncoding(link.to, other.to)
    })
  ) {
    return false
  }
  if (!sameChecks(left.checks, right.checks) || !sameContext(left.context, right.context)) return false
  if (SchemaAST.isSuspend(left) && SchemaAST.isSuspend(right)) {
    return sameRuntimeEncoding(left.thunk(), right.thunk())
  }
  if (SchemaAST.isUnion(left) && SchemaAST.isUnion(right)) {
    return (
      left.types.length === right.types.length &&
      left.types.every((ast, index) => sameRuntimeEncoding(ast, right.types[index]))
    )
  }
  if (SchemaAST.isArrays(left) && SchemaAST.isArrays(right)) {
    return (
      left.elements.length === right.elements.length &&
      left.rest.length === right.rest.length &&
      left.elements.every((ast, index) => sameRuntimeEncoding(ast, right.elements[index])) &&
      left.rest.every((ast, index) => sameRuntimeEncoding(ast, right.rest[index]))
    )
  }
  if (SchemaAST.isObjects(left) && SchemaAST.isObjects(right)) {
    return (
      left.propertySignatures.length === right.propertySignatures.length &&
      left.indexSignatures.length === right.indexSignatures.length &&
      left.propertySignatures.every((field, index) =>
        sameRuntimeEncoding(field.type, right.propertySignatures[index].type),
      ) &&
      left.indexSignatures.every(
        (field, index) =>
          sameRuntimeEncoding(field.parameter, right.indexSignatures[index].parameter) &&
          sameRuntimeEncoding(field.type, right.indexSignatures[index].type),
      )
    )
  }
  return true
}

function sameChecks(left: SchemaAST.Checks | undefined, right: SchemaAST.Checks | undefined): boolean {
  if (left?.length !== right?.length) return false
  if (left === undefined || right === undefined) return true
  return left.every((check, index) => {
    const other = right[index]
    if (other === undefined || check._tag !== other._tag) return false
    if (check._tag === "Filter" && other._tag === "Filter") {
      return check.run === other.run && check.aborted === other.aborted
    }
    return check._tag === "FilterGroup" && other._tag === "FilterGroup" && sameChecks(check.checks, other.checks)
  })
}

function sameContext(left: SchemaAST.Context | undefined, right: SchemaAST.Context | undefined) {
  return left?.isOptional === right?.isOptional && left?.isMutable === right?.isMutable
}

export function write(
  output: Output,
  directory: string,
): Effect.Effect<void, GenerationError | PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const paths = new Set<string>()
    const normalizedPaths = new Set<string>()
    for (const file of output.files) {
      if (!isSafeOutputPath(file.path)) yield* new GenerationError({ reason: `Unsafe output path: ${file.path}` })
      const path = file.path.toLowerCase()
      if (normalizedPaths.has(path)) yield* new GenerationError({ reason: `Duplicate output path: ${file.path}` })
      normalizedPaths.add(path)
      paths.add(file.path)
    }
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(directory, { recursive: true })
    const manifest = join(directory, manifestName)
    const previous = (yield* fs.exists(manifest))
      ? yield* fs.readFileString(manifest).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
          Effect.mapError(() => new GenerationError({ reason: `Invalid generated file manifest: ${manifest}` })),
        )
      : []
    if (previous.some((path) => !isSafeOutputPath(path))) {
      yield* new GenerationError({ reason: `Invalid generated file manifest: ${manifest}` })
    }
    yield* Effect.forEach(
      previous.filter((path) => !paths.has(path)),
      (path) => fs.remove(join(directory, path), { force: true }),
      { concurrency: 8, discard: true },
    )
    yield* Effect.forEach(
      output.files,
      (file) =>
        fs.exists(join(directory, file.path)).pipe(
          Effect.flatMap((exists) => (exists ? fs.stat(join(directory, file.path)) : Effect.undefined)),
          Effect.flatMap((info) =>
            info?.type === "SymbolicLink"
              ? new GenerationError({ reason: `Unsafe output path: ${file.path}` })
              : Effect.void,
          ),
        ),
      { concurrency: 8, discard: true },
    )
    yield* Effect.forEach(
      output.files,
      (file) =>
        Effect.tryPromise({
          try: () => format(file.content, { filepath: file.path, parser: "typescript", semi: false, printWidth: 120 }),
          catch: (error) => new GenerationError({ reason: `Failed to format ${file.path}: ${String(error)}` }),
        }).pipe(Effect.flatMap((content) => fs.writeFileString(join(directory, file.path), content))),
      { concurrency: 8, discard: true },
    )
    // Format the manifest with the same prettier settings as the repo-wide
    // format pass, so `check:generated` stays clean after the generate bot
    // reformats the tree.
    const manifestJson = JSON.stringify(output.files.map((file) => file.path).sort())
    const manifestContent = yield* Effect.tryPromise({
      try: () => format(manifestJson, { filepath: manifest, parser: "json", printWidth: 120 }),
      catch: (error) => new GenerationError({ reason: `Failed to format ${manifest}: ${String(error)}` }),
    })
    yield* fs.writeFileString(manifest, manifestContent)
  })
}

function isSafeOutputPath(path: string) {
  return path !== manifestName && !isAbsolute(path) && path !== "." && path !== ".." && !/[\\/]/.test(path)
}

export function generate<Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  options: { readonly directory: string },
): Effect.Effect<void, GenerationError | PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.try({
    try: () => emitEffect(compile(api)),
    catch: (error) => (error instanceof GenerationError ? error : new GenerationError({ reason: String(error) })),
  }).pipe(Effect.flatMap((output) => write(output, options.directory)))
}

function isFlattenableStruct(schema: Schema.Top) {
  const ast = Schema.toType(schema).ast
  return SchemaAST.isObjects(ast) && ast.indexSignatures.length === 0
}

function isOpaquePayload(endpoint: Endpoint) {
  const payload = endpoint.payloads[0]
  return payload !== undefined && !isFlattenableStruct(payload)
}

function inputFields(schema: Schema.Top | undefined, source: InputField["source"], operation: string) {
  if (schema === undefined) return []
  const ast = Schema.toType(schema).ast
  if (!SchemaAST.isObjects(ast) || ast.indexSignatures.length > 0) {
    if (source === "payload") return [{ name: "payload", source, optional: false }] as const
    throw new GenerationError({ reason: `Input schema must be a struct: ${operation}.${source}` })
  }
  return ast.propertySignatures.map((field) => {
    if (typeof field.name !== "string") {
      throw new GenerationError({ reason: `Input field must have a string name: ${operation}.${source}` })
    }
    return {
      name: field.name,
      source,
      optional: SchemaAST.isOptional(field.type),
    }
  })
}

function responseSchemas(schema: Schema.Top, path: string): Array<readonly [string, Schema.Top]> {
  if (HttpApiSchema.isNoContent(schema.ast)) return []
  if (!isStreamSchema(schema)) return [[path, schema]]
  if (schema._tag === "StreamUint8Array") return []
  const value = schema.sseMode === "data" ? streamDataSchema(schema) : Schema.make<Schema.Top>(schema.events.ast)
  return [
    [`${path}.${schema.sseMode}`, value],
    [`${path}.error`, schema.error],
  ]
}

function assertPortable(schema: Schema.Top, path: string, portable: Map<SchemaAST.AST, boolean>) {
  const visiting = new Set<SchemaAST.AST>()
  const taggedError = taggedErrorFields(schema)
  const visit = (ast: SchemaAST.AST): boolean => {
    const cached = portable.get(ast)
    if (cached !== undefined) return cached
    if (visiting.has(ast)) return true
    visiting.add(ast)
    const result = visitCurrent(ast)
    visiting.delete(ast)
    portable.set(ast, result)
    return result
  }
  const visitCurrent = (ast: SchemaAST.AST): boolean => {
    if (!annotationsPortable(ast.annotations)) return false
    if (!checksPortable(ast.checks) || ("encodingChecks" in ast && !checksPortable(ast.encodingChecks))) return false
    if (SchemaAST.isDeclaration(ast)) {
      return typeof ast.annotations?.toCode === "function" && ast.typeParameters.every(visit)
    }
    if (ast.encoding !== undefined && ast.annotations?.toCode === undefined) return false
    if (SchemaAST.isSuspend(ast)) return visit(ast.thunk())
    if (SchemaAST.isUnion(ast)) return ast.types.every(visit)
    if (SchemaAST.isArrays(ast)) {
      return ast.elements.every(visit) && ast.rest.every(visit)
    }
    if (SchemaAST.isObjects(ast)) {
      return (
        ast.propertySignatures.every((field) => visit(field.type)) &&
        ast.indexSignatures.every((index) => visit(index.parameter) && visit(index.type))
      )
    }
    if (SchemaAST.isTemplateLiteral(ast)) return ast.parts.every(visit)
    return true
  }
  if (taggedError !== undefined && SchemaAST.isDeclaration(schema.ast)) {
    if (
      schema.ast.checks !== undefined ||
      ("encodingChecks" in schema.ast && !checksPortable(schema.ast.encodingChecks)) ||
      schema.ast.typeParameters.some((ast) => ast.checks !== undefined) ||
      !schema.ast.typeParameters.every(visit)
    ) {
      throw new GenerationError({ reason: `Unportable schema: ${path}` })
    }
    return
  }
  if (!visit(schema.ast)) throw new GenerationError({ reason: `Unportable schema: ${path}` })
}

function checksPortable(checks: SchemaAST.Checks | undefined): boolean {
  if (checks === undefined) return true
  return checks.every((check) =>
    check._tag === "Filter"
      ? !check.aborted &&
        check.annotations?.representation !== undefined &&
        serializable(check.annotations.representation) &&
        typeof check.annotations.arbitrary === "object" &&
        check.annotations.arbitrary !== null &&
        "constraint" in check.annotations.arbitrary
      : checksPortable(check.checks),
  )
}

function metadataPortable(ast: SchemaAST.AST, seen: Set<SchemaAST.AST>): boolean {
  if (seen.has(ast)) return true
  seen.add(ast)
  if (!annotationsPortable(ast.annotations) || !checksPortable(ast.checks)) return false
  if ("encodingChecks" in ast && !checksPortable(ast.encodingChecks)) return false
  if (ast.encoding?.some((link) => !metadataPortable(link.to, seen))) return false
  if (SchemaAST.isDeclaration(ast)) return ast.typeParameters.every((item) => metadataPortable(item, seen))
  if (SchemaAST.isSuspend(ast)) return metadataPortable(ast.thunk(), seen)
  if (SchemaAST.isUnion(ast)) return ast.types.every((item) => metadataPortable(item, seen))
  if (SchemaAST.isArrays(ast)) {
    return (
      ast.elements.every((item) => metadataPortable(item, seen)) &&
      ast.rest.every((item) => metadataPortable(item, seen))
    )
  }
  if (SchemaAST.isObjects(ast)) {
    return (
      ast.propertySignatures.every((field) => metadataPortable(field.type, seen)) &&
      ast.indexSignatures.every(
        (field) => metadataPortable(field.parameter, seen) && metadataPortable(field.type, seen),
      )
    )
  }
  return true
}

function annotationsPortable(annotations: Schema.Annotations.Annotations | undefined) {
  if (annotations === undefined) return true
  return Object.entries(annotations).every(([key, value]) => {
    if (
      [
        "toCodec",
        "toCodecJson",
        "toCodecStringTree",
        "toArbitrary",
        "toFormatter",
        "toEquivalence",
        "toCode",
        "~constructor",
      ].includes(key)
    ) {
      return true
    }
    return serializable(value)
  })
}

function serializable(value: unknown): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(serializable)
  if (typeof value !== "object") return false
  return Object.values(value).every(serializable)
}

function taggedErrorFields(schema: Schema.Top) {
  const fields = declaredErrorFields(schema)
  return fields?.key === "_tag" ? fields : undefined
}

function declaredErrorFields(schema: Schema.Top) {
  if (!SchemaAST.isDeclaration(schema.ast) || schema.ast.annotations?.["~constructor"] === undefined) {
    return undefined
  }
  const fields = schema.ast.typeParameters[0]
  if (!SchemaAST.isObjects(fields) || fields.indexSignatures.length > 0) return undefined
  const key = fields.propertySignatures.find((field) => field.name === "_tag" || field.name === "name")?.name
  if (key !== "_tag" && key !== "name") return undefined
  const tag = fields.propertySignatures.find((field) => field.name === key)?.type
  if (tag === undefined || !SchemaAST.isLiteral(tag) || typeof tag.literal !== "string") return undefined
  return {
    key,
    tag: tag.literal,
    identifier: SchemaAST.resolveIdentifier(schema.ast) ?? tag.literal,
    fields: fields.propertySignatures.flatMap((field) =>
      field.name === key || typeof field.name !== "string"
        ? []
        : [[field.name, Schema.make<Schema.Top>(field.type), SchemaAST.isOptional(field.type)] as const],
    ),
  }
}

function isDataEnvelope(schema: Schema.Top) {
  if (isStreamSchema(schema) || HttpApiSchema.isNoContent(schema.ast)) return false
  const ast = Schema.toType(schema).ast
  return (
    SchemaAST.isObjects(ast) &&
    ast.indexSignatures.length === 0 &&
    ast.propertySignatures.length === 1 &&
    ast.propertySignatures[0]?.name === "data"
  )
}

function isStreamSchema(schema: Schema.Top): schema is HttpApiSchema.StreamSchema {
  return "_tag" in schema && (schema._tag === "StreamSse" || schema._tag === "StreamUint8Array")
}

function streamDataSchema(schema: Extract<HttpApiSchema.StreamSchema, { readonly _tag: "StreamSse" }>) {
  return Schema.make<Schema.Top>(streamDataAst(Schema.toType(schema.events).ast))
}

function streamEncodedDataSchema(schema: Extract<HttpApiSchema.StreamSchema, { readonly _tag: "StreamSse" }>) {
  const replaceEncoding: unknown = Reflect.get(SchemaAST, "replaceEncoding")
  if (typeof replaceEncoding !== "function") throw new GenerationError({ reason: "Invalid SSE data schema" })
  const ast: unknown = replaceEncoding(streamDataAst(schema.events.ast), undefined)
  if (!SchemaAST.isAST(ast)) throw new GenerationError({ reason: "Invalid SSE data schema" })
  return Schema.toEncoded(Schema.make<Schema.Top>(ast))
}

function streamDataAst(ast: SchemaAST.AST) {
  if (!SchemaAST.isObjects(ast)) throw new GenerationError({ reason: "Invalid SSE data schema" })
  const data = ast.propertySignatures.find((field) => field.name === "data")?.type
  if (data === undefined) throw new GenerationError({ reason: "Invalid SSE data schema" })
  return data
}

function streamEffectPortable(schema: Schema.Top) {
  if (!isStreamSchema(schema) || schema._tag === "StreamUint8Array" || schema.sseMode === "events") return true
  const rebuilt = HttpApiSchema.StreamSse({
    data: streamDataSchema(schema),
    error: schema.error,
    contentType: schema.contentType,
  })
  return sameEncoding(schema.events.ast, rebuilt.events.ast)
}

function renderGroup(group: Group) {
  const slots: Array<Slot> = []
  const adapters: Array<string> = []
  const endpointSources = group.endpoints.map((operation) => {
    const {
      endpoint,
      errors,
      headers: endpointHeaders,
      params: endpointParams,
      payloads: endpointPayloads,
      query: endpointQuery,
      successes,
    } = operation
    const prefix = `Endpoint${operation.clientPath.map(identifierPart).join("")}`
    const params = addSlot(endpointParams, `${prefix}Params`)
    const query = addSlot(endpointQuery, `${prefix}Query`)
    const headers = addSlot(endpointHeaders, `${prefix}Headers`)
    const payloads = endpointPayloads.map((schema, index) => addSlot(schema, `${prefix}Payload${index}`)!)
    const success = renderSuccess(successes[0], `${prefix}Success`)
    const errorSlots = errors.map((error, index) => addSlot(error.schema, `${prefix}Error${index}`)!)
    const options = [
      params === undefined ? undefined : `params: ${params.name}`,
      query === undefined ? undefined : `query: ${query.name}`,
      headers === undefined ? undefined : `headers: ${headers.name}`,
      payloads.length === 0
        ? undefined
        : `payload: ${payloads.length === 1 ? payloads[0].name : `[${payloads.map((slot) => slot.name).join(", ")}]`}`,
      `success: ${success.source}`,
      errorSlots.length === 0
        ? undefined
        : `error: ${errorSlots.length === 1 ? errorSlots[0].name : `[${errorSlots.map((slot) => slot.name).join(", ")}]`}`,
    ].filter((option): option is string => option !== undefined)
    const schemaBySource = { params, query, headers, payload: payloads[0] }
    const inputType = operation.input
      .map((field) => {
        const slot = schemaBySource[field.source]
        if (slot === undefined) {
          throw new GenerationError({ reason: `Missing input schema: ${group.identifier}.${endpoint.identifier}` })
        }
        return `readonly ${JSON.stringify(field.name)}${field.optional ? "?" : ""}: ${isOpaquePayload(operation) && field.source === "payload" ? `typeof ${slot.name}.Type` : `(typeof ${slot.name}.Type)[${JSON.stringify(field.name)}]`}`
      })
      .join("; ")
    const argument =
      operation.operation.inputMode === "none"
        ? ""
        : `input${operation.operation.inputMode === "optional" ? "?" : ""}: ${prefix}Input`
    const request = (["params", "query", "headers", "payload"] as const)
      .map((source) =>
        renderEffectRequestPart(
          operation.input,
          operation.operation.inputMode,
          source,
          isOpaquePayload(operation),
          schemaBySource[source] !== undefined,
        ),
      )
      .filter((part): part is string => part !== undefined)
      .join(", ")
    const declared = [...errorSlots, ...(success.streamError === undefined ? [] : [success.streamError])]
    const declaredSchema =
      declared.length === 0 ? "Schema.Never" : `Schema.Union([${declared.map((slot) => slot.name).join(", ")}])`
    const opaquePayload = isOpaquePayload(operation)
    // HttpApiClient distributes union payloads into union request objects, while rebuilding a flattened input
    // produces one object containing a union value. The shapes are equivalent but TypeScript cannot correlate them.
    const rawCall = `raw[${JSON.stringify(endpoint.identifier)}]({ ${request} }${opaquePayload ? ` as ${prefix}Request` : ""})`
    const mapped = `${rawCall}.pipe(Effect.mapError(map${prefix}Error)${operation.unwrapData ? ", Effect.map((value) => value.data)" : ""})`
    const inputDeclaration =
      operation.operation.inputMode === "none"
        ? ""
        : `${opaquePayload ? `type ${prefix}Request = Parameters<RawGroup[${JSON.stringify(endpoint.identifier)}]>[0]\n` : ""}type ${prefix}Input = { ${inputType} }\n`
    adapters.push(
      `${inputDeclaration}const ${prefix}DeclaredError = ${declaredSchema}\nconst map${prefix}Error = (error: unknown) => HttpClientError.isHttpClientError(error) || Schema.isSchemaError(error) || Sse.Retry.is(error) ? new ClientError({ cause: error }) : Schema.is(${prefix}DeclaredError)(error) ? error : new ClientError({ cause: error })\nconst ${prefix} = (raw: RawGroup) => (${argument}) => ${operation.operation.success === "stream" ? `Stream.unwrap(${rawCall}.pipe(Effect.mapError(map${prefix}Error), Effect.map((stream) => stream.pipe(Stream.mapError(map${prefix}Error)))))` : mapped}`,
    )
    return `HttpApiEndpoint.make(${JSON.stringify(endpoint.method)})(${JSON.stringify(endpoint.identifier)}, ${JSON.stringify(endpoint.path)}, { ${options.join(", ")} })`
  })

  function addSlot(schema: Schema.Top | undefined, name: string) {
    if (schema === undefined) return undefined
    const slot = { name, schema }
    slots.push(slot)
    return slot
  }

  function renderSuccess(schema: Schema.Top, name: string) {
    if (!isStreamSchema(schema)) return { source: addSlot(schema, name)!.name }
    const status = resolveHttpApiStatus(schema.ast) ?? 200
    const annotate = status === 200 ? "" : `.pipe(HttpApiSchema.status(${status}))`
    if (schema._tag === "StreamUint8Array") {
      return {
        source: `HttpApiSchema.StreamUint8Array({ contentType: ${JSON.stringify(schema.contentType)} })${annotate}`,
      }
    }
    const value = addSlot(
      schema.sseMode === "data" ? streamDataSchema(schema) : Schema.make<Schema.Top>(schema.events.ast),
      `${name}${schema.sseMode === "data" ? "Data" : "Events"}`,
    )!
    const error = addSlot(schema.error, `${name}Error`)!
    return {
      source: `HttpApiSchema.StreamSse({ ${schema.sseMode}: ${value.name}, error: ${error.name}, contentType: ${JSON.stringify(schema.contentType)} })${annotate}`,
      streamError: error,
    }
  }

  const declarations = renderSchemas(slots)
  const groupSource = `HttpApiGroup.make(${JSON.stringify(group.identifier)}, { topLevel: ${group.endpoints[0]?.topLevel ?? false} })${endpointSources.map((endpoint) => `.add(${endpoint})`).join("")}`
  const usesHttpApiSchema = endpointSources.some((source) => source.includes("HttpApiSchema."))
  const methods = renderClientTree(
    group.endpoints,
    (item) => `Endpoint${item.clientPath.map(identifierPart).join("")}(raw)`,
    (name, value) => `${JSON.stringify(name)}: ${value}`,
    ", ",
  )
  const name = groupTypeName(group)
  const rawGroup = group.endpoints[0]?.topLevel
    ? `HttpApiClient.Client<typeof Group${name}>`
    : `HttpApiClient.Client.Group<typeof Group${name}, never, never>`
  const usesStream = group.endpoints.some((item) => item.operation.success === "stream")
  return `// Generated by @opencode/httpapi-codegen. Do not edit.\nimport { Effect, Schema${usesStream ? ", Stream" : ""} } from "effect"\nimport { Sse } from "effect/unstable/encoding"\nimport { HttpClientError } from "effect/unstable/http"\nimport { HttpApiClient, HttpApiEndpoint, HttpApiGroup${usesHttpApiSchema ? ", HttpApiSchema" : ""} } from "effect/unstable/httpapi"\nimport { ClientError } from "./client-error.js"\n\n${declarations}\n\nexport const Group${name} = ${groupSource}\n\ntype RawGroup = ${rawGroup}\n\n${adapters.join("\n\n")}\n\nexport const adaptGroup${name} = (raw: RawGroup) => ({ ${methods} })\n`
}

function renderEffectRequestPart(
  input: Endpoint["input"],
  mode: Operation["inputMode"],
  source: InputField["source"],
  opaquePayload: boolean,
  present = false,
) {
  const fields = input.filter((field) => field.source === source)
  if (fields.length === 0) return present ? `${source}: { }` : undefined
  const access = (name: string) => `input${mode === "optional" ? "?." : ""}[${JSON.stringify(name)}]`
  if (opaquePayload && source === "payload") return `${source}: ${access(fields[0].name)}`
  return `${source}: { ${fields.map((field) => `${JSON.stringify(field.name)}: ${access(field.name)}`).join(", ")} }`
}

function renderSchemas(slots: ReadonlyArray<Slot>) {
  if (slots.length === 0) return ""
  const classes = new Map(
    slots.flatMap((slot, index) => {
      const tagged = taggedErrorFields(slot.schema)
      return tagged === undefined ? [] : [[index, tagged] as const]
    }),
  )
  const expanded = [
    ...slots.map((slot, index) => (classes.has(index) ? { name: slot.name, schema: Schema.Never } : slot)),
    ...Array.from(classes.values()).flatMap((tagged, classIndex) =>
      tagged.fields.map(([name, schema]) => ({ name: `Class${classIndex}${name}`, schema })),
    ),
  ]
  const [first, ...rest] = expanded
  const document = SchemaRepresentation.toCodeDocument(
    SchemaRepresentation.toRepresentations(
      codegenAsts(expanded.map((slot) => slot.schema.ast)) as [SchemaAST.AST, ...Array<SchemaAST.AST>],
    ),
  )
  const artifacts = document.artifacts.flatMap((artifact) => {
    if (artifact._tag === "Import") return [artifact.importDeclaration]
    if (artifact._tag === "Enum") return [artifact.code.runtime]
    return [`const ${artifact.identifier} = ${artifact.code.runtime}`]
  })
  const references = [
    ...document.references.nonRecursives.map(({ $ref, code }) => `const ${$ref} = ${code.runtime}`),
    ...Object.entries(document.references.recursives).map(
      ([$ref, code]) => `type ${$ref} = ${code.Type}\nconst ${$ref}: Schema.Codec<${$ref}> = ${code.runtime}`,
    ),
  ]
  let fieldIndex = slots.length
  const declarations = slots.map((slot, index) => {
    const tagged = classes.get(index)
    if (tagged === undefined) return `const ${slot.name} = ${document.codes[index].runtime}`
    const fields = tagged.fields
      .map(([name]) => `${JSON.stringify(name)}: ${document.codes[fieldIndex++].runtime}`)
      .join(", ")
    const annotations = Object.entries({
      httpApiStatus: resolveHttpApiStatus(slot.schema.ast),
      "~httpApiEncoding": resolveHttpApiEncoding(slot.schema.ast),
    }).filter((entry) => entry[1] !== undefined)
    const annotate =
      annotations.length === 0
        ? ""
        : `.annotate({ ${annotations.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")} })`
    return `class ${slot.name}Class extends Schema.TaggedError<${slot.name}Class>(${JSON.stringify(tagged.identifier)})(${JSON.stringify(tagged.tag)}, { ${fields} }) {}\nconst ${slot.name} = ${slot.name}Class${annotate}`
  })
  return [...artifacts, ...references, ...declarations].join("\n\n")
}

function renderClient(groups: ReadonlyArray<Group>) {
  const imports = groups
    .map(
      (group) =>
        `import { adaptGroup${groupTypeName(group)}, Group${groupTypeName(group)} } from ${JSON.stringify(`./${group.module}`)}`,
    )
    .join("\n")
  const api = `HttpApi.make("generated")${groups.map((group) => `.add(Group${groupTypeName(group)})`).join("")}`
  const fields = groups.flatMap((group) => {
    if (!group.endpoints[0]?.topLevel) {
      return [
        `${JSON.stringify(group.identifier)}: adaptGroup${groupTypeName(group)}(raw[${JSON.stringify(group.identifier)}])`,
      ]
    }
    const raw = `{ ${group.endpoints.map((item) => `${JSON.stringify(item.endpoint.identifier)}: raw[${JSON.stringify(item.endpoint.identifier)}]`).join(", ")} }`
    return [`...adaptGroup${groupTypeName(group)}(${raw})`]
  })
  return `// Generated by @opencode/httpapi-codegen. Do not edit.\nimport { Effect } from "effect"\nimport { HttpApi, HttpApiClient } from "effect/unstable/httpapi"\n${imports}\n\nconst Api = ${api}\nconst adaptClient = (raw: HttpApiClient.ForApi<typeof Api>) => ({ ${fields.join(", ")} })\n\nexport const make = (options?: { readonly baseUrl?: URL | string }) =>\n  HttpApiClient.make(Api, options).pipe(Effect.map(adaptClient))\n`
}
