import path from "node:path"
import fs from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Document, Event, Info } from "@opencode/schema/config"
import { ConfigMCP } from "@opencode/schema/config/mcp"
import { McpEvent } from "@opencode/schema/mcp-event"
import { Config } from "@opencode/core/config"
import { ConfigMcpPlugin } from "@opencode/core/config/plugin/mcp"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { ID, type Payload } from "@opencode/schema/event"
import { Form } from "@opencode/core/form"
import { Integration } from "@opencode/core/integration"
import { Environment } from "@opencode/core/environment/index"
import { EnvironmentUnavailable } from "@opencode/core/environment/unavailable"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { McpClient } from "@opencode/core/mcp/client"
import { McpStdio } from "@opencode/core/mcp/stdio"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { State } from "@opencode/core/state"
import { McpTool } from "@opencode/core/tool/mcp"
import { Tool } from "@opencode/core/tool"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Ref,
  Schedule,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { Image } from "@opencode/core/image"
import { advance, drain } from "./lib/clock"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { hostEnvironmentLayer, recordingEnvironmentLayer } from "./fixture/environment"
import { codeModeListings, executeTool, toolDefinitions, toolIdentity, waitForTool } from "./lib/tool"

let assertion: Deferred.Deferred<Permission.AssertInput> | undefined
let decision: Effect.Effect<void, Permission.Error> = Effect.void
let calls = 0
let invocations: Array<Parameters<Mcp.Interface["callTool"]>[0]> = []

type ResourcePage = {
  items: Array<{ name: string; uri: string; description?: string; mimeType?: string }>
  nextCursor?: string
}

type ResourceTemplatePage = {
  items: Array<{ name: string; uriTemplate: string; description?: string; mimeType?: string }>
  nextCursor?: string
}

function resourceServer(
  input: {
    resources?: boolean
    listChanged?: boolean
    emptyElicitation?: boolean
    urlElicitation?: boolean
    respond?: (request: Request) => Response | undefined | Promise<Response | undefined>
  } = {},
) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const state = {
        resources: [] as ResourcePage["items"],
        templates: [] as ResourceTemplatePage["items"],
        resourcePages: undefined as Record<string, ResourcePage> | undefined,
        templatePages: undefined as Record<string, ResourceTemplatePage> | undefined,
        contents: [
          { uri: "docs://readme", text: "hello", mimeType: "text/plain" },
          { uri: "docs://logo", blob: "aGVsbG8=", mimeType: "image/png" },
        ] as Array<{ uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string }>,
        resourceLists: 0,
        templateLists: 0,
        toolLists: 0,
        toolCalls: [] as Array<{
          name: string
          arguments: Record<string, unknown> | undefined
          sessionID: unknown
          progressToken: unknown
        }>,
        initializations: 0,
        urls: [] as string[],
      }
      const protocol = new Server(
        { name: "mcp-resources", version: "1.0.0" },
        {
          capabilities: {
            tools: {},
            ...(input.resources === false ? {} : { resources: { listChanged: input.listChanged } }),
          },
        },
      )
      protocol.setRequestHandler(ListToolsRequestSchema, () => {
        state.toolLists += 1
        return Promise.resolve({
          tools: input.emptyElicitation
            ? [{ name: "empty-elicitation", inputSchema: { type: "object" as const, properties: {} } }]
            : input.urlElicitation
              ? [{ name: "url-elicitation", inputSchema: { type: "object" as const, properties: {} } }]
              : [],
        })
      })
      if (input.emptyElicitation) {
        protocol.setRequestHandler(CallToolRequestSchema, async () => {
          const result = await protocol.elicitInput({
            mode: "form",
            message: "Confirm",
            requestedSchema: { type: "object", properties: {} },
          })
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          }
        })
      }
      if (input.urlElicitation) {
        protocol.setRequestHandler(CallToolRequestSchema, async () => {
          const result = await protocol.elicitInput({
            mode: "url",
            message: "Authorize access",
            url: "https://example.com/authorize",
            elicitationId: "elicitation-test",
          })
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          }
        })
      }
      if (!input.emptyElicitation && !input.urlElicitation) {
        protocol.setRequestHandler(CallToolRequestSchema, (request) => {
          state.toolCalls.push({
            name: request.params.name,
            arguments: request.params.arguments,
            sessionID: request.params._meta?.sessionID,
            progressToken: request.params._meta?.progressToken,
          })
          return Promise.resolve({ content: [] })
        })
      }
      if (input.resources !== false) {
        protocol.setRequestHandler(ListResourcesRequestSchema, (request) => {
          state.resourceLists += 1
          const page = state.resourcePages?.[request.params?.cursor ?? "initial"]
          return Promise.resolve({ resources: page?.items ?? state.resources, nextCursor: page?.nextCursor })
        })
        protocol.setRequestHandler(ListResourceTemplatesRequestSchema, (request) => {
          state.templateLists += 1
          const page = state.templatePages?.[request.params?.cursor ?? "initial"]
          return Promise.resolve({ resourceTemplates: page?.items ?? state.templates, nextCursor: page?.nextCursor })
        })
        protocol.setRequestHandler(ReadResourceRequestSchema, () => Promise.resolve({ contents: state.contents }))
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const http = Bun.serve({
        port: 0,
        fetch: async (request) => {
          state.urls.push(request.url)
          const body: unknown = request.method === "POST" ? await request.clone().json() : undefined
          if (typeof body === "object" && body !== null && "method" in body && body.method === "initialize") {
            state.initializations += 1
          }
          return (await input.respond?.(request)) ?? transport.handleRequest(request)
        },
      })
      return {
        state,
        url: http.url.toString(),
        clientVersion: () => protocol.getClientVersion(),
        sendResourceListChanged: () => protocol.sendResourceListChanged(),
        completeElicitation: () => protocol.createElicitationCompletionNotifier("elicitation-test")(),
        close: async () => {
          await protocol.close().catch(() => {})
          await http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function resourceMcpLayer(
  server: string | typeof ConfigMCP.Server.Type,
  onFormCreated?: (form: Form.Info) => Effect.Effect<void>,
  options?: Mcp.Options,
  overrides?: {
    entries?: Config.Interface["entries"]
    subscribe?: Bus.Interface["subscribe"]
    environment?: Layer.Layer<Environment.Service>
    published?: string[]
  },
) {
  const directory = AbsolutePath.make(import.meta.dir)
  const unusedIntegration = () => Effect.die("unused integration service")
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      yield* ConfigMcpPlugin.register(bus.subscribe())
    }),
  ).pipe(
    Layer.provideMerge(Mcp.layer(options)),
    Layer.provideMerge(Form.layer),
    Layer.provide(
      Layer.mergeAll(
        overrides?.entries
          ? Layer.succeed(
              Config.Service,
              Config.Service.of({
                entries: overrides.entries,
                changes: () => Stream.never,
              }),
            )
          : Config.testLayer([
              new Document({
                type: "document",
                info: new Info({
                  mcp: new ConfigMCP.Info({
                    servers: {
                      resources:
                        typeof server === "string"
                          ? new ConfigMCP.Remote({ type: "remote", url: server, oauth: false })
                          : server,
                    },
                  }),
                }),
              }),
            ]),
        Layer.succeed(Location.Service, Location.Service.of(location({ directory }))),
        Layer.mock(Bus.Service, {
          subscribe: overrides?.subscribe ?? (() => Stream.never),
          publish: (definition, data) => {
            const event = {
              id: ID.create(),
              type: definition.type,
              data,
            } as Payload<typeof definition>
            overrides?.published?.push(event.type)
            if (event.type !== Form.Event.Created.type || !onFormCreated) return Effect.succeed(event)
            return onFormCreated(Schema.decodeUnknownSync(Form.Event.Created.data)(data).form).pipe(Effect.as(event))
          },
        }),
        Layer.mock(Integration.Service, {
          connection: {
            active: unusedIntegration,
            resolve: unusedIntegration,
            key: unusedIntegration,
            activate: unusedIntegration,
            update: unusedIntegration,
            remove: unusedIntegration,
          },
          oauth: {
            connect: unusedIntegration,
            status: unusedIntegration,
            complete: unusedIntegration,
            cancel: unusedIntegration,
          },
          command: {
            connect: unusedIntegration,
            status: unusedIntegration,
            cancel: unusedIntegration,
          },
        }),
        Layer.mock(Credential.Service, {}),
        overrides?.environment ?? hostEnvironmentLayer,
      ),
    ),
  )
}

