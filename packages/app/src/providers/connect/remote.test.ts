import { expect, test } from "bun:test"
import { authServerName } from "./remote"

test("SSH disclosure uses the remote identity even with a loopback proxy", () => {
  expect(authServerName({ type: "ssh", host: "production.example", http: { url: "http://127.0.0.1:4096" } })).toBe(
    "production.example",
  )
  expect(
    authServerName({
      type: "ssh",
      host: "production.example",
      displayName: "Production server",
      http: { url: "http://127.0.0.1:4096" },
    }),
  ).toBe("Production server")
})

test("local Desktop and loopback HTTP connections do not show remote disclosure", () => {
  expect(authServerName({ type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } })).toBeUndefined()
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    expect(authServerName({ type: "http", http: { url: `http://${host}:4096` } })).toBeUndefined()
  }
})

test("WSL and remote HTTP connections show their server identity", () => {
  expect(
    authServerName({ type: "sidecar", variant: "wsl", distro: "Ubuntu", http: { url: "http://127.0.0.1:4096" } }),
  ).toBe("Ubuntu")
  expect(authServerName({ type: "http", http: { url: "https://production.example" } })).toBe("production.example")
})
