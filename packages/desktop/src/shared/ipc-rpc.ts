import { RpcClient, RpcClientError } from "effect/unstable/rpc"
import { AppRpcs } from "./ipc-rpc/app"
import { EventRpcs } from "./ipc-rpc/events"
import { FileRpcs } from "./ipc-rpc/files"
import { MenuRpcs } from "./ipc-rpc/menu"
import { StorageRpcs } from "./ipc-rpc/storage"
import { UpdaterRpcs } from "./ipc-rpc/updater"
import { WindowRpcs } from "./ipc-rpc/window"
import { WslRpcs } from "./ipc-rpc/wsl"
import { SshRpcs } from "./ipc-rpc/ssh"

export { AppRpcs } from "./ipc-rpc/app"
export { EventRpcs } from "./ipc-rpc/events"
export { FileRpcs } from "./ipc-rpc/files"
export { MenuRpcs } from "./ipc-rpc/menu"
export { StorageRpcs } from "./ipc-rpc/storage"
export { UpdaterRpcs } from "./ipc-rpc/updater"
export { WindowRpcs } from "./ipc-rpc/window"
export { WslRpcs } from "./ipc-rpc/wsl"
export { SshRpcs } from "./ipc-rpc/ssh"

export const DesktopRpcs = AppRpcs.merge(
  StorageRpcs,
  FileRpcs,
  WindowRpcs,
  MenuRpcs,
  UpdaterRpcs,
  WslRpcs,
  SshRpcs,
  EventRpcs,
)
export type DesktopRpcClient = RpcClient.FromGroup<typeof DesktopRpcs, RpcClientError.RpcClientError>
