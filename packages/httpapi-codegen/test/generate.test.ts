import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, FileSystem, Schema, SchemaAST, SchemaGetter } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi"
import { format } from "prettier"
import {
  compile as compileContract,
  emitEffect,
  emitEffectImported,
  emitEffectShape,
  emitPromise,
  generate,
  GenerationError,
  type Output,
} from "../src"
import { it } from "./effect"
import { Api as FixtureApi, Missing } from "./fixture"

function api(endpoint: HttpApiEndpoint.Constraint) {
  return HttpApi.make("test").add(HttpApiGroup.make("session").add(endpoint))
}

function compile<Id extends string, Groups extends HttpApiGroup.Constraint>(source: HttpApi.HttpApi<Id, Groups>) {
  return emitEffect(compileContract(source))
}

async function emittedModule(output: Output) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-httpapi-codegen-"))
  const dispose = () => rm(directory, { recursive: true, force: true })

  try {
    // Finish each write before cleanup can run, even when a later write fails.
    await Array.fromAsync(output.files, (file) => Bun.write(join(directory, file.path), file.content))
    const module = await import(`${join(directory, "index.ts")}?t=${crypto.randomUUID()}`)
    return { module, [Symbol.asyncDispose]: dispose }
  } catch (cause) {
    await dispose()
    throw cause
  }
}

