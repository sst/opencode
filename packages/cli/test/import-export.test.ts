import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OPENCODE_VERSION } from "../src/version"

const info = {
  id: "ses_export_test",
  projectID: "global",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  title: "Exported session",
  location: { directory: "/project" },
}
const transfer = {
  info,
  messages: [
    { id: "msg_first", type: "user", text: "First", time: { created: 1 } },
    { id: "msg_second", type: "user", text: "Second", time: { created: 2 } },
  ],
}
const sanitizedTransfer = {
  info: {
    ...info,
    title: "[redacted:session-title:ses_export_test]",
    location: { directory: "/[redacted:session-directory:ses_export_test]" },
  },
  messages: [
    {
      id: "msg_first",
      type: "user",
      text: "[redacted:text:msg_first]",
      time: { created: 1 },
    },
    {
      id: "msg_second",
      type: "user",
      text: "[redacted:text:msg_second]",
      time: { created: 2 },
    },
  ],
}

const health = () => Response.json({ healthy: true, version: OPENCODE_VERSION, pid: process.pid })

function run(args: string[], stdin?: string) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    stdin: stdin === undefined ? undefined : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
}

test("export is raw by default and supports explicit sanitization", async () => {
  const sanitization: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/health") return health()
      if (url.pathname === `/api/session/${info.id}`) return Response.json({ data: info })
      if (url.pathname === `/api/session/${info.id}/export`) {
        sanitization.push(url.searchParams.get("sanitize") ?? "")
        return Response.json({ data: url.searchParams.get("sanitize") === "true" ? sanitizedTransfer : transfer })
      }
      return new Response("Not found", { status: 404 })
    },
  })

  try {
    const [stdout, , exitCode] = await run(["session", "export", info.id, "--server", server.url.toString()])
    const exported = JSON.parse(stdout)

    expect(exitCode).toBe(0)
    expect(exported).toEqual(transfer)

    const [sanitized, , sanitizedExitCode] = await run([
      "session",
      "export",
      info.id,
      "--sanitize",
      "--server",
      server.url.toString(),
    ])
    expect(sanitizedExitCode).toBe(0)
    expect(JSON.parse(sanitized)).toEqual(sanitizedTransfer)
    expect(sanitization).toEqual(["false", "true"])
  } finally {
    await server.stop(true)
  }
}, 15_000)

test("export requires a session outside an interactive terminal", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/health") return health()
      if (url.pathname === "/api/location") {
        return Response.json({
          directory: "/project",
          project: { id: "global", directory: "/project", canonical: "/project" },
        })
      }
      if (url.pathname === "/api/session") return Response.json({ data: [], cursor: {} })
      return new Response("Not found", { status: 404 })
    },
  })

  try {
    const [stdout, stderr, exitCode] = await run(["session", "export", "--server", server.url.toString()])

    expect(exitCode).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toBe(`Pass a session ID when running without an interactive terminal${os.EOL}`)
  } finally {
    await server.stop(true)
  }
})

test("export reports a missing session without a stack trace", async () => {
  const sessionID = "ses_missing"
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/health") return health()
      if (url.pathname === `/api/session/${sessionID}/export`) {
        return Response.json(
          { _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` },
          { status: 404 },
        )
      }
      return new Response("Not found", { status: 404 })
    },
  })

  try {
    const [stdout, stderr, exitCode] = await run(["session", "export", sessionID, "--server", server.url.toString()])

    expect(exitCode).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toBe(`Session not found: ${sessionID}${os.EOL}`)
  } finally {
    await server.stop(true)
  }
})

test("import validates a file and sends it to the resolved location", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-import-"))
  const file = path.join(root, "session.json")
  await fs.writeFile(file, JSON.stringify(transfer))
  let imported: unknown
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/health") return health()
      if (url.pathname === "/api/location") {
        return Response.json({
          directory: root,
          project: { id: "global", directory: root, canonical: root },
        })
      }
      if (url.pathname === "/api/session/import") {
        imported = await request.json()
        return Response.json({ data: { ...info, location: { directory: root } } })
      }
      return new Response("Not found", { status: 404 })
    },
  })

  try {
    const [stdout, , exitCode] = await run([
      "session",
      "import",
      file,
      "--directory",
      root,
      "--server",
      server.url.toString(),
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toBe(`Imported session: ${info.id}${os.EOL}`)
    expect(imported).toEqual({ ...transfer, location: { directory: root } })
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("import reports an existing session without a stack trace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-import-conflict-"))
  const file = path.join(root, "session.json")
  await fs.writeFile(file, JSON.stringify(transfer))
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/health") return health()
      if (url.pathname === "/api/location") {
        return Response.json({
          directory: root,
          project: { id: "global", directory: root, canonical: root },
        })
      }
      if (url.pathname === "/api/session/import") return new Response("Conflict", { status: 409 })
      return new Response("Not found", { status: 404 })
    },
  })

  try {
    const [stdout, stderr, exitCode] = await run(["session", "import", file, "--server", server.url.toString()])

    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toBe(`Session already exists${os.EOL}`)
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})
