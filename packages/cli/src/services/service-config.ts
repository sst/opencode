import { Global } from "@opencode/util/global"
import { OPENCODE_CHANNEL, OPENCODE_VERSION } from "../version"
import { Hash } from "@opencode/util/hash"
import { Service } from "@opencode/client/effect/service"
import { Effect, FileSystem, Option, Schema } from "effect"
import { randomBytes } from "crypto"
import path from "path"
import { selfCommand } from "../util/process"

// The CLI's service configuration file, plus the Service.EnsureOptions binding that
// points the client package's service operations at this CLI: which
// registration file (by channel), which version, and how to spawn opencode.

export const Info = Schema.Struct({
  hostname: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65_535))),
  password: Schema.optional(Schema.String),
  cors: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type Info = typeof Info.Type

const keys = ["hostname", "port", "password", "cors", "env"] as const
type Key = (typeof keys)[number]

const decodeInfo = Schema.decodeUnknownEffect(Schema.fromJsonString(Info))
const decodeRegistration = Schema.decodeUnknownEffect(Schema.fromJsonString(Service.Info))

export function filename(channel = OPENCODE_CHANNEL) {
  if (channel === "latest" || channel === "dev" || channel === "beta" || channel === "next") return "service.json"
  return `service-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`
}

export function defaultPort(channel = OPENCODE_CHANNEL) {
  if (process.platform === "win32") {
    if (channel === "latest" || channel === "dev" || channel === "beta" || channel === "next") return 0x40de
    if (channel === "local") return 0x40df
    return 10_000 + (Number.parseInt(Hash.fast(channel).slice(0, 8), 16) % 35_000)
  }
  if (channel === "latest" || channel === "dev" || channel === "beta" || channel === "next") return 0xc0de
  if (channel === "local") return 0xc0df
  return 10_000 + (Number.parseInt(Hash.fast(channel).slice(0, 8), 16) % 50_000)
}

export function legacyFilename(channel = OPENCODE_CHANNEL) {
  if (channel === "latest" || channel === "local") return undefined
  return `service-${Hash.fast(channel)}.json`
}

export function versionBelongsToChannel(
  version: string | undefined,
  channel = OPENCODE_CHANNEL,
  installedVersion = OPENCODE_VERSION,
) {
  if (version === undefined) return false
  if (version === installedVersion) return true
  const prefix = `0.0.0-${channel}-`
  if (!version.startsWith(prefix)) return false
  return /^\d+(?:\.\d+)?$/.test(version.slice(prefix.length))
}

export const migrateRegistration = Effect.fnUntraced(function* (
  legacy: string,
  file: string,
  channel = OPENCODE_CHANNEL,
  installedVersion = OPENCODE_VERSION,
) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(legacy).pipe(Effect.option)
  if (Option.isNone(text)) return
  const registration = yield* decodeRegistration(text.value).pipe(Effect.option)
  if (Option.isNone(registration)) return
  if (!versionBelongsToChannel(registration.value.version, channel, installedVersion)) return
  yield* fs.writeFileString(file, text.value, { flag: "wx", mode: 0o600 }).pipe(Effect.ignore)
})

export const migrateConfig = Effect.fnUntraced(function* (legacy: string, file: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(legacy).pipe(Effect.option)
  if (Option.isNone(text)) return
  if (Option.isNone(yield* decodeInfo(text.value).pipe(Effect.option))) return
  yield* fs.writeFileString(file, text.value, { flag: "wx", mode: 0o600 }).pipe(Effect.ignore)
})

function configKey(key: string): Key {
  if (key === "hostname" || key === "port" || key === "password" || key === "cors" || key === "env") return key
  throw new Error(`Unknown service config key: ${key}`)
}

const paths = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const name = filename()
  const legacy = legacyFilename()
  const file = path.join(global.state, name)
  return {
    fs,
    file,
    legacyConfigFile: legacy ? path.join(global.config, legacy) : undefined,
    legacyRegistrationFiles: [
      ...(legacy ? [path.join(global.state, legacy)] : []),
      ...(name !== "service.json" && OPENCODE_CHANNEL !== "local" ? [path.join(global.state, "service.json")] : []),
    ],
    configFile: path.join(global.config, name),
  }
})

export const options = Effect.fnUntraced(function* (input: { readonly checkVersion?: boolean } = {}) {
  const { file, legacyRegistrationFiles } = yield* paths
  yield* Effect.forEach(legacyRegistrationFiles, (legacy) => migrateRegistration(legacy, file))
  return {
    file,
    version: input.checkVersion ? OPENCODE_VERSION : undefined,
    env: (yield* read()).env,
    command: [
      ...selfCommand(),
      "serve",
      "--service",
    ],
  }
})

