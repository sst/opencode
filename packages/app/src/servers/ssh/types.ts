import { Schema } from "effect"
export { sshHostname, sshName } from "./name"
export { isSshConnecting } from "./status"

export const SshConfig = Schema.Struct({ id: Schema.String, target: Schema.String, name: Schema.String })
export type SshConfig = typeof SshConfig.Type
export const SshHttp = Schema.Struct({ url: Schema.String, password: Schema.String })
export type SshHttp = typeof SshHttp.Type
export const SshStage = Schema.Literals([
  "disconnected",
  "connecting",
  "checking",
  "downloading",
  "uploading",
  "starting",
  "ready",
  "authentication",
  "incompatible",
  "failed",
])
export const SshPrompt = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  confirm: Schema.Boolean,
})
export const SshItem = Schema.Struct({
  config: SshConfig,
  saved: Schema.Boolean,
  destination: Schema.optional(Schema.String),
  stage: SshStage,
  http: Schema.optional(SshHttp),
  prompt: Schema.optional(SshPrompt),
  authenticatingElsewhere: Schema.optional(Schema.Boolean),
  detail: Schema.String,
  error: Schema.optional(
    Schema.Literals([
      "connection",
      "input",
      "platform",
      "version",
      "install",
      "service",
      "host-key",
      "ssh-missing",
      "unpublished",
    ]),
  ),
})
export type SshItem = typeof SshItem.Type
export const SshState = Schema.Struct({ servers: Schema.Array(SshItem) })
export type SshState = typeof SshState.Type
export const SshStart = Schema.Struct({
  id: Schema.String,
  target: Schema.String,
  name: Schema.String,
  replace: Schema.optional(Schema.Boolean),
  background: Schema.optional(Schema.Boolean),
})
export type SshStart = typeof SshStart.Type

export type SshPlatform = {
  getState(): Promise<SshState>
  subscribe(callback: (state: SshState) => void): () => void
  hosts(): Promise<readonly string[]>
  start(input: SshStart): Promise<void>
  resolve(id: string): Promise<SshHttp | null>
  respond(id: string, prompt: string, value: string): Promise<void>
  disconnect(id: string): Promise<void>
  cancel(id: string): Promise<void>
  forget(id: string): Promise<void>
  openConfig(): Promise<void>
}
