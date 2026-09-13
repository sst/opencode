import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { collectStream } from "@opencode/util/process"
import { Failed, NotFound, WrongKind, type FileInfo, type FileType, type FilesImpl } from "./files.js"

/**
 * Files derived from spawning processes: one process per intent, "$1" is
 * always the target path. Scripts report classification through an exit-code
 * protocol (44/45/46) so failures never require parsing localized error text;
 * LC_ALL=C pins the one stderr match that remains. Requires GNU coreutils and
 * findutils in the target image — BSD and busybox userlands will not work.
 * Malformed output from these scripts is our own bug and dies as a defect.
 */

const MAX_DATA_BYTES = 64 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
const NOT_FOUND = 44
const WRONG_KIND = 45
const FAILED = 46
const TAB = "\t"

const loadMetadata = (flags = "") => `
metadata=$(stat ${flags} -c '%F${TAB}%s${TAB}%Y' -- "$1" 2>&1) || {
  case "$metadata" in
    *'No such file or directory'*|*'Not a directory'*) exit ${NOT_FOUND} ;;
    *) printf '%s' "$metadata" >&2; exit ${FAILED} ;;
  esac
}
`

const statScript = `
${loadMetadata()}
printf '%s\n' "$metadata"
`

const realpathScript = `
resolved=$(realpath -e -- "$1" 2>&1) || {
  case "$resolved" in
    *'No such file or directory'*|*'Not a directory'*) exit ${NOT_FOUND} ;;
    *) printf '%s' "$resolved" >&2; exit ${FAILED} ;;
  esac
}
printf '%s\\0' "$resolved"
`

const readScript = `
${loadMetadata("-L")}
kind=\${metadata%%${TAB}*}
if [ "$kind" != 'regular file' ] && [ "$kind" != 'regular empty file' ]; then
  printf '%s' "$kind" >&2
  exit ${WRONG_KIND}
fi
printf '%s\n' "$metadata"
if [ "$2" = range ]; then
  dd if="$1" iflag=skip_bytes,count_bytes skip="$3" count="$4" status=none
else
  cat -- "$1"
fi
`

const listScript = `
${loadMetadata("-L")}
kind=\${metadata%%${TAB}*}
if [ "$kind" != directory ]; then
  printf '%s' "$kind" >&2
  exit ${WRONG_KIND}
fi
find -H "$1" -mindepth 1 -maxdepth 1 -printf '%y\\0%f\\0'
`

const moveScript = `
${loadMetadata()}
mv -- "$1" "$2"
`

interface Result {
  readonly exitCode: number
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

export const execDefaults = (spawner: ChildProcessSpawner["Service"]): FilesImpl => {
  const run = (
    path: string,
    script: string,
    args: ReadonlyArray<string> = [],
    stdin?: Uint8Array,
  ): Effect.Effect<Result, Failed> =>
    Effect.scoped(
      Effect.gen(function* () {
        const command = ChildProcess.make("sh", ["-c", script, "sh", path, ...args], {
          env: { LC_ALL: "C" },
          extendEnv: true,
          stdin: stdin === undefined ? undefined : Stream.make(stdin),
        })
        const handle = yield* spawner.spawn(command).pipe(Effect.mapError((cause) => new Failed({ path, cause })))
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectStream(handle.stdout, MAX_DATA_BYTES),
            collectStream(handle.stderr, MAX_ERROR_BYTES),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError((cause) => new Failed({ path, cause })))
        if (stdout.truncated || stderr.truncated) {
          return yield* new Failed({ path, cause: new Error("Process output exceeded its collection limit") })
        }
        return { exitCode, stdout: stdout.buffer, stderr: stderr.buffer }
      }),
    )

  const classify = <A>(
    path: string,
    result: Result,
    success: (stdout: Uint8Array) => A,
  ): Effect.Effect<A, NotFound | WrongKind | Failed> => {
    if (result.exitCode === 0) return Effect.sync(() => success(result.stdout))
    if (result.exitCode === NOT_FOUND) return Effect.fail(new NotFound({ path }))
    if (result.exitCode === WRONG_KIND) {
      return Effect.fail(new WrongKind({ path, actual: parseType(new TextDecoder().decode(result.stderr)) }))
    }
    return Effect.fail(processFailure(path, result))
  }

