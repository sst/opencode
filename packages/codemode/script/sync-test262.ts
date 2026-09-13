// Copies the manifest's test262 directories from a local checkout into test/test262, verbatim.
// Files needing unsupported flags, features, or harness includes, or whose code crosses one of the
// interpreter's intentional boundaries, are not copied, so the vendored tree is exactly what
// test/test262.test.ts runs.
//
// Usage: bun run script/sync-test262.ts /path/to/test262
import path from "node:path"
import { rm } from "node:fs/promises"

type Frontmatter = { flags?: Array<string>; features?: Array<string>; includes?: Array<string> }

const root = path.resolve(import.meta.dir, "../test/test262")
const manifest = (await Bun.file(path.join(root, "manifest.json")).json()) as {
  revision: string
  directories: Array<string>
  harness: Array<string>
  flags: Array<string>
  features: Array<string>
  boundaries: Record<string, string>
}
const boundaries = Object.entries(manifest.boundaries).map(([name, pattern]) => [name, new RegExp(pattern)] as const)
const checkout = process.argv[2]
if (checkout === undefined) {
  console.error("usage: bun run script/sync-test262.ts /path/to/test262")
  process.exit(1)
}
const head = (await Bun.$`git -C ${checkout} rev-parse HEAD`.text()).trim()
if (head !== manifest.revision) {
  console.error(`checkout is at ${head}; manifest pins ${manifest.revision}`)
  process.exit(1)
}

const excluded = new Map<string, number>()
let copied = 0
for (const dir of manifest.directories) {
  await rm(path.join(root, dir), { recursive: true, force: true })
  const from = path.join(checkout, "test", dir)
  for await (const file of new Bun.Glob("**/*.js").scan({ cwd: from })) {
    if (file.endsWith("_FIXTURE.js")) continue
    const source = await Bun.file(path.join(from, file)).text()
    const start = source.indexOf("/*---")
    const end = source.indexOf("---*/", start)
    const meta = start === -1 ? {} : (Bun.YAML.parse(source.slice(start + 5, end)) as Frontmatter)
    const code = start === -1 ? source : source.slice(end + 5)
    const reason =
      meta.flags?.find((flag) => manifest.flags.includes(flag)) ??
      meta.features?.find((feature) => manifest.features.includes(feature)) ??
      meta.includes?.find((include) => !manifest.harness.includes(include)) ??
      boundaries.find(([, pattern]) => pattern.test(code))?.[0]
    if (reason !== undefined) {
      excluded.set(reason, (excluded.get(reason) ?? 0) + 1)
      continue
    }
    await Bun.write(path.join(root, dir, file), Bun.file(path.join(from, file)))
    copied++
  }
}

console.log(`copied ${copied} files`)
for (const [reason, count] of [...excluded].sort((a, b) => b[1] - a[1])) {
  console.log(`  excluded ${String(count).padStart(5)}  ${reason}`)
}