const connect = (server: string, config: typeof ConfigMCP.Server.Type, directory: string) =>
  McpClient.connect(server, config, directory).pipe(Effect.provide(hostEnvironmentLayer))

const mcp = Layer.mock(Mcp.Service, {
  tools: () =>
    Effect.succeed([
      new Mcp.Tool({
        server: Mcp.ServerName.make("demo"),
        name: "search",
        description: "Search",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      }),
      new Mcp.Tool({
        server: Mcp.ServerName.make("demo"),
        name: "status",
        description: "Status",
        inputSchema: { type: "object", properties: {} },
      }),
      new Mcp.Tool({
        server: Mcp.ServerName.make("demo"),
        name: "issues",
        description: "Returns JSON as text",
        inputSchema: { type: "object", properties: {} },
      }),
      new Mcp.Tool({
        server: Mcp.ServerName.make("demo"),
        name: "count",
        description: "Returns a number as text",
        inputSchema: { type: "object", properties: {} },
      }),
      new Mcp.Tool({
        server: Mcp.ServerName.make("demo"),
        name: "typed",
        description: "Declares a string output and returns JSON as text",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "string" },
      }),
      new Mcp.Tool({
        server: Mcp.ServerName.make("direct"),
        name: "issues",
        codemode: false,
        description: "Returns JSON as text",
        inputSchema: { type: "object", properties: {} },
      }),
      new Mcp.Tool({
        server: Mcp.ServerName.make("direct"),
        name: "lookup",
        codemode: false,
        description: "Lookup",
        inputSchema: { type: "object", properties: {} },
      }),
      new Mcp.Tool({
        server: Mcp.ServerName.make("direct"),
        name: "fail",
        codemode: false,
        description: "Always fails",
        inputSchema: { type: "object", properties: {} },
      }),
      new Mcp.Tool({
        server: Mcp.ServerName.make("direct"),
        name: "media",
        codemode: false,
        description: "Returns text and an image",
        inputSchema: { type: "object", properties: {} },
      }),
    ]),
  callTool: (input) =>
    Effect.sync(() => {
      calls += 1
      invocations.push(input)
      if (input.name === "fail")
        return new Mcp.ToolResult({
          server: Mcp.ServerName.make(input.server),
          tool: input.name,
          isError: true,
          content: [{ type: "text", text: "search index unavailable" }],
        })
      if (input.name === "media")
        return new Mcp.ToolResult({
          server: Mcp.ServerName.make(input.server),
          tool: input.name,
          isError: false,
          content: [
            { type: "text", text: "rendered chart" },
            { type: "media", data: "aGVsbG8=", mimeType: "image/png" },
          ],
        })
      if (input.name === "status")
        return new Mcp.ToolResult({
          server: Mcp.ServerName.make(input.server),
          tool: input.name,
          isError: false,
          content: [{ type: "text", text: "hello" }],
        })
      if (input.name === "issues" || input.name === "typed")
        return new Mcp.ToolResult({
          server: Mcp.ServerName.make(input.server),
          tool: input.name,
          isError: false,
          content: [{ type: "text", text: '{"issues":[{"id":1}]}' }],
        })
      if (input.name === "count")
        return new Mcp.ToolResult({
          server: Mcp.ServerName.make(input.server),
          tool: input.name,
          isError: false,
          content: [{ type: "text", text: "42" }],
        })
      return new Mcp.ToolResult({
        server: Mcp.ServerName.make(input.server),
        tool: input.name,
        isError: false,
        structured: { ok: true },
        content: [],
      })
    }),
})
const permissions = Layer.mock(Permission.Service, {
  assert: (input) =>
    Effect.gen(function* () {
      if (!assertion) return yield* Effect.die("Permission test is not initialized")
      yield* Deferred.succeed(assertion, input)
      yield* decision
    }),
})
const events = Layer.mock(Bus.Service, { subscribe: () => Stream.never })
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, McpTool.node]), [
    Mcp.node.replace(mcp),
    Permission.node.replace(permissions),
    Bus.node.replace(events),
    Image.node.replace(imagePassthrough),
  ]),
)

describe("MCP errors", () => {
  test("expose useful messages", () => {
    expect(new Mcp.NotFoundError({ server: Mcp.ServerName.make("demo") }).message).toBe("MCP server not found: demo")
    expect(
      new Mcp.ToolCallError({ server: Mcp.ServerName.make("demo"), tool: "search", message: "failed" }).message,
    ).toBe("failed")
    expect(new McpClient.NeedsAuthError({ server: "demo" }).message).toBe("MCP server requires authentication: demo")
    expect(new McpClient.ConnectError({ server: "demo", message: "offline" }).message).toBe("offline")
  })
})

test("MCP tool names match V1 sanitization", () => {
  expect(McpTool.namespace("context 7")).toBe("context_7")
  expect(McpTool.name("context 7", "resolve.library/id")).toBe("context_7_resolve_library_id")
})

test("passes session IDs as MCP request metadata", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer()
        const connection = yield* connect(
          "session-metadata",
          new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false }),
          import.meta.dir,
        )
        yield* connection.callTool({
          name: "echo",
          args: { text: "hello" },
          sessionID: Session.ID.make("ses_mcp_metadata"),
        })
        yield* connection.callTool({ name: "echo" })

        expect(server.state.toolCalls).toEqual([
          {
            name: "echo",
            arguments: { text: "hello" },
            sessionID: "ses_mcp_metadata",
            progressToken: expect.any(Number),
          },
          {
            name: "echo",
            arguments: {},
            sessionID: undefined,
            progressToken: expect.any(Number),
          },
        ])
        expect(server.state.toolCalls[0]?.progressToken).not.toBe(server.state.toolCalls[1]?.progressToken)
      }),
    ),
  )
})

test("preserves output schema validation across paginated tool discovery", async () => {
  const server = new Server({ name: "pagination", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) =>
    Promise.resolve(
      params?.cursor === "page-2"
        ? {
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
            ],
          }
        : {
            tools: [
              {
                name: "first",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
            nextCursor: "page-2",
          },
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
    Promise.resolve({
      content: [],
      structuredContent: { value: params.name === "first" ? 42 : 1 },
    }),
  )

  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const first = await client.listTools()
    const second = await client.listTools({ cursor: first.nextCursor })
    expect([...first.tools, ...second.tools].map((tool) => tool.name)).toEqual(["first", "second"])
    await expect(client.callTool({ name: "first", arguments: {} })).rejects.toThrow(
      "Structured content does not match the tool's output schema",
    )
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})

test("retains output schemas across paginated MCP discovery", async () => {
  const tools = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* connect(
          "pagination",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
          }),
          import.meta.dir,
        )
        return yield* connection.tools()
      }),
    ),
  )

  expect(tools.map((tool) => ({ name: tool.name, outputSchema: tool.outputSchema }))).toEqual([
    {
      name: "first",
      outputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
    {
      name: "second",
      outputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
    },
  ])
})

test("lists paginated prompts and invokes them through the MCP client", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* connect(
          "prompts",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-prompts.ts")],
          }),
          import.meta.dir,
        )
        return {
          prompts: yield* connection.prompts(),
          result: yield* connection.prompt({ name: "first", args: { topic: "Effect" } }),
        }
      }),
    ),
  )

  expect(result.prompts).toEqual([
    {
      name: "first",
      description: "First prompt",
      arguments: [{ name: "topic", description: "Topic to explain", required: true }],
    },
    { name: "second", description: "Second prompt", arguments: undefined },
  ])
  expect(result.result).toEqual({ messages: [{ role: "user", content: { type: "text", text: "Effect" } }] })
})

test("spawns local MCP servers through the location environment", async () => {
  const spawns: Array<ChildProcess.Command> = []
  const cwd = path.join(import.meta.dir, "fixture")
  const config = new ConfigMCP.Local({
    type: "local",
    command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
    cwd: "fixture",
    environment: { MCP_LOCATION_TEST: "configured" },
  })

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* McpClient.connect("environment", config, import.meta.dir)
        yield* connection.tools()
      }),
    ).pipe(Effect.provide(recordingEnvironmentLayer(spawns))),
  )

  expect(spawns).toHaveLength(1)
  const command = spawns[0]
  if (!command || !ChildProcess.isStandardCommand(command)) throw new Error("Expected a standard process command")
  expect(command.command).toBe(process.execPath)
  expect(command.options.cwd).toBe(cwd)
  expect(command.options.extendEnv).toBe(true)
  expect(command.options.env).toEqual({ MCP_LOCATION_TEST: "configured" })
})