describe("HttpApiCodegen.generate", () => {
  test("compiles one contract for Promise and Effect emitters", () => {
    const contract = compileContract(
      api(
        HttpApiEndpoint.get("get", "/session/:sessionID", {
          params: { sessionID: Schema.String },
          success: Schema.Struct({ data: Schema.String }),
        }),
      ),
    )

    const promise = emitPromise(contract)
    const effect = emitEffect(contract)

    expect(promise.operations).toEqual(effect.operations)
    expect(promise.files.map((file) => file.path)).toEqual(["types.ts", "client-error.ts", "client.ts", "index.ts"])
    const promiseClient = promise.files.find((file) => file.path === "client.ts")?.content
    expect(promiseClient).toContain('"get": (input: SessionGetInput, requestOptions?: RequestOptions)')
    expect(promiseClient).toContain("`/session/${encodeURIComponent(input.sessionID)}`")
    expect(effect.files.find((file) => file.path === "session.ts")?.content).toContain(
      'params: { "sessionID": input["sessionID"] }',
    )
  })

  test("allows Promise outputs to use an authoritative imported wire type", () => {
    const contract = compileContract(
      api(HttpApiEndpoint.get("events", "/event", { success: HttpApiSchema.StreamSse({ data: Schema.Unknown }) })),
    )
    const output = emitPromise(contract, {
      outputTypes: {
        "session.events": {
          name: "EventWire",
          import: 'import type { EventWire } from "./event-wire"',
        },
      },
    })
    const types = output.files.find((file) => file.path === "types.ts")?.content

    expect(types).toContain('import type { EventWire } from "./event-wire"')
    expect(types).toContain("export type SessionEventsOutput = EventWire")
  })

  test("emits an Effect client against an imported authoritative API", () => {
    const output = emitEffectImported(
      compileContract(
        api(
          HttpApiEndpoint.get("get", "/session/:sessionID", {
            params: { sessionID: Schema.String },
            success: Schema.Struct({ data: Schema.String }),
          }),
        ),
      ),
      { module: "@example/api", api: "Api" },
    )

    expect(output.files.map((file) => file.path)).toEqual(["client-error.ts", "client.ts", "index.ts"])
    expect(output.files.find((file) => file.path === "client.ts")?.content).toContain(
      'import { Api } from "@example/api"',
    )
    expect(output.files.find((file) => file.path === "client.ts")?.content).toContain(
      "HttpApiClient.ForApi<typeof Api>",
    )
  })

  test("generates Effect API types from schemas instead of the imported API", () => {
    const Info = Schema.Struct({ id: Schema.String }).annotate({ identifier: "Session.Info" })
    const output = emitEffectShape(
      compileContract(
        api(
          HttpApiEndpoint.get("get", "/session/:id", {
            params: { id: Schema.String },
            success: Schema.Struct({ data: Info }),
          }),
        ),
      ),
      {
        typeReferences: [
          {
            schema: Info,
            name: "Session.Info",
            import: 'import type { Session } from "@example/schema/session"',
          },
        ],
      },
    )
    const source = output.files[0]?.content

    expect(source).toContain('import type { Session } from "@example/schema/session"')
    expect(source).toContain('export type SessionGetInput = { readonly "id": string }')
    expect(source).toContain("export type SessionGetOutput = Session.Info")
    expect(source).not.toContain("HttpApiClient")
    expect(source).not.toContain("@example/api")
  })

  test("preserves named Effect references across optional schema occurrences", () => {
    const State = Schema.Record(Schema.String, Schema.Unknown).annotate({ identifier: "Message.State" })
    const output = emitEffectShape(
      compileContract(
        api(
          HttpApiEndpoint.get("get", "/session", {
            success: Schema.Struct({
              encoded: Schema.toEncoded(Schema.Struct({ state: Schema.optionalKey(State) })),
              optional: Schema.optional(State),
            }),
          }),
        ),
      ),
      {
        typeReferences: [
          { schema: State, name: "Message.State", import: 'import type { Message } from "@example/schema/message"' },
        ],
      },
    )
    const source = output.files[0]?.content
    expect(source).toContain('readonly "state"?: Message.State')
    expect(source).toContain('readonly "optional"?: Message.State | undefined')
  })

  test("does not reuse named Effect references for different suffixed shapes", () => {
    const State = Schema.Record(Schema.String, Schema.Unknown).annotate({ identifier: "Message.State" })
    const Different = Schema.Record(Schema.String, Schema.Number).annotate({ identifier: "Message.State" })
    const output = emitEffectShape(
      compileContract(
        api(
          HttpApiEndpoint.get("get", "/session", {
            success: Schema.Struct({ original: State, different: Different }),
          }),
        ),
      ),
      {
        typeReferences: [
          { schema: State, name: "Message.State", import: 'import type { Message } from "@example/schema/message"' },
        ],
      },
    )
    const source = output.files[0]?.content
    expect(source).toContain('readonly "original": Message.State')
    expect(source).toContain('readonly "different": ({ readonly [x: string]: number })')
  })

  test("allows composed Effect outputs to use an authoritative named type", () => {
    const output = emitEffectShape(
      compileContract(api(HttpApiEndpoint.get("events", "/event", { success: Schema.Unknown }))),
      {
        outputTypes: {
          "session.events": {
            name: "OpenCodeEvent",
            import: 'import type { OpenCodeEvent } from "@example/protocol/event"',
          },
        },
      },
    )
    const source = output.files[0]?.content

    expect(source).toContain('import type { OpenCodeEvent } from "@example/protocol/event"')
    expect(source).toContain("export type SessionEventsOutput = OpenCodeEvent")
  })

  test("rejects authoritative Effect types colliding with generated aliases", () => {
    expect(() =>
      emitEffectShape(compileContract(api(HttpApiEndpoint.get("get", "/session", { success: Schema.String }))), {
        outputTypes: {
          "session.get": {
            name: "SessionGetOutput",
            import: 'import type { SessionGetOutput } from "@example/schema/session"',
          },
        },
      }),
    ).toThrow("Generated Effect type collides with imported type: SessionGetOutput")
  })

  test("rejects qualified Effect imports colliding with generated interfaces", () => {
    const Info = Schema.Struct({ id: Schema.String }).annotate({ identifier: "Session.Info" })

    expect(() =>
      emitEffectShape(compileContract(api(HttpApiEndpoint.get("get", "/session", { success: Info }))), {
        typeReferences: [
          {
            schema: Info,
            name: "SessionApi.Info",
            import: 'import type { SessionApi } from "@example/schema/session"',
          },
        ],
      }),
    ).toThrow("Generated Effect type collides with imported type: SessionApi")
  })

  test("rejects imported endpoints colliding with generated adapter values", () => {
    const contract = compileContract(api(HttpApiEndpoint.get("session.get", "/session", { success: Schema.String })))

    expect(() =>
      emitEffectImported(contract, {
        module: "@example/api",
        endpoints: { "session.session.get": "EndpointSessionGet" },
      }),
    ).toThrow("Generated Effect adapter collides with imported endpoint: EndpointSessionGet")
    expect(() =>
      emitEffectImported(contract, {
        module: "@example/api",
        api: "EndpointSessionGet",
      }),
    ).toThrow("Generated Effect adapter collides with imported endpoint: EndpointSessionGet")
  })

  test("exposes an imported Effect client through its generated shape", () => {
    const output = emitEffectImported(
      compileContract(api(HttpApiEndpoint.get("get", "/session", { success: Schema.String }))),
      { module: "@example/api", api: "Api", shapeModule: "../api" },
    )
    const source = output.files.find((file) => file.path === "client.ts")?.content

    expect(source).toContain('import type { SessionGetOutput } from "../api"')
    expect(source).toContain("preserveEffect<SessionGetOutput>()")
  })

  test("projects imported endpoint constants into a generated API", () => {
    const output = emitEffectImported(
      compileContract(
        api(
          HttpApiEndpoint.get("get", "/session/:sessionID", {
            params: { sessionID: Schema.String },
            success: Schema.Struct({ data: Schema.String }),
          }),
        ),
      ),
      { module: "@example/api", endpoints: { "session.get": "SessionGet" } },
    )
    const client = output.files.find((file) => file.path === "client.ts")?.content

    expect(client).toContain('import { SessionGet } from "@example/api"')
    expect(client).toContain('const Api = HttpApi.make("generated").add(HttpApiGroup.make("session").add(SessionGet))')
  })

  test("imports an authoritative group without reconstructing it", () => {
    const output = emitEffectImported(
      compileContract(
        api(
          HttpApiEndpoint.get("get", "/session/:sessionID", {
            params: { sessionID: Schema.String },
            success: Schema.String,
          }),
        ),
      ),
      { module: "@example/api", group: "SessionGroup" },
    )
    const client = output.files.find((file) => file.path === "client.ts")?.content

    expect(client).toContain('import { SessionGroup } from "@example/api"')
    expect(client).toContain('const Api = HttpApi.make("generated").add(SessionGroup)')
    expect(client).not.toContain("HttpApiGroup")
  })

  test("separates hosted and consumer group names", () => {
    const source = HttpApi.make("test").add(
      HttpApiGroup.make("server.session").add(
        HttpApiEndpoint.get("session.get", "/session", { success: Schema.String }),
      ),
    )
    const contract = compileContract(source, { groupNames: { "server.session": "sessions" } })

    expect(contract.groups[0]?.identifier).toBe("sessions")
    expect(contract.groups[0]?.sourceIdentifier).toBe("server.session")
    expect(contract.groups[0]?.endpoints[0]?.operation).toMatchObject({ group: "sessions", name: "get" })
  })

  test("derives nested paths from OpenAPI operation IDs", () => {
    const source = HttpApi.make("test").add(
      HttpApiGroup.make("server.session").add(
        HttpApiEndpoint.get("internal.stage", "/session/revert/stage", { success: Schema.String }).annotateMerge(
          OpenApi.annotations({ identifier: "v2.session.revert.stage" }),
        ),
      ),
    )
    const contract = compileContract(source, { groupNames: { "server.session": "session" } })

    expect(contract.groups[0]?.endpoints[0]?.clientPath).toEqual(["revert", "stage"])
    expect(OpenApi.fromApi(source).paths["/session/revert/stage"]?.get?.operationId).toBe("v2.session.revert.stage")
  })

  test("uses nested OpenAPI operation IDs across emitters", () => {
    const source = HttpApi.make("test").add(
      HttpApiGroup.make("server.session")
        .add(
          HttpApiEndpoint.get("list", "/session/instructions", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "v2.session.instructions.list" }),
          ),
        )
        .add(
          HttpApiEndpoint.put("put", "/session/instructions", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "v2.session.instructions.put" }),
          ),
        )
        .add(
          HttpApiEndpoint.delete("remove", "/session/instructions", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "v2.session.instructions.remove" }),
          ),
        ),
    )
    const contract = compileContract(source, { groupNames: { "server.session": "session" } })

    expect(contract.groups[0]?.endpoints.map((endpoint) => endpoint.clientPath)).toEqual([
      ["instructions", "list"],
      ["instructions", "put"],
      ["instructions", "remove"],
    ])
    expect(contract.groups[0]?.endpoints.map((endpoint) => endpoint.operation.name)).toEqual([
      "instructions.list",
      "instructions.put",
      "instructions.remove",
    ])

    const promise = emitPromise(contract, {
      outputTypes: {
        "session.instructions.list": {
          name: "InstructionListWire",
          import: 'import type { InstructionListWire } from "./instruction-list-wire"',
        },
      },
    })
    const promiseClient = promise.files.find((file) => file.path === "client.ts")?.content
    const promiseTypes = promise.files.find((file) => file.path === "types.ts")?.content
    expect(promiseClient).toContain('"session": { "instructions": { "list": (requestOptions?: RequestOptions)')
    expect(promiseClient).toContain('"put": (requestOptions?: RequestOptions)')
    expect(promiseClient).toContain('"remove": (requestOptions?: RequestOptions)')
    expect(promiseTypes).toContain('import type { InstructionListWire } from "./instruction-list-wire"')
    expect(promiseTypes).toContain("export type SessionInstructionsListOutput = InstructionListWire")
    expect(promiseTypes).toContain("export type SessionInstructionsPutOutput = string")
    expect(promiseTypes).toContain("export type SessionInstructionsRemoveOutput = string")

    const effect = emitEffect(contract)
    expect(effect.files.find((file) => file.path === "session.ts")?.content).toContain(
      '"instructions": { "list": EndpointInstructionsList(raw), "put": EndpointInstructionsPut(raw), "remove": EndpointInstructionsRemove(raw) }',
    )

    const imported = emitEffectImported(contract, { module: "@example/api", api: "Api" })
    expect(imported.files.find((file) => file.path === "client.ts")?.content).toContain(
      '"instructions": { "list": EndpointSessionInstructionsList(raw), "put": EndpointSessionInstructionsPut(raw), "remove": EndpointSessionInstructionsRemove(raw) }',
    )

    const shape = emitEffectShape(contract)
    const apiShape = shape.files.find((file) => file.path === "api.ts")?.content
    expect(apiShape).toContain('readonly "instructions": { readonly "list": SessionInstructionsListOperation<E>')
    expect(apiShape).toContain('readonly "put": SessionInstructionsPutOperation<E>')
    expect(apiShape).toContain('readonly "remove": SessionInstructionsRemoveOperation<E>')
  })

  test("executes nested Promise operation IDs", async () => {
    const source = HttpApi.make("test").add(
      HttpApiGroup.make("session")
        .add(
          HttpApiEndpoint.get("list", "/session/instructions", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "session.instructions.list" }),
          ),
        )
        .add(
          HttpApiEndpoint.put("put", "/session/instructions", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "session.instructions.put" }),
          ),
        )
        .add(
          HttpApiEndpoint.delete("remove", "/session/instructions", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "session.instructions.remove" }),
          ),
        ),
    )
    const output = emitPromise(compileContract(source))
    await using emitted = await emittedModule(output)
    const methods: Array<string> = []

    const client = emitted.module.OpenCode.make({
      baseUrl: "https://example.com",
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        methods.push(init?.method ?? "GET")
        return Response.json("ok")
      },
    })

    expect(await client.session.instructions.list()).toBe("ok")
    expect(await client.session.instructions.put()).toBe("ok")
    expect(await client.session.instructions.remove()).toBe("ok")
    expect(methods).toEqual(["GET", "PUT", "DELETE"])
  })

  test("rejects duplicate and leaf-namespace endpoint paths", () => {
    const source = HttpApi.make("test").add(
      HttpApiGroup.make("session")
        .add(
          HttpApiEndpoint.get("first", "/first", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "session.instructions.list" }),
          ),
        )
        .add(
          HttpApiEndpoint.get("second", "/second", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "session.instructions.list" }),
          ),
        ),
    )

    expect(() => compileContract(source)).toThrow("Client endpoint name collision: session.instructions.list")
  })

  test("rejects nested root collisions across top-level groups", () => {
    const source = HttpApi.make("test")
      .add(
        HttpApiGroup.make("first", { topLevel: true }).add(
          HttpApiEndpoint.get("first.list", "/first", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "instructions.list" }),
          ),
        ),
      )
      .add(
        HttpApiGroup.make("second", { topLevel: true }).add(
          HttpApiEndpoint.get("second.put", "/second", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "instructions.put" }),
          ),
        ),
      )

    expect(() => compileContract(source)).toThrow("Client name collision: instructions")
  })

  test("rejects nested paths that collide after type-name normalization", () => {
    const source = HttpApi.make("test").add(
      HttpApiGroup.make("session")
        .add(
          HttpApiEndpoint.get("first", "/first", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "session.foo.bar" }),
          ),
        )
        .add(
          HttpApiEndpoint.get("second", "/second", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "session.foo-bar" }),
          ),
        ),
    )

    expect(() => compileContract(source)).toThrow("Client endpoint type collision: SessionFooBar")
  })

  test("rejects ambiguous and prototype-mutating nested path segments", () => {
    const source = api(
      HttpApiEndpoint.get("get", "/session", { success: Schema.String }).annotateMerge(
        OpenApi.annotations({ identifier: "session.__proto__.get" }),
      ),
    )

    expect(() => compileContract(source)).toThrow("Client endpoint path cannot contain __proto__")
  })

  test("rejects normalized group, operation-key, and group prototype collisions", () => {
    const sanitized = HttpApi.make("test")
      .add(HttpApiGroup.make("foo-bar").add(HttpApiEndpoint.get("get", "/first", { success: Schema.String })))
      .add(HttpApiGroup.make("foo.bar").add(HttpApiEndpoint.get("get", "/second", { success: Schema.String })))
    expect(() => compileContract(sanitized)).toThrow("Client module name collision: foo-bar")

    const normalized = HttpApi.make("test")
      .add(HttpApiGroup.make("foo_bar").add(HttpApiEndpoint.get("get", "/first", { success: Schema.String })))
      .add(HttpApiGroup.make("foo.bar").add(HttpApiEndpoint.get("get", "/second", { success: Schema.String })))
    expect(() => compileContract(normalized)).toThrow("Client group type collision: FooBar")

    const endpointType = HttpApi.make("test")
      .add(
        HttpApiGroup.make("foo").add(
          HttpApiEndpoint.get("first", "/first", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "foo.bar.baz" }),
          ),
        ),
      )
      .add(
        HttpApiGroup.make("fooBar").add(
          HttpApiEndpoint.get("second", "/second", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "fooBar.baz" }),
          ),
        ),
      )
    expect(() => compileContract(endpointType)).toThrow("Client endpoint type collision: FooBarBaz")

    const operationKey = HttpApi.make("test")
      .add(
        HttpApiGroup.make("a.b").add(
          HttpApiEndpoint.get("get", "/first", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "a.b.c" }),
          ),
        ),
      )
      .add(
        HttpApiGroup.make("a").add(
          HttpApiEndpoint.get("b.c", "/second", { success: Schema.String }).annotateMerge(
            OpenApi.annotations({ identifier: "a.b.c" }),
          ),
        ),
      )
    expect(() => compileContract(operationKey)).toThrow("Client operation key collision: a.b.c")

    const prototype = HttpApi.make("test").add(
      HttpApiGroup.make("session").add(HttpApiEndpoint.get("get", "/session", { success: Schema.String })),
    )
    expect(() => compileContract(prototype, { groupNames: { session: "__proto__" } })).toThrow(
      "Client group name cannot be __proto__",
    )
  })

  test("omits custom transport endpoints", () => {
    const source = HttpApi.make("test").add(
      HttpApiGroup.make("server.pty")
        .add(HttpApiEndpoint.get("pty.get", "/pty", { success: Schema.String }))
        .add(HttpApiEndpoint.get("pty.connect", "/pty/connect", { success: Schema.Boolean })),
    )
    const contract = compileContract(source, { omitEndpoints: new Set(["pty.connect"]) })

    expect(contract.groups[0]?.endpoints.map((endpoint) => endpoint.endpoint.identifier)).toEqual(["pty.get"])
  })

  test("uses bracket access for input field names", () => {
    const source = api(
      HttpApiEndpoint.post("token", "/token", {
        headers: { "x-example-token": Schema.Literal("1") },
        success: Schema.String,
      }),
    )
    const contract = compileContract(source)
    const promise = emitPromise(contract).files.find((file) => file.path === "client.ts")?.content
    const effect = emitEffectImported(contract, {
      module: "@example/api",
      endpoints: { "session.token": "Token" },
    }).files.find((file) => file.path === "client.ts")?.content

    expect(promise).toContain('"x-example-token": input["x-example-token"]')
    expect(effect).toContain('"x-example-token": input["x-example-token"]')
  })

  test("rejects consumer group name collisions", () => {
    const source = HttpApi.make("test")
      .add(HttpApiGroup.make("first").add(HttpApiEndpoint.get("one", "/one", { success: Schema.String })))
      .add(HttpApiGroup.make("second").add(HttpApiEndpoint.get("two", "/two", { success: Schema.String })))

    expect(() => compileContract(source, { groupNames: { first: "same", second: "same" } })).toThrow(
      "Client group name collision: same",
    )
  })

  test("uses the unqualified endpoint name for the public client", () => {
    const contract = compileContract(
      api(
        HttpApiEndpoint.get("session.get", "/session/:sessionID", {
          params: { sessionID: Schema.String },
          success: Schema.String,
        }),
      ),
    )
    const promise = emitPromise(contract).files.find((file) => file.path === "client.ts")?.content
    const effect = emitEffectImported(contract, {
      module: "@example/api",
      endpoints: { "session.session.get": "SessionGet" },
    }).files.find((file) => file.path === "client.ts")?.content

    expect(contract.groups[0]?.endpoints[0]?.operation.name).toBe("get")
    expect(promise).toContain('"get": (input: SessionGetInput, requestOptions?: RequestOptions)')
    expect(effect).toContain(
      'const adaptGroupSession = (raw: RawClient["session"]) => ({ "get": EndpointSessionGet(raw) })',
    )
    expect(effect).toContain('raw["session.get"]')
  })

  test("preserves optional keys in Promise error types", () => {
    class OptionalError extends Schema.TaggedError<OptionalError>()(
      "OptionalError",
      { message: Schema.String, detail: Schema.String.pipe(Schema.optional) },
      { httpApiStatus: 400 },
    ) {}
    const output = emitPromise(
      compileContract(api(HttpApiEndpoint.get("get", "/session", { success: Schema.String, error: OptionalError }))),
    )

    expect(output.files.find((file) => file.path === "types.ts")?.content).toContain(
      'readonly "message": string; readonly "detail"?: string | undefined',
    )
  })

  test("supports name-discriminated Promise errors", () => {
    class NamedError extends Schema.Error<NamedError>("NamedError")(
      { name: Schema.Literal("NamedError"), message: Schema.String },
      { httpApiStatus: 400 },
    ) {}
    const output = emitPromise(
      compileContract(
        api(HttpApiEndpoint.get("get", "/session", { success: Schema.NumberFromString, error: NamedError })),
      ),
    )
    const types = output.files.find((file) => file.path === "types.ts")?.content

    expect(types).toContain('readonly "name": "NamedError"')
    expect(types).toContain('"name" in value && value["name"] === "NamedError"')
  })

  test("preserves reflected default error statuses", () => {
    class MissingStatus extends Schema.TaggedError<MissingStatus>()("MissingStatus", {
      message: Schema.String,
    }) {}
    const output = emitPromise(
      compileContract(api(HttpApiEndpoint.get("get", "/session", { success: Schema.String, error: MissingStatus }))),
    )

    expect(output.files.find((file) => file.path === "client.ts")?.content).toContain("declaredStatuses: [500]")
  })

  test("erases brands from Promise wire types", () => {
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.get("get", "/session/:sessionID", {
            params: { sessionID: Schema.String.pipe(Schema.brand("SessionID")) },
            success: Schema.Struct({ data: Schema.String.pipe(Schema.brand("SessionID")) }),
          }),
        ),
      ),
    )
    const types = output.files.find((file) => file.path === "types.ts")?.content

    expect(types).toContain('readonly "sessionID": string')
    expect(types).not.toContain("Brand")
  })

  test("preserves suggestions for open string unions in Promise wire types", () => {
    const Field = Schema.Union([Schema.Literals(["reasoning", "reasoning_content"]), Schema.String]).annotate({
      identifier: "Field",
    })
    const output = emitPromise(
      compileContract(api(HttpApiEndpoint.get("get", "/model", { success: Schema.Struct({ field: Field }) }))),
    )

    expect(output.files.find((file) => file.path === "types.ts")?.content).toContain(
      'export type Field = "reasoning" | "reasoning_content" | (string & {})',
    )
  })

  test("retains non-recursive references in Promise wire types", () => {
    const Referenced = Schema.Struct({ value: Schema.String }).annotate({ identifier: "Referenced" })
    const output = emitPromise(
      compileContract(
        HttpApi.make("test").add(
          HttpApiGroup.make("session")
            .add(HttpApiEndpoint.get("get", "/session", { success: Schema.Struct({ data: Referenced }) }))
            .add(
              HttpApiEndpoint.get("list", "/sessions", {
                success: Schema.Struct({ data: Schema.Array(Referenced) }),
              }),
            ),
        ),
      ),
    )

    const types = output.files.find((file) => file.path === "types.ts")?.content
    expect(types).toContain('export type Referenced = { readonly "value": string }')
    expect(types).toContain('export type SessionGetOutput = ({ readonly "data": Referenced })["data"]')
    expect(types).not.toContain("Referenced1")
  })

  test("inlines shared anonymous Promise wire types", () => {
    const Shared = Schema.Struct({ value: Schema.String })
    const output = emitPromise(
      compileContract(
        api(HttpApiEndpoint.get("get", "/session", { success: Schema.Struct({ first: Shared, second: Shared }) })),
      ),
    )
    const types = output.files.find((file) => file.path === "types.ts")?.content

    expect(types).toContain('readonly "first": { readonly "value": string }')
    expect(types).toContain('readonly "second": { readonly "value": string }')
    expect(types).not.toContain("export type Objects")
  })

  test("emits mutable Promise outputs without restricting inputs", () => {
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.post("create", "/session", {
            payload: Schema.Struct({ values: Schema.Array(Schema.String) }),
            success: Schema.Struct({ data: Schema.Array(Schema.Struct({ values: Schema.Array(Schema.String) })) }),
          }),
        ),
      ),
      { mutableOutputs: true },
    )
    const types = output.files.find((file) => file.path === "types.ts")?.content

    expect(types).toContain('readonly "values": ReadonlyArray<string>')
    expect(types).toContain(
      'export type SessionCreateOutput = ({ "data": Array<{ "values": Array<string> }> })["data"]',
    )
  })

  test("retains distinct Promise references at identifier boundaries", () => {
    const Session = Schema.Struct({ name: Schema.Literal("Session"), id: Schema.String }).annotate({
      identifier: "Session",
    })
    const SessionID = Schema.String.annotate({ identifier: "SessionID" })
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.get("get", "/session", {
            success: Schema.Struct({ session: Session, sessionID: SessionID }),
          }),
        ),
      ),
    )

    const types = output.files.find((file) => file.path === "types.ts")?.content
    expect(types).toContain('export type Session = { readonly "name": "Session", readonly "id": string }')
    expect(types).toContain("export type SessionID = string")
    expect(types).toContain('readonly "session": Session, readonly "sessionID": SessionID')
  })

  test("disambiguates flattened Promise reference names", () => {
    const First = Schema.String.annotate({ identifier: "ExampleName" })
    const Second = Schema.String.annotate({ identifier: "Example_Name" })
    const output = emitPromise(
      compileContract(
        api(HttpApiEndpoint.get("get", "/session", { success: Schema.Struct({ first: First, second: Second }) })),
      ),
    )
    const types = output.files.find((file) => file.path === "types.ts")?.content

    expect(types).toContain("export type ExampleName = string")
    expect(types).toContain("export type ExampleName2 = string")
  })

  test("keeps conflicting Promise reference identifiers distinct", () => {
    const First = Schema.Struct({ value: Schema.String }).annotate({ identifier: "Shared" })
    const Second = Schema.Struct({ value: Schema.Number }).annotate({ identifier: "Shared" })

    const output = emitPromise(
      compileContract(
        api(HttpApiEndpoint.get("get", "/session", { success: Schema.Struct({ first: First, second: Second }) })),
      ),
    )
    const types = output.files.find((file) => file.path === "types.ts")?.content

    expect(types).toContain('export type Shared = { readonly "value": string }')
    expect(types).toContain('export type Shared1 = { readonly "value": number }')
    expect(types).toContain('readonly "first": Shared, readonly "second": Shared1')
  })

  test("deduplicates equivalent Promise references with the same identifier", () => {
    const First = Schema.String.annotate({ identifier: "Shared", description: "first" })
    const Second = Schema.String.annotate({ identifier: "Shared", description: "second" })
    const output = emitPromise(
      compileContract(
        api(HttpApiEndpoint.get("get", "/session", { success: Schema.Struct({ first: First, second: Second }) })),
      ),
    )
    const types = output.files.find((file) => file.path === "types.ts")?.content

    expect(types).toContain("export type Shared = string")
    expect(types).not.toContain("export type Shared1")
    expect(types).toContain('readonly "first": Shared, readonly "second": Shared')
  })

  test("emits Effect Json schemas as standalone Promise types", () => {
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.get("get", "/session", {
            success: Schema.Json,
          }),
        ),
      ),
    )
    const types = output.files.find((file) => file.path === "types.ts")?.content

    expect(types).toContain("export type JsonValue =")
    expect(types).toContain("{ readonly [key: string]: JsonValue }")
    expect(types).not.toContain("Schema.Json")
  })

  test("emits an optional Promise input when every field is optional", () => {
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.get("list", "/session", {
            query: { limit: Schema.optional(Schema.Number) },
            success: Schema.Array(Schema.String),
          }),
        ),
      ),
    )

    expect(output.files.find((file) => file.path === "client.ts")?.content).toContain(
      '"list": (input?: SessionListInput, requestOptions?: RequestOptions)',
    )
  })

  test("rejects Promise transports that are not implemented", () => {
    expect(() =>
      emitPromise(
        compileContract(
          api(
            HttpApiEndpoint.get("text", "/text", {
              success: Schema.String.pipe(HttpApiSchema.asText()),
            }),
          ),
        ),
      ),
    ).toThrow("Unsupported Promise success encoding: session.text")

    expect(() =>
      emitPromise(compileContract(api(HttpApiEndpoint.get("read", "/file/*/tail", { success: Schema.String })))),
    ).toThrow("Unsupported Promise path wildcard: /file/*/tail")

    expect(() =>
      emitPromise(
        compileContract(
          api(
            HttpApiEndpoint.get("events", "/events", {
              success: HttpApiSchema.StreamSse({ data: Schema.String, error: Missing }),
            }),
          ),
        ),
      ),
    ).toThrow("Unsupported Promise stream: session.events")
  })

  test("executes an emitted Promise GET through fetch", async () => {
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.get("get", "/session/:sessionID", {
            params: { sessionID: Schema.String },
            success: Schema.Struct({ data: Schema.String }),
          }),
        ),
      ),
    )
    await using emitted = await emittedModule(output)
    let request: Request | undefined
    const client = emitted.module.OpenCode.make({
      baseUrl: "https://example.com",
      fetch: async (input: RequestInfo | URL) => {
        request = input instanceof Request ? input : new Request(input)
        return Response.json({ data: "hello" })
      },
    })

    expect(await client.session.get({ sessionID: "a/b" })).toBe("hello")
    expect(request?.method).toBe("GET")
    expect(request?.url).toBe("https://example.com/session/a%2Fb")
  })

  test("maps an emitted no-content response to undefined", async () => {
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.post("interrupt", "/session/:sessionID/interrupt", {
            params: { sessionID: Schema.String },
            success: HttpApiSchema.NoContent,
          }),
        ),
      ),
    )
    await using emitted = await emittedModule(output)
    const client = emitted.module.OpenCode.make({
      baseUrl: "https://example.com",
      fetch: async () => new Response(null, { status: 204 }),
    })

    expect(await client.session.interrupt({ sessionID: "session" })).toBeUndefined()
  })

  test("executes an emitted binary wildcard GET through fetch", async () => {
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.get("read", "/file/*", {
            query: { token: Schema.optional(Schema.String) },
            success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
          }),
        ),
      ),
    )
    await using emitted = await emittedModule(output)
    let request: Request | undefined
    const client = emitted.module.OpenCode.make({
      baseUrl: "https://example.com",
      fetch: async (input: RequestInfo | URL) => {
        request = input instanceof Request ? input : new Request(input)
        return new Response(new Uint8Array([1, 2, 3]))
      },
    })

    const result = await client.session.read({ path: "src/a b#c.ts", token: "x/y" })
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Array.from(result)).toEqual([1, 2, 3])
    expect(request?.method).toBe("GET")
    expect(request?.url).toBe("https://example.com/file/src/a%20b%23c.ts?token=x%2Fy")
  })

  test("serializes flattened query, header, and JSON payload inputs", async () => {
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.post("prompt", "/session/:sessionID", {
            params: { sessionID: Schema.String },
            query: { resume: Schema.optional(Schema.Boolean) },
            headers: { traceID: Schema.String },
            payload: Schema.Struct({ prompt: Schema.String }),
            success: Schema.Struct({ data: Schema.String }),
          }),
        ),
      ),
    )
    await using emitted = await emittedModule(output)
    let request: Request | undefined
    const client = emitted.module.OpenCode.make({
      baseUrl: "https://example.com",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        request = input instanceof Request ? input : new Request(input, init)
        return Response.json({ data: "admitted" })
      },
    })

    expect(await client.session.prompt({ sessionID: "session", resume: true, traceID: "trace", prompt: "hello" })).toBe(
      "admitted",
    )
    expect(request?.url).toBe("https://example.com/session/session?resume=true")
    expect(request?.headers.get("traceID")).toBe("trace")
    expect(await request?.json()).toEqual({ prompt: "hello" })
  })

  test("serializes an opaque union payload as the direct JSON body", async () => {
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.post("configure", "/session", {
            payload: Schema.Union([
              Schema.Struct({ type: Schema.Literal("local"), command: Schema.Array(Schema.String) }),
              Schema.Struct({ type: Schema.Literal("remote"), url: Schema.String }),
            ]),
            success: HttpApiSchema.NoContent,
          }),
        ),
      ),
    )
    await using emitted = await emittedModule(output)
    let request: Request | undefined
    const client = emitted.module.OpenCode.make({
      baseUrl: "https://example.com",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        request = input instanceof Request ? input : new Request(input, init)
        return new Response(null, { status: 204 })
      },
    })

    await client.session.configure({ payload: { type: "local", command: ["opencode"] } })

    expect(await request?.json()).toEqual({ type: "local", command: ["opencode"] })
  })

  test("serializes explicit null query values", async () => {
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.get("list", "/session", {
            query: { parentID: Schema.optional(Schema.NullOr(Schema.String)) },
            success: Schema.Struct({ data: Schema.Array(Schema.String) }),
          }),
        ),
      ),
    )
    await using emitted = await emittedModule(output)
    let request: Request | undefined
    const client = emitted.module.OpenCode.make({
      baseUrl: "https://example.com",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        request = input instanceof Request ? input : new Request(input, init)
        return Response.json({ data: [] })
      },
    })

    await client.session.list({ parentID: null })

    expect(request?.url).toBe("https://example.com/session?parentID=null")
  })

  test("rejects with declared tagged errors and exports a type guard", async () => {
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.get("get", "/session/:sessionID", {
            params: { sessionID: Schema.String },
            success: Schema.Struct({ data: Schema.String }),
            error: Missing.pipe(HttpApiSchema.status(404)),
          }),
        ),
      ),
    )
    await using emitted = await emittedModule(output)
    const client = emitted.module.OpenCode.make({
      baseUrl: "https://example.com",
      fetch: async () => Response.json({ _tag: "Missing", message: "gone" }, { status: 404 }),
    })

    const error = await client.session.get({ sessionID: "missing" }).catch((cause: unknown) => cause)
    expect(error).toEqual({ _tag: "Missing", message: "gone" })
    expect(emitted.module.isMissing(error)).toBeTrue()
  })

  test("iterates an emitted SSE stream lazily without reconnecting", async () => {
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.get("subscribe", "/event", {
            query: { after: Schema.optional(Schema.Number) },
            success: HttpApiSchema.StreamSse({
              data: Schema.Struct({ type: Schema.String, count: Schema.NumberFromString }),
            }),
          }),
        ),
      ),
    )
    await using emitted = await emittedModule(output)
    let requests = 0
    let url: string | undefined
    const client = emitted.module.OpenCode.make({
      baseUrl: "https://example.com",
      fetch: async (input: RequestInfo | URL) => {
        requests++
        url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"type":"ready","count":"1"}\r'))
              controller.enqueue(encoder.encode("\n\r\n"))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const events = client.session.subscribe({ after: 2 })

    expect(requests).toBe(0)
    const received = []
    for await (const event of events) received.push(event)
    expect(received).toEqual([{ type: "ready", count: "1" }])
    expect(requests).toBe(1)
    expect(url).toBe("https://example.com/event?after=2")
  })

  test("preserves public group and endpoint identifiers exactly", () => {
    const output = compile(
      HttpApi.make("test").add(
        HttpApiGroup.make("session").add(HttpApiEndpoint.get("get", "/session/:sessionID", { success: Schema.String })),
      ),
    )

    expect(output.operations[0]).toMatchObject({ group: "session", name: "get" })
  })

  test("emits one client module per HttpApi group", () => {
    const source = HttpApi.make("test")
      .add(HttpApiGroup.make("session").add(HttpApiEndpoint.get("get", "/session", { success: Schema.String })))
      .add(HttpApiGroup.make("tool").add(HttpApiEndpoint.get("list", "/tool", { success: Schema.String })))

    const output = compile(source)

    expect(output.files.map((file) => file.path)).toEqual([
      "session.ts",
      "tool.ts",
      "client-error.ts",
      "client.ts",
      "index.ts",
    ])
  })

  test("emits syntactically valid TypeScript modules", () => {
    const output = compile(
      api(
        HttpApiEndpoint.get("get", "/session/:sessionID", {
          params: { sessionID: Schema.String },
          success: Schema.Struct({ data: Schema.String }),
        }),
      ),
    )
    const transpiler = new Bun.Transpiler({ loader: "ts" })

    for (const file of output.files) expect(() => transpiler.transformSync(file.content)).not.toThrow()
  })

  it.live("keeps the strict generated-consumer fixture current", () =>
    Effect.gen(function* () {
      const output = compile(FixtureApi)
      const actual = yield* Effect.promise(() =>
        Array.fromAsync(new Bun.Glob("*.ts").scan(fileURLToPath(new URL("generated", import.meta.url)))),
      )
      expect(actual.sort((a, b) => a.localeCompare(b))).toEqual(
        output.files.map((file) => file.path).sort((a, b) => a.localeCompare(b)),
      )
      yield* Effect.forEach(output.files, (file) =>
        Effect.tryPromise(() =>
          Promise.all([
            Bun.file(new URL(`generated/${file.path}`, import.meta.url)).text(),
            format(file.content, { parser: "typescript", semi: false, printWidth: 120 }),
          ]),
        ).pipe(Effect.map(([content, expected]) => expect(content).toBe(expected))),
      )
    }),
  )

  test("flattens transport input channels into one domain input", () => {
    const output = compile(
      api(
        HttpApiEndpoint.post("prompt", "/session/:sessionID", {
          params: { sessionID: Schema.String },
          query: { resume: Schema.String },
          headers: { traceID: Schema.String },
          payload: Schema.Struct({ prompt: Schema.String }),
          success: Schema.Struct({ data: Schema.String }),
        }),
      ),
    )

    expect(output.operations[0]?.input).toEqual([
      { name: "sessionID", source: "params" },
      { name: "resume", source: "query" },
      { name: "traceID", source: "headers" },
      { name: "prompt", source: "payload" },
    ])
    expect(output.files.find((file) => file.path === "session.ts")?.content).toContain(
      'params: { "sessionID": input["sessionID"] }',
    )
  })

  test("uses one opaque field for non-struct payloads across emitters", () => {
    const source = api(
      HttpApiEndpoint.post("configure", "/session/configure", {
        payload: Schema.Union([
          Schema.Struct({ type: Schema.Literal("local"), command: Schema.Array(Schema.String) }),
          Schema.Struct({ type: Schema.Literal("remote"), url: Schema.String }),
        ]),
        success: Schema.String,
      }),
    )
    const contract = compileContract(source)
    const effect = emitEffect(contract)
    const imported = emitEffectImported(contract, { module: "@example/api", api: "Api" })
    const shape = emitEffectShape(contract)
    const promise = emitPromise(contract)

    expect(effect.operations[0]).toMatchObject({
      input: [{ name: "payload", source: "payload" }],
      inputMode: "required",
    })
    expect(effect.files.find((file) => file.path === "session.ts")?.content).toContain('payload: input["payload"]')
    expect(imported.files.find((file) => file.path === "client.ts")?.content).toContain('payload: input["payload"]')
    expect(shape.files[0]?.content).toContain(
      'readonly "payload": { readonly "type": "local", readonly "command": ReadonlyArray<string> }',
    )
    expect(promise.files.find((file) => file.path === "types.ts")?.content).toContain(
      'readonly "payload": { readonly "type": "local", readonly "command": ReadonlyArray<string> } | { readonly "type": "remote", readonly "url": string }',
    )
    expect(promise.files.find((file) => file.path === "client.ts")?.content).toContain('body: input["payload"]')
  })

  test("routes arrays, primitives, and index-signature records through the opaque payload path", () => {
    for (const payload of [Schema.Array(Schema.String), Schema.String, Schema.Record(Schema.String, Schema.Number)]) {
      expect(
        compileContract(api(HttpApiEndpoint.post("set", "/session", { payload, success: HttpApiSchema.NoContent })))
          .groups[0]?.endpoints[0]?.operation.input,
      ).toEqual([{ name: "payload", source: "payload" }])
    }
  })

  test("rejects an opaque payload field that collides with another input channel", () => {
    expect(() =>
      compileContract(
        api(
          HttpApiEndpoint.post("configure", "/session", {
            query: { payload: Schema.String },
            payload: Schema.Union([Schema.String, Schema.Number]),
            success: Schema.String,
          }),
        ),
      ),
    ).toThrow("Opaque payload field collision: session.configure.payload conflicts with query.payload")
  })

  test("preserves required empty struct payloads in imported Effect adapters", () => {
    const contract = compileContract(
      api(
        HttpApiEndpoint.post("empty", "/session", {
          payload: Schema.Struct({}),
          success: Schema.String,
        }),
      ),
    )
    const effect = emitEffectImported(contract, { module: "@example/api", api: "Api" })
    const promise = emitPromise(contract)

    expect(effect.files.find((file) => file.path === "client.ts")?.content).toContain("payload: { }")
    expect(promise.files.find((file) => file.path === "client.ts")?.content).toContain("body: { }")
  })

  test("uses no argument when an operation has no input fields", () => {
    const output = compile(api(HttpApiEndpoint.get("health", "/health", { success: Schema.String })))

    expect(output.operations[0]?.inputMode).toBe("none")
  })

  test("uses an optional object when every input field is optional", () => {
    const output = compile(
      api(
        HttpApiEndpoint.get("list", "/session", {
          query: { limit: Schema.optional(Schema.String) },
          success: Schema.Array(Schema.String),
        }),
      ),
    )

    expect(output.operations[0]?.inputMode).toBe("optional")
    expect(output.files.find((file) => file.path === "session.ts")?.content).toContain('input?.["limit"]')
  })

  test("regenerates standard HttpApi transport codecs from decoded schemas", () => {
    const output = compile(
      api(
        HttpApiEndpoint.get("list", "/session", {
          query: { archived: Schema.optional(Schema.Boolean) },
          success: Schema.String,
        }),
      ),
    )

    expect(output.files.find((file) => file.path === "session.ts")?.content).toContain("Schema.Boolean")
  })

  test("uses a required object when any input field is required", () => {
    const output = compile(
      api(
        HttpApiEndpoint.get("get", "/session/:sessionID", {
          params: { sessionID: Schema.String },
          query: { includeArchived: Schema.optional(Schema.String) },
          success: Schema.String,
        }),
      ),
    )

    expect(output.operations[0]?.inputMode).toBe("required")
  })

  test("rejects colliding input names across transport channels", () => {
    expect(() =>
      compile(
        api(
          HttpApiEndpoint.post("prompt", "/session/:id", {
            params: { id: Schema.String },
            payload: Schema.Struct({ id: Schema.String }),
            success: Schema.Void,
          }),
        ),
      ),
    ).toThrow("Input field collision: id")
  })

  test("rejects multiple payload alternatives until selection semantics are explicit", () => {
    expect(() =>
      compile(
        api(
          HttpApiEndpoint.post("prompt", "/session", {
            payload: [Schema.Struct({ text: Schema.String }), Schema.Struct({ count: Schema.Number })],
            success: Schema.String,
          }),
        ),
      ),
    ).toThrow("Multiple payload schemas: session.prompt")
  })

  test("unwraps an exact data success envelope", () => {
    const output = compile(
      api(
        HttpApiEndpoint.get("get", "/session/:sessionID", {
          params: { sessionID: Schema.String },
          success: Schema.Struct({ data: Schema.String }),
        }),
      ),
    )

    expect(output.operations[0]?.success).toBe("value")
    expect(output.files.find((file) => file.path === "session.ts")?.content).toContain(
      "Effect.map((value) => value.data)",
    )
  })

  test("maps no-content success to void", () => {
    const output = compile(
      api(HttpApiEndpoint.post("interrupt", "/session/:sessionID/interrupt", { success: HttpApiSchema.NoContent })),
    )

    expect(output.operations[0]?.success).toBe("void")
    expect(output.files.find((file) => file.path === "session.ts")?.content).toContain('"httpApiStatus": 204')
  })

  test("preserves non-default empty response statuses", () => {
    const output = compile(api(HttpApiEndpoint.post("create", "/session", { success: HttpApiSchema.Created })))

    expect(output.files.find((file) => file.path === "session.ts")?.content).toContain('"httpApiStatus": 201')
  })

  test("returns a non-envelope success unchanged", () => {
    const output = compile(api(HttpApiEndpoint.get("health", "/health", { success: Schema.String })))

    expect(output.operations[0]?.success).toBe("value")
  })

  test("rejects multiple success shapes until their public semantics are explicit", () => {
    expect(() =>
      compile(
        api(
          HttpApiEndpoint.get("get", "/session", {
            success: [Schema.String, Schema.Number],
          }),
        ),
      ),
    ).toThrow("Multiple success schemas: session.get")
  })

  test("models an SSE success as a direct stream", () => {
    const output = compile(
      api(
        HttpApiEndpoint.get("subscribe", "/event", {
          success: HttpApiSchema.StreamSse({ data: Schema.Struct({ type: Schema.String }) }),
        }),
      ),
    )

    expect(output.operations[0]?.success).toBe("stream")
  })

  test("emits opaque Promise SSE fields as any", () => {
    const output = emitPromise(
      compileContract(
        api(
          HttpApiEndpoint.get("subscribe", "/event", {
            success: HttpApiSchema.StreamSse({
              data: Schema.Struct({
                metadata: Schema.Record(Schema.String, Schema.Unknown),
                label: Schema.Literal("unknown"),
              }),
            }),
          }),
        ),
      ),
    )
    const types = output.files.find((file) => file.path === "types.ts")?.content

    expect(types).toContain('readonly "metadata": { readonly [x: string]: any }')
    expect(types).toContain('readonly "label": "unknown"')
  })

  test("preserves annotated stream response statuses", () => {
    const output = compile(
      api(
        HttpApiEndpoint.get("subscribe", "/event", {
          success: HttpApiSchema.StreamSse({ data: Schema.String }).pipe(HttpApiSchema.status(202)),
        }),
      ),
    )

    expect(output.files.find((file) => file.path === "session.ts")?.content).toContain(
      ".pipe(HttpApiSchema.status(202))",
    )
  })

  test("rejects schemas whose semantics cannot be emitted exactly", () => {
    const OpaqueUrl = Schema.declare((input): input is URL => input instanceof URL)

    expect(() => compile(api(HttpApiEndpoint.get("get", "/url", { success: OpaqueUrl })))).toThrow(
      "Unportable schema: session.get.success",
    )
  })

  test("rejects custom transformations hidden beneath standard HttpApi codecs", () => {
    const QueryBoolean = Schema.Literals(["yes", "no"]).pipe(
      Schema.decodeTo(Schema.Boolean, {
        decode: SchemaGetter.transform((value) => value === "yes"),
        encode: SchemaGetter.transform((value) => (value ? "yes" : "no")),
      }),
    )

    expect(() =>
      compile(
        api(
          HttpApiEndpoint.get("get", "/session", {
            query: { archived: QueryBoolean },
            success: Schema.String,
          }),
        ),
      ),
    ).toThrow("Effect schema requires authoritative import: session.get")
  })

  test("rejects same-shape custom transformations", () => {
    const Trimmed = Schema.String.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((value) => value.trim()),
        encode: SchemaGetter.transform((value) => value),
      }),
    )

    expect(() => compile(api(HttpApiEndpoint.get("get", "/session", { success: Trimmed })))).toThrow(
      "Effect schema requires authoritative import: session.get",
    )
  })

  test("rejects custom validation checks without portable metadata", () => {
    const Positive = Schema.Number.check(Schema.makeFilter((value) => (value > 0 ? undefined : "positive")))

    expect(() => compile(api(HttpApiEndpoint.get("get", "/session", { success: Positive })))).toThrow(
      "Unportable schema: session.get.success",
    )
  })

  test("rejects spoofed and aborted validation checks", () => {
    const Spoofed = Schema.Number.check(
      Schema.makeFilter(() => "always fails", { meta: { _tag: "isFinite" }, arbitrary: {} }),
    )
    const Aborted = Schema.Number.check(Schema.isFinite().abort())

    expect(() => compile(api(HttpApiEndpoint.get("spoofed", "/session", { success: Spoofed })))).toThrow(
      "Unportable schema: session.spoofed.success",
    )
    expect(() => compile(api(HttpApiEndpoint.get("aborted", "/session", { success: Aborted })))).toThrow(
      "Unportable schema: session.aborted.success",
    )
  })

  test("rejects altered wire-side schemas even when the codec transformation is canonical", () => {
    const JsonNumber = Schema.toCodecJson(Schema.Number)
    const link = JsonNumber.ast.encoding?.[0]
    if (link === undefined) throw new Error("Expected JSON number encoding")
    // This helper is present at runtime but omitted from the public declaration surface.
    const replaceEncoding: unknown = Reflect.get(SchemaAST, "replaceEncoding")
    if (typeof replaceEncoding !== "function") throw new Error("Expected SchemaAST.replaceEncoding")
    const ast: unknown = replaceEncoding(JsonNumber.ast, [
      new SchemaAST.Link(Schema.String.check(Schema.isMinLength(2)).ast, link.transformation),
    ])
    if (!SchemaAST.isAST(ast)) throw new Error("Expected altered schema AST")
    const Altered = Schema.make<Schema.Top>(ast)

    expect(() => compile(api(HttpApiEndpoint.get("get", "/session", { success: Altered })))).toThrow(
      "Effect schema requires authoritative import: session.get",
    )
  })

  test("rejects lexical generation and annotation values", () => {
    const Generated = Schema.declare((input): input is string => typeof input === "string").annotate({
      generation: { runtime: "LocalOnly", Type: "string" },
    })
    const Annotated = Schema.declare((input): input is string => typeof input === "string").annotate({
      custom: () => "local",
    })

    expect(() => compile(api(HttpApiEndpoint.get("generated", "/session", { success: Generated })))).toThrow(
      "Unportable schema: session.generated.success",
    )
    expect(() => compile(api(HttpApiEndpoint.get("annotated", "/session", { success: Annotated })))).toThrow(
      "Unportable schema: session.annotated.success",
    )
  })

  test("preserves errors from server-only middleware", () => {
    class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
    class Authorization extends HttpApiMiddleware.Service<Authorization>()("Authorization", {
      error: Unauthorized,
    }) {}

    const output = compile(
      api(HttpApiEndpoint.get("get", "/session", { success: Schema.String }).middleware(Authorization)),
    )

    expect(output.operations[0]).toBeDefined()
    expect(output.files.find((file) => file.path === "session.ts")?.content).toContain(
      'extends Schema.TaggedError<EndpointGetError0Class>("Unauthorized")',
    )
  })

  test("preserves tagged error response statuses", () => {
    class Missing extends Schema.TaggedError<Missing>()("Missing", {}) {}
    const output = compile(
      api(
        HttpApiEndpoint.get("get", "/session", {
          success: Schema.String,
          error: Missing.pipe(HttpApiSchema.status(404)),
        }),
      ),
    )

    expect(output.files.find((file) => file.path === "session.ts")?.content).toContain(
      'EndpointGetError0Class.annotate({ "httpApiStatus": 404 })',
    )
  })

  test("supports every HttpApi method through the generic constructor", () => {
    const output = compile(api(HttpApiEndpoint.make("TRACE")("trace", "/trace", { success: Schema.String })))

    expect(output.files.find((file) => file.path === "session.ts")?.content).toContain('HttpApiEndpoint.make("TRACE")')
  })

  test("uses safe identity-derived module paths without changing public group identifiers", () => {
    const output = compile(
      HttpApi.make("test")
        .add(HttpApiGroup.make("../session").add(HttpApiEndpoint.get("get", "/session", { success: Schema.String })))
        .add(HttpApiGroup.make("GROUP-0").add(HttpApiEndpoint.get("list", "/session", { success: Schema.String }))),
    )

    expect(output.files.slice(0, 2).map((file) => file.path)).toEqual(["session.ts", "GROUP-0.ts"])
    expect(output.files[0]?.content).toContain('HttpApiGroup.make("../session"')
  })

  test("prefixes group modules that collide with support or Windows-reserved names", () => {
    const output = compile(
      HttpApi.make("test")
        .add(HttpApiGroup.make("INDEX").add(HttpApiEndpoint.get("get", "/index", { success: Schema.String })))
        .add(HttpApiGroup.make("CON").add(HttpApiEndpoint.get("get", "/con", { success: Schema.String }))),
    )

    expect(output.files.slice(0, 2).map((file) => file.path)).toEqual(["group-INDEX.ts", "group-CON.ts"])
  })

  test("rejects module names colliding after normalization", () => {
    expect(() =>
      compile(
        HttpApi.make("test")
          .add(HttpApiGroup.make("my.group").add(HttpApiEndpoint.get("first", "/first", { success: Schema.String })))
          .add(HttpApiGroup.make("my/group").add(HttpApiEndpoint.get("second", "/second", { success: Schema.String }))),
      ),
    ).toThrow("Client module name collision: my-group")
  })

  test("rejects collisions in the flattened client namespace", () => {
    expect(() =>
      compile(
        HttpApi.make("test")
          .add(HttpApiGroup.make("status").add(HttpApiEndpoint.get("get", "/nested", { success: Schema.String })))
          .add(
            HttpApiGroup.make("system", { topLevel: true }).add(
              HttpApiEndpoint.get("status", "/status", { success: Schema.String }),
            ),
          ),
      ),
    ).toThrow("Client name collision: status")
  })

  test("emits a usable raw type for top-level groups", () => {
    const output = compile(
      HttpApi.make("test").add(
        HttpApiGroup.make("health", { topLevel: true }).add(
          HttpApiEndpoint.get("check", "/health", { success: Schema.String }),
        ),
      ),
    )

    expect(output.files[0]?.content).toContain("type RawGroup = HttpApiClient.Client<typeof GroupHealth")
  })

  it.effect("reports compiler failures in the generate Effect", () =>
    Effect.gen(function* () {
      const error = yield* generate(
        api(
          HttpApiEndpoint.get("get", "/url", {
            success: Schema.declare((input): input is URL => input instanceof URL),
          }),
        ),
        {
          directory: "/generated",
        },
      ).pipe(Effect.flip)

      expect(error).toBeInstanceOf(GenerationError)
      if (error instanceof GenerationError) expect(error.reason).toBe("Unportable schema: session.get.success")
    }).pipe(Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({}))),
  )

  test("rejects required client middleware without an adapter", () => {
    class SignedRequest extends HttpApiMiddleware.Service<SignedRequest>()("SignedRequest", {
      requiredForClient: true,
    }) {}

    expect(() =>
      compile(api(HttpApiEndpoint.get("get", "/session", { success: Schema.String }).middleware(SignedRequest))),
    ).toThrow("Client middleware requires adapter: SignedRequest")
  })

  test("maps transport and decode failures to one stable client error", () => {
    const output = compile(
      api(
        HttpApiEndpoint.get("get", "/session", {
          success: Schema.String,
        }),
      ),
    )

    expect(output.operations[0]?.errors).toContain("ClientError")
    expect(output.operations[0]?.errors).not.toContain("HttpClientError")
    expect(output.operations[0]?.errors).not.toContain("SchemaError")
    expect(output.files.find((file) => file.path === "session.ts")?.content).toContain(
      "new ClientError({ cause: error })",
    )
  })
})
