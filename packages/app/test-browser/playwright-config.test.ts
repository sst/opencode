import { expect, test } from "bun:test"
import path from "node:path"

test.each([
  { name: "local development", ci: "", build: "", built: false },
  { name: "local production build", ci: "", build: "1", built: true },
  { name: "CI production build", ci: "true", build: "", built: true },
  { name: "CI cannot opt into development", ci: "true", build: "0", built: true },
])("Playwright uses $name", ({ ci, build, built }) => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", 'import config from "./playwright.config.ts"; console.log(JSON.stringify(config))'],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      CI: ci,
      PLAYWRIGHT_BUILD: build,
      PLAYWRIGHT_BASE_URL: undefined,
      PLAYWRIGHT_PORT: "4321",
      PLAYWRIGHT_SERVER_HOST: "127.0.0.2",
      PLAYWRIGHT_SERVER_PORT: "4322",
    },
  })
  expect(result.exitCode).toBe(0)
  const config = JSON.parse(result.stdout.toString())
  expect(config.use.baseURL).toBe("http://127.0.0.1:4321")
  expect(config.webServer.url).toBe(config.use.baseURL)
  expect(config.webServer.command).toBe(
    built
      ? "bun run build && bun run serve -- --host 127.0.0.1 --port 4321 --strictPort"
      : "bun run dev -- --host 127.0.0.1 --port 4321 --strictPort",
  )
  expect(config.webServer.reuseExistingServer).toBe(!built)
  expect(config.webServer.env).toEqual({
    VITE_OPENCODE_TEST_FIXTURES: "1",
    VITE_OPENCODE_SERVER_HOST: built ? "127.0.0.1" : "127.0.0.2",
    VITE_OPENCODE_SERVER_PORT: built ? "4321" : "4322",
  })
})

test.each([
  "./playwright.config.ts",
  "./e2e/performance/playwright.config.ts",
  "./e2e/performance/playwright.uncapped.config.ts",
  "./e2e/performance/timeline-stability/playwright.config.ts",
])("%s leaves an explicit external app unmanaged", (file) => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `import config from ${JSON.stringify(file)}; console.log(JSON.stringify({ ...config, fixtureHost: process.env.PLAYWRIGHT_SERVER_HOST, fixturePort: process.env.PLAYWRIGHT_SERVER_PORT }))`,
    ],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, CI: "true", PLAYWRIGHT_BASE_URL: "http://127.0.0.1:4444" },
  })
  expect(result.exitCode).toBe(0)
  const config = JSON.parse(result.stdout.toString())
  expect(config.webServer).toBeUndefined()
  expect(config.use.baseURL).toBe("http://127.0.0.1:4444")
  expect(config.fixtureHost).toBe("127.0.0.1")
  expect(config.fixturePort).toBe("4444")
})

test("Playwright rejects HTTPS targets unsupported by the API fixtures", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", 'import "./playwright.config.ts"'],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, CI: "true", PLAYWRIGHT_BASE_URL: "https://e2e.example.com" },
  })
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("E2E fixtures require an http:// app URL")
})
