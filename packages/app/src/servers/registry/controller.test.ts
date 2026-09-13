import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/runtime/server/registry"
import { sortServerConnections } from "./controller"

const server = (url: string): ServerConnection.Http => ({ type: "http", http: { url } })

describe("sortServerConnections", () => {
  test("places the default first and preserves health and insertion ordering", () => {
    const first = server("http://first")
    const offline = server("http://offline")
    const preferred = server("http://preferred")
    const unknown = server("http://unknown")
    const result = sortServerConnections({
      servers: [first, offline, preferred, unknown],
      health: {
        [ServerConnection.key(first)]: { healthy: true },
        [ServerConnection.key(offline)]: { healthy: false },
      },
      defaultKey: ServerConnection.key(preferred),
    })

    expect(result).toEqual([preferred, first, unknown, offline])
  })
})
