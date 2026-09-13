// Subprocess test harness for the opencode CLI. Spawns the real binary against
// a TestLLMServer running in-process at a random port, with full env isolation.
//
// This is the missing test tier: in-process tests can't catch bugs that span
// argv parsing → server boot → SDK call → event consumption → exit code (like
// the original /event race or #27371's invalid-model hang).
//
// Configuration flows through opencode's built-in test affordances:
//   - OPENCODE_CONFIG_CONTENT      : provider config inline, no files to find
//   - OPENCODE_TEST_HOME           : pins os.homedir() → tmpdir
//   - OPENCODE_DISABLE_PROJECT_CONFIG : skip walking up for opencode.json
//   - OPENCODE_PURE                : skip external plugin discovery + install
//   - OPENCODE_DISABLE_AUTOUPDATE / AUTOCOMPACT / MODELS_FETCH : no background work
// Plus HOME / XDG_* pointing at the tmpdir for belt-and-suspenders isolation.
//
// Today only `opencode.run` is fully wired. The shape supports adding more
// builders (`opencode.serve(opts)`, `opencode.acp(opts)`, `opencode.auth(...)`)
// without changing the fixture. Long-lived commands like `serve` will need a
// different return shape — see the TODO at the bottom of OpencodeCli.
import { test, type TestOptions } from "bun:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { Deferred, Duration, Effect, Layer, Queue, Schedule, Scope, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import path from "node:path"
import { TestLLMServer } from "./llm-server"
import { testProviderConfig } from "./test-provider"
import { it } from "./effect"

const opencodeRoot = path.resolve(import.meta.dir, "../../")
const cliEntry = path.join(opencodeRoot, "src/index.ts")

export const testModelID = "test/test-model"

// Wrap a Bun subprocess pipe (or any ReadableStream<Uint8Array>) as a Stream.
// Centralizes the `evaluate` + `onError` boilerplate and tags errors with the
// stream name so a stderr/stdout failure is greppable in logs.
function fromBunStream(name: string, get: () => ReadableStream<Uint8Array>) {
  return Stream.fromReadableStream({
    evaluate: get,
    onError: (cause) => new Error(`${name} stream error: ${String(cause)}`),
  })
}

// Long-lived processes (serve, acp) all want the same stderr drain: read every
// chunk, push to a tail buffer, swallow stream errors (the child closing the
// pipe is normal). `log: true` surfaces a real protocol error to logs so a
// regression doesn't silently disappear.
function forkStderrDrain(stream: ReadableStream<Uint8Array>, into: string[]) {
  return Effect.forkScoped(
    fromBunStream("stderr", () => stream).pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Effect.sync(() => into.push(chunk))),
      Effect.ignore({ log: true }),
    ),
  )
}

function isolatedEnv(home: string, configJson: string): Record<string, string> {
  return {
    OPENCODE_TEST_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_CONFIG_CONTENT: configJson,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
  }
}

export type RunResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

export type RunHandle = {
  readonly interrupt: () => void
  readonly result: Effect.Effect<RunResult>
}

export type SpawnOpts = { readonly timeoutMs?: number; readonly env?: Record<string, string> }

// Typed equivalent of constructing argv for `opencode run`. New flags should
// land here so tests stay grep-able and refactor-safe.
export type RunOpts = SpawnOpts & {
  readonly model?: string
  readonly agent?: string
  readonly format?: "default" | "json"
  readonly command?: string
  readonly printLogs?: boolean
  readonly permission?: Record<string, "ask" | "allow" | "deny">
  readonly extraArgs?: string[]
}

// `opencode serve` is a long-lived process — it never exits on its own.
// `serve(opts)` therefore returns a handle inside the caller's Scope: the
// subprocess is killed when the scope closes (test end), and the URL the
// server actually bound to (port 0 means OS-assigned) is parsed off stdout.
export type ServeOpts = SpawnOpts & {
  readonly port?: number
  readonly hostname?: string
  readonly extraArgs?: string[]
  // How long to wait for the "listening on http://..." line before failing.
  // Default 15s — startup is dominated by bun's transpile + plugin init, not
  // the actual listen() call.
  readonly readyTimeoutMs?: number
}

