import { expect, test } from "bun:test"

test("disables public npm security audits", () => {
  expect(process.env.NPM_CONFIG_AUDIT).toBe("false")
})
