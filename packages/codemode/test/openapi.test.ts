import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { CodeMode, OpenAPI, Tool } from "../src/index.js"
import { inputTypeScript, outputTypeScript } from "../src/tool-schema.js"

const baseUrl = "http://localhost:4096"
type Document = OpenAPI.Document

type Recorded = {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

const opencodeSpec = async (): Promise<Document> => {
  return Bun.file(new URL("./fixtures/opencode-v2-openapi.json", import.meta.url)).json() as Promise<Document>
}

const happyPathSpec = async (): Promise<Document> => {
  return Bun.file(new URL("./fixtures/openapi-happy-path.json", import.meta.url)).json() as Promise<Document>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toolAt = (tools: OpenAPI.Tools, name: string) =>
  name
    .split(".")
    .reduce<
      Tool.Tool<HttpClient.HttpClient> | OpenAPI.Tools | undefined
    >((current, segment) => (current !== undefined && !Tool.isTool(current) ? current[segment] : undefined), tools)

const recordingClient = (respond: (request: HttpClientRequest.HttpClientRequest) => Response) => {
  const requests: Array<Recorded> = []
  const layer = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined
        const url = Option.map(HttpClientRequest.toUrl(request), (resolved) => resolved.toString())
        requests.push({
          method: request.method,
          url: Option.getOrElse(url, () => request.url),
          headers: { ...request.headers },
          body,
        })
        return HttpClientResponse.fromWeb(request, respond(request))
      }),
    ),
  )
  return { requests, layer }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const singleOperation = (operation: Record<string, unknown>, method = "get"): Document => ({
  openapi: "3.1.0",
  paths: {
    "/test": { [method]: { operationId: "test", responses: { 200: { description: "Success" } }, ...operation } },
  },
})

const directionalSpec = (openapi: string): Document => ({
  openapi,
  paths: {
    "/users": {
      post: {
        operationId: "users.create",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
        },
        responses: {
          200: {
            description: "Created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ReadOnlyID: { type: "string", readOnly: true },
      User: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "password", "profile", "generated"],
        properties: {
          id: { type: "string", readOnly: true },
          name: { type: "string" },
          password: { type: "string", writeOnly: true },
          profile: {
            type: "object",
            additionalProperties: false,
            required: ["createdAt", "secret", "label"],
            properties: {
              createdAt: { type: "string", readOnly: true },
              secret: { type: "string", writeOnly: true },
              label: { type: "string" },
            },
          },
          generated: { $ref: "#/components/schemas/ReadOnlyID" },
        },
      },
    },
  },
})