test("reports a local MCP server as failed when the location has no execution plane", async () => {
  const config = new ConfigMCP.Local({ type: "local", command: ["example-mcp"] })
  const driver = Environment.makeMemoryDriver()
  const environment = Layer.succeed(
    Environment.Service,
    Environment.Service.of({ files: Environment.makeFiles(driver), spawner: EnvironmentUnavailable.spawner }),
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Mcp.Service
      yield* service.tools()
      const status = (yield* service.servers()).find((server) => server.name === "resources")?.status
      expect(status).toEqual({
        status: "failed",
        error: expect.stringContaining("location has no execution plane"),
      })
    }).pipe(Effect.provide(resourceMcpLayer(config, undefined, undefined, { environment }))),
  )
})

test("rejects sends before the stdio transport is started", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* McpStdio.make({
          server: "not-started",
          command: process.execPath,
          args: [path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
          cwd: import.meta.dir,
          environment: {},
        })
        yield* Effect.tryPromise({
          try: () => transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(
          Effect.flip,
          Effect.tap((error) => Effect.sync(() => expect(error.message).toBe("Not connected"))),
        )
      }).pipe(Effect.provide(hostEnvironmentLayer)),
    ),
  )
})

test("joins concurrent stdio transport closes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* McpStdio.make({
          server: "concurrent-close",
          command: "unused",
          args: [],
          cwd: import.meta.dir,
          environment: {},
        })
        const first = transport.close()
        expect(transport.close()).toBe(first)
        yield* Effect.promise(() => first)
      }).pipe(Effect.provide(hostEnvironmentLayer)),
    ),
  )
})

const testMcpDescendants =
  process.platform === "win32" ? testEffect(hostEnvironmentLayer).live.skip : testEffect(hostEnvironmentLayer).live
testMcpDescendants(
  "terminates MCP descendants after the wrapper exits successfully",
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const pidFile = path.join(tmp.path, "child.pid")
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(async () => process.kill(Number(await fs.readFile(pidFile, "utf8")), "SIGKILL")).pipe(
        Effect.ignore,
      ),
    )
    const ready = yield* Deferred.make<void>()
    // Stdin EOF exits the wrapper, but its ready descendant ignores SIGTERM and retains both pipes.
    const transport = yield* McpStdio.make({
      server: "held-stdio",
      command: "node",
      args: [path.join(import.meta.dir, "fixture/held-stdio.cjs"), "mcp", pidFile],
      cwd: tmp.path,
      environment: {},
    })
    transport.onmessage = () => {
      Deferred.doneUnsafe(ready, Exit.void)
    }
    yield* Effect.promise(() => transport.start())
    yield* Deferred.await(ready).pipe(Effect.timeout("3 seconds"))
    const pid = Number(yield* Effect.promise(() => fs.readFile(pidFile, "utf8")))

    yield* Effect.promise(() => transport.close()).pipe(Effect.timeout("6 seconds"))

    // close() must kill the descendant, not merely observe the wrapper's bounded exitCode.
    const stopped = yield* Effect.try(() => process.kill(pid, 0)).pipe(
      Effect.exit,
      Effect.repeat({ while: Exit.isSuccess, schedule: Schedule.spaced("25 millis") }),
      Effect.timeout("2 seconds"),
    )
    expect(Exit.isFailure(stopped)).toBe(true)
  }),
  15_000,
)

test("closes a stdio process that finishes spawning after close", async () => {
  const spawning = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const exited = Deferred.makeUnsafe<ExitCode>()
  const signals: Array<string> = []
  const driver = Environment.makeMemoryDriver()
  const environment = Layer.succeed(
    Environment.Service,
    Environment.Service.of({
      files: Environment.makeFiles(driver),
      spawner: ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(spawning, undefined)
          yield* Deferred.await(release)
          return makeHandle({
            pid: ProcessId(1),
            exitCode: Deferred.await(exited),
            isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
            kill: (options) =>
              Effect.gen(function* () {
                signals.push(options?.killSignal ?? "SIGTERM")
                yield* Deferred.succeed(exited, ExitCode(143))
              }),
            stdin: Sink.drain,
            stdout: Stream.never,
            stderr: Stream.empty,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          })
        }),
      ),
    }),
  )

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* McpStdio.make({
          server: "close-during-spawn",
          command: "unused",
          args: [],
          cwd: import.meta.dir,
          environment: {},
        })
        const start = transport.start()
        yield* Deferred.await(spawning)
        const close = transport.close()
        yield* Deferred.succeed(release, undefined)
        yield* Effect.promise(() => Promise.all([start, close]))
      }).pipe(Effect.provide(environment)),
    ),
  )

  expect(signals).toEqual(["SIGTERM"])
})

test("applies the configured MCP catalog timeout", async () => {
  const result = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* connect(
          "catalog-timeout",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-timeout.ts")],
            environment: { MCP_TIMEOUT_TARGET: "catalog" },
            timeout: new ConfigMCP.Timeout({ catalog: 10 }),
          }),
          import.meta.dir,
        )
        return yield* connection.tools()
      }),
    ),
  )

  await expect(result).rejects.toThrow("Request timed out")
})

test("applies the configured MCP execution timeout", async () => {
  const result = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* connect(
          "execution-timeout",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-timeout.ts")],
            timeout: new ConfigMCP.Timeout({ execution: 10 }),
          }),
          import.meta.dir,
        )
        return yield* connection.callTool({ name: "slow" })
      }),
    ),
  )

  await expect(result).rejects.toThrow("Request timed out")
})

test("applies the configured MCP execution timeout to prompts", async () => {
  const result = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* connect(
          "prompt-timeout",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-timeout.ts")],
            timeout: new ConfigMCP.Timeout({ execution: 10 }),
          }),
          import.meta.dir,
        )
        return yield* connection.prompt({ name: "slow" })
      }),
    ),
  )

  await expect(result).rejects.toThrow("Request timed out")
})

test("applies configured MCP timeouts to resource operations", async () => {
  const catalog = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* connect(
          "resource-catalog-timeout",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-timeout.ts")],
            environment: { MCP_TIMEOUT_TARGET: "resource-catalog" },
            timeout: new ConfigMCP.Timeout({ catalog: 10 }),
          }),
          import.meta.dir,
        )
        return yield* connection.resources()
      }),
    ),
  )
  await expect(catalog).rejects.toThrow("Request timed out")

  const read = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* connect(
          "resource-read-timeout",
          new ConfigMCP.Local({
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-timeout.ts")],
            timeout: new ConfigMCP.Timeout({ execution: 10 }),
          }),
          import.meta.dir,
        )
        return yield* connection.readResource({ uri: "test://slow" })
      }),
    ),
  )
  await expect(read).rejects.toThrow("Request timed out")
})

for (const entry of [
  { name: "default", query: "", codemode: undefined, expected: "?codemode=false" },
  { name: "explicit local code mode", query: "", codemode: true, expected: "?codemode=false" },
  { name: "direct tools", query: "", codemode: false, expected: "" },
  {
    name: "existing query",
    query: "?source=opencode",
    codemode: undefined,
    expected: "?source=opencode&codemode=false",
  },
  { name: "explicit remote code mode", query: "?codemode=true", codemode: undefined, expected: "?codemode=true" },
  { name: "explicit remote opt-out", query: "?codemode=false", codemode: undefined, expected: "?codemode=false" },
  { name: "portal opt-out", query: "?codemode=off", codemode: undefined, expected: "?codemode=off" },
]) {
  testEffect(Layer.empty).live(`remote MCP code mode preference: ${entry.name}`, () =>
    Effect.gen(function* () {
      const server = yield* resourceServer()
      const config = new ConfigMCP.Remote({
        type: "remote",
        url: server.url + entry.query,
        oauth: false,
        codemode: entry.codemode,
      })
      const connection = yield* connect("resources", config, import.meta.dir)
      yield* connection.tools()
      expect(server.state.initializations).toBe(1)
      expect(server.state.toolLists).toBe(1)
      expect(server.state.urls.length).toBeGreaterThanOrEqual(3)
      expect(new Set(server.state.urls)).toEqual(new Set([server.url + entry.expected]))
      expect(config.url).toBe(server.url + entry.query)
    }),
  )
}

