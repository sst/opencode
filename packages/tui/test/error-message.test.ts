import { expect, test } from "bun:test"
import { ClientError } from "@opencode-ai/client"
import { cliErrorMessage } from "../src/util/error"

test("client transport errors format as a friendly message", () => {
  const error = new ClientError("Transport", {
    cause: new Error("Unable to connect. Is the computer able to access the url?"),
  })
  try {
    const message = cliErrorMessage(error)
    expect(message).toContain("Could not reach the OpenCode server")
    expect(message).toContain("Unable to connect. Is the computer able to access the url?")
    expect(process.exitCode).toBe(1)
  } finally {
    process.exitCode = 0
  }
})

test("unknown errors are left to the fallback formatter", () => {
  expect(cliErrorMessage(new Error("boom"))).toBeUndefined()
})
