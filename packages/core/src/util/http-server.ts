import type { Server } from "node:http"

/**
 * Bun's node:http compatibility layer does not emit ServerResponse "close"
 * when the client disconnects mid-response (oven-sh/bun#14697). Hosts that
 * interrupt request work from that event, such as @effect/platform-node,
 * therefore never release long-lived streams like SSE, and the abandoned
 * stream keeps writing into a dead socket. Destroying the response from the
 * request "aborted" event makes Bun emit the missing "close".
 */
export function bridgeClientDisconnect<T extends Server>(server: T): T {
  if (!process.versions.bun) return server
  server.on("request", (request, response) => {
    request.once("aborted", () => {
      if (!response.writableEnded && !response.destroyed) response.destroy()
    })
  })
  return server
}
