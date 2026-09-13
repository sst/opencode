import { describe, expect, test } from "bun:test"
import { extractServerCause } from "../../../src/cli/cmd/serve"

describe("extractServerCause", () => {
  test("extracts message from a plain Error", () => {
    const err = new Error("listen EADDRINUSE: address already in use :::4096")
    expect(extractServerCause(err)).toBe("listen EADDRINUSE: address already in use :::4096")
  })

  test("digs through Error.cause chain", () => {
    const root = new Error("EADDRINUSE")
    const wrapper = new Error("outer", { cause: root })
    expect(extractServerCause(wrapper)).toBe("EADDRINUSE")
  })

  test("digs through ServeError-shaped { _tag, cause }", () => {
    const nodeErr = new Error("listen EADDRINUSE: address already in use :::4096")
    const serveError = { _tag: "ServeError", cause: nodeErr }
    expect(extractServerCause(serveError)).toBe("listen EADDRINUSE: address already in use :::4096")
  })

  test("digs through Effect Cause.Fail shape { error }", () => {
    const nodeErr = new Error("EADDRINUSE")
    const serveError = { _tag: "ServeError", cause: nodeErr }
    const failCause = { error: serveError }
    expect(extractServerCause(failCause)).toBe("EADDRINUSE")
  })

  test("handles FiberFailure → Cause.Fail → ServeError → node Error", () => {
    const nodeErr = new Error("listen EADDRINUSE: address already in use :::4096")
    const serveError = { _tag: "ServeError", cause: nodeErr }
    const failCause = { error: serveError }
    const fiberFailure = new Error("ServeError", { cause: failCause })
    expect(extractServerCause(fiberFailure)).toBe("listen EADDRINUSE: address already in use :::4096")
  })

  test("handles Cause.Die shape { defect }", () => {
    const inner = new Error("permission denied")
    const dieCause = { defect: inner }
    expect(extractServerCause(dieCause)).toBe("permission denied")
  })

  test("falls back to errorMessage for string errors", () => {
    expect(extractServerCause("string error")).toBe("string error")
  })

  test("falls back for null/undefined", () => {
    const result = extractServerCause(null)
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  test("does not loop on self-referencing cause", () => {
    const obj: Record<string, unknown> = { _tag: "ServeError", message: "fallback" }
    obj.cause = obj
    expect(extractServerCause(obj)).toBe("fallback")
  })
})