for (const { status, query } of [400, 404].flatMap((status) =>
  ["", "?source=hello%20world&tag=a&tag=b"].map((query) => ({ status, query })),
)) {
  testEffect(Layer.empty).live(`retries MCP initialization ${status} at the original URL: ${query || "no query"}`, () =>
    Effect.gen(function* () {
      const headers: Array<string | null> = []
      const server = yield* resourceServer({
        respond: (request) => {
          headers.push(request.headers.get("x-mcp-test"))
          return new URL(request.url).searchParams.has("codemode") ? new Response(null, { status }) : undefined
        },
      })
      const config = new ConfigMCP.Remote({
        type: "remote",
        url: server.url + query,
        headers: { "x-mcp-test": "preserved" },
        oauth: false,
      })
      const connection = yield* connect("resources", config, import.meta.dir)
      yield* connection.tools()
      yield* connection.resources()

      expect(server.state.initializations).toBe(2)
      expect(new URL(server.state.urls[0]).searchParams.get("codemode")).toBe("false")
      expect(new Set(server.state.urls.slice(1))).toEqual(new Set([config.url]))
      expect(new Set(headers)).toEqual(new Set(["preserved"]))
      expect(server.state.toolLists).toBe(1)
      expect(server.state.resourceLists).toBe(1)
      expect(config.url).toBe(server.url + query)
    }),
  )
}

for (const entry of [
  { name: "second 404", status: 404, query: "", codemode: undefined, attempts: 2 },
  { name: "second 400", status: 400, query: "", codemode: undefined, attempts: 2 },
  { name: "401", status: 401, query: "", codemode: undefined, attempts: 1 },
  { name: "403", status: 403, query: "", codemode: undefined, attempts: 1 },
  { name: "500", status: 500, query: "", codemode: undefined, attempts: 1 },
  { name: "user codemode=true", status: 404, query: "?codemode=true", codemode: undefined, attempts: 1 },
  { name: "user codemode=false", status: 404, query: "?codemode=false", codemode: undefined, attempts: 1 },
  { name: "empty user codemode", status: 404, query: "?codemode=", codemode: undefined, attempts: 1 },
  { name: "direct tools", status: 404, query: "", codemode: false, attempts: 1 },
  { name: "400 with user codemode=true", status: 400, query: "?codemode=true", codemode: undefined, attempts: 1 },
  { name: "400 with user codemode=false", status: 400, query: "?codemode=false", codemode: undefined, attempts: 1 },
  { name: "400 with empty user codemode", status: 400, query: "?codemode=", codemode: undefined, attempts: 1 },
  { name: "400 with direct tools", status: 400, query: "", codemode: false, attempts: 1 },
]) {
  testEffect(Layer.empty).live(`does not retry MCP beyond the query fallback: ${entry.name}`, () =>
    Effect.gen(function* () {
      const server = yield* resourceServer({
        respond: () => new Response(null, { status: entry.status }),
      })
      const config = new ConfigMCP.Remote({
        type: "remote",
        url: server.url + entry.query,
        codemode: entry.codemode,
        oauth: false,
      })
      const error = yield* connect("resources", config, import.meta.dir).pipe(Effect.flip)

      expect(error).toBeInstanceOf(McpClient.ConnectError)
      expect(server.state.initializations).toBe(entry.attempts)
      expect(server.state.urls).toHaveLength(entry.attempts)
      if (entry.query || entry.codemode === false) expect(server.state.urls).toEqual([config.url])
      if (entry.attempts === 2) expect(server.state.urls[1]).toBe(config.url)
    }),
  )
}

for (const status of [400, 404]) {
  testEffect(Layer.empty).live(`does not strip codemode for an MCP ${status} after initialization`, () =>
    Effect.gen(function* () {
      let expired = false
      const server = yield* resourceServer({
        respond: (request) => (expired && request.method === "POST" ? new Response(null, { status }) : undefined),
      })
      const config = new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false })
      const connection = yield* connect("resources", config, import.meta.dir)
      expired = true
      expect(yield* connection.tools().pipe(Effect.flip)).toBeInstanceOf(Error)

      // The SDK tries to recover an expired session on 404, but must keep the same URL.
      expect(server.state.initializations).toBe(status === 404 ? 2 : 1)
      expect(new Set(server.state.urls)).toEqual(new Set([server.url + "?codemode=false"]))
      expect(server.state.toolLists).toBe(0)
    }),
  )
}

test("lists, reads, and reports MCP resource changes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer({ listChanged: true })
        server.state.resourcePages = {
          initial: {
            items: [{ name: "Readme", uri: "docs://readme", description: "Project docs" }],
            nextCursor: "resources-2",
          },
          "resources-2": { items: [{ name: "Logo", uri: "docs://logo", mimeType: "image/png" }] },
        }
        server.state.templatePages = {
          initial: {
            items: [{ name: "File", uriTemplate: "docs://{path}" }],
            nextCursor: "templates-2",
          },
          "templates-2": { items: [{ name: "Issue", uriTemplate: "issue://{id}", description: "Issue" }] },
        }
        const connection = yield* connect(
          "resources",
          new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false }),
          import.meta.dir,
        )

        expect(yield* connection.resources()).toEqual([
          { name: "Readme", uri: "docs://readme", description: "Project docs", mimeType: undefined },
          { name: "Logo", uri: "docs://logo", description: undefined, mimeType: "image/png" },
        ])
        expect(yield* connection.resourceTemplates()).toEqual([
          { name: "File", uriTemplate: "docs://{path}", description: undefined, mimeType: undefined },
          { name: "Issue", uriTemplate: "issue://{id}", description: "Issue", mimeType: undefined },
        ])
        expect(yield* connection.readResource({ uri: "docs://readme" })).toEqual({
          contents: [
            { type: "text", uri: "docs://readme", text: "hello", mimeType: "text/plain" },
            { type: "blob", uri: "docs://logo", blob: "aGVsbG8=", mimeType: "image/png" },
          ],
        })

        const changed = yield* Deferred.make<void>()
        connection.onResourcesChanged(() => Deferred.doneUnsafe(changed, Exit.void))
        yield* Effect.promise(server.sendResourceListChanged)
        yield* Deferred.await(changed)
      }),
    ),
  )
})

test("does not reconnect an SSE stream after a JSON-RPC error response", async () => {
  let requests = 0
  const transport = new StreamableHTTPClientTransport(new URL("http://mcp.invalid"), {
    fetch: async () => {
      requests += 1
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("id: prime\nretry: 1\ndata:\n\n"))
            controller.enqueue(
              new TextEncoder().encode(
                'id: error\ndata: {"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found"},"id":1}\n\n',
              ),
            )
            controller.close()
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    },
    reconnectionOptions: {
      initialReconnectionDelay: 1,
      maxReconnectionDelay: 1,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 2,
    },
  })

  await transport.start()
  await transport.send({ jsonrpc: "2.0", method: "resources/list", id: 1 })
  await Bun.sleep(25)
  await transport.close()

  expect(requests).toBe(1)
})

test("skips MCP resource requests when the capability is absent", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer({ resources: false })
        const connection = yield* connect(
          "resources",
          new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false }),
          import.meta.dir,
        )
        expect(yield* connection.resources()).toEqual([])
        expect(yield* connection.resourceTemplates()).toEqual([])
        expect(yield* connection.readResource({ uri: "docs://readme" })).toBeUndefined()
        expect({ resources: server.state.resourceLists, templates: server.state.templateLists }).toEqual({
          resources: 0,
          templates: 0,
        })
      }),
    ),
  )
})

test("accepts empty MCP elicitations without creating forms", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer({ resources: false, emptyElicitation: true })
        const result = yield* Effect.gen(function* () {
          const service = yield* Mcp.Service
          const forms = yield* Form.Service
          const result = yield* service.callTool({ server: "resources", name: "empty-elicitation" })
          expect(yield* forms.list()).toEqual([])
          return result
        }).pipe(Effect.provide(resourceMcpLayer(server.url)))

        expect(result.structured).toEqual({ action: "accept", content: {} })
      }),
    ),
  )
})

