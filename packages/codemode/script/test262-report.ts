// Runs every vendored test262 file, including skipped ones, and groups failures by cause. Pass
// --write to regenerate test/test262/skipped.txt from the current failures.
//
// Usage: bun run script/test262-report.ts [--write] [path-prefix]
import path from "node:path"
import { root, run, skipped } from "../test/test262/run.js"

const write = process.argv.includes("--write")
const prefix = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? ""
const files = [...new Bun.Glob("**/*.js").scanSync({ cwd: root })].filter((file) => file.startsWith(prefix)).sort()

const failures: Array<{ file: string; reason: string }> = []
const recovered: Array<string> = []
for (const file of files) {
  const outcome = await run(file)
  if (outcome.status === "fail") failures.push({ file, reason: outcome.reason })
  if (outcome.status === "pass" && skipped.has(file)) recovered.push(file)
}

// Collapse a reason to the part that identifies the cause rather than the test.
const bucket = (reason: string) => {
  const syntax = reason.match(/Syntax '([A-Za-z]+)' is not supported/)
  if (syntax) return `unsupported syntax ${syntax[1]}`
  if (reason.startsWith("expected ")) return reason.replace(/ but got .*/, " but the program ran")
  return reason
    .replace(/^(\$DONE: |ExecutionFailure: |InvalidDataValue: |ParseError: |Uncaught: |Test262Error: |Error: )+/, "")
    .replace(/ \(line \d+, col \d+\)/, "")
    .replace(/^[\w$]+\.(\w+) is not a function/, ".$1 is not a function")
    .replace(/^[\w$]+ cannot be constructed/, "… cannot be constructed")
    .replace(/'[^']*'/g, "'…'")
    .slice(0, 100)
}

const buckets = new Map<string, Array<string>>()
for (const failure of failures) {
  const key = bucket(failure.reason)
  buckets.set(key, [...(buckets.get(key) ?? []), failure.file])
}

console.log(`${files.length - failures.length} pass, ${failures.length} fail of ${files.length}\n`)
for (const [key, list] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(list.length).padStart(5)}  ${key}`)
  for (const file of list.slice(0, 3)) console.log(`         ${file}`)
  if (list.length > 3) console.log(`         … ${list.length - 3} more`)
}
if (recovered.length > 0) {
  console.log(`\n${recovered.length} skipped files pass now; remove them from skipped.txt:`)
  for (const file of recovered) console.log(`         ${file}`)
}

if (write) {
  const lines = failures.map((failure) => `${failure.file}  # ${bucket(failure.reason)}`)
  await Bun.write(path.join(root, "skipped.txt"), `${lines.join("\n")}\n`)
  console.log(`\nwrote ${lines.length} entries to skipped.txt`)
}