describe("OpenAPI.fromSpec", () => {
  test("covers a representative API from generation through execution", async () => {
    const resolutions: Array<string> = []
    const client = recordingClient((request) => {
      const url = Option.getOrElse(HttpClientRequest.toUrl(request), () => new URL(request.url))
      if (request.method === "POST") {
        return new Response(
          JSON.stringify({ id: "user-2", name: "Grace", email: "grace@example.test", role: "admin" }),
          { status: 201, headers: { "content-type": "application/vnd.example+json" } },
        )
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      if (url.pathname === "/search") {
        return new Response("2 matches", { headers: { "content-type": "text/plain" } })
      }
      return json({ id: "user-1", name: "Ada", email: "ada@example.test", role: "member" })
    })
    const api = OpenAPI.fromSpec({
      spec: await happyPathSpec(),
      baseUrl,
      auth: {
        resolve: ({ name }) => {
          resolutions.push(name)
          return Effect.succeed(
            name === "BearerAuth"
              ? { type: "bearer", token: "bearer-secret" }
              : { type: "apiKey", value: "api-secret" },
          )
        },
      },
    })
    const get = toolAt(api.tools, "users.get")
    const create = toolAt(api.tools, "users.create")
    const search = toolAt(api.tools, "search.run")
    const remove = toolAt(api.tools, "users.remove")

    expect(api.skipped).toEqual([])
    if (!Tool.isTool(get) || !Tool.isTool(create) || !Tool.isTool(search) || !Tool.isTool(remove)) {
      throw new Error("happy-path fixture did not generate every operation")
    }
    expect(inputTypeScript(get)).toBe(
      '{ userId: string; include?: Array<string>; verbose?: boolean; "X-Trace-ID"?: string }',
    )
    expect(inputTypeScript(create)).toBe('{ name: string; email: string; role?: "admin" | "member" }')
    expect(inputTypeScript(search)).toBe("{ filter?: { query: string; page?: number }; tags?: Array<string> }")
    expect(inputTypeScript(remove)).toBe("{ userId: string }")
    expect(outputTypeScript(get)).toContain("id: string")
    expect(outputTypeScript(create)).toContain('role?: "admin" | "member"')
    expect(outputTypeScript(search)).toBe("string")
    expect(outputTypeScript(remove)).toBe("null")

    const result = await Effect.runPromise(
      CodeMode.make({ tools: { api: api.tools } })
        .execute(
          `
          const user = await tools.api.users.get({
            userId: "user-1",
            include: ["profile", "permissions"],
            verbose: true,
            "X-Trace-ID": "trace-1",
          })
          const created = await tools.api.users.create({
            name: "Grace",
            email: "grace@example.test",
            role: "admin",
          })
          const summary = await tools.api.search.run({
            filter: { query: "effect", page: 2 },
            tags: ["typescript", "runtime"],
          })
          const removed = await tools.api.users.remove({ userId: "user-1" })
          return { user, created, summary, removed }
        `,
        )
        .pipe(Effect.provide(client.layer)),
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        user: { id: "user-1", name: "Ada" },
        created: { id: "user-2", name: "Grace" },
        summary: "2 matches",
        removed: null,
      },
    })
    expect(resolutions).toEqual(["BearerAuth", "ApiKey", "BearerAuth"])
    expect(client.requests).toHaveLength(4)

    const getUrl = new URL(client.requests[0]!.url)
    expect(getUrl.pathname).toBe("/users/user-1")
    expect(getUrl.searchParams.get("include")).toBe("profile,permissions")
    expect(getUrl.searchParams.get("verbose")).toBe("true")
    expect(client.requests[0]!.headers["x-trace-id"]).toBe("trace-1")
    expect(client.requests[0]!.headers.authorization).toBe("Bearer bearer-secret")

    const createUrl = new URL(client.requests[1]!.url)
    expect(createUrl.searchParams.get("api_key")).toBe("api-secret")
    expect(client.requests[1]!.body).toEqual({ name: "Grace", email: "grace@example.test", role: "admin" })

    const searchUrl = new URL(client.requests[2]!.url)
    expect(searchUrl.searchParams.get("filter[query]")).toBe("effect")
    expect(searchUrl.searchParams.get("filter[page]")).toBe("2")
    expect(searchUrl.searchParams.getAll("tags")).toEqual(["typescript", "runtime"])
    expect(client.requests[2]!.headers.authorization).toBeUndefined()
    expect(new URL(client.requests[3]!.url).pathname).toBe("/users/user-1")
    expect(client.requests[3]!.headers.authorization).toBe("Bearer bearer-secret")
  })

  test("converts representative opencode operations into the expected tool shape", async () => {
    const spec = await opencodeSpec()
    const result = OpenAPI.fromSpec({ spec, baseUrl })

    expect(result.skipped).toHaveLength(4)
    expect(result.skipped).toContainEqual({
      method: "GET",
      path: "/api/pty/{ptyID}/connect",
      reason: "WebSocket operations are not supported",
    })
    expect(result.skipped.filter((item) => item.reason === "SSE operations are not supported")).toHaveLength(2)
    expect(result.skipped).toContainEqual({
      method: "GET",
      path: "/api/fs/read/*",
      reason: "binary responses are not supported",
    })
    expect(toolAt(result.tools, "v2.health.get")).not.toBeUndefined()
    expect(toolAt(result.tools, "v2.session.get")).not.toBeUndefined()
    expect(toolAt(result.tools, "v2.session.create")).not.toBeUndefined()

    const sessionGet = toolAt(result.tools, "v2.session.get")
    expect(Tool.isTool(sessionGet)).toBe(true)
    if (!Tool.isTool(sessionGet)) throw new Error("v2.session.get was not generated")
    expect(inputTypeScript(sessionGet)).toBe("{ sessionID: string }")
    expect(outputTypeScript(sessionGet)).toContain("id: string")
    expect(outputTypeScript(sessionGet)).toContain("additions: number")

    const switchAgent = toolAt(result.tools, "v2.session.switchAgent")
    expect(Tool.isTool(switchAgent)).toBe(true)
    if (!Tool.isTool(switchAgent)) throw new Error("v2.session.switchAgent was not generated")
    expect(inputTypeScript(switchAgent)).toBe("{ sessionID: string; agent: string }")

    const instructionPut = toolAt(result.tools, "v2.session.instructions.entry.put")
    expect(Tool.isTool(instructionPut)).toBe(true)
    if (!Tool.isTool(instructionPut)) throw new Error("v2.session.instructions.entry.put was not generated")
    expect(inputTypeScript(instructionPut)).toBe("{ sessionID: string; key: string; value: unknown }")
    expect(toolAt(result.tools, "v2_session_instructions_entry_put_2")).toBeUndefined()
    expect(Tool.isTool(toolAt(result.tools, "v2.pty.connect"))).toBe(false)
    expect(toolAt(result.tools, "v2.session.log")).toBeUndefined()
    expect(toolAt(result.tools, "v2.event.subscribe")).toBeUndefined()
    expect(toolAt(result.tools, "v2.fs.read")).toBeUndefined()
    expect(toolAt(result.tools, "v2.pty.connect.token")).not.toBeUndefined()
  })

  test("preserves operation path sanitization and collision handling", () => {
    const response = { responses: { 200: { description: "Success" } } }
    const result = OpenAPI.fromSpec({
      baseUrl,
      spec: {
        openapi: "3.1.0",
        paths: {
          "/first": { get: { ...response, operationId: "group.item" } },
          "/second": { get: { ...response, operationId: "group.item" } },
          "/third": { get: { ...response, operationId: "group..other" } },
        },
      },
    })

    expect(Tool.isTool(toolAt(result.tools, "group.item"))).toBe(true)
    expect(Tool.isTool(toolAt(result.tools, "group_item_2"))).toBe(true)
    expect(Tool.isTool(toolAt(result.tools, "group.operation.other"))).toBe(true)
  })

  test("does not reserve names for unsupported operations between duplicate operation IDs", () => {
    const operation = { operationId: "group.item", responses: { 200: { description: "Success" } } }
    for (const unsupported of [false, true]) {
      const result = OpenAPI.fromSpec({
        baseUrl,
        spec: {
          openapi: "3.1.0",
          paths: {
            "/first": { get: operation },
            ...(unsupported ? { "/unsupported": { get: { ...operation, "x-websocket": true } } } : {}),
            "/last": { get: operation },
          },
        },
      })

      expect(Object.keys(result.tools)).toEqual(["group", "group_item_2"])
      expect(toolAt(result.tools, "group.item")).toMatchObject({ _tag: "CodeModeTool", description: "GET /first" })
      expect(toolAt(result.tools, "group_item_2")).toMatchObject({ _tag: "CodeModeTool", description: "GET /last" })
      expect(result.skipped).toEqual(
        unsupported ? [{ method: "GET", path: "/unsupported", reason: "WebSocket operations are not supported" }] : [],
      )
    }
  })

  test("synthesizes flat operation IDs from methods and paths", () => {
    const response = { responses: { 200: { description: "Success" } } }
    const tools = OpenAPI.fromSpec({
      baseUrl,
      spec: {
        openapi: "3.1.0",
        paths: {
          "/users": { get: response, post: response },
          "/users/{id}": { get: response, patch: response, delete: response },
          "/organizations/{organizationId}/users/{id}": { get: response },
        },
      },
    }).tools

    for (const path of [
      "getUsers",
      "postUsers",
      "getUsersById",
      "patchUsersById",
      "deleteUsersById",
      "getOrganizationsByOrganizationidUsersById",
    ]) {
      expect(Tool.isTool(toolAt(tools, path))).toBe(true)
    }
  })

  test("lets operation parameters override matching path parameters", () => {
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: {
          openapi: "3.1.0",
          paths: {
            "/test": {
              parameters: [{ name: "limit", in: "query", schema: { type: "string" } }],
              get: {
                operationId: "test",
                parameters: [
                  { name: "limit", in: "query", schema: { type: "boolean" } },
                  { name: "limit", in: "query", required: true, schema: { type: "number" } },
                ],
                responses: { 200: { description: "Success" } },
              },
            },
          },
        },
      }).tools,
      "test",
    )

    if (!Tool.isTool(tool)) throw new Error("test was not generated")
    expect(inputTypeScript(tool)).toBe("{ limit: number }")
  })

  test("normalizes OpenAPI 3.0 schemas with Effect", () => {
    const result = OpenAPI.fromSpec({
      baseUrl,
      spec: {
        openapi: "3.0.3",
        paths: {
          "/search": {
            get: {
              operationId: "search",
              parameters: [
                {
                  in: "query",
                  name: "value",
                  schema: { type: "string", nullable: true, minLength: 2 },
                },
              ],
              responses: { 200: { description: "Success" } },
            },
          },
        },
      },
    })
    const search = toolAt(result.tools, "search")

    expect(Tool.isTool(search)).toBe(true)
    if (!Tool.isTool(search)) throw new Error("search was not generated")
    expect(inputTypeScript(search)).toBe("{ value?: string | null }")
    const schema: unknown = search.input
    const input = isRecord(schema) ? schema : {}
    const properties = isRecord(input.properties) ? input.properties : {}
    const value = isRecord(properties.value) ? properties.value : {}
    expect(value.minLength).toBe(2)
  })

  test("preserves schema-local definitions alongside component definitions", () => {
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: {
          openapi: "3.1.0",
          paths: {
            "/test": {
              get: {
                operationId: "test",
                responses: {
                  200: {
                    description: "Success",
                    content: {
                      "application/json": {
                        schema: { $ref: "#/$defs/Local", $defs: { Local: { type: "string" } } },
                      },
                    },
                  },
                },
              },
            },
          },
          components: { schemas: { Global: { type: "number" } } },
        },
      }).tools,
      "test",
    )

    if (!Tool.isTool(tool) || !isRecord(tool.output)) throw new Error("test output was not generated")
    expect(tool.output.$defs).toMatchObject({ Local: { type: "string" }, Global: { type: "number" } })
  })

  test("projects read-only and write-only properties by schema direction", () => {
    for (const version of ["3.0.3", "3.1.0"]) {
      const tool = toolAt(OpenAPI.fromSpec({ baseUrl, spec: directionalSpec(version) }).tools, "users.create")
      if (!Tool.isTool(tool) || !isRecord(tool.input) || !isRecord(tool.output)) {
        throw new Error(`users.create was not generated for OpenAPI ${version}`)
      }

      expect(inputTypeScript(tool)).toBe(
        "{ name: string; password: string; profile: { secret: string; label: string } }",
      )
      expect(outputTypeScript(tool)).toBe(
        "{ id: string; name: string; profile: { createdAt: string; label: string }; generated: string }",
      )

      const requestDefinitions = isRecord(tool.input.$defs) ? tool.input.$defs : {}
      const responseDefinitions = isRecord(tool.output.$defs) ? tool.output.$defs : {}
      const requestUser = isRecord(requestDefinitions.User) ? requestDefinitions.User : {}
      const responseUser = isRecord(responseDefinitions.User) ? responseDefinitions.User : {}
      expect(Object.keys(isRecord(requestUser.properties) ? requestUser.properties : {})).toEqual([
        "name",
        "password",
        "profile",
      ])
      expect(requestUser.required).toEqual(["name", "password", "profile"])
      expect(Object.keys(isRecord(responseUser.properties) ? responseUser.properties : {})).toEqual([
        "id",
        "name",
        "profile",
        "generated",
      ])
      expect(responseUser.required).toEqual(["id", "name", "profile", "generated"])
    }
  })

  test("projects directional annotations through local refs and allOf composition", () => {
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: singleOperation(
          {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["local", "composed", "name"],
                    properties: {
                      local: { $ref: "#/$defs/ReadOnlyValue" },
                      composed: { allOf: [{ $ref: "#/$defs/ReadOnlyValue" }] },
                      name: { type: "string" },
                    },
                    $defs: {
                      ReadOnlyValue: { type: "string", readOnly: true },
                    },
                  },
                },
              },
            },
          },
          "post",
        ),
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool)) throw new Error("test was not generated")

    expect(inputTypeScript(tool)).toBe("{ name: string }")
  })

  test("honors declarations that are siblings of a $ref", () => {
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: {
          openapi: "3.1.0",
          paths: {
            "/test": {
              post: {
                operationId: "test",
                responses: { 200: { description: "Success" } },
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        additionalProperties: false,
                        required: ["record"],
                        properties: {
                          record: {
                            $ref: "#/components/schemas/Base",
                            properties: { extra: { type: "string", readOnly: true }, note: { type: "string" } },
                            required: ["extra", "note", "id"],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          components: {
            schemas: {
              Base: {
                type: "object",
                required: ["id", "name"],
                properties: { id: { type: "string", readOnly: true }, name: { type: "string" } },
              },
            },
          },
        },
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool) || !isRecord(tool.input)) throw new Error("test was not generated")
    const properties = isRecord(tool.input.properties) ? tool.input.properties : {}
    const record = isRecord(properties.record) ? properties.record : {}
    const definitions = isRecord(tool.input.$defs) ? tool.input.$defs : {}
    const base = isRecord(definitions.Base) ? definitions.Base : {}

    expect(Object.keys(isRecord(record.properties) ? record.properties : {})).toEqual(["note"])
    expect(record.required).toEqual(["note"])
    expect(Object.keys(isRecord(base.properties) ? base.properties : {})).toEqual(["name"])
    expect(base.required).toEqual(["name"])
  })

  test("honors directional declarations on intermediate reference hops", () => {
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: {
          ...singleOperation(
            {
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      additionalProperties: false,
                      required: ["secret", "name"],
                      properties: {
                        // Hidden only by the sibling declaration on the middle hop.
                        secret: { $ref: "#/components/schemas/Middle" },
                        name: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
            "post",
          ),
          components: {
            schemas: {
              Middle: { $ref: "#/components/schemas/Plain", readOnly: true },
              Plain: { type: "string" },
            },
          },
        },
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool)) throw new Error("test was not generated")

    expect(inputTypeScript(tool)).toBe("{ name: string }")
  })

  test("projects cyclic component references without hanging", () => {
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: {
          openapi: "3.1.0",
          paths: {
            "/test": {
              post: {
                operationId: "test",
                responses: { 200: { description: "Success" } },
                requestBody: {
                  required: true,
                  content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } },
                },
              },
            },
          },
          components: {
            schemas: {
              Node: {
                type: "object",
                required: ["id", "name", "child"],
                properties: {
                  id: { type: "string", readOnly: true },
                  name: { type: "string" },
                  child: { $ref: "#/components/schemas/Node" },
                },
              },
            },
          },
        },
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool) || !isRecord(tool.input)) throw new Error("test was not generated")
    const definitions = isRecord(tool.input.$defs) ? tool.input.$defs : {}
    const node = isRecord(definitions.Node) ? definitions.Node : {}

    expect(Object.keys(isRecord(node.properties) ? node.properties : {})).toEqual(["name", "child"])
    expect(node.required).toEqual(["name", "child"])
  })

  test("projects diamond-shaped reference graphs in linear time", () => {
    // Each component references the next twice; without memoized hidden-ness this is 2^30 work.
    const depth = 30
    const schemas = Object.fromEntries(
      Array.from({ length: depth }, (_, index) => [
        `C${index}`,
        index === depth - 1
          ? { type: "object", properties: { id: { type: "string", readOnly: true }, name: { type: "string" } } }
          : { allOf: [{ $ref: `#/components/schemas/C${index + 1}` }, { $ref: `#/components/schemas/C${index + 1}` }] },
      ]),
    )
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: {
          openapi: "3.1.0",
          paths: {
            "/test": {
              post: {
                operationId: "test",
                responses: { 200: { description: "Success" } },
                requestBody: {
                  required: true,
                  content: { "application/json": { schema: { $ref: "#/components/schemas/C0" } } },
                },
              },
            },
          },
          components: { schemas },
        },
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool) || !isRecord(tool.input)) throw new Error("test was not generated")
    const definitions = isRecord(tool.input.$defs) ? tool.input.$defs : {}
    const leaf = isRecord(definitions[`C${depth - 1}`]) ? definitions[`C${depth - 1}`] : {}

    expect(Object.keys(isRecord(leaf.properties) ? leaf.properties : {})).toEqual(["name"])
  })

  test("resolves hiding through reference cycles regardless of evaluation order", () => {
    // `Wrap` is hidden only through the cycle member `Loop`; evaluating a property that
    // enters the cycle at `Loop` first must not freeze a provisional result for `Wrap`.
    const schemas = {
      Wrap: { allOf: [{ $ref: "#/components/schemas/Loop" }] },
      Loop: { allOf: [{ $ref: "#/components/schemas/Wrap" }, { readOnly: true }] },
    }
    const body = (properties: Record<string, unknown>) => ({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: [...Object.keys(properties), "name"],
            properties: { ...properties, name: { type: "string" } },
          },
        },
      },
    })
    for (const properties of [
      { a: { $ref: "#/components/schemas/Loop" }, b: { $ref: "#/components/schemas/Wrap" } },
      { a: { $ref: "#/components/schemas/Wrap" }, b: { $ref: "#/components/schemas/Loop" } },
    ]) {
      const tool = toolAt(
        OpenAPI.fromSpec({
          baseUrl,
          spec: { ...singleOperation({ requestBody: body(properties) }, "post"), components: { schemas } },
        }).tools,
        "test",
      )
      if (!Tool.isTool(tool)) throw new Error("test was not generated")

      expect(inputTypeScript(tool)).toBe("{ name: string }")
    }
  })

  test("keeps not, if, and contains subschemas unprojected", () => {
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: singleOperation(
          {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["record"],
                    properties: {
                      record: {
                        type: "object",
                        // Removing `secret` here would turn `not` unsatisfiable and
                        // flip which branch of `if` applies; both must pass through.
                        not: { required: ["secret"], properties: { secret: { type: "string", readOnly: true } } },
                        if: { required: ["kind"], properties: { kind: { type: "string", readOnly: true } } },
                      },
                    },
                  },
                },
              },
            },
          },
          "post",
        ),
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool) || !isRecord(tool.input)) throw new Error("test was not generated")
    const properties = isRecord(tool.input.properties) ? tool.input.properties : {}
    const record: Record<string, unknown> = isRecord(properties.record) ? properties.record : {}

    expect(record.not).toEqual({ required: ["secret"], properties: { secret: { type: "string", readOnly: true } } })
    expect(record.if).toEqual({ required: ["kind"], properties: { kind: { type: "string", readOnly: true } } })
  })

  test("does not hide properties whose direction is declared only in anyOf or oneOf alternatives", () => {
    // Deliberate scope bound: alternatives may apply, so a directional declaration on
    // one alternative does not hide the property; the annotation is preserved as-is.
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: singleOperation(
          {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["choice", "pick"],
                    properties: {
                      choice: { anyOf: [{ type: "string", readOnly: true }, { type: "number" }] },
                      pick: { oneOf: [{ type: "string", readOnly: true }, { type: "number" }] },
                    },
                  },
                },
              },
            },
          },
          "post",
        ),
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool) || !isRecord(tool.input)) throw new Error("test was not generated")
    const properties = isRecord(tool.input.properties) ? tool.input.properties : {}
    const choice: Record<string, unknown> = isRecord(properties.choice) ? properties.choice : {}
    const pick: Record<string, unknown> = isRecord(properties.pick) ? properties.pick : {}

    expect(Object.keys(properties)).toEqual(["choice", "pick"])
    expect(choice.anyOf).toEqual([{ type: "string", readOnly: true }, { type: "number" }])
    expect(pick.oneOf).toEqual([{ type: "string", readOnly: true }, { type: "number" }])
  })

  test("does not misresolve shadowed local $defs when flattening body fields", () => {
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: singleOperation(
          {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["record"],
                    $defs: { Value: { type: "string" } },
                    properties: {
                      record: {
                        type: "object",
                        required: ["x"],
                        properties: { x: { $ref: "#/$defs/Value" } },
                        // Shadows the body-level Value; must not affect the body-rooted projection.
                        $defs: { Value: { type: "string", readOnly: true } },
                      },
                    },
                  },
                },
              },
            },
          },
          "post",
        ),
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool) || !isRecord(tool.input)) throw new Error("test was not generated")
    const properties = isRecord(tool.input.properties) ? tool.input.properties : {}
    const record = isRecord(properties.record) ? properties.record : {}

    expect(Object.keys(isRecord(record.properties) ? record.properties : {})).toEqual(["x"])
    expect(record.required).toEqual(["x"])
  })

  test("projects directional annotations inside parameter schemas", () => {
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: singleOperation({
          parameters: [
            {
              name: "filter",
              in: "query",
              required: true,
              schema: {
                type: "object",
                required: ["state", "id"],
                properties: { state: { type: "string" }, id: { type: "string", readOnly: true } },
              },
            },
          ],
        }),
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool)) throw new Error("test was not generated")

    expect(inputTypeScript(tool)).toBe("{ filter: { state: string } }")
  })

  test("ignores inherited directional annotations", () => {
    const inherited: Record<string, unknown> = { type: "string" }
    Object.setPrototypeOf(inherited, { readOnly: true })
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: singleOperation({
          parameters: [
            {
              name: "filter",
              in: "query",
              required: true,
              schema: {
                type: "object",
                // The own annotation on `id` keeps projection active for the document,
                // so `value` pins that prototype-inherited annotations are not read.
                properties: { value: inherited, id: { type: "string", readOnly: true } },
                required: ["value", "id"],
              },
            },
          ],
        }),
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool)) throw new Error("test was not generated")

    expect(inputTypeScript(tool)).toBe("{ filter: { value: string } }")
  })

  test("cleans required properties across allOf branches", () => {
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: singleOperation(
          {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id", "name"],
                    allOf: [
                      {
                        type: "object",
                        required: ["id", "name"],
                        properties: { id: { type: "string", readOnly: true }, name: { type: "string" } },
                      },
                    ],
                  },
                },
              },
            },
          },
          "post",
        ),
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool) || !isRecord(tool.input)) throw new Error("test was not generated")
    const properties = isRecord(tool.input.properties) ? tool.input.properties : {}
    const body = isRecord(properties.body) ? properties.body : {}
    const allOf = Array.isArray(body.allOf) ? body.allOf : []
    const branch = isRecord(allOf[0]) ? allOf[0] : {}

    expect(body.required).toEqual(["name"])
    expect(branch.required).toEqual(["name"])
    expect(Object.keys(isRecord(branch.properties) ? branch.properties : {})).toEqual(["name"])
  })

  test("keeps directional schemas model-facing while preserving runtime pass-through", async () => {
    const client = recordingClient(() =>
      json({
        id: "server-id",
        name: "Ada",
        password: "returned-by-server",
        profile: { createdAt: "today", secret: "returned-secret", label: "primary" },
        generated: "generated-id",
      }),
    )
    const tool = toolAt(OpenAPI.fromSpec({ baseUrl, spec: directionalSpec("3.1.0") }).tools, "users.create")
    if (!Tool.isTool(tool)) throw new Error("users.create was not generated")

    const result = await Effect.runPromise(
      tool
        .execute({
          id: "ignored-top-level",
          generated: "ignored-generated",
          name: "Ada",
          password: "request-secret",
          profile: { createdAt: "sent-nested", secret: "nested-secret", label: "primary" },
        })
        .pipe(Effect.provide(client.layer)),
    )

    expect(client.requests[0]?.body).toEqual({
      name: "Ada",
      password: "request-secret",
      profile: { createdAt: "sent-nested", secret: "nested-secret", label: "primary" },
    })
    expect(result).toMatchObject({ password: "returned-by-server", profile: { secret: "returned-secret" } })
  })

  test("documents that the opencode fixture is unauthenticated", async () => {
    const spec = await opencodeSpec()
    const components = isRecord(spec.components) ? spec.components : {}
    const result = OpenAPI.fromSpec({ spec, baseUrl })

    expect(spec.security).toStrictEqual([])
    expect(isRecord(components.securitySchemes) ? Object.keys(components.securitySchemes) : []).toStrictEqual([])
    const health = toolAt(result.tools, "v2.health.get")
    const healthInput = Tool.isTool(health) && isRecord(health.input) ? health.input : undefined
    expect(healthInput).toMatchObject({ type: "object", properties: {} })
    const input = isRecord(healthInput) ? healthInput : {}
    expect(Object.keys(isRecord(input.properties) ? input.properties : {})).toStrictEqual([])
  })

  test("exposes real opencode operations through CodeMode discovery", async () => {
    const { layer } = recordingClient(() => json({}))
    const runtime = CodeMode.make({
      tools: { opencode: OpenAPI.fromSpec({ spec: await opencodeSpec(), baseUrl }).tools },
    })
    const result = await Effect.runPromise(
      runtime
        .execute(
          `
        return search({ query: "global health", namespace: "opencode", limit: 1 })
      `,
        )
        .pipe(Effect.provide(layer)),
    )

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.value).toMatchObject({
      items: [
        {
          path: "tools.opencode.v2.health.get",
          description: "Check whether the API server is ready to accept requests.",
        },
      ],
    })
    expect(JSON.stringify(result.value)).toContain("healthy: true")
  })

  test("invokes real opencode path parameters and JSON request bodies", async () => {
    const { requests, layer } = recordingClient((request) => {
      if (request.method === "GET") return json({ id: "ses_123" })
      return json({ id: "ses_456" })
    })
    const runtime = CodeMode.make({
      tools: { opencode: OpenAPI.fromSpec({ spec: await opencodeSpec(), baseUrl }).tools },
    })

    const result = await Effect.runPromise(
      runtime
        .execute(
          `
          const existing = await tools.opencode.v2.session.get({ sessionID: "ses_123" })
          const created = await tools.opencode.v2.session.create({ id: "ses_456" })
          return { existing, created }
        `,
        )
        .pipe(Effect.provide(layer)),
    )

    expect(result).toMatchObject({ ok: true })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ method: "GET", body: undefined })
    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_123")
    expect(requests[1]).toMatchObject({
      method: "POST",
      url: "http://localhost:4096/api/session",
      body: { id: "ses_456" },
    })
  })

  test("serializes deep-object query parameters from the opencode fixture", async () => {
    const client = recordingClient(() => json({ directory: "/tmp" }))
    const location = toolAt(OpenAPI.fromSpec({ spec: await opencodeSpec(), baseUrl }).tools, "v2.location.get")
    if (!Tool.isTool(location)) throw new Error("v2.location.get was not generated")

    await Effect.runPromise(
      location
        .execute({ location: { directory: "/tmp", workspace: "workspace-1" } })
        .pipe(Effect.provide(client.layer)),
    )

    const url = new URL(client.requests[0]!.url)
    expect(url.searchParams.get("location[directory]")).toBe("/tmp")
    expect(url.searchParams.get("location[workspace]")).toBe("workspace-1")
  })

  test("serializes supported simple and form parameter shapes", async () => {
    const client = recordingClient(() => json({ ok: true }))
    const result = OpenAPI.fromSpec({
      baseUrl,
      spec: {
        openapi: "3.1.0",
        paths: {
          "/items/{keys}": {
            get: {
              operationId: "items",
              parameters: [
                { name: "keys", in: "path", required: true, schema: { type: "array", items: { type: "string" } } },
                { name: "tags", in: "query", style: "form", explode: false, schema: { type: "array" } },
                { name: "filter", in: "query", style: "form", explode: true, schema: { type: "object" } },
                { name: "nullable", in: "query", required: true, schema: { type: ["string", "null"] } },
                { name: "constructor", in: "query", schema: { type: "string" } },
                { name: "meta", in: "header", style: "simple", explode: true, schema: { type: "object" } },
              ],
              responses: { 200: { description: "Success" } },
            },
          },
        },
      },
    })
    const tool = toolAt(result.tools, "items")
    if (!Tool.isTool(tool)) throw new Error("items was not generated")

    await Effect.runPromise(
      tool
        .execute({
          keys: ["a!", "b*"],
          tags: ["x", "y"],
          filter: { state: "open", page: 2 },
          nullable: null,
          constructor: "safe",
          meta: { a: "b", c: "d" },
        })
        .pipe(Effect.provide(client.layer)),
    )

    const url = new URL(client.requests[0]!.url)
    expect(url.pathname).toBe("/items/a%21,b%2A")
    expect(url.searchParams.get("tags")).toBe("x,y")
    expect(url.searchParams.get("state")).toBe("open")
    expect(url.searchParams.get("page")).toBe("2")
    expect(url.searchParams.get("nullable")).toBe("null")
    expect(url.searchParams.get("constructor")).toBe("safe")
    expect(client.requests[0]!.headers.meta).toBe("a=b,c=d")
    await expect(
      Effect.runPromise(tool.execute({ keys: [undefined] }).pipe(Effect.provide(client.layer))),
    ).rejects.toThrow("unsupported nested value")
  })

  test("preserves ordered exploded and deep-object query parameters", async () => {
    const client = recordingClient(() => json({ ok: true }))
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: singleOperation({
          parameters: [
            { name: "tags", in: "query", style: "form", explode: true, schema: { type: "array" } },
            { name: "filter", in: "query", style: "form", explode: true, schema: { type: "object" } },
            { name: "location", in: "query", style: "deepObject", explode: true, schema: { type: "object" } },
          ],
        }),
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool)) throw new Error("test was not generated")

    await Effect.runPromise(
      tool
        .execute({
          tags: ["first value", "second&value"],
          filter: { state: "open now", page: 2 },
          location: { directory: "/tmp/a b", workspace: "work&1" },
        })
        .pipe(Effect.provide(client.layer)),
    )

    expect(client.requests[0]?.url).toBe(
      `${baseUrl}/test?tags=first+value&tags=second%26value&state=open+now&page=2&location%5Bdirectory%5D=%2Ftmp%2Fa+b&location%5Bworkspace%5D=work%261`,
    )
    await expect(Effect.runPromise(tool.execute({ tags: [{}] }).pipe(Effect.provide(client.layer)))).rejects.toThrow(
      "Parameter 'tags' contains an unsupported nested value.",
    )
    await expect(
      Effect.runPromise(tool.execute({ filter: { state: {} } }).pipe(Effect.provide(client.layer))),
    ).rejects.toThrow("Query parameter 'filter' contains an unsupported nested value.")
    await expect(
      Effect.runPromise(tool.execute({ location: { directory: [] } }).pipe(Effect.provide(client.layer))),
    ).rejects.toThrow("Deep-object parameter 'location' contains an unsupported nested value.")
    expect(client.requests).toHaveLength(1)
  })

  test("skips unsupported parameter encodings and malformed security", () => {
    const result = OpenAPI.fromSpec({
      baseUrl,
      spec: {
        openapi: "3.1.0",
        security: [{ bearer: [] }],
        paths: {
          "/cookie": {
            get: {
              operationId: "cookie",
              parameters: [{ name: "session", in: "cookie", schema: { type: "string" } }],
              responses: { 200: { description: "Success" } },
            },
          },
          "/reserved": {
            get: {
              operationId: "reserved",
              parameters: [{ name: "query", in: "query", allowReserved: true, schema: { type: "string" } }],
              responses: { 200: { description: "Success" } },
            },
          },
          "/invalid-style": {
            get: {
              operationId: "invalidStyle",
              parameters: [{ name: "query", in: "query", style: 42, schema: { type: "string" } }],
              responses: { 200: { description: "Success" } },
            },
          },
          "/security": {
            get: { operationId: "security", security: null, responses: { 200: { description: "Success" } } },
          },
        },
      },
    })

    expect(result.tools).toEqual({})
    expect(result.skipped.map((item) => item.reason)).toEqual([
      "cookie parameter 'session' is not supported",
      "parameter 'query' uses unsupported allowReserved encoding",
      "parameter 'query' has an invalid style",
      "security declaration is not an array",
    ])
  })

  test("fails closed on prototype-named missing security schemes", () => {
    const result = OpenAPI.fromSpec({
      baseUrl,
      spec: singleOperation({ security: [JSON.parse('{"__proto__":[]}')] }),
    })

    expect(result.tools).toEqual({})
    expect(result.skipped[0]?.reason).toBe("security requirement references missing or malformed scheme: __proto__")
  })

  test("resolves bearer authentication without exposing it as input", async () => {
    const contexts: Array<Parameters<OpenAPI.AuthResolver>[0]> = []
    const client = recordingClient(() => json({ ok: true }))
    const spec = {
      ...singleOperation({ operationId: undefined }),
      security: [{ bearer: [] }],
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    } satisfies Document
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec,
        auth: {
          resolve: (context) => {
            contexts.push(context)
            return Effect.succeed({ type: "bearer", token: "secret" })
          },
        },
      }).tools,
      "getTest",
    )
    if (!Tool.isTool(tool)) throw new Error("test was not generated")

    await Effect.runPromise(tool.execute({}).pipe(Effect.provide(client.layer)))

    expect(inputTypeScript(tool)).toBe("{}")
    expect(client.requests[0]!.headers.authorization).toBe("Bearer secret")
    expect(contexts).toEqual([
      {
        name: "bearer",
        definition: { type: "http", scheme: "bearer" },
        scopes: [],
        operation: {
          operationId: undefined,
          method: "GET",
          path: "/test",
          summary: undefined,
          description: undefined,
        },
      },
    ])
  })

  test("applies authentication carriers without prototype or collision loss", async () => {
    const client = recordingClient(() => json({ ok: true }))
    const authenticated = (
      security: ReadonlyArray<Record<string, ReadonlyArray<string>>>,
      schemes: Record<string, unknown>,
    ) =>
      OpenAPI.fromSpec({
        baseUrl,
        spec: { ...singleOperation({}), security, components: { securitySchemes: schemes } },
        auth: { resolve: () => Effect.succeed({ type: "apiKey", value: "secret" }) },
      })
    const prototype = toolAt(
      authenticated([{ key: [] }], { key: { type: "apiKey", in: "query", name: "__proto__" } }).tools,
      "test",
    )
    if (!Tool.isTool(prototype)) throw new Error("prototype auth tool was not generated")

    await Effect.runPromise(prototype.execute({}).pipe(Effect.provide(client.layer)))
    expect(new URL(client.requests[0]!.url).searchParams.get("__proto__")).toBe("secret")

    const duplicate = toolAt(
      authenticated([{ first: [], second: [] }], {
        first: { type: "apiKey", in: "header", name: "x-key" },
        second: { type: "apiKey", in: "header", name: "x-key" },
      }).tools,
      "test",
    )
    if (!Tool.isTool(duplicate)) throw new Error("duplicate auth tool was not generated")
    await expect(Effect.runPromise(duplicate.execute({}).pipe(Effect.provide(client.layer)))).rejects.toThrow(
      "multiple credentials",
    )

    const cookie = authenticated([{ key: [] }], { key: { type: "apiKey", in: "cookie", name: "session" } })
    expect(cookie.tools).toEqual({})
    expect(cookie.skipped[0]?.reason).toBe("cookie authentication 'key' is not supported")

    const alternative = OpenAPI.fromSpec({
      baseUrl,
      spec: {
        ...singleOperation({}),
        security: [{ cookie: [] }, { bearer: [] }],
        components: {
          securitySchemes: {
            cookie: { type: "apiKey", in: "cookie", name: "session" },
            bearer: { type: "http", scheme: "bearer" },
          },
        },
      },
      auth: {
        resolve: ({ name }) => Effect.succeed(name === "bearer" ? { type: "bearer", token: "secret" } : undefined),
      },
    })
    const alternativeTool = toolAt(alternative.tools, "test")
    if (!Tool.isTool(alternativeTool)) throw new Error("supported auth alternative was not generated")
    await Effect.runPromise(alternativeTool.execute({}).pipe(Effect.provide(client.layer)))
    expect(client.requests.at(-1)?.headers.authorization).toBe("Bearer secret")
  })

  test("honors server precedence and rejects ambiguous base URLs", async () => {
    const client = recordingClient(() => json({ ok: true }))
    const spec = {
      ...singleOperation({ servers: [{ url: "https://operation.example/v1" }] }),
      servers: [{ url: "https://document.example" }],
    } satisfies Document
    const tool = toolAt(OpenAPI.fromSpec({ spec }).tools, "test")
    if (!Tool.isTool(tool)) throw new Error("test was not generated")

    await Effect.runPromise(tool.execute({}).pipe(Effect.provide(client.layer)))
    expect(client.requests[0]?.url).toBe("https://operation.example/v1/test")

    const invalid = OpenAPI.fromSpec({ spec, baseUrl: "https://example.com/api?tenant=one" })
    expect(invalid.tools).toEqual({})
    expect(invalid.skipped[0]?.reason).toContain("unsupported query string or fragment")

    const malformed = OpenAPI.fromSpec({ spec, baseUrl: "https:/example.com" })
    expect(malformed.tools).toEqual({})
    expect(malformed.skipped[0]?.reason).toContain("not an absolute HTTP(S) URL")
  })

  test("resolves chained response refs before detecting unsupported transports", () => {
    const result = OpenAPI.fromSpec({
      baseUrl,
      spec: {
        ...singleOperation({ responses: { 200: { $ref: "#/components/responses/First" } } }),
        components: {
          responses: {
            First: { $ref: "#/components/responses/Stream" },
            Stream: { content: { "text/event-stream": { schema: { type: "string" } } } },
          },
        },
      },
    })

    expect(result.tools).toEqual({})
    expect(result.skipped[0]?.reason).toBe("SSE operations are not supported")
  })

  test("resolves response schemas before detecting binary output", () => {
    const result = OpenAPI.fromSpec({
      baseUrl,
      spec: {
        ...singleOperation({
          responses: {
            200: {
              content: { "text/plain": { schema: { $ref: "#/components/schemas/File" } } },
            },
          },
        }),
        components: { schemas: { File: { type: "string", format: "binary" } } },
      },
    })

    expect(result.tools).toEqual({})
    expect(result.skipped[0]?.reason).toBe("binary responses are not supported")
  })

  test("validates composite parameters before resolving auth", async () => {
    const resolutions: Array<string> = []
    const client = recordingClient(() => json({ ok: true }))
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: {
          ...singleOperation({
            parameters: [{ name: "filter", in: "query", style: "form", explode: true, schema: { type: "object" } }],
          }),
          security: [{ bearer: [] }],
          components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
        },
        auth: {
          resolve: ({ name }) => {
            resolutions.push(name)
            return Effect.succeed({ type: "bearer", token: "secret" })
          },
        },
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool)) throw new Error("test was not generated")

    await expect(
      Effect.runPromise(tool.execute({ filter: { value: undefined } }).pipe(Effect.provide(client.layer))),
    ).rejects.toThrow("unsupported nested value")
    expect(resolutions).toEqual([])
    expect(client.requests).toEqual([])
  })

  test("preserves JSON media types and rejects unencodable bodies", async () => {
    const client = recordingClient(() => json({ ok: true }))
    const tool = toolAt(
      OpenAPI.fromSpec({
        baseUrl,
        spec: singleOperation(
          {
            requestBody: {
              required: true,
              content: { "application/merge-patch+json": { schema: { type: "object" } } },
            },
          },
          "post",
        ),
      }).tools,
      "test",
    )
    if (!Tool.isTool(tool)) throw new Error("test was not generated")

    await Effect.runPromise(tool.execute({ body: { name: "updated" } }).pipe(Effect.provide(client.layer)))
    expect(client.requests[0]!.headers["content-type"]).toBe("application/merge-patch+json")
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(Effect.runPromise(tool.execute({ body: cyclic }).pipe(Effect.provide(client.layer)))).rejects.toThrow(
      "Invalid JSON body",
    )
  })

  test("rejects oversized and malformed JSON responses", async () => {
    const tool = toolAt(OpenAPI.fromSpec({ baseUrl, spec: singleOperation({}) }).tools, "test")
    if (!Tool.isTool(tool)) throw new Error("test was not generated")
    const oversized = recordingClient(
      () => new Response(null, { headers: { "content-length": String(50 * 1024 * 1024 + 1) } }),
    )
    const malformed = recordingClient(() => new Response("{", { headers: { "content-type": "application/json" } }))
    const chunked = recordingClient(() => new Response(new Uint8Array(50 * 1024 * 1024 + 1)))

    await expect(Effect.runPromise(tool.execute({}).pipe(Effect.provide(oversized.layer)))).rejects.toThrow(
      "response exceeds 50 MiB",
    )
    await expect(Effect.runPromise(tool.execute({}).pipe(Effect.provide(malformed.layer)))).rejects.toThrow(
      "returned malformed JSON",
    )
    await expect(Effect.runPromise(tool.execute({}).pipe(Effect.provide(chunked.layer)))).rejects.toThrow(
      "response exceeds 50 MiB",
    )
  })

  test("keeps non-JSON responses raw and unions every success output", async () => {
    const spec = singleOperation({
      responses: {
        200: { description: "Text", content: { "text/plain": { schema: { type: "string" } } } },
        204: { description: "Empty" },
      },
    })
    const tool = toolAt(OpenAPI.fromSpec({ baseUrl, spec }).tools, "test")
    if (!Tool.isTool(tool)) throw new Error("test was not generated")
    const client = recordingClient(() => new Response("123", { headers: { "content-type": "text/plain" } }))

    expect(outputTypeScript(tool)).toBe("string | null")
    await expect(Effect.runPromise(tool.execute({}).pipe(Effect.provide(client.layer)))).resolves.toBe("123")
  })

  test("fails missing required parameters before auth and network", async () => {
    const { requests, layer } = recordingClient(() => json({}))
    const runtime = CodeMode.make({
      tools: { opencode: OpenAPI.fromSpec({ spec: await opencodeSpec(), baseUrl }).tools },
    })

    const result = await Effect.runPromise(
      runtime.execute("return await tools.opencode.v2.session.get({})").pipe(Effect.provide(layer)),
    )

    expect(result).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).toContain("Missing required path parameter 'sessionID'")
    expect(requests).toHaveLength(0)
  })

  test("prefixes cross-location collisions and reconstructs the HTTP request", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "collision", version: "1.0.0" },
      paths: {
        "/echo": {
          post: {
            operationId: "echo",
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "string" } } },
            },
            responses: { "204": { description: "Echoed" } },
          },
        },
        "/things/{id}": {
          post: {
            operationId: "things.update",
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              { name: "id", in: "query", required: true, schema: { type: "string" } },
              { name: "path_id", in: "query", schema: { type: "string" } },
              { name: "id", in: "header", required: true, schema: { type: "string" } },
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"],
                    additionalProperties: false,
                  },
                },
              },
            },
            responses: { "204": { description: "Updated" } },
          },
        },
      },
    } satisfies Document
    const { requests, layer } = recordingClient(() => new Response(null, { status: 204 }))
    const tools = OpenAPI.fromSpec({ spec, baseUrl }).tools
    const update = toolAt(tools, "things.update")
    const echo = toolAt(tools, "echo")

    expect(Tool.isTool(update)).toBe(true)
    if (!Tool.isTool(update)) throw new Error("things.update was not generated")
    expect(inputTypeScript(update)).toBe(
      "{ path_id: string; query_id: string; path_id_2?: string; header_id: string; body_id: string }",
    )
    expect(Tool.isTool(echo)).toBe(true)
    if (!Tool.isTool(echo)) throw new Error("echo was not generated")
    expect(inputTypeScript(echo)).toBe("{ body: string }")

    const runtime = CodeMode.make({ tools })
    const result = await Effect.runPromise(
      runtime
        .execute(
          `
            const updated = await tools.things.update({ path_id: "path", query_id: "query", path_id_2: "literal", header_id: "header", body_id: "body" })
            const echoed = await tools.echo({ body: "hello" })
            return { updated, echoed }
          `,
        )
        .pipe(Effect.provide(layer)),
    )

    expect(result).toMatchObject({ ok: true })
    expect(requests).toHaveLength(2)
    expect(new URL(requests[0]!.url).pathname).toBe("/things/path")
    expect(new URL(requests[0]!.url).searchParams.get("id")).toBe("query")
    expect(new URL(requests[0]!.url).searchParams.get("path_id")).toBe("literal")
    expect(requests[0]!.headers.id).toBe("header")
    expect(requests[0]!.body).toStrictEqual({ id: "body" })
    expect(requests[1]!.body).toBe("hello")
  })

  test("keeps bodies nested when flattening would lose schema semantics", () => {
    const body = (schema: Record<string, unknown>, required = true) => ({
      required,
      content: { "application/json": { schema } },
    })
    const spec = {
      openapi: "3.1.0",
      info: { title: "bodies", version: "1.0.0" },
      paths: Object.fromEntries(
        [
          [
            "optional",
            body(
              {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
                additionalProperties: false,
              },
              false,
            ),
          ],
          ["dictionary", body({ type: "object", additionalProperties: { type: "string" } })],
          [
            "composed",
            body({
              type: "object",
              allOf: [{ type: "object", properties: { name: { type: "string" } }, required: ["name"] }],
              additionalProperties: false,
            }),
          ],
          [
            "nullable",
            body({
              type: ["object", "null"],
              properties: { name: { type: "string" } },
              additionalProperties: false,
            }),
          ],
        ].map(([name, requestBody]) => [
          `/body/${name}`,
          {
            post: {
              operationId: `body.${name}`,
              requestBody,
              responses: { "204": { description: "Accepted" } },
            },
          },
        ]),
      ),
    } satisfies Document
    const tools = OpenAPI.fromSpec({ spec, baseUrl }).tools

    for (const name of ["optional", "dictionary", "composed", "nullable"]) {
      const tool = toolAt(tools, `body.${name}`)
      expect(Tool.isTool(tool)).toBe(true)
      if (!Tool.isTool(tool)) throw new Error(`body.${name} was not generated`)
      const input = isRecord(tool.input) ? tool.input : {}
      expect(Object.keys(isRecord(input.properties) ? input.properties : {})).toStrictEqual(["body"])
    }
    const optional = toolAt(tools, "body.optional")
    if (!Tool.isTool(optional)) throw new Error("body.optional was not generated")
    expect(inputTypeScript(optional)).toBe("{ body?: { name: string } }")
  })
})