test("acknowledges completed MCP URL elicitations without returning internal content", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer({ resources: false, urlElicitation: true })
        const created = yield* Deferred.make<Form.Info>()
        const result = yield* Effect.gen(function* () {
          const service = yield* Mcp.Service
          const forms = yield* Form.Service
          const call = yield* service.callTool({ server: "resources", name: "url-elicitation" }).pipe(Effect.forkScoped)

          const form = yield* Deferred.await(created)
          expect(form.fields).toEqual([{ key: "elicitation", type: "external", url: "https://example.com/authorize" }])

          yield* Effect.promise(server.completeElicitation)
          const result = yield* Fiber.join(call)
          expect(yield* forms.state(form.id)).toEqual({ status: "answered", answer: { elicitation: true } })
          return result
        }).pipe(
          Effect.provide(resourceMcpLayer(server.url, (form) => Deferred.succeed(created, form).pipe(Effect.asVoid))),
        )

        expect(result.structured).toEqual({ action: "accept" })
      }),
    ),
  )
})

test("loads and reads MCP resources", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer()
        server.state.resources = [{ name: "Readme", uri: "docs://readme" }]
        server.state.templates = [{ name: "File", uriTemplate: "docs://{path}" }]

        yield* Effect.gen(function* () {
          const service = yield* Mcp.Service
          expect(yield* service.resourceCatalog()).toEqual({
            resources: [
              {
                server: "resources",
                name: "Readme",
                uri: "docs://readme",
                description: undefined,
                mimeType: undefined,
              },
            ],
            templates: [
              {
                server: "resources",
                name: "File",
                uriTemplate: "docs://{path}",
                description: undefined,
                mimeType: undefined,
              },
            ],
          })

          server.state.resources = [{ name: "Guide", uri: "docs://guide" }]
          expect((yield* service.resourceCatalog()).resources.map((resource) => resource.uri)).toEqual(["docs://guide"])
          expect(yield* service.readResource({ server: "resources", uri: "docs://readme" })).toEqual({
            server: "resources",
            uri: "docs://readme",
            contents: [
              { type: "text", uri: "docs://readme", text: "hello", mimeType: "text/plain" },
              { type: "blob", uri: "docs://logo", blob: "aGVsbG8=", mimeType: "image/png" },
            ],
          })
          expect(server.clientVersion()).toMatchObject({ name: "sdk", version: "1.2.3" })
        }).pipe(
          Effect.provide(resourceMcpLayer(server.url, undefined, { clientInfo: { name: "sdk", version: "1.2.3" } })),
        )
      }),
    ),
  )
})

test("adds, disconnects, and reconnects MCP servers at runtime", async () => {
  const published: string[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const service = yield* Mcp.Service

          expect((yield* service.servers())[0]?.status).toEqual({ status: "disabled" })
          expect(published).toContain(McpEvent.StatusChanged.type)
          expect(yield* service.connect("missing").pipe(Effect.flip)).toBeInstanceOf(Mcp.NotFoundError)
          expect(yield* service.disconnect("missing").pipe(Effect.flip)).toBeInstanceOf(Mcp.NotFoundError)
          yield* service.add(
            "dynamic",
            new ConfigMCP.Local({
              type: "local",
              command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
            }),
          )
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status).toEqual({
            status: "connected",
          })

          yield* service.add(
            "dynamic",
            new ConfigMCP.Local({
              type: "local",
              command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
              disabled: true,
            }),
          )
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status).toEqual({
            status: "disabled",
          })
          expect(yield* service.tools()).toEqual([])

          yield* service.connect("dynamic")
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status).toEqual({
            status: "connected",
          })
          yield* service.disconnect("dynamic")
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status).toEqual({
            status: "disabled",
          })
          expect(yield* service.tools()).toEqual([])

          yield* service.connect("dynamic")
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status).toEqual({
            status: "connected",
          })

          yield* service.remove("dynamic")
          expect((yield* service.servers()).some((server) => server.name === "dynamic")).toBe(false)
          expect(yield* service.tools()).toEqual([])
          expect(yield* service.remove("dynamic").pipe(Effect.flip)).toBeInstanceOf(Mcp.NotFoundError)
        }).pipe(
          Effect.provide(
            resourceMcpLayer(
              new ConfigMCP.Local({
                type: "local",
                command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
                disabled: true,
              }),
              undefined,
              undefined,
              { published },
            ),
          ),
        )
      }),
    ),
  )
})

testEffect(Layer.empty).live(
  "merges MCP defaults into the winning configured server without changing runtime overrides",
  () =>
    Effect.gen(function* () {
      const entries = [
        new Document({
          type: "document",
          info: new Info({
            mcp: new ConfigMCP.Info({
              timeout: { startup: 10, catalog: 20, execution: 30 },
              servers: {
                resources: { type: "local", command: ["earlier"], disabled: true, timeout: { execution: 90 } },
              },
            }),
          }),
        }),
        new Document({
          type: "document",
          info: new Info({
            mcp: new ConfigMCP.Info({
              timeout: { catalog: 40 },
              servers: {
                resources: { type: "local", command: ["later"], disabled: true, timeout: { startup: 50 } },
              },
            }),
          }),
        }),
      ]
      const original = JSON.stringify(entries)
      yield* Effect.gen(function* () {
        const service = yield* Mcp.Service
        const check = yield* service.transform((editor) => {
          expect(editor.get("resources")).toEqual({
            type: "local",
            command: ["later"],
            disabled: true,
            timeout: { startup: 50, catalog: 40, execution: 30 },
          })
        })
        yield* check.dispose
        const runtime = {
          type: "local",
          command: ["runtime"],
          disabled: true,
          timeout: { catalog: 60 },
        } satisfies ConfigMCP.Local
        yield* service.add("resources", runtime)
        yield* service.reload()
        yield* service.transform((editor) => {
          expect(editor.get("resources")).toEqual(runtime)
        })
      }).pipe(
        Effect.provide(
          resourceMcpLayer("https://unused.example", undefined, undefined, {
            entries: () => Effect.succeed(entries),
          }),
        ),
      )
      expect(JSON.stringify(entries)).toBe(original)
    }),
)

testEffect(resourceMcpLayer(new ConfigMCP.Local({ type: "local", command: ["unused"], disabled: true }))).live(
  "manages live MCP servers entirely through scoped transforms",
  () =>
    Effect.gen(function* () {
      const service = yield* Mcp.Service

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* service.transform((editor) => {
            editor.set("dynamic", {
              type: "local",
              command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
            })
          })
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status.status).toBe(
            "connected",
          )
          expect(yield* service.tools()).toHaveLength(2)

          yield* service.transform((editor) => editor.update("dynamic", (server) => (server.codemode = false)))
          expect((yield* service.tools()).map((tool) => tool.codemode)).toEqual([false, false])

          const settings = { disabled: true }
          yield* service.transform((editor) => {
            editor.update("dynamic", (server) => {
              server.disabled = settings.disabled
            })
          })
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status.status).toBe("disabled")
          expect(yield* service.tools()).toEqual([])

          settings.disabled = false
          yield* service.reload()
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status.status).toBe(
            "connected",
          )
          expect(yield* service.tools()).toHaveLength(2)

          const removed = yield* service.transform((editor) => editor.remove("dynamic"))
          expect((yield* service.servers()).some((server) => server.name === "dynamic")).toBe(false)
          expect(yield* service.tools()).toEqual([])

          yield* removed.dispose
          expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status.status).toBe(
            "connected",
          )
          expect(yield* service.tools()).toHaveLength(2)
        }),
      )

      expect((yield* service.servers()).map((server) => server.name)).toEqual([Mcp.ServerName.make("resources")])
      expect(yield* service.tools()).toEqual([])
    }),
)

test("restores runtime MCP config when a transform is disposed", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Mcp.Service
        const config = new ConfigMCP.Remote({
          type: "remote",
          url: "https://example.com/mcp",
          headers: { Authorization: "original" },
          oauth: false,
          disabled: true,
        })
        yield* service.add("dynamic", config)
        const transformed = yield* service.transform((editor) =>
          editor.update("dynamic", (server) => {
            if (server.type === "remote") server.headers = { Authorization: "transformed" }
          }),
        )
        let observed: string | undefined
        yield* service.transform((editor) => {
          const server = editor.get("dynamic")
          observed = server?.type === "remote" ? server.headers?.Authorization : undefined
        })

        expect(observed).toBe("transformed")
        expect(config.headers?.Authorization).toBe("original")
        yield* transformed.dispose
        expect(observed).toBe("original")
      }).pipe(
        Effect.provide(resourceMcpLayer(new ConfigMCP.Local({ type: "local", command: ["unused"], disabled: true }))),
      ),
    ),
  )
})

