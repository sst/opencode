#!/usr/bin/env bun

import { OPENCODE_VERSION } from "./version"

const args = process.argv.slice(2)
const version =
  !process.env.OPENCODE_SSH_ASKPASS_PORT && args.length === 1 && (args[0] === "--version" || args[0] === "-v")

// The installer invokes the binary directly; version queries must not acquire
// runtime services that create directories owned by the installing user.
if (version) process.stdout.write(`opencode v${OPENCODE_VERSION}\n`)
if (!version) await import("./main")