  const complete = (path: string, result: Result) =>
    result.exitCode === 0 ? Effect.void : Effect.fail(processFailure(path, result))

  return {
    realpath: (path) =>
      run(path, realpathScript).pipe(
        Effect.flatMap((result) =>
          classifyPlain(path, result, (stdout) => {
            if (stdout.at(-1) !== 0) throw new Error("Missing realpath terminator")
            return new TextDecoder().decode(stdout.subarray(0, -1))
          }),
        ),
      ),
    stat: (path) => run(path, statScript).pipe(Effect.flatMap((result) => classifyPlain(path, result, parseInfo))),
    read: (path, range) =>
      run(
        path,
        readScript,
        range === undefined ? ["whole"] : ["range", String(range.offset), String(range.length)],
      ).pipe(
        Effect.flatMap((result) =>
          classify(path, result, (stdout) => {
            const newline = stdout.indexOf(10)
            if (newline < 0) throw new Error("Missing read metadata header")
            return {
              info: parseInfo(stdout.slice(0, newline)),
              bytes: stdout.slice(newline + 1),
            }
          }),
        ),
      ),
    write: (path, bytes) =>
      run(path, `mkdir -p "$(dirname "$1")" && cat > "$1"`, [], bytes).pipe(
        Effect.flatMap((result) => complete(path, result)),
      ),
    list: (path) => run(path, listScript).pipe(Effect.flatMap((result) => classify(path, result, parseList))),
    remove: (path) => run(path, `rm -rf -- "$1"`).pipe(Effect.flatMap((result) => complete(path, result))),
    move: (from, to) =>
      run(from, moveScript, [to]).pipe(Effect.flatMap((result) => classifyPlain(from, result, () => undefined))),
    mkdir: (path) => run(path, `mkdir -p -- "$1"`).pipe(Effect.flatMap((result) => complete(path, result))),
  }
}

/** `classify` for scripts whose protocol never reports WrongKind. */
const classifyPlain = <A>(
  path: string,
  result: Result,
  success: (stdout: Uint8Array) => A,
): Effect.Effect<A, NotFound | Failed> => {
  if (result.exitCode === 0) return Effect.sync(() => success(result.stdout))
  if (result.exitCode === NOT_FOUND) return Effect.fail(new NotFound({ path }))
  return Effect.fail(processFailure(path, result))
}

const processFailure = (path: string, result: Result) =>
  new Failed({
    path,
    cause: new Error(new TextDecoder().decode(result.stderr).trim() || `Process exited with code ${result.exitCode}`),
  })

const parseInfo = (bytes: Uint8Array): FileInfo => {
  const [rawType, rawSize, rawMtime] = new TextDecoder().decode(bytes).trim().split(TAB)
  const size = Number(rawSize)
  const mtimeMs = Number(rawMtime) * 1_000
  if (!rawType || !Number.isFinite(size) || !Number.isFinite(mtimeMs)) throw new Error("Invalid stat output")
  return { type: parseType(rawType), size, mtimeMs }
}

const parseType = (value: string): FileType => {
  if (value === "regular file" || value === "regular empty file" || value === "f") return "file"
  if (value === "directory" || value === "d") return "directory"
  if (value === "symbolic link" || value === "l") return "symlink"
  return "other"
}

const parseList = (bytes: Uint8Array) => {
  const fields = new TextDecoder().decode(bytes).split("\0")
  fields.pop()
  if (fields.length % 2 !== 0) throw new Error("Invalid find output")
  return Array.from({ length: fields.length / 2 }, (_, index) => ({
    name: fields[index * 2 + 1],
    type: parseType(fields[index * 2]),
  }))
}

export * as EnvironmentExecDefaults from "./exec-defaults.js"
