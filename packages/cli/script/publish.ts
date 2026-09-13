#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode/script"
import { fileURLToPath } from "url"
import { existsSync } from "fs"
import { chmod, rm, utimes } from "node:fs/promises"
import path from "node:path"
import { UpdateArtifact } from "../../../script/update-artifact"

const dir = fileURLToPath(new URL("..", import.meta.url))
const root = path.resolve(process.env.OPENCODE_CLI_DIST ?? path.join(dir, "dist"))
process.chdir(dir)
const dryRun = process.argv.includes("--dry-run")

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  const exists = !dryRun && (await published(name, version))
  if (exists) console.log(`already published ${name}@${version}`)
  // Keep local tarballs available to downstream publishers when retrying a release.
  await $`bun pm pack`.cwd(dir)
  if (!exists && !dryRun) await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir)
}

async function publishDistribution(input: {
  root: string
  name: string
  command: string
  legacyCommand?: string
  binary: string
  packagePrefix: string
  artifact: string
}) {
  const binaries: Record<string, string> = {}
  for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: input.root })) {
    const item = await Bun.file(`${input.root}/${filepath}`).json()
    if (!item.name.startsWith(input.packagePrefix)) continue
    binaries[item.name] = item.version
  }
  console.log(input.name, "binaries", binaries)
  const versions = new Set(Object.values(binaries))
  if (versions.size > 1) throw new Error(`Binary package versions do not match for ${input.name}`)
  const version = versions.values().next().value
  if (!version) throw new Error(`No binary packages found for ${input.name}`)
  if (version !== Script.version) throw new Error(`Expected ${Script.version}, got ${version} for ${input.name}`)

  await $`mkdir -p ${input.root}/${input.name}/bin`
  await $`cp ./script/postinstall.mjs ${input.root}/${input.name}/postinstall.mjs`
  await Bun.file(`${input.root}/${input.name}/bin/${input.command}.exe`).write(
    [
      `echo "Error: ${input.name}'s postinstall script was not run." >&2`,
      'echo "" >&2',
      'echo "This occurs when installation scripts are disabled." >&2',
      'echo "Run the package postinstall script or reinstall with scripts enabled." >&2',
      "exit 1",
      "",
    ].join("\n"),
  )
  await Bun.file(`${input.root}/${input.name}/package.json`).write(
    JSON.stringify(
      {
        name: input.name,
        bin: {
          [input.command]: `./bin/${input.command}.exe`,
          ...(input.legacyCommand ? { [input.legacyCommand]: `./bin/${input.command}.exe` } : {}),
        },
        ...(input.command !== input.binary ? { opencodeSourceBinary: input.binary } : {}),
        scripts: { postinstall: "node ./postinstall.mjs" },
        version,
        license: pkg.license,
        repository: { type: "git", url: "git+https://github.com/anomalyco/opencode.git" },
        os: ["darwin", "linux", "win32"],
        cpu: ["arm64", "x64"],
        optionalDependencies: binaries,
      },
      null,
      2,
    ),
  )

  await Promise.all(
    Object.entries(binaries).map(([name, version]) =>
      publish(`${input.root}/${name.replace("@opencode/", "")}`, name, version),
    ),
  )
  await publish(`${input.root}/${input.name}`, input.name, version)
  const files = await UpdateArtifact.upload({
    version,
    files: await Promise.all(
      Object.keys(binaries).map((name) =>
        archive(
          path.join(input.root, name.replace("@opencode/", ""), "bin"),
          name.slice(input.packagePrefix.length),
          input.binary,
          input.root,
        ),
      ),
    ),
    dryRun,
  })
  const artifact = {
    channel: Script.channel,
    name: input.artifact,
    distribution: "opencode",
    version,
    metadata: { files },
  }
  if (dryRun) {
    console.log(`dry-run artifact: ${JSON.stringify(artifact)}`)
    return
  }
  await UpdateArtifact.publish({
    channel: Script.channel,
    name: input.artifact,
    distribution: "npm",
    version,
    metadata: { package: input.name },
  })
  await UpdateArtifact.publish(artifact)
}

await publishDistribution({
  root,
  name: pkg.name,
  command: "opencode",
  legacyCommand: "opencode2",
  binary: "opencode",
  packagePrefix: "@opencode/cli-",
  artifact: "cli",
})
if (Script.channel !== "latest" && existsSync(path.join(root, "node"))) {
  await publishDistribution({
    root: path.join(root, "node"),
    name: "@opencode/cli-node",
    command: "opencode2-node",
    binary: "opencode2-node",
    packagePrefix: "@opencode/cli-node-",
    artifact: "cli-node",
  })
}

if (Script.channel === "latest" && Script.release && !dryRun) {
  await $`docker buildx build --platform linux/amd64,linux/arm64 --tag ghcr.io/anomalyco/opencode:${Script.version} --push .`
}

if (Script.channel === "beta" && Script.release) {
  await $`bun ./script/publish-aur.ts ${dryRun ? ["--dry-run"] : []}`.env({ ...process.env, OPENCODE_CLI_DIST: root })
}

async function archive(bin: string, target: string, binary: string, directory: string) {
  const executable = `${binary}${target.startsWith("windows-") ? ".exe" : ""}`
  const source = path.join(bin, executable)
  if (!(await Bun.file(source).exists()) || !Bun.file(source).size) throw new Error(`Missing binary: ${source}`)
  // GitHub artifact downloads lose execute bits. Fixed timestamps make retries reproducible.
  await chmod(source, 0o755)
  await utimes(source, new Date("1980-01-01T00:00:00Z"), new Date("1980-01-01T00:00:00Z"))
  const extension = target.startsWith("linux-") ? "tar.gz" : "zip"
  const output = path.join(directory, `${binary}-${target}.${extension}`)
  await rm(output, { force: true })
  if (extension === "tar.gz") {
    await $`tar --mtime=@0 --owner=0 --group=0 --numeric-owner -czf ${output} -C ${bin} ${executable}`
  }
  if (extension === "zip") await $`zip -X -q ${output} ${executable}`.cwd(bin)
  return output
}
