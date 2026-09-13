import type { SshItem } from "./types"

export function isSshConnecting(stage: SshItem["stage"]) {
  return (
    stage === "connecting" ||
    stage === "checking" ||
    stage === "downloading" ||
    stage === "uploading" ||
    stage === "starting"
  )
}
