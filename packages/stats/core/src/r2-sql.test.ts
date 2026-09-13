import { expect, test } from "bun:test"
import { R2SqlQueryError } from "./r2-sql"

test("includes the transport failure in the message used by sync logging", () => {
  const cause = new DOMException("The operation timed out.", "TimeoutError")
  const error = new R2SqlQueryError({ message: "Failed to run R2 SQL stats query", cause })

  expect(error.message).toBe("Failed to run R2 SQL stats query: TimeoutError: The operation timed out.")
  expect(error.cause).toBe(cause)
})

test("preserves an R2 response error and request details", () => {
  const error = new R2SqlQueryError({ message: "R2 SQL stats query failed", status: 400, requestId: "test-request" })

  expect(error.message).toBe("R2 SQL stats query failed")
  expect(error.status).toBe(400)
  expect(error.requestId).toBe("test-request")
})
