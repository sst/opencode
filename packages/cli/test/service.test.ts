import { NodeFileSystem } from "@effect/platform-node"
import { Service, type Info } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { OPENCODE_VERSION } from "../src/version"
import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"
import { ServiceRegistration } from "../src/services/service-registration"
import { isolatedEnv } from "./fixture/environment"

test("managed service ports are stable per installation channel", () => {
  const expectedDefault = process.platform === "win32" ? 0x40de : 0xc0de
  const expectedLocal = process.platform === "win32" ? 0x40df : 0xc0df
  expect(ServiceConfig.defaultPort("latest")).toBe(expectedDefault)
  expect(ServiceConfig.defaultPort("dev")).toBe(expectedDefault)
  expect(ServiceConfig.defaultPort("beta")).toBe(expectedDefault)
  expect(ServiceConfig.defaultPort("next")).toBe(expectedDefault)
  expect(ServiceConfig.defaultPort("local")).toBe(expectedLocal)
  expect(ServiceConfig.defaultPort("preview-a")).toBe(ServiceConfig.defaultPort("preview-a"))
  expect(ServiceConfig.defaultPort("preview-a")).not.toBe(ServiceConfig.defaultPort("preview-b"))
})

test("local channel stores service config with the local service filename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-"))
  try {
    await Effect.runPromise(
      ServiceConfig.set("hostname", "127.0.0.2").pipe(
        Effect.provide(Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })),
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(path.join(root, "config", "service-local.json")).json()).toEqual({
      hostname: "127.0.0.2",
    })
    expect(await Bun.file(path.join(root, "config", "service.json")).exists()).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("service config manages environment variables", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-env-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  try {
    await Effect.runPromise(
      ServiceConfig.set("env", "OPENCODE_SERVICE_ENV_TEST", "configured").pipe(
        Effect.provide(layer),
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(
      await Effect.runPromise(
        ServiceConfig.get("env", "OPENCODE_SERVICE_ENV_TEST").pipe(
          Effect.provide(layer),
          Effect.provide(NodeFileSystem.layer),
        ),
      ),
    ).toBe("configured")
    expect(
      (
        await Effect.runPromise(
          ServiceConfig.options().pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)),
        )
      ).env,
    ).toEqual({ OPENCODE_SERVICE_ENV_TEST: "configured" })

    await Effect.runPromise(
      ServiceConfig.unset("env", "OPENCODE_SERVICE_ENV_TEST").pipe(
        Effect.provide(layer),
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(path.join(root, "config", "service-local.json")).json()).toEqual({})
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("service filenames share release channels and identify preview channels", () => {
  expect(ServiceConfig.filename("latest")).toBe("service.json")
  expect(ServiceConfig.filename("dev")).toBe("service.json")
  expect(ServiceConfig.filename("beta")).toBe("service.json")
  expect(ServiceConfig.filename("next")).toBe("service.json")
  expect(ServiceConfig.filename("local")).toBe("service-local.json")
  expect(ServiceConfig.filename("preview-a")).toBe("service-preview-a.json")
  expect(ServiceConfig.filename("preview/a")).toBe("service-preview-a.json")
  expect(ServiceConfig.versionBelongsToChannel("0.0.0-preview-a-1234", "preview-a")).toBe(true)
  expect(ServiceConfig.versionBelongsToChannel("0.0.0-preview-a-1234.2", "preview-a")).toBe(true)
  expect(ServiceConfig.versionBelongsToChannel("0.0.0-preview-a-other-1234", "preview-a")).toBe(false)
  expect(ServiceConfig.versionBelongsToChannel("1.2.3", "preview-a")).toBe(false)
})

test("service config migrates from the hashed channel filename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-config-migration-"))
  const legacy = path.join(root, ServiceConfig.legacyFilename("preview-a")!)
  const target = path.join(root, ServiceConfig.filename("preview-a"))
  try {
    await fs.writeFile(legacy, JSON.stringify({ hostname: "127.0.0.2", port: 4098 }))
    await Effect.runPromise(ServiceConfig.migrateConfig(legacy, target).pipe(Effect.provide(NodeFileSystem.layer)))
    expect(await Bun.file(target).json()).toEqual({ hostname: "127.0.0.2", port: 4098 })

    await fs.writeFile(target, JSON.stringify({ port: 4099 }))
    await Effect.runPromise(ServiceConfig.migrateConfig(legacy, target).pipe(Effect.provide(NodeFileSystem.layer)))
    expect(await Bun.file(target).json()).toEqual({ port: 4099 })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("preview registration migration never moves stable discovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-migration-"))
  const legacy = path.join(root, "service.json")
  const target = path.join(root, ServiceConfig.filename("preview-a"))
  try {
    await fs.writeFile(
      legacy,
      JSON.stringify({ id: "old-preview", version: "0.0.0-preview-a-1234", url: "http://localhost:4096", pid: 1 }),
    )
    await Effect.runPromise(
      ServiceConfig.migrateRegistration(legacy, target, "preview-a", "0.0.0-preview-a-5678").pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Bun.file(target).json()).toMatchObject({ id: "old-preview" })

    await fs.rm(target)
    await fs.writeFile(legacy, JSON.stringify({ id: "stable", version: "1.2.3", url: "http://localhost:4096", pid: 1 }))
    await Effect.runPromise(
      ServiceConfig.migrateRegistration(legacy, target, "preview-a", "0.0.0-preview-a-5678").pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Bun.file(target).exists()).toBe(false)

    await fs.writeFile(
      legacy,
      JSON.stringify({ id: "old-preview", version: "0.0.0-preview-a-1234", url: "http://localhost:4096", pid: 1 }),
    )
    await fs.writeFile(target, JSON.stringify({ id: "current-preview" }))
    await Effect.runPromise(
      ServiceConfig.migrateRegistration(legacy, target, "preview-a", "0.0.0-preview-a-5678").pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(legacy).exists()).toBe(true)
    expect(await Bun.file(target).json()).toMatchObject({ id: "current-preview" })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("deleting a managed service registration stops its owner", async () => {
  const service = await startManagedService("opencode-service-delete-")
  try {
    await fs.rm(service.registration)
    expect(await waitForExit(service.owner)).toBe(true)
    expect(await Bun.file(service.registration).exists()).toBe(false)
    await expectPortAvailable(service.port)
  } finally {
    await stopManagedService(service)
  }
}, 30_000)

test("deleting a failed service registration stops its owner", async () => {
  const service = await startManagedService("opencode-service-failed-delete-", true)
  try {
    await waitForFailed(service.info)
    await fs.rm(service.registration)
    expect(await waitForExit(service.owner)).toBe(true)
    await expectPortAvailable(service.port)
  } finally {
    await stopManagedService(service)
  }
}, 30_000)

test("corrupting a managed service registration stops its owner", async () => {
  const service = await startManagedService("opencode-service-corrupt-")
  try {
    await fs.writeFile(service.registration, "not-json")
    expect(await waitForExit(service.owner)).toBe(true)
    expect(await Bun.file(service.registration).text()).toBe("not-json")
    await expectPortAvailable(service.port)
  } finally {
    await stopManagedService(service)
  }
}, 30_000)

test("replacing a managed service registration stops its owner and preserves the foreign owner", async () => {
  const service = await startManagedService("opencode-service-foreign-")
  const foreign = { ...service.info, id: "foreign-owner", pid: process.pid }
  try {
    await fs.writeFile(service.registration, JSON.stringify(foreign))
    expect(await waitForExit(service.owner)).toBe(true)
    expect(await Bun.file(service.registration).json()).toEqual(foreign)
    await expectPortAvailable(service.port)
  } finally {
    await stopManagedService(service)
  }
}, 30_000)

test("clean managed service shutdown removes its registration", async () => {
  const service = await startManagedService("opencode-service-clean-")
  try {
    await Effect.runPromise(Service.stop({ file: service.registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    expect(await waitForExit(service.owner)).toBe(true)
    expect(await Bun.file(service.registration).exists()).toBe(false)
  } finally {
    await stopManagedService(service)
  }
}, 30_000)

test("concurrent service processes elect one server", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-election-"))
  const database = path.join(root, "opencode.db")
  const env = {
    ...process.env,
    HOME: root,
    OPENCODE_DB: database,
    OPENCODE_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
  const command = [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"]
  const registration = path.join(root, "state", "opencode", "service-local.json")
  const port = await availablePort()
  const config = path.join(root, "config", "opencode", "service-local.json")
  await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
  await fs.writeFile(config, JSON.stringify({ port }))
  const processes = Array.from({ length: 10 }, () => Bun.spawn(command, { env, stderr: "pipe", stdout: "pipe" }))

  try {
    const info = await waitForInfo(registration)
    const winner = processes.find((process) => process.pid === info.pid)
    const losers = processes.filter((process) => process.pid !== info.pid)
    const exited = await Promise.all(
      losers.map((process) => Promise.race([process.exited.then(() => true), Bun.sleep(60_000).then(() => false)])),
    )

    expect(exited).toEqual(losers.map(() => true))
    const errors = await Promise.all(
      losers.map(
        async (process) => (await new Response(process.stdout).text()) + (await new Response(process.stderr).text()),
      ),
    )
    expect(
      losers.map((process) => process.exitCode),
      errors.filter(Boolean).join("\n"),
    ).toEqual(losers.map(() => 0))
    expect(winner?.exitCode).toBe(null)
    expect(new URL(info.url).port).toBe(String(port))
    expect((await Bun.file(config).json()).password).toBe(info.password)
    expect(await Bun.file(registration + ".lock").exists()).toBe(false)
    expect(
      await fetch(new URL("/api/health", info.url), {
        headers: { authorization: "Basic " + btoa(`opencode:${info.password}`) },
      }).then((response) => response.json()),
    ).toEqual({
      healthy: true,
      version: info.version,
      pid: info.pid,
    })
    const contender = Bun.spawn(command, { env, stderr: "pipe", stdout: "ignore" })
    try {
      const contenderExited = await Promise.race([
        contender.exited.then(() => true),
        Bun.sleep(10_000).then(() => false),
      ])
      expect(contenderExited).toBe(true)
      expect(contender.exitCode).toBe(0)
      expect((await waitForInfo(registration)).id).toBe(info.id)
    } finally {
      contender.kill("SIGTERM")
      await contender.exited
    }
    await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    await winner?.exited
    expect(await Bun.file(registration).exists()).toBe(false)
  } finally {
    processes.forEach((process) => process.kill("SIGTERM"))
    await Promise.all(processes.map((process) => process.exited))
    await fs.rm(root, { recursive: true, force: true })
  }
}, 120_000)

test("configured managed service port overrides the channel default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-port-"))
  const port = await availablePort()
  const env = serviceEnv(root)
  const registration = path.join(root, "state", "opencode", "service-local.json")
  const config = path.join(root, "config", "opencode", "service-local.json")
  await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
  await fs.writeFile(config, JSON.stringify({ port, password: "" }))
  const owner = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env,
    stderr: "pipe",
    stdout: "ignore",
  })
  try {
    const info = await waitForInfo(registration)
    expect(new URL(info.url).port).toBe(String(port))
    expect(info.password).not.toBe("")
    expect((await Bun.file(config).json()).password).toBe(info.password)
    await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    await owner.exited
  } finally {
    owner.kill("SIGTERM")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.each([
  { args: [], origins: ["http://192.0.2.10:3001", "https://configured.example.com"] },
  {
    args: ["--cors", "http://192.0.2.20:3001", "--cors", "https://override.example.com"],
    origins: ["http://192.0.2.20:3001", "https://override.example.com"],
  },
])(
  "managed service applies CORS configuration with flag overrides: $args",
  async ({ args, origins }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-cors-"))
    const config = path.join(root, "config", ServiceConfig.filename())
    const registration = path.join(root, "state", "opencode", ServiceConfig.filename())
    const cors = ["http://192.0.2.10:3001", "https://configured.example.com"]
    await fs.mkdir(path.dirname(config), { recursive: true })
    await fs.writeFile(config, JSON.stringify({ cors }))
    const owner = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service", "--port", "0", ...args],
      { env: isolatedEnv(root), stderr: "pipe", stdout: "ignore" },
    )
    try {
      const info = await waitForInfo(registration)
      await Promise.all(
        [...new Set([...cors, ...origins, "https://unlisted.example.com"])].map(async (origin) => {
          const response = await fetch(new URL("/api/health", info.url), {
            method: "OPTIONS",
            headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
          })
          expect(response.headers.get("access-control-allow-origin")).toBe(
            origins.some((value) => value === origin) ? origin : null,
          )
        }),
      )
      expect((await Bun.file(config).json()).cors).toEqual(cors)
    } finally {
      owner.kill("SIGTERM")
      await owner.exited
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

test("unrelated managed port occupancy reports an actionable conflict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-conflict-"))
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unrelated") })
  const port = listener.port
  const registration = path.join(root, "state", "opencode", "service-local.json")
  await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
  await fs.writeFile(path.join(root, "config", "opencode", "service-local.json"), JSON.stringify({ port }))
  const contender = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env: serviceEnv(root),
    stderr: "pipe",
    stdout: "pipe",
  })
  try {
    expect(await contender.exited).not.toBe(0)
    const output = (await new Response(contender.stdout).text()) + (await new Response(contender.stderr).text())
    expect(output).toContain(`Managed service port ${port} on 127.0.0.1 is already in use by another process`)
    expect(output).toContain("opencode service set port <port>")
    expect(await Bun.file(registration).exists()).toBe(false)
  } finally {
    listener.stop(true)
    contender.kill("SIGTERM")
    await contender.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("service ensure surfaces managed port conflict in error", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-ensure-conflict-"))
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unrelated") })
  const port = listener.port
  const registration = path.join(root, "state", "opencode", "service-local.json")
  await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
  await fs.writeFile(path.join(root, "config", "opencode", "service-local.json"), JSON.stringify({ port }))
  const env = serviceEnv(root)
  try {
    const error = await Effect.runPromise(
      Service.ensure({
        file: registration,
        env,
        command: [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"],
      }).pipe(
        Effect.flip,
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(error.message).toContain(`Managed service port ${port} on 127.0.0.1 is already in use by another process`)
    expect(error.message).toContain("opencode service set port <port>")
  } finally {
    listener.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("unresponsive managed port occupancy reports a bounded conflict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-unresponsive-conflict-"))
  const recognizing = Promise.withResolvers<void>()
  const requests = { count: 0 }
  using listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests.count += 1
      if (requests.count === 2) recognizing.resolve()
      return new Promise<Response>(() => {})
    },
  })
  const registration = path.join(root, "state", "opencode", "service-local.json")
  await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await fs.writeFile(
    path.join(root, "config", "opencode", "service-local.json"),
    JSON.stringify({ port: listener.port }),
  )
  const stale = {
    id: "stale",
    version: OPENCODE_VERSION,
    url: "http://127.0.0.1:1",
    pid: process.pid,
    password: "stale",
  }
  await fs.writeFile(registration, JSON.stringify(stale))
  const contender = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env: serviceEnv(root),
    stderr: "pipe",
    stdout: "pipe",
  })

  try {
    expect(await Promise.race([recognizing.promise.then(() => true), Bun.sleep(20_000).then(() => false)])).toBe(true)
    const exitCode = await Promise.race([contender.exited, Bun.sleep(20_000).then(() => undefined)])
    expect(exitCode).toBe(1)
    const output = (await new Response(contender.stdout).text()) + (await new Response(contender.stderr).text())
    expect(output).toContain(`Managed service port ${listener.port} on 127.0.0.1 is already in use by another process`)
    expect(await Bun.file(registration).json()).toEqual(stale)
  } finally {
    contender.kill("SIGTERM")
    await contender.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 45_000)

test("port contender recognizes an incumbent registered during the bind race", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-bind-race-"))
  const recognizing = Promise.withResolvers<void>()
  const requests = { count: 0 }
  using listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests.count += 1
      if (requests.count === 2) recognizing.resolve()
      return Response.json({ healthy: true, version: OPENCODE_VERSION, pid: process.pid }, { status: 503 })
    },
  })
  const registration = path.join(root, "state", "opencode", "service-local.json")
  const config = path.join(root, "config", "opencode", "service-local.json")
  await fs.mkdir(path.dirname(config), { recursive: true })
  await fs.writeFile(config, JSON.stringify({ port: listener.port }))
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await fs.writeFile(
    registration,
    JSON.stringify({
      id: "stale",
      version: OPENCODE_VERSION,
      url: "http://127.0.0.1:1",
      pid: 2_147_483_647,
      password: "stale",
    }),
  )
  const contender = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env: serviceEnv(root),
    stderr: "pipe",
    stdout: "ignore",
  })

  try {
    expect(await Promise.race([recognizing.promise.then(() => true), Bun.sleep(20_000).then(() => false)])).toBe(true)
    await Bun.sleep(8_000)
    const info = {
      id: "incumbent",
      version: OPENCODE_VERSION,
      url: `http://127.0.0.1:${listener.port}`,
      pid: process.pid,
      password: "incumbent",
    }
    await fs.writeFile(registration, JSON.stringify(info))

    expect(await Promise.race([contender.exited, Bun.sleep(20_000).then(() => undefined)])).toBe(0)
    expect(await Bun.file(registration).json()).toEqual(info)
  } finally {
    contender.kill("SIGTERM")
    await contender.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 45_000)

