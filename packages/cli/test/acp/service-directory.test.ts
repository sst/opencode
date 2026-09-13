import { describe, expect, test } from "bun:test"
import type { McpServer, SessionConfigOption } from "@agentclientprotocol/sdk"
import { makeACPFixture, makeSession, secondModel, testModel } from "./service-fixture"
import { flattenSelectOptions, requireSelectOption } from "./subprocess"

describe("acp service directory behavior", () => {
  test("does not cache an available model before plugin activation settles", async () => {
    const requested = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let ready = false
    await using fixture = makeACPFixture({
      fetch(request) {
        requested.resolve()
        if (request.path === "/api/plugin/await-activation") {
          return release.promise.then(() => {
            ready = true
            return new Response(null, { status: 204 })
          })
        }
        if (!ready && request.path === "/api/model") {
          return Response.json({ data: [{ ...testModel, providerID: "ambient" }] })
        }
        if (!ready && request.path === "/api/model/default") {
          return Response.json({ data: { ...testModel, providerID: "ambient" } })
        }
        if (request.path === "/api/session" && request.method === "POST") {
          return Response.json({ data: { ...makeSession("ses_ready"), model: undefined } })
        }
        return undefined
      },
    })
    const pending = fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })
    try {
      await requested.promise
      expect(fixture.requests.map((request) => request.path)).toEqual(["/api/plugin/await-activation"])
      expect(fixture.requests[0]?.query["location[directory]"]).toBe("/workspace")
      release.resolve()
      expect(currentValue(await pending, "model")).toBe("test/test-model")
      expect(
        fixture.requests.find((request) => request.path === "/api/session" && request.method === "POST")?.body,
      ).toMatchObject({ model: { providerID: "test", id: "test-model" } })
    } finally {
      release.resolve()
      await pending.catch(() => {})
    }
  })

  test("creates sessions from a catalog shared by concurrent callers in the same cwd", async () => {
    let created = 0
    await using fixture = makeACPFixture({
      fetch(request) {
        if (request.method !== "POST" || request.path !== "/api/session") return undefined
        created++
        return Response.json({
          data: makeSession(`ses_${created}`, { cwd: created <= 2 ? "/workspace" : "/other" }),
        })
      },
    })

    const first = await Promise.all([
      fixture.service.newSession({ cwd: "/workspace", mcpServers: [] }),
      fixture.service.newSession({ cwd: "/workspace", mcpServers: [] }),
    ])
    const other = await fixture.service.newSession({ cwd: "/other", mcpServers: [] })

    expect(first.map((session) => session.sessionId).toSorted()).toEqual(["ses_1", "ses_2"])
    expect(other.sessionId).toBe("ses_3")
    expect(currentValue(first[0], "model")).toBe("test/test-model")
    expect(currentValue(first[0], "mode")).toBe("build")
    expect(
      [
        "/api/plugin/await-activation",
        "/api/model",
        "/api/model/default",
        "/api/agent",
        "/api/command",
        "/api/skill",
      ].map((path) =>
        fixture.requests
          .filter((request) => request.path === path)
          .map((request) => request.query["location[directory]"]),
      ),
    ).toEqual([
      ["/workspace", "/other"],
      ["/workspace", "/other"],
      ["/workspace", "/other"],
      ["/workspace", "/other"],
      ["/workspace", "/other"],
      ["/workspace", "/other"],
    ])
    expect(
      fixture.requests
        .filter((request) => request.method === "POST" && request.path === "/api/session")
        .map((request) => request.body),
    ).toEqual([
      {
        agent: "build",
        model: { providerID: "test", id: "test-model", variant: "default" },
        location: { directory: "/workspace" },
      },
      {
        agent: "build",
        model: { providerID: "test", id: "test-model", variant: "default" },
        location: { directory: "/workspace" },
      },
      {
        agent: "build",
        model: { providerID: "test", id: "test-model", variant: "default" },
        location: { directory: "/other" },
      },
    ])
    expect(
      fixture.updates.map((item) =>
        item.update.sessionUpdate === "available_commands_update"
          ? item.update.availableCommands.map((command) => command.name)
          : [],
      ),
    ).toEqual([
      ["review", "verify"],
      ["review", "verify"],
      ["review", "verify"],
    ])
  })

  test.each(["empty", "missing the default"])(
    "retries when the model list is %s but the default is ready",
    async (initial) => {
      await using fixture = makeACPFixture({
        fetch(request, context) {
          if (
            request.path === "/api/model" &&
            context.requests.filter((request) => request.path === "/api/model").length === 1
          ) {
            return Response.json({
              location: {
                directory: "/workspace",
                project: { id: "global", directory: "/workspace", canonical: "/workspace" },
              },
              data: initial === "empty" ? [] : [secondModel],
            })
          }
          if (request.method === "POST" && request.path === "/api/session") {
            return Response.json({ data: makeSession("ses_ready") })
          }
          return undefined
        },
      })

      const session = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })
      const model = requireSelectOption(session.configOptions, "model")
      const choices = flattenSelectOptions(model).map((option) => option.value)

      expect(choices).toContain("test/second-model")
      expect(choices).toContain("test/test-model")
      expect(model.currentValue).toBe("test/test-model")
      expect(fixture.requests.filter((request) => request.path === "/api/model")).toHaveLength(2)
    },
  )

  test("does not cache a failed catalog load", async () => {
    let modelCalls = 0
    await using fixture = makeACPFixture({
      fetch(request) {
        if (request.path === "/api/model") {
          modelCalls++
          if (modelCalls === 1) {
            return Response.json(
              { name: "ModelsNotReadyError", data: { message: "catalog is warming" } },
              { status: 503 },
            )
          }
        }
        if (request.method === "POST" && request.path === "/api/session") {
          return Response.json({ data: makeSession("ses_retry") })
        }
        return undefined
      },
    })

    const failure = await fixture.service
      .newSession({ cwd: "/workspace", mcpServers: [] })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ name: "ModelsNotReadyError" })
    const retried = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })

    expect(retried.sessionId).toBe("ses_retry")
    expect(modelCalls).toBe(2)
  })

  test("switches model, effort, and mode against the warm catalog", async () => {
    await using fixture = makeACPFixture({
      fetch(request) {
        if (request.method === "POST" && request.path === "/api/session") {
          return Response.json({ data: makeSession("ses_config") })
        }
        if (
          request.method === "POST" &&
          (request.path === "/api/session/ses_config/model" || request.path === "/api/session/ses_config/agent")
        ) {
          return new Response(null, { status: 204 })
        }
        return undefined
      },
    })
    const session = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })

    const selectedModel = await fixture.service.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "model",
      value: "test/second-model",
    })
    const selectedEffort = await fixture.service.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "effort",
      value: "medium",
    })
    const selectedMode = await fixture.service.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "mode",
      value: "plan",
    })
    await fixture.service.setSessionMode({ sessionId: session.sessionId, modeId: "build" })

    expect(currentValue(selectedModel, "model")).toBe("test/second-model")
    expect(currentValue(selectedModel, "effort")).toBe("default")
    expect(currentValue(selectedEffort, "effort")).toBe("medium")
    expect(currentValue(selectedMode, "mode")).toBe("plan")
    expect(
      fixture.requests
        .filter((request) => request.path === "/api/session/ses_config/model")
        .map((request) => request.body),
    ).toEqual([
      { model: { providerID: "test", id: secondModel.id } },
      { model: { providerID: "test", id: secondModel.id, variant: "medium" } },
    ])
    expect(
      fixture.requests
        .filter((request) => request.path === "/api/session/ses_config/agent")
        .map((request) => request.body),
    ).toEqual([{ agent: "plan" }, { agent: "build" }])
    expect(fixture.requests.filter((request) => request.path === "/api/model")).toHaveLength(1)

    const invalidEffort = await fixture.service
      .setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "effort",
        value: "maximum",
      })
      .catch((error: unknown) => error)
    const invalidMode = await fixture.service
      .setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "mode",
        value: "missing",
      })
      .catch((error: unknown) => error)
    const invalidConfig = await fixture.service
      .setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "missing",
        value: "value",
      })
      .catch((error: unknown) => error)
    expect(invalidEffort).toMatchObject({ _tag: "ACPInvalidEffortError" })
    expect(invalidMode).toMatchObject({ _tag: "ACPInvalidModeError" })
    expect(invalidConfig).toMatchObject({ _tag: "ACPInvalidConfigOptionError" })
  })

  test("converts MCP configs and deduplicates registrations per session and config", async () => {
    const local: McpServer = {
      name: "tools",
      command: "bun",
      args: ["server.ts"],
      env: [{ name: "TOKEN", value: "x" }],
    }
    const changed: McpServer = { ...local, args: ["changed.ts"] }
    const remote: McpServer = {
      type: "http",
      name: "docs",
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer x" }],
    }
    let created = 0
    await using fixture = makeACPFixture({
      fetch(request) {
        if (request.method === "POST" && request.path === "/api/session") {
          created++
          return Response.json({ data: makeSession(`ses_${created}`) })
        }
        if (request.method === "GET" && request.path === "/api/session/ses_1") {
          return Response.json({ data: makeSession("ses_1") })
        }
        if (request.method === "PUT" && request.path.startsWith("/api/mcp/")) {
          return new Response(null, { status: 204 })
        }
        return undefined
      },
    })

    await fixture.service.newSession({ cwd: "/workspace", mcpServers: [local, local, remote] })
    await fixture.service.resumeSession({ cwd: "/workspace", sessionId: "ses_1", mcpServers: [local, remote] })
    await fixture.service.resumeSession({ cwd: "/workspace", sessionId: "ses_1", mcpServers: [changed] })
    await fixture.service.newSession({ cwd: "/workspace", mcpServers: [local] })

    const adds = fixture.requests.filter((request) => request.method === "PUT" && request.path.startsWith("/api/mcp/"))
    expect(adds).toHaveLength(4)
    expect(adds.filter((request) => request.path === "/api/mcp/tools").map((request) => request.body)).toEqual([
      {
        config: {
          type: "local",
          command: ["bun", "server.ts"],
          environment: { TOKEN: "x" },
        },
      },
      {
        config: {
          type: "local",
          command: ["bun", "changed.ts"],
          environment: { TOKEN: "x" },
        },
      },
      {
        config: {
          type: "local",
          command: ["bun", "server.ts"],
          environment: { TOKEN: "x" },
        },
      },
    ])
    expect(adds.find((request) => request.path === "/api/mcp/docs")?.body).toEqual({
      config: {
        type: "remote",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer x" },
        oauth: false,
      },
    })
    expect(adds.map((request) => request.query)).toEqual([
      { "location[directory]": "/workspace" },
      { "location[directory]": "/workspace" },
      { "location[directory]": "/workspace" },
      { "location[directory]": "/workspace" },
    ])
  })
})

function currentValue(
  result: { readonly configOptions?: readonly SessionConfigOption[] | null } | undefined,
  id: string,
) {
  return result?.configOptions?.find((option) => option.id === id)?.currentValue
}