export type ServeHandle = {
  // Full URL the server is bound to, e.g. "http://127.0.0.1:54321". Use this
  // as the base for HTTP requests in tests — never assume the port.
  readonly url: string
  readonly hostname: string
  readonly port: number
  // Sends SIGTERM. The scope finalizer also calls this, so tests rarely need
  // to invoke it directly — useful for tests that assert exit behavior.
  readonly kill: () => void
  // Resolves with the exit code once the process exits. Bun returns a number.
  readonly exited: Promise<number>
}

// `opencode acp` speaks newline-delimited JSON-RPC over stdin/stdout. It is
// long-lived and exits cleanly when stdin is closed. The handle exposes the
// duplex stream as send/receive rather than raw pipes so tests don't have to
// reimplement framing on every call site.
export type AcpOpts = SpawnOpts & {
  readonly cwd?: string
  readonly extraArgs?: string[]
}

export type AcpHandle = {
  // Writes a single JSON-RPC message to the child's stdin as one ndjson line.
  readonly send: (msg: object) => Effect.Effect<void>
  // Resolves with the next parsed JSON-RPC line from the child's stdout.
  // Lines are buffered in a queue so multiple receives in a row won't drop
  // anything. Pair with `Effect.timeout` if a test wants a deadline.
  readonly receive: Effect.Effect<unknown>
  // Closes stdin. ACP exits cleanly on stdin EOF; the scope finalizer also
  // calls this, so tests only need it when asserting exit behavior.
  readonly close: () => void
  readonly exited: Promise<number>
}

export type OpencodeCli = {
  // High-level: run a single prompt against the test model. Short-lived.
  readonly run: (message: string, opts?: RunOpts) => Effect.Effect<RunResult>
  readonly startRun: (message: string, opts?: RunOpts) => Effect.Effect<RunHandle, never, Scope.Scope>
  // Spawn `opencode serve` and wait until it's listening. Long-lived: the
  // returned handle is killed when the caller's Scope closes. Fails if the
  // listening line doesn't appear within `readyTimeoutMs`.
  readonly serve: (opts?: ServeOpts) => Effect.Effect<ServeHandle, Error, Scope.Scope>
  // Spawn `opencode acp` and return a duplex JSON-RPC handle. Long-lived:
  // the subprocess exits on stdin close, which the scope finalizer triggers.
  readonly acp: (opts?: AcpOpts) => Effect.Effect<AcpHandle, Error, Scope.Scope>
  // Escape hatch: any CLI invocation with full control over argv. Used to test
  // commands that don't yet have a typed builder.
  readonly spawn: (args: string[], opts?: SpawnOpts) => Effect.Effect<RunResult>
  // Convenience assertion. Dumps captured stderr/stdout on mismatch so CI
  // failures are debuggable without re-running locally.
  readonly expectExit: (result: RunResult, expected: number, label?: string) => void
  // Parse `--format json` stdout into one event object per non-empty line.
  // The CLI writes `JSON.stringify({ type, sessionID, ... }) + EOL` for each
  // event (see src/cli/cmd/run.ts `emit`). Throws on a malformed line so
  // tests fail loudly rather than silently skipping data.
  readonly parseJsonEvents: (stdout: string) => Array<Record<string, unknown>>
}

export type CliFixture = {
  readonly llm: TestLLMServer["Service"]
  readonly home: string
  readonly opencode: OpencodeCli
}

