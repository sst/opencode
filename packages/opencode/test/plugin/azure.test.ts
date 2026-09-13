import { afterEach, describe, expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "../fixture/fixture"
import type { Hooks } from "@opencode-ai/plugin"
import type { Auth, Provider } from "@opencode-ai/sdk/v2"
import { OAUTH_DUMMY_KEY } from "../../src/auth"
import { AzureAuthPlugin, createAzureAuthHooks } from "../../src/plugin/azure"
import { Process } from "../../src/util/process"
import { which } from "@opencode-ai/core/util/which"

const resourceName = process.env.AZURE_RESOURCE_NAME
const originalPath = process.env.PATH

afterEach(() => {
  if (resourceName === undefined) delete process.env.AZURE_RESOURCE_NAME
  else process.env.AZURE_RESOURCE_NAME = resourceName
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
})

const oauth: Auth = {
  type: "oauth",
  access: OAUTH_DUMMY_KEY,
  refresh: OAUTH_DUMMY_KEY,
  expires: Date.now() + 60 * 60 * 1000,
  accountId: "test-resource",
}

const provider: Provider = {
  id: "azure",
  name: "Azure",
  source: "custom",
  env: [],
  options: {},
  models: {},
}

function oauthMethod(hooks: Hooks) {
  const method = hooks.auth?.methods.find((method) => method.type === "oauth")
  if (!method || method.type !== "oauth") throw new Error("Azure OAuth method is missing")
  return method
}

function loader(hooks: Hooks) {
  if (!hooks.auth?.loader) throw new Error("Azure auth loader is missing")
  return hooks.auth.loader
}

function customFetch(options: Record<string, unknown>) {
  const result = options["fetch"]
  if (typeof result !== "function") throw new Error("Azure custom fetch is missing")
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const response: unknown = await Reflect.apply(result, undefined, [input, init])
    if (!(response instanceof Response)) throw new Error("Azure custom fetch returned an invalid response")
    return response
  }
}

function azureShell(scopes: string[]) {
  return async (args: string[]) => {
    const scope = args[args.indexOf("--scope") + 1]
    scopes.push(scope)
    return {
      accessToken: `${scope}-token`,
      expires_on: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
    }
  }
}