test("isolates nested configured MCP mutations and reconciles them", async () => {
  const published: string[] = []
  const config = new ConfigMCP.Remote({
    type: "remote",
    url: "https://example.com/mcp",
    headers: { Authorization: "original" },
    oauth: false,
    disabled: true,
  })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Mcp.Service
        expect(published.filter((type) => type === McpEvent.StatusChanged.type)).toHaveLength(1)
        yield* service.transform((editor) =>
          editor.update("resources", (server) => {
            if (server.type === "remote" && server.headers) server.headers.Authorization = "transformed"
          }),
        )

        expect(config.headers?.Authorization).toBe("original")
        expect(published.filter((type) => type === McpEvent.StatusChanged.type)).toHaveLength(2)
      }).pipe(Effect.provide(resourceMcpLayer(config, undefined, undefined, { published }))),
    ),
  )
})

testEffect(Layer.empty).live("batches MCP transforms without connecting intermediate configurations", () =>
  Effect.gen(function* () {
    const server = yield* resourceServer()
    yield* Effect.gen(function* () {
      const service = yield* Mcp.Service
      const registrations = yield* State.batch(
        Effect.gen(function* () {
          const added = yield* service.transform((editor) =>
            editor.set("dynamic", {
              type: "remote",
              url: server.url,
              oauth: false,
            }),
          )
          expect((yield* service.servers()).some((server) => server.name === "dynamic")).toBe(false)
          const disabled = yield* service.transform((editor) =>
            editor.update("dynamic", (config) => (config.disabled = true)),
          )
          return [added, disabled]
        }),
      )

      expect((yield* service.servers()).find((server) => server.name === "dynamic")?.status).toEqual({
        status: "disabled",
      })
      expect(yield* service.tools()).toEqual([])
      yield* State.batch(Effect.forEach(registrations, (registration) => registration.dispose))
      expect((yield* service.servers()).some((server) => server.name === "dynamic")).toBe(false)
      expect(server.state.initializations).toBe(0)
    }).pipe(
      Effect.provide(resourceMcpLayer(new ConfigMCP.Local({ type: "local", command: ["unused"], disabled: true }))),
    )
  }),
)

test("reconciles only changed MCP server config", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* resourceServer()
        const updates = yield* PubSub.unbounded<Payload>()
        const resources = (codemode?: boolean) =>
          new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false, codemode })
        const added = new ConfigMCP.Local({ type: "local", command: ["unused"], disabled: true })
        const dynamic = new ConfigMCP.Local({ type: "local", command: ["unused"], disabled: true })
        const document = (servers: Record<string, typeof ConfigMCP.Server.Type>, username?: string) =>
          new Document({
            type: "document",
            info: new Info({
              username,
              mcp: new ConfigMCP.Info({ servers }),
            }),
          })
        let entries = [document({ resources: resources() })]
        const publishUpdate = () =>
          PubSub.publish(updates, {
            id: ID.create(),
            created: 0,
            type: Event.Updated.type,
            data: {},
          } satisfies Payload<typeof Event.Updated>)

        yield* Effect.gen(function* () {
          const service = yield* Mcp.Service
          yield* service.tools()
          expect(server.state.toolLists).toBe(1)
          expect(server.state.initializations).toBe(1)

          yield* service.add("dynamic", dynamic)
          entries = [document({ resources: resources() }, "unrelated")]
          yield* publishUpdate()
          entries = [document({ resources: resources(), added }, "unrelated")]
          yield* publishUpdate()
          const appended = yield* service.servers().pipe(
            Effect.filterOrFail(
              (items) => items.some((item) => item.name === "added"),
              () => new Error("MCP config addition was not applied"),
            ),
            Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }),
          )
          expect(appended.map((item) => String(item.name)).toSorted()).toEqual(["added", "dynamic", "resources"])
          expect(server.state.toolLists).toBe(1)
          expect(server.state.initializations).toBe(1)

          entries = [
            document(
              {
                resources: resources(false),
                added,
              },
              "unrelated",
            ),
          ]
          yield* publishUpdate()
          yield* Effect.sync(() => server.state.initializations).pipe(
            Effect.filterOrFail(
              (count) => count === 2,
              () => new Error("MCP config change did not reconnect the server"),
            ),
            Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }),
          )

          entries = [document({ added }, "unrelated")]
          yield* publishUpdate()
          const removed = yield* service.servers().pipe(
            Effect.filterOrFail(
              (items) => !items.some((item) => item.name === "resources"),
              () => new Error("MCP config removal was not applied"),
            ),
            Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }),
          )
          expect(removed.map((item) => String(item.name)).toSorted()).toEqual(["added", "dynamic"])
        }).pipe(
          Effect.provide(
            resourceMcpLayer(resources(), undefined, undefined, {
              entries: () => Effect.sync(() => entries),
              subscribe: (() => Stream.fromPubSub(updates)) as Bus.Interface["subscribe"],
            }),
          ),
        )
      }),
    ),
  )
})

testEffect(Layer.empty).live("keeps MCP config snapshots stable during an in-flight replacement", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const accepted = yield* Deferred.make<void>()
    const server = yield* resourceServer({
      respond: (request) =>
        request.method !== "POST"
          ? undefined
          : Effect.runPromise(
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(undefined)),
            ),
    })

    yield* Effect.gen(function* () {
      const service = yield* Mcp.Service
      const replacing = yield* service
        .transform((editor) => editor.update("resources", (config) => (config.disabled = false)))
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(started)

      const restoring = yield* State.batch(
        Effect.gen(function* () {
          yield* service.transform((editor) => editor.update("resources", (config) => (config.disabled = true)))
          yield* Deferred.succeed(accepted, undefined)
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(accepted)
      expect((yield* service.servers())[0]?.status).toEqual({ status: "pending" })

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(replacing)
      yield* Fiber.join(restoring)
      expect((yield* service.servers())[0]?.status).toEqual({ status: "disabled" })
      expect(yield* service.tools()).toEqual([])
      expect(server.state.initializations).toBe(1)
    }).pipe(
      Effect.ensuring(Deferred.succeed(release, undefined)),
      Effect.provide(
        resourceMcpLayer(new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false, disabled: true })),
      ),
    )
  }),
)

const shutdownIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Bus.node, Integration.node, Credential.node, Form.node, Environment.node, Location.node]),
    [
      Location.node.replace(
        Layer.succeed(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
        ),
      ),
      Environment.node.replace(hostEnvironmentLayer),
    ],
  ),
)
shutdownIt.effect("discards in-flight and queued MCP notifications after its layer closes", () =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const root = yield* Scope.make()
    yield* Effect.addFinalizer(() =>
      Deferred.succeed(release, undefined).pipe(Effect.andThen(State.shutdown(Scope.close(root, Exit.void)))),
    )
    const context = yield* Layer.buildWithScope(Mcp.layer(), root)
    const service = Context.get(context, Mcp.Service)
    const observed: string[] = []
    let block = false
    yield* Effect.acquireRelease(
      bus.listen((event) =>
        Effect.gen(function* () {
          if (event.type !== McpEvent.StatusChanged.type) return
          observed.push(Schema.decodeUnknownSync(McpEvent.StatusChanged.data)(event.data).server)
          if (!block) return
          block = false
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }),
      ),
      (unsubscribe) => unsubscribe,
    )
    const source = { url: "https://example.com/initial", added: false }
    yield* service
      .transform((editor) => {
        editor.set("fixture", { type: "remote", url: source.url, oauth: false, disabled: true })
        if (source.added) editor.set("queued", { type: "local", command: ["unused"], disabled: true })
      })
      .pipe(Scope.provide(root))

    block = true
    source.url = "https://example.com/first"
    source.added = true
    const first = yield* service.reload().pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(entered)
    source.url = "https://example.com/second"
    const second = yield* service.reload().pipe(Effect.forkChild({ startImmediately: true }))

    const shutdown = yield* State.shutdown(Scope.close(root, Exit.void)).pipe(
      Effect.forkChild({ startImmediately: true }),
    )
    yield* TestClock.adjust("1 millis")
    expect(shutdown.pollUnsafe()).toBeDefined()
    expect(first.pollUnsafe()).toBeDefined()
    expect(second.pollUnsafe()).toBeDefined()
    expect(yield* Deferred.isDone(release)).toBe(false)
    yield* Fiber.join(shutdown)
    observed.length = 0
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    expect(observed).toEqual([])
    expect((yield* service.servers()).map((server) => server.name)).toEqual([Mcp.ServerName.make("fixture")])
  }),
)