// Provisions a TestLLMServer + tmpdir + spawn helper and invokes fn. Cleans
// up the tmpdir on scope exit. TestLLMServer.layer is provided internally so
// the caller doesn't need to wire it up — the fixture's lifetime is tied to
// the surrounding Scope.
export function withCliFixture<A, E>(
  fn: (input: CliFixture) => Effect.Effect<A, E, Scope.Scope | HttpClient.HttpClient>,
): Effect.Effect<A, E | unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const fs = yield* FSUtil.Service
    const appProc = yield* AppProcess.Service

    const home = yield* fs.makeTempDirectory({ prefix: "oc-cli-" })
    yield* Effect.addFinalizer(() =>
      fs
        .remove(home, { recursive: true })
        .pipe(Effect.retry(Schedule.spaced("50 millis").pipe(Schedule.both(Schedule.recurs(20)))), Effect.ignore),
    )

    const configJson = JSON.stringify(testProviderConfig(llm.url))
    const env = isolatedEnv(home, configJson)

    const spawn = Effect.fn("opencode.spawn")(function* (args: string[], opts?: SpawnOpts) {
      const start = Date.now()
      const timeoutMs = opts?.timeoutMs ?? 30_000
      // stdin: "ignore" so the child doesn't see a piped stdin and block
      // on `Bun.stdin.text()` (see src/cli/cmd/run.ts — non-TTY stdin is
      // consumed as the prompt). The old Process.run wrapper defaulted to
      // ignore; ChildProcess.make defaults to pipe, so we set it explicitly.
      const command = ChildProcess.make("bun", ["run", cliEntry, ...args], {
        cwd: home,
        env: { ...env, ...opts?.env },
        extendEnv: true,
        stdin: "ignore",
      })
      // Pass timeout to appProc.run rather than wrapping with
      // Effect.timeoutOrElse externally: AppProcess.run is itself scoped, so
      // its built-in timeout triggers the acquireRelease kill finalizer
      // inside cross-spawn-spawner *before* surfacing the AppProcessError —
      // guaranteeing the child is dead by the time the test continues.
      // External timeoutOrElse interrupts the run fiber but races the
      // scope close, which can leak the child past the test boundary.
      //
      // Catch AppProcessError (timeout OR spawn failure) and synthesize a
      // non-zero result so the test sees it via the usual `expectExit`
      // path rather than as an unhandled Effect failure.
      const result = yield* appProc.run(command, { timeout: Duration.millis(timeoutMs) }).pipe(
        Effect.catchTag("AppProcessError", (err) =>
          Effect.succeed({
            command: err.command,
            exitCode: err.exitCode ?? -1,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from((err.stderr ?? String(err.cause ?? err.message)) + "\n"),
            stdoutTruncated: false,
            stderrTruncated: false,
          } satisfies AppProcess.RunResult),
        ),
      )
      return {
        exitCode: result.exitCode,
        stdout: normalizeLines(result.stdout.toString()),
        stderr: normalizeLines(result.stderr.toString()),
        durationMs: Date.now() - start,
      }
    })

    const runArgs = (message: string, opts?: RunOpts) => {
      const argv: string[] = ["run"]
      if (opts?.printLogs) argv.push("--print-logs")
      argv.push("--model", opts?.model ?? testModelID)
      if (opts?.agent) argv.push("--agent", opts.agent)
      if (opts?.format) argv.push("--format", opts.format)
      if (opts?.command) argv.push("--command", opts.command)
      if (opts?.extraArgs) argv.push(...opts.extraArgs)
      argv.push(message)
      return argv
    }

    const runOpts = (opts?: RunOpts): SpawnOpts | undefined => {
      if (!opts?.permission) return opts
      return {
        ...opts,
        env: {
          ...opts.env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            permission: opts.permission,
          }),
        },
      }
    }

    const run = (message: string, opts?: RunOpts): Effect.Effect<RunResult> => {
      return spawn(runArgs(message, opts), runOpts(opts))
    }

    const startRun = Effect.fn("opencode.startRun")(function* (message: string, opts?: RunOpts) {
      const start = Date.now()
      const options = runOpts(opts)
      const proc = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn(["bun", "run", cliEntry, ...runArgs(message, opts)], {
            cwd: home,
            env: { ...process.env, ...env, ...options?.env },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
        ),
        (child) =>
          Effect.promise(() => {
            child.kill()
            return child.exited
          }).pipe(Effect.ignore),
      )
      const stdout = new Response(proc.stdout).text()
      const stderr = new Response(proc.stderr).text()

      return {
        interrupt: () => proc.kill("SIGINT"),
        result: Effect.promise(async () => ({
          exitCode: await proc.exited,
          stdout: normalizeLines(await stdout),
          stderr: normalizeLines(await stderr),
          durationMs: Date.now() - start,
        })),
      } satisfies RunHandle
    })

    const serve = Effect.fn("opencode.serve")(function* (opts?: ServeOpts) {
      const argv = ["serve"]
      // Default port 0 — let the OS pick a free port, parse the actual one
      // off stdout. Hard-coded ports flake under parallel tests.
      argv.push("--port", String(opts?.port ?? 0))
      if (opts?.hostname) argv.push("--hostname", opts.hostname)
      if (opts?.extraArgs) argv.push(...opts.extraArgs)

      // Acquire the subprocess; release sends SIGTERM and awaits exit on
      // scope close. Wrapped in Effect.ignore so a flaky kill doesn't surface
      // as a finalizer error during test teardown.
      const proc = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn(["bun", "run", cliEntry, ...argv], {
            cwd: home,
            env: { ...process.env, ...env, ...opts?.env },
            stdout: "pipe",
            stderr: "pipe",
          }),
        ),
        (p) =>
          Effect.promise(() => {
            p.kill()
            return p.exited
          }).pipe(Effect.ignore),
      )

      // Tail buffer so timeout failures can include stderr context. The fork
      // also keeps the OS pipe buffer from filling and wedging the child.
      const stderrChunks: string[] = []
      yield* forkStderrDrain(proc.stderr, stderrChunks)

      // Watch stdout line-by-line for the listening sentinel. Format
      // (see src/cli/cmd/serve.ts):
      //   "opencode server listening on http://<host>:<port>"
      const readyRe = /listening on (http:\/\/([^\s:]+):(\d+))/
      const readyDeferred = yield* Deferred.make<{ url: string; hostname: string; port: number }>()
      yield* Effect.forkScoped(
        fromBunStream("stdout", () => proc.stdout).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => {
            const m = line.match(readyRe)
            return m ? Deferred.succeed(readyDeferred, { url: m[1], hostname: m[2], port: Number(m[3]) }) : Effect.void
          }),
          Effect.ignore({ log: true }),
        ),
      )

      const readyTimeoutMs = opts?.readyTimeoutMs ?? 15_000
      const match = yield* Deferred.await(readyDeferred).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(readyTimeoutMs),
          orElse: () =>
            Effect.fail(
              new Error(
                `opencode serve did not become ready within ${readyTimeoutMs}ms\n` +
                  `stderr (last 2000):\n${stderrChunks.join("").slice(-2000)}`,
              ),
            ),
        }),
      )

      return {
        url: match.url,
        hostname: match.hostname,
        port: match.port,
        kill: () => {
          proc.kill()
        },
        exited: proc.exited as Promise<number>,
      } satisfies ServeHandle
    })

    const acp = Effect.fn("opencode.acp")(function* (opts?: AcpOpts) {
      const argv = ["acp"]
      if (opts?.cwd) argv.push("--cwd", opts.cwd)
      if (opts?.extraArgs) argv.push(...opts.extraArgs)

      // Acquire the subprocess. Release ends stdin (clean shutdown — ACP exits
      // on stdin EOF) and falls back to SIGTERM if it doesn't exit promptly.
      // Either way we await proc.exited so the test scope doesn't leak.
      const proc = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn(["bun", "run", cliEntry, ...argv], {
            cwd: opts?.cwd ?? home,
            env: { ...process.env, ...env, ...opts?.env },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          }),
        ),
        (p) =>
          // Graceful shutdown: close stdin (ACP exits on EOF), give it a
          // window to exit, then SIGTERM. The Effect.timeoutOrElse expresses
          // exactly that race without raw setTimeout or Promise.race.
          Effect.gen(function* () {
            yield* Effect.sync(() => p.stdin.end())
            yield* Effect.promise(() => p.exited).pipe(
              Effect.timeoutOrElse({
                duration: Duration.seconds(2),
                orElse: () =>
                  Effect.sync(() => {
                    p.kill()
                  }),
              }),
            )
            yield* Effect.promise(() => p.exited)
          }).pipe(Effect.ignore),
      )

      const stderrChunks: string[] = []
      yield* forkStderrDrain(proc.stderr, stderrChunks)

      // Each ndjson line becomes one queue entry. JSON.parse failures are
      // surfaced as the raw string so a malformed protocol message doesn't
      // silently wedge the test in `receive`.
      const responses = yield* Queue.unbounded<unknown>()
      yield* Effect.forkScoped(
        fromBunStream("stdout", () => proc.stdout).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => {
            if (line.length === 0) return Effect.void
            let parsed: unknown
            try {
              parsed = JSON.parse(line)
            } catch {
              parsed = { _rawLine: line }
            }
            return Queue.offer(responses, parsed)
          }),
          Effect.ignore({ log: true }),
        ),
      )

      return {
        // `proc.stdin.write` returns `number | Promise<number>`. The promise
        // form is the backpressure signal — if we don't await it, rapid
        // successive sends can interleave under pipe-buffer-full conditions
        // and corrupt the ndjson framing.
        send: (msg: object) =>
          Effect.promise(async () => {
            const ret = proc.stdin.write(JSON.stringify(msg) + "\n")
            if (typeof ret !== "number") await ret
          }),
        receive: Queue.take(responses),
        // proc.stdin.end() is idempotent in Bun; no try/catch needed.
        close: () => proc.stdin.end(),
        exited: proc.exited as Promise<number>,
      } satisfies AcpHandle
    })

    const opencode: OpencodeCli = { run, startRun, serve, acp, spawn, expectExit, parseJsonEvents }

    return yield* fn({ llm, home, opencode })
    // FetchHttpClient is provided so test bodies can `yield* HttpClient.HttpClient`
    // and hit endpoints on `opencode.serve()` without rolling their own fetch.
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        TestLLMServer.layer,
        FetchHttpClient.layer,
        AppNodeBuilder.build(LayerNode.group([FSUtil.node, AppProcess.node])),
      ),
    ),
  )
}

function parseJsonEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function normalizeLines(value: string) {
  return value.replaceAll("\r\n", "\n")
}

// Convenience for the common assertion pattern. Dumps stderr/stdout when
// the exit code doesn't match — saves debugging time on CI failures.
function expectExit(result: RunResult, expected: number, label = "opencode") {
  if (result.exitCode === expected) return
  const tail = (s: string, n: number) => (s.length > n ? "..." + s.slice(-n) : s)
  // eslint-disable-next-line no-console
  console.error(`[${label}] expected exit ${expected}, got ${result.exitCode} after ${result.durationMs}ms`)
  // eslint-disable-next-line no-console
  console.error(`[${label}] stderr (last 2000):\n${tail(result.stderr, 2000)}`)
  // eslint-disable-next-line no-console
  console.error(`[${label}] stdout (last 500):\n${tail(result.stdout, 500)}`)
  throw new Error(`${label}: expected exit ${expected}, got ${result.exitCode}`)
}

// `cliIt.live(name, fixture => effect)` is the same as
// `it.live(name, () => withCliFixture(fixture))` — one fewer nesting level at
// every call site. Use this for any test that needs the opencode CLI fixture.
//
// Subprocess tests must run against the real clock — a TestClock-paused
// environment can't drive a child process. If you need `.only` or `.skip`, fall
// back to `it.live` + `withCliFixture` directly.
// Body's R is `Scope.Scope | never` so tests can yield* scope-requiring
// resources (e.g. `opencode.serve`) without an extra `Effect.scoped` wrapper —
// `withCliFixture`'s outer scope is the natural lifetime.
export const cliIt = {
  live: <A, E>(
    name: string,
    body: (input: CliFixture) => Effect.Effect<A, E, Scope.Scope | HttpClient.HttpClient>,
    opts?: number | TestOptions,
  ) => it.live(name, () => withCliFixture(body), opts),
  concurrent: <A, E>(
    name: string,
    body: (input: CliFixture) => Effect.Effect<A, E, Scope.Scope | HttpClient.HttpClient>,
    opts?: number | TestOptions,
  ) =>
    (process.platform === "win32" ? test : test.concurrent)(
      name,
      () => Effect.runPromise(Effect.scoped(withCliFixture(body))),
      opts,
    ),
}