export const read = Effect.fn("cli.service-config.read")(function* () {
  const { fs, configFile, legacyConfigFile } = yield* paths
  if (legacyConfigFile) yield* migrateConfig(legacyConfigFile, configFile)
  return yield* fs.readFileString(configFile).pipe(
    Effect.flatMap(decodeInfo),
    Effect.orElseSucceed(() => ({}) as Info),
  )
})

const write = Effect.fn("cli.service-config.write")(function* (value: Info) {
  const { fs, configFile } = yield* paths
  const temp = configFile + ".tmp"
  yield* fs.makeDirectory(path.dirname(configFile), { recursive: true })
  yield* fs.writeFileString(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  yield* fs.rename(temp, configFile)
})

export const password = Effect.fn("cli.service-config.password")(function* (value?: string) {
  const existing = yield* read()
  if (value === undefined && existing.password) return existing.password
  const next = value ?? randomBytes(32).toString("base64url")

  // Keep one private credential across server restarts so discovered clients
  // can reconnect without exposing a password flag or environment variable.
  yield* write({ ...existing, password: next })
  return next
})

export const get = Effect.fn("cli.service-config.get")(function* (key?: string, name?: string) {
  if (key === undefined) {
    const { password: _password, ...safe } = yield* read()
    return JSON.stringify(safe, null, 2)
  }
  const selected = configKey(key)
  if (selected !== "env" && name !== undefined) throw new Error(`Usage: opencode service get ${selected}`)
  switch (selected) {
    case "hostname": {
      return (yield* read()).hostname ?? ""
    }
    case "port": {
      const port = (yield* read()).port
      return port === undefined ? "" : String(port)
    }
    case "password": {
      return yield* password()
    }
    case "cors": {
      return JSON.stringify((yield* read()).cors ?? [], null, 2)
    }
    case "env": {
      const env = (yield* read()).env ?? {}
      return name === undefined ? JSON.stringify(env, null, 2) : (env[name] ?? "")
    }
  }
  throw new Error(`Unknown service config key: ${key}`)
})

export const set = Effect.fn("cli.service-config.set")(function* (key: string, value: string, nestedValue?: string) {
  const selected = configKey(key)
  if (selected !== "env" && nestedValue !== undefined)
    throw new Error(`Usage: opencode service set ${selected} <value>`)
  switch (selected) {
    case "hostname": {
      yield* Service.stop(yield* options())
      yield* write({ ...(yield* read()), hostname: value })
      return
    }
    case "port": {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Port must be between 1 and 65535")
      yield* Service.stop(yield* options())
      yield* write({ ...(yield* read()), port })
      return
    }
    case "password": {
      yield* Service.stop(yield* options())
      yield* password(value)
      return
    }
    case "env": {
      if (nestedValue === undefined) throw new Error("Usage: opencode service set env <key> <value>")
      yield* Service.stop(yield* options())
      const existing = yield* read()
      yield* write({ ...existing, env: { ...existing.env, [value]: nestedValue } })
      return
    }
    case "cors": {
      const cors = value.split(",").map((origin) => origin.trim())
      if (
        cors.some((origin) => {
          const url = URL.parse(origin)
          return !url || (url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin
        })
      )
        throw new Error("CORS must be a comma-separated list of HTTP(S) origins without paths or trailing slashes")
      yield* Service.stop(yield* options())
      yield* write({ ...(yield* read()), cors })
      return
    }
  }
})

export const unset = Effect.fn("cli.service-config.unset")(function* (key: string, name?: string) {
  const selected = configKey(key)
  if (selected !== "env" && name !== undefined) throw new Error(`Usage: opencode service unset ${selected}`)
  switch (selected) {
    case "hostname": {
      yield* Service.stop(yield* options())
      const { hostname: _hostname, ...next } = yield* read()
      yield* write(next)
      return
    }
    case "port": {
      yield* Service.stop(yield* options())
      const { port: _port, ...next } = yield* read()
      yield* write(next)
      return
    }
    case "password": {
      yield* Service.stop(yield* options())
      const { password: _password, ...next } = yield* read()
      yield* write(next)
      return
    }
    case "env": {
      if (name === undefined) throw new Error("Usage: opencode service unset env <key>")
      yield* Service.stop(yield* options())
      const existing = yield* read()
      const { [name]: _removed, ...env } = existing.env ?? {}
      const { env: _existingEnv, ...rest } = existing
      yield* write(Object.keys(env).length === 0 ? rest : { ...rest, env })
      return
    }
    case "cors": {
      yield* Service.stop(yield* options())
      const { cors: _cors, ...next } = yield* read()
      yield* write(next)
      return
    }
  }
})

export * as ServiceConfig from "./service-config"