async function azureCli(dir: string) {
  const bin = path.join(dir, "azure cli")
  const calls = path.join(dir, "calls.jsonl")
  const script = path.join(bin, "cli.cjs")
  await Bun.write(calls, "")
  await Bun.write(
    script,
    `
    const fs = require("node:fs")
    const args = process.argv.slice(2)
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n")
    console.log(JSON.stringify(args.includes("get-access-token")
      ? { accessToken: "test-token", expires_on: Math.floor(Date.now() / 1000) + 3600 }
      : []))
  `,
  )
  const executable = path.join(bin, process.platform === "win32" ? "az.cmd" : "az")
  await Bun.write(
    executable,
    process.platform === "win32"
      ? `@"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,
  )
  await chmod(executable, 0o755)
  return {
    bin,
    calls: async () =>
      (await Bun.file(calls).text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  }
}

describe("plugin.azure", () => {
  test("initializes and runs Azure CLI under Node without Bun or a plugin shell", async () => {
    await using tmp = await tmpdir()
    const node = which("node")
    if (!node) throw new Error("Node is required for the Azure runtime compatibility test")
    const bundle = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "../../src/plugin/azure.ts")],
      target: "node",
      format: "esm",
    })
    expect(bundle.success).toBe(true)
    const entry = path.join(tmp.path, "azure.mjs")
    await Bun.write(entry, bundle.outputs[0])
    const cli = await azureCli(tmp.path)
    for (const installed of [false, true]) {
      const result = await Process.run(
        [
          node,
          "--input-type=module",
          "-e",
          `
        import assert from "node:assert/strict"
        import { AzureAuthPlugin } from ${JSON.stringify(pathToFileURL(entry).href)}
        assert.equal(typeof Bun, "undefined")
        delete process.env.AZURE_RESOURCE_NAME
        const hooks = await AzureAuthPlugin({ $: undefined })
        assert.equal(hooks.auth.provider, "azure")
        assert.deepEqual(hooks.auth.methods.map((method) => method.type), ${JSON.stringify(installed ? ["api", "oauth"] : ["api"])})
        if (${installed}) {
          const method = hooks.auth.methods.find((method) => method.type === "oauth")
          assert.equal(method.prompts[0].type, "text")
          const authorization = await method.authorize({ resourceName: "test-resource" })
          const auth = await authorization.callback()
          assert.equal(auth.type, "success")
          assert.equal(auth.accountId, "test-resource")
        }
      `,
        ],
        {
          env: { PATH: installed ? cli.bin : tmp.path, XDG_DATA_HOME: tmp.path },
          nothrow: true,
        },
      )
      expect(result.stderr.toString()).toBe("")
      expect(result.code).toBe(0)
    }
    expect(await cli.calls()).toEqual([
      ["account", "get-access-token", "--scope", "https://cognitiveservices.azure.com/.default", "--output", "json"],
    ])
  })

  test("does not invoke Azure CLI during initialization", async () => {
    await using tmp = await tmpdir()
    const cli = await azureCli(tmp.path)
    process.env.PATH = cli.bin
    delete process.env.AZURE_RESOURCE_NAME

    const hooks = await AzureAuthPlugin()

    expect(await cli.calls()).toEqual([])
    expect(oauthMethod(hooks).prompts?.[0].type).toBe("text")
  })

  test("keeps the existing API-key method and adds Entra ID", () => {
    delete process.env.AZURE_RESOURCE_NAME
    const hooks = createAzureAuthHooks(azureShell([]), fetch, true)

    expect(hooks.auth?.provider).toBe("azure")
    expect(hooks.auth?.methods.map((method) => [method.type, method.label])).toEqual([
      ["api", "API key"],
      ["oauth", "Microsoft Entra ID (Azure CLI)"],
    ])
    expect(hooks.auth?.methods[0]).toEqual({
      type: "api",
      label: "API key",
      prompts: [
        {
          type: "text",
          key: "resourceName",
          message: "Enter Azure Resource Name",
          placeholder: "e.g. my-models",
        },
      ],
    })
    expect(hooks.auth?.methods[1].prompts).toEqual(hooks.auth?.methods[0].prompts)
  })

  test("hides Azure CLI authentication when the Azure CLI is not installed", () => {
    const hooks = createAzureAuthHooks(azureShell([]), fetch, false)

    expect(hooks.auth?.methods.map((method) => method.type)).toEqual(["api"])
  })

  test("checks Azure CLI and stores the resource name", async () => {
    const scopes: string[] = []
    const hooks = createAzureAuthHooks(azureShell(scopes), fetch, true)
    const authorization = await oauthMethod(hooks).authorize({ resourceName: "test-resource" })
    if (authorization.method !== "auto") throw new Error("Unexpected Azure authorization method")

    expect(await authorization.callback()).toMatchObject({
      type: "success",
      access: OAUTH_DUMMY_KEY,
      refresh: OAUTH_DUMMY_KEY,
      accountId: "test-resource",
    })
    expect(scopes).toEqual(["https://cognitiveservices.azure.com/.default"])
  })

  test("supports Azure CLI versions that only provide expiresOn", async () => {
    const hooks = createAzureAuthHooks(
      async () => ({
        accessToken: "legacy-token",
        expiresOn: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
      fetch,
      true,
    )
    const authorization = await oauthMethod(hooks).authorize({ resourceName: "test-resource" })
    if (authorization.method !== "auto") throw new Error("Unexpected Azure authorization method")

    expect(await authorization.callback()).toMatchObject({ type: "success", accountId: "test-resource" })
  })

  test("rejects Azure CLI tokens without a usable expiration", async () => {
    const hooks = createAzureAuthHooks(async () => ({ accessToken: "invalid-token" }), fetch, true)
    const authorization = await oauthMethod(hooks).authorize({ resourceName: "test-resource" })
    if (authorization.method !== "auto") throw new Error("Unexpected Azure authorization method")

    await expect(authorization.callback()).rejects.toThrow("Azure CLI returned an invalid token expiration")
  })

  test("does not change API-key loading", async () => {
    const scopes: string[] = []
    const hooks = createAzureAuthHooks(azureShell(scopes), fetch, true)

    expect(await loader(hooks)(async () => ({ type: "api", key: "test-key" }), provider)).toEqual({})
    expect(scopes).toEqual([])
  })

  test("uses Azure CLI bearer tokens for Azure inference endpoints", async () => {
    const scopes: string[] = []
    const requests: Headers[] = []
    const hooks = createAzureAuthHooks(
      azureShell(scopes),
      async (_input, init) => {
        requests.push(new Headers(init?.headers))
        return new Response(null, { status: 200 })
      },
      true,
    )
    const options = await loader(hooks)(async () => oauth, provider)
    const request = customFetch(options)

    await request("https://test-resource.openai.azure.com/openai/v1/responses", {
      headers: { "api-key": OAUTH_DUMMY_KEY, "x-keep": "yes" },
    })
    await request("https://test-resource.services.ai.azure.com/models/chat/completions", {
      headers: { Authorization: `Bearer ${OAUTH_DUMMY_KEY}` },
    })
    await request("https://test-resource.services.ai.azure.com/anthropic/v1/messages", {
      headers: { "x-api-key": OAUTH_DUMMY_KEY },
    })

    expect(scopes).toEqual(["https://cognitiveservices.azure.com/.default", "https://ai.azure.com/.default"])
    expect(requests.map((headers) => headers.get("authorization"))).toEqual([
      "Bearer https://cognitiveservices.azure.com/.default-token",
      "Bearer https://cognitiveservices.azure.com/.default-token",
      "Bearer https://ai.azure.com/.default-token",
    ])
    expect(requests[0].get("api-key")).toBeNull()
    expect(requests[0].get("x-keep")).toBe("yes")
    expect(requests[2].get("x-api-key")).toBeNull()
    expect(requests.every((headers) => headers.get("user-agent")?.startsWith("opencode/"))).toBe(true)
  })
})
