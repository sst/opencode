import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { SshHttp, SshStart, SshState } from "@opencode/app/ssh"

export const SshRpcs = RpcGroup.make(
  Rpc.make("SshGetState", { success: SshState }),
  Rpc.make("SshSubscribe"),
  Rpc.make("SshUnsubscribe"),
  Rpc.make("SshHosts", { success: Schema.Array(Schema.String) }),
  Rpc.make("SshStart", { payload: SshStart }),
  Rpc.make("SshResolve", { payload: { id: Schema.String }, success: Schema.NullOr(SshHttp) }),
  Rpc.make("SshRespond", { payload: { id: Schema.String, prompt: Schema.String, value: Schema.String } }),
  Rpc.make("SshDisconnect", { payload: { id: Schema.String } }),
  Rpc.make("SshCancel", { payload: { id: Schema.String } }),
  Rpc.make("SshForget", { payload: { id: Schema.String } }),
  Rpc.make("SshOpenConfig"),
)
