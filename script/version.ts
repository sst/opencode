#!/usr/bin/env bun

import { Script } from "@opencode/script"

const output = [`version=${Script.version}`]

if (!Script.preview || Script.channel === "beta") {
  output.push("release=true")
  output.push(`tag=v${Script.version}`)
}

output.push(`repo=${process.env.GH_REPO}`)

if (process.env.GITHUB_OUTPUT) {
  await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
}

process.exit(0)
