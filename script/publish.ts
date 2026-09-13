#!/usr/bin/env bun

import { Script } from "@opencode/script"
import { $ } from "bun"
import { fileURLToPath } from "url"

console.log("=== publishing ===\n")

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)
const tag = `v${Script.version}`

const pkgjsons = await Array.fromAsync(
  new Bun.Glob("**/package.json").scan({
    absolute: true,
  }),
).then((arr) => arr.filter((x) => !x.includes("node_modules") && !x.includes("dist")))

async function prepareReleaseFiles() {
  for (const file of pkgjsons) {
    let pkg = await Bun.file(file).text()
    pkg = pkg.replaceAll(/"version": "[^"]+"/g, `"version": "${Script.version}"`)
    console.log("updated:", file)
    await Bun.file(file).write(pkg)
  }

  await $`bun install`
}

if (Script.release && !Script.preview) {
  await $`git fetch origin --tags`
  await $`git switch --detach`
}

await prepareReleaseFiles()

if (Script.release) await $`bun ./packages/desktop/scripts/publish.ts --dry-run`

console.log("\n=== schema ===\n")
await $`bun ./packages/schema/script/publish.ts`

console.log("\n=== codemode ===\n")
await $`bun ./packages/codemode/script/publish.ts`

console.log("\n=== theme ===\n")
await $`bun ./packages/theme/script/publish.ts`

console.log("\n=== ai ===\n")
await $`bun ./packages/ai/script/publish.ts`

console.log("\n=== util ===\n")
await $`bun ./packages/util/script/publish.ts`

console.log("\n=== protocol ===\n")
await $`bun ./packages/protocol/script/publish.ts`

console.log("\n=== client ===\n")
await $`bun ./packages/client/script/publish.ts`

console.log("\n=== cli ===\n")
await $`bun ./packages/cli/script/publish.ts`

console.log("\n=== plugin ===\n")
await $`bun ./packages/plugin/script/publish.ts`

console.log("\n=== plugin-browser ===\n")
await $`bun ./packages/plugin-browser/script/publish.ts`

console.log("\n=== core ===\n")
await $`bun ./packages/core/script/publish.ts`

console.log("\n=== simulation ===\n")
await $`bun ./packages/simulation/script/publish.ts`

console.log("\n=== server ===\n")
await $`bun ./packages/server/script/publish.ts`

console.log("\n=== sdk ===\n")
await $`bun ./packages/sdk/script/publish.ts`

console.log("\n=== ui ===\n")
await $`bun ./packages/ui/script/publish.ts`

if (Script.release && !Script.preview) {
  if ((await $`git diff --quiet`.nothrow()).exitCode !== 0) await $`git commit -am "release: ${tag}"`
  await $`git tag -d ${tag}`.nothrow()
  await $`git tag ${tag}`
  await $`git push origin refs/tags/${tag} --force-with-lease --no-verify`
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  await $`git fetch origin`
  await $`git checkout -B v2 origin/v2`
  await prepareReleaseFiles()
  if ((await $`git diff --quiet`.nothrow()).exitCode !== 0) {
    await $`git commit -am "sync release versions for ${tag}"`
    await $`git push origin HEAD:v2 --no-verify`
  }
}

if (Script.release) {
  console.log("\n=== desktop ===\n")
  await $`bun ./packages/desktop/scripts/publish.ts`
}