test("serializes concurrent MCP lifecycle operations", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const service = yield* Mcp.Service

          // Whatever order the racing operations land in, the resulting state must be consistent.
          yield* Effect.all(
            [
              service.connect("resources"),
              service.connect("resources"),
              service.disconnect("resources"),
              service.connect("resources"),
            ],
            { concurrency: "unbounded", discard: true },
          )
          const status = (yield* service.servers()).find((server) => server.name === "resources")?.status
          const tools = yield* service.tools()
          expect(status?.status === "connected" || status?.status === "disabled").toBe(true)
          if (status?.status === "disabled") expect(tools).toEqual([])
          if (status?.status === "connected") expect(tools.length).toBeGreaterThan(0)

          yield* service.disconnect("resources")
          expect((yield* service.servers())[0]?.status).toEqual({ status: "disabled" })
          expect(yield* service.tools()).toEqual([])
          yield* service.connect("resources")
          expect((yield* service.servers())[0]?.status).toEqual({ status: "connected" })
          expect((yield* service.tools()).length).toBeGreaterThan(0)
        }).pipe(
          Effect.provide(
            resourceMcpLayer(
              new ConfigMCP.Local({
                type: "local",
                command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-output-schema.ts")],
                disabled: true,
              }),
            ),
          ),
        )
      }),
    ),
  )
})

testEffect(Layer.empty).live("isolates invalid MCP tools and preserves plugin transforms through catalog updates", () =>
  Effect.gen(function* () {
    const tool = (server: string, name: string, description = name) =>
      new Mcp.Tool({
        server: Mcp.ServerName.make(server),
        name,
        description,
        codemode: false,
        inputSchema: { type: "object", properties: {} },
      })
    const healthy = [tool("demo", "search"), tool("other", "lookup")]
    const namespace = tool("x".repeat(65), "lookup")
    const catalog = yield* Ref.make([tool("demo", "x".repeat(65)), ...healthy, namespace])

    yield* Effect.gen(function* () {
      const registry = yield* Tool.Service
      const registration = yield* McpTool.Service
      const bus = yield* Bus.Service
      yield* registration.flush
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([
        "demo_search",
        "other_lookup",
        "execute",
      ])
      const override = yield* registry.transform((editor) => {
        editor.add({
          name: "search",
          options: { namespace: "demo", codemode: false },
          description: "Override search",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed({ output: "override" }),
        })
      })
      const mutation = yield* registry.transform((editor) => {
        editor.update("other_lookup", (tool) => {
          tool.description += " updated"
        })
        editor.remove("repaired_lookup")
      })

      yield* Ref.set(catalog, [tool("demo", "y".repeat(65)), ...healthy, tool("demo", "added"), namespace])
      yield* bus.publish(McpEvent.ToolsChanged, { server: "demo" })
      yield* waitForTool(registry, "demo_added")
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([
        "demo_added",
        "demo_search",
        "other_lookup",
        "execute",
      ])
      expect((yield* toolDefinitions(registry)).find((tool) => tool.name === "demo_search")?.description).toBe(
        "Override search",
      )
      expect((yield* toolDefinitions(registry)).find((tool) => tool.name === "other_lookup")?.description).toBe(
        "lookup updated",
      )
      yield* Effect.forEach(["demo_search", "other_lookup"], (name) =>
        executeTool(registry, {
          sessionID: Session.ID.make("ses_mcp_invalid_catalog"),
          ...toolIdentity,
          call: { type: "tool-call", id: `call_${name}`, name, input: {} },
        }).pipe(
          Effect.tap((result) =>
            Effect.sync(() =>
              expect(result).toMatchObject({
                status: "completed",
                output: name === "demo_search" ? "override" : "healthy",
              }),
            ),
          ),
        ),
      )

      yield* Ref.set(catalog, [
        tool("demo", "status"),
        tool("other", "lookup"),
        tool("demo", "added"),
        tool("repaired", "lookup"),
      ])
      yield* bus.publish(McpEvent.ToolsChanged, { server: "demo" })
      yield* waitForTool(registry, "demo_status")
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([
        "demo_added",
        "demo_search",
        "demo_status",
        "other_lookup",
        "execute",
      ])
      expect((yield* toolDefinitions(registry)).find((tool) => tool.name === "demo_search")?.description).toBe(
        "Override search",
      )
      expect((yield* toolDefinitions(registry)).find((tool) => tool.name === "other_lookup")?.description).toBe(
        "lookup updated",
      )
      yield* mutation.dispose
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("repaired_lookup")
      expect((yield* toolDefinitions(registry)).find((tool) => tool.name === "other_lookup")?.description).toBe(
        "lookup",
      )

      yield* Ref.set(catalog, [tool("demo", "search", "Latest search"), tool("demo", "refreshed")])
      yield* bus.publish(McpEvent.ToolsChanged, { server: "demo" })
      yield* waitForTool(registry, "demo_refreshed")
      expect((yield* toolDefinitions(registry)).find((tool) => tool.name === "demo_search")?.description).toBe(
        "Override search",
      )

      yield* override.dispose
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([
        "demo_refreshed",
        "demo_search",
        "execute",
      ])
      expect((yield* toolDefinitions(registry)).find((tool) => tool.name === "demo_search")?.description).toBe(
        "Latest search",
      )
      expect(
        yield* executeTool(registry, {
          sessionID: Session.ID.make("ses_mcp_invalid_catalog"),
          ...toolIdentity,
          call: { type: "tool-call", id: "call_restored_search", name: "demo_search", input: {} },
        }),
      ).toMatchObject({ status: "completed", output: "healthy" })
    }).pipe(
      Effect.provide(
        Layer.fresh(
          AppNodeBuilder.build(LayerNode.group([Tool.node, McpTool.node, Bus.node]), [
            Mcp.node.replace(
              Layer.mock(Mcp.Service, {
                tools: () => Ref.get(catalog),
                callTool: (input) =>
                  Effect.succeed(
                    new Mcp.ToolResult({
                      server: Mcp.ServerName.make(input.server),
                      tool: input.name,
                      isError: false,
                      content: [{ type: "text", text: "healthy" }],
                    }),
                  ),
              }),
            ),
            Permission.node.replace(Layer.mock(Permission.Service, { assert: () => Effect.void })),
            Image.node.replace(imagePassthrough),
          ]),
        ),
      ),
    )
  }),
)

testEffect(Layer.empty).effect("coalesces queued MCP tool notifications after initial registration", () => {
  let reads = 0
  return Effect.gen(function* () {
    const registry = yield* Tool.Service
    const registration = yield* McpTool.Service
    const bus = yield* Bus.Service
    yield* registration.flush
    expect(reads).toBe(1)
    expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["demo_read_1", "execute"])

    yield* bus.publish(McpEvent.ToolsChanged, { server: "demo" })
    yield* advance(() => reads >= 2)
    expect(reads).toBe(2)
    yield* Effect.forEach(Array.from({ length: 20 }), () => bus.publish(McpEvent.ToolsChanged, { server: "demo" }))
    yield* advance(() => reads >= 3)
    yield* drain
    expect(reads).toBe(3)
    expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["demo_read_3", "execute"])
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Tool.node, McpTool.node, Bus.node]), [
        Mcp.node.replace(
          Layer.mock(Mcp.Service, {
            tools: () =>
              Effect.sync(() => [
                new Mcp.Tool({
                  server: Mcp.ServerName.make("demo"),
                  name: `read_${++reads}`,
                  codemode: false,
                  inputSchema: { type: "object", properties: {} },
                }),
              ]),
          }),
        ),
        Permission.node.replace(Layer.mock(Permission.Service, { assert: () => Effect.void })),
        Image.node.replace(imagePassthrough),
      ]),
    ),
  )
})

it.effect("advertises MCP output schemas to Code Mode", () =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    const registration = yield* McpTool.Service
    yield* registration.flush
    const toolSet = yield* registry.snapshot()
    const execute = toolSet.definitions.find((tool) => tool.name === "execute")

    expect(toolSet.definitions.map((tool) => tool.name)).toEqual([
      "direct_fail",
      "direct_issues",
      "direct_lookup",
      "direct_media",
      "execute",
    ])
    expect(codeModeListings(toolSet.codeModeCatalog!).find((tool) => tool.path === "demo.search")?.line).toContain(
      "ok: boolean",
    )
    expect(execute?.description).not.toContain("tools.demo.search")
  }),
)