test("service registration replaces a stale owner with the bound address", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-stale-"))
  const registration = path.join(root, "state", "opencode", "service-local.json")
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await fs.writeFile(
    registration,
    JSON.stringify({ id: "dead", version: "dead", url: "http://127.0.0.1:4321", pid: 2_147_483_647 }),
  )
  try {
    const cleanup = await Effect.runPromise(
      ServiceRegistration.register({
        address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 4321 },
        password: "secret",
        id: "owner",
        file: registration,
        shutdown: Effect.never,
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
    )
    expect(await Bun.file(registration).json()).toEqual({
      id: "owner",
      version: OPENCODE_VERSION,
      url: "http://127.0.0.1:4321",
      pid: process.pid,
      password: "secret",
    })
    await Effect.runPromise(cleanup.pipe(Effect.provide(NodeFileSystem.layer)))
    expect(await Bun.file(registration).exists()).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a failed service stays registered and owns the selected port until stopped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-failed-"))
  const port = await availablePort()
  const database = path.join(root, "database")
  await fs.mkdir(database)
  await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
  await fs.writeFile(path.join(root, "config", "opencode", "service-local.json"), JSON.stringify({ port }))
  const env = {
    ...process.env,
    HOME: root,
    OPENCODE_DB: database,
    OPENCODE_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
  const command = [process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"]
  const registration = path.join(root, "state", "opencode", "service-local.json")
  const owner = Bun.spawn(command, { env, stderr: "pipe", stdout: "ignore" })

  try {
    const info = await waitForInfo(registration)
    await waitForFailed(info)
    expect(owner.exitCode).toBe(null)

    const contender = Bun.spawn(command, { env, stderr: "pipe", stdout: "ignore" })
    expect(await Promise.race([contender.exited.then(() => true), Bun.sleep(10_000).then(() => false)])).toBe(true)
    expect(contender.exitCode).toBe(0)
    expect((await waitForInfo(registration)).id).toBe(info.id)
    expect(owner.exitCode).toBe(null)

    await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    await owner.exited
    expect(await Bun.file(registration).exists()).toBe(false)
  } finally {
    owner.kill("SIGTERM")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

async function waitForInfo(file: string, accept: (info: Info) => boolean = () => true) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (value !== undefined) {
      const info = await Schema.decodeUnknownPromise(Service.Info)(value)
      if (accept(info)) return info
    }
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for service registration")
}

async function waitForFailed(info: Info) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = await fetch(new URL("/api/health", info.url), {
      headers: { authorization: "Basic " + btoa(`opencode:${info.password}`) },
    })
      .then((response) => response.status)
      .catch(() => undefined)
    if (status === 500) return
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for service boot failure")
}

async function availablePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error("Server did not bind a port")
  return port
}

function serviceEnv(root: string) {
  return {
    ...process.env,
    HOME: root,
    OPENCODE_DB: path.join(root, "opencode.db"),
    OPENCODE_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
}

async function startManagedService(prefix: string, failBoot = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const port = await availablePort()
  const registration = path.join(root, "state", "opencode", "service-local.json")
  await fs.mkdir(path.join(root, "config", "opencode"), { recursive: true })
  if (failBoot) await fs.mkdir(path.join(root, "database"))
  await fs.writeFile(path.join(root, "config", "opencode", "service-local.json"), JSON.stringify({ port }))
  const owner = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "serve", "--service"], {
    env: failBoot ? { ...serviceEnv(root), OPENCODE_DB: path.join(root, "database") } : serviceEnv(root),
    stderr: "pipe",
    stdout: "ignore",
  })
  const info = await waitForInfo(registration).catch(async (cause) => {
    owner.kill("SIGTERM")
    await owner.exited
    await fs.rm(root, { recursive: true, force: true })
    throw cause
  })
  return { root, port, registration, owner, info }
}

async function stopManagedService(service: Awaited<ReturnType<typeof startManagedService>>) {
  service.owner.kill("SIGTERM")
  await service.owner.exited
  await fs.rm(service.root, { recursive: true, force: true })
}

function waitForExit(process: Bun.Subprocess, timeout = 10_000) {
  return Promise.race([process.exited.then(() => true), Bun.sleep(timeout).then(() => false)])
}

async function expectPortAvailable(port: number) {
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() })
  await server.stop(true)
}
