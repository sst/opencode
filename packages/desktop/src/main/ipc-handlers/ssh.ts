import { Effect } from "effect"
import { SshRpcs } from "../../shared/ipc-rpc"
import { IpcPortHandoff } from "../ipc-transport"
import { Ssh } from "../ssh/service"
import { sender } from "./context"

export const sshHandlers = SshRpcs.toLayer(
  Effect.gen(function* () {
    const handoff = yield* IpcPortHandoff
    const ssh = yield* Ssh.Service
    return SshRpcs.of({
      SshGetState: (_args, context) => ssh.state(sender(handoff, context).id),
      SshSubscribe: (_args, context) => ssh.subscribeWindow(sender(handoff, context)),
      SshUnsubscribe: (_args, context) => ssh.unsubscribeWindow(sender(handoff, context).id),
      SshHosts: () => ssh.hosts(),
      SshStart: (input, context) => ssh.start(input, input.background ? undefined : sender(handoff, context).id),
      SshResolve: ({ id }) => ssh.resolve(id),
      SshRespond: ({ id, prompt, value }, context) => ssh.respond(id, prompt, value, sender(handoff, context).id),
      SshDisconnect: ({ id }) => ssh.disconnect(id),
      SshCancel: ({ id }, context) => ssh.cancel(id, sender(handoff, context).id),
      SshForget: ({ id }) => ssh.forget(id).pipe(Effect.orDie),
      SshOpenConfig: () => ssh.openConfig().pipe(Effect.orDie),
    })
  }),
)