it.effect("forwards the invoking session through direct and Code Mode MCP tools", () =>
  Effect.gen(function* () {
    assertion = yield* Deferred.make<Permission.AssertInput>()
    decision = Effect.void
    invocations = []
    const registry = yield* Tool.Service
    const registration = yield* McpTool.Service
    yield* registration.flush
    const toolSet = yield* registry.snapshot()

    expect(toolSet.definitions.find((tool) => tool.name === "direct_lookup")?.inputSchema).not.toHaveProperty(
      "properties.sessionID",
    )
    expect(codeModeListings(toolSet.codeModeCatalog!).find((tool) => tool.path === "demo.search")?.line).not.toContain(
      "sessionID",
    )

    const directSessionID = Session.ID.make("ses_mcp_direct")
    yield* toolSet.execute({
      sessionID: directSessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: "call_mcp_direct", name: "direct_lookup", input: {} },
    })
    expect(invocations[0]).toEqual({
      server: "direct",
      name: "lookup",
      args: {},
      sessionID: directSessionID,
    })

    const codeModeSessionID = Session.ID.make("ses_mcp_codemode")
    yield* toolSet.execute({
      sessionID: codeModeSessionID,
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "call_mcp_codemode",
        name: "execute",
        input: { code: "return await tools.demo.search({})" },
      },
    })
    expect(invocations[1]).toEqual({
      server: "demo",
      name: "search",
      args: {},
      sessionID: codeModeSessionID,
    })
  }),
)

it.effect("returns content-only MCP results through Code Mode", () =>
  Effect.gen(function* () {
    assertion = yield* Deferred.make<Permission.AssertInput>()
    decision = Effect.void
    const registry = yield* Tool.Service
    const registration = yield* McpTool.Service
    yield* registration.flush
    const toolSet = yield* registry.snapshot()

    expect(codeModeListings(toolSet.codeModeCatalog!).some((tool) => tool.path === "demo.status")).toBe(true)

    const execution = yield* toolSet.execute({
      sessionID: Session.ID.make("ses_mcp_content_only"),
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "call_mcp_content_only",
        name: "execute",
        input: { code: "return await tools.demo.status({})" },
      },
    })

    expect(execution).toMatchObject({
      output: { output: "hello", toolCalls: [{ tool: "demo.status", status: "completed" }] },
      content: [{ type: "text", text: "hello" }],
    })
  }),
)

it.effect("parses JSON text results from MCP tools without an output schema", () =>
  Effect.gen(function* () {
    assertion = yield* Deferred.make<Permission.AssertInput>()
    decision = Effect.void
    const registry = yield* Tool.Service
    const registration = yield* McpTool.Service
    yield* registration.flush
    const toolSet = yield* registry.snapshot()

    const run = (code: string) =>
      toolSet
        .execute({
          sessionID: Session.ID.make("ses_mcp_json_text"),
          ...toolIdentity,
          call: { type: "tool-call", id: `call_${code.length}`, name: "execute", input: { code } },
        })
        .pipe(Effect.map((execution) => execution.output.output))

    expect(yield* run("return (await tools.demo.issues({})).issues[0].id")).toBe("1")
    expect(yield* run("return typeof (await tools.demo.count({}))")).toBe("string")
    expect(yield* run("return typeof (await tools.demo.typed({}))")).toBe("string")

    // Outside Code Mode the content the model reads is the original text.
    expect(
      yield* toolSet.execute({
        sessionID: Session.ID.make("ses_mcp_json_text"),
        ...toolIdentity,
        call: { type: "tool-call", id: "call_direct_issues", name: "direct_issues", input: {} },
      }),
    ).toMatchObject({ output: { issues: [{ id: 1 }] }, content: [{ type: "text", text: '{"issues":[{"id":1}]}' }] })
  }),
)

it.effect("advertises MCP tools directly when Code Mode is disabled for the server", () =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    const registration = yield* McpTool.Service
    yield* registration.flush
    const definitions = yield* toolDefinitions(registry)
    const execute = definitions.find((tool) => tool.name === "execute")

    expect(definitions.some((tool) => tool.name === "direct_lookup")).toBe(true)
    expect(execute?.description).not.toContain("tools.direct.lookup")
  }),
)

// Baseline (PLAN.md step 1): MCP isError must become one failed tool call, not a
// success whose text happens to describe an error.
it.effect("fails the call when MCP reports isError", () =>
  Effect.gen(function* () {
    assertion = yield* Deferred.make<Permission.AssertInput>()
    decision = Effect.void
    const registry = yield* Tool.Service
    const registration = yield* McpTool.Service
    yield* registration.flush

    const execution = yield* executeTool(registry, {
      sessionID: Session.ID.make("ses_mcp_is_error"),
      ...toolIdentity,
      call: { type: "tool-call", id: "call_mcp_is_error", name: "direct_fail", input: {} },
    })

    expect(execution).toMatchObject({ status: "error", error: { message: "search index unavailable" } })
  }),
)

// Baseline (PLAN.md step 1): mixed MCP text and media content must reach the model intact.
it.effect("preserves MCP text and media content for the model", () =>
  Effect.gen(function* () {
    assertion = yield* Deferred.make<Permission.AssertInput>()
    decision = Effect.void
    const registry = yield* Tool.Service
    const registration = yield* McpTool.Service
    yield* registration.flush

    const execution = yield* executeTool(registry, {
      sessionID: Session.ID.make("ses_mcp_media"),
      ...toolIdentity,
      call: { type: "tool-call", id: "call_mcp_media", name: "direct_media", input: {} },
    })

    expect(execution.output).toBe("rendered chart")
    expect(execution.content).toMatchObject([
      { type: "text", text: "rendered chart" },
      { type: "file", mime: "image/png" },
    ])
  }),
)

it.effect("waits for permission before calling an MCP tool", () =>
  Effect.gen(function* () {
    calls = 0
    assertion = yield* Deferred.make<Permission.AssertInput>()
    const permission = yield* Deferred.make<void>()
    decision = Deferred.await(permission)
    const registry = yield* Tool.Service
    const registration = yield* McpTool.Service
    yield* registration.flush
    const toolSet = yield* registry.snapshot()
    expect(codeModeListings(toolSet.codeModeCatalog!).some((tool) => tool.path === "demo.search")).toBe(true)

    const fiber = yield* toolSet
      .execute({
        sessionID: Session.ID.make("ses_mcp_permission"),
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call_mcp_permission",
          name: "execute",
          input: { code: "return await tools.demo.search({})" },
        },
      })
      .pipe(Effect.forkScoped)
    expect(yield* Deferred.await(assertion)).toEqual({
      action: "demo_search",
      resources: ["*"],
      save: ["*"],
      metadata: {},
      sessionID: Session.ID.make("ses_mcp_permission"),
      agent: toolIdentity.agent,
      source: {
        type: "tool",
        messageID: toolIdentity.messageID,
        id: "call_mcp_permission",
      },
    })
    expect(calls).toBe(0)

    yield* Deferred.succeed(permission, undefined)
    yield* Fiber.join(fiber)
    expect(calls).toBe(1)
  }),
)

it.effect("does not call MCP when permission is blocked", () =>
  Effect.gen(function* () {
    calls = 0
    assertion = yield* Deferred.make<Permission.AssertInput>()
    decision = Effect.fail(new Permission.BlockedError({ rules: [], permission: "demo_search", resources: ["*"] }))
    const registry = yield* Tool.Service
    const registration = yield* McpTool.Service
    yield* registration.flush
    const toolSet = yield* registry.snapshot()
    expect(codeModeListings(toolSet.codeModeCatalog!).some((tool) => tool.path === "demo.search")).toBe(true)

    const execution = yield* toolSet.execute({
      sessionID: Session.ID.make("ses_mcp_blocked"),
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "call_mcp_blocked",
        name: "execute",
        input: { code: "return await tools.demo.search({})" },
      },
    })
    expect(execution.content).toEqual([{ type: "text", text: "Unable to execute demo_search" }])
    expect(execution.metadata).toEqual({
      toolCalls: [{ tool: "demo.search", status: "error" }],
      error: true,
    })
    expect(calls).toBe(0)
  }),
)
