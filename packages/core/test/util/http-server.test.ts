import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { bridgeClientDisconnect } from "@opencode-ai/core/util/http-server"

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address === "object") return resolve(address.port)
      reject(new Error("expected a TCP address"))
    })
  })
}

describe("bridgeClientDisconnect", () => {
  test("emits response close after an SSE client disconnects", async () => {
    const closed = Promise.withResolvers<void>()
    const server = bridgeClientDisconnect(
      createServer((request, response) => {
        request.on("error", () => {})
        response.on("close", () => closed.resolve())
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write("data: ready\n\n")
      }),
    )
    const port = await listen(server)

    const abort = new AbortController()
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: abort.signal })
    const reader = response.body!.getReader()
    await reader.read()
    abort.abort()

    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000))
    expect(await Promise.race([closed.promise.then(() => "closed"), timeout])).toBe("closed")
    server.close()
    server.closeAllConnections()
  })

  test("leaves completed responses untouched", async () => {
    let destroyed = false
    const server = bridgeClientDisconnect(
      createServer((request, response) => {
        response.on("close", () => {
          destroyed = response.destroyed && !response.writableEnded
        })
        response.writeHead(200, { "content-type": "text/plain" })
        response.end("ok")
      }),
    )
    const port = await listen(server)

    const response = await fetch(`http://127.0.0.1:${port}/`)
    expect(await response.text()).toBe("ok")
    expect(destroyed).toBe(false)
    server.close()
    server.closeAllConnections()
  })
})
