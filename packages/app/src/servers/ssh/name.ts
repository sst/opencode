import type { SshConfig } from "./types"

export function sshHostname(target: string) {
  // Accepted SSH targets end with a hostname or user@hostname, never a remote
  // command. Strip shell quoting for display only; keep the saved target intact.
  return (
    (target.trim().split(/\s+/).at(-1) ?? "")
      .replace(/["'\\]/g, "")
      .split("@")
      .at(-1) ?? ""
  )
}

export function sshName(config: Pick<SshConfig, "name" | "target">) {
  return config.name || sshHostname(config.target)
}
