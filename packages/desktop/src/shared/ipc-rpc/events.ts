import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { BrowserPaneEventSchema, BrowserPaneRpc } from "./browser"
import { UpdaterStateSchema } from "./updater"
import { WslServersEventSchema } from "./wsl"
import { SshState } from "@opencode/app/ssh"

export class SshChanged extends Schema.TaggedClass<SshChanged>()("SshChanged", { state: SshState }) {}

export class BrowserPaneEvent extends Schema.TaggedClass<BrowserPaneEvent>()("BrowserPaneEvent", {
  bindingID: Schema.String,
  event: BrowserPaneEventSchema,
}) {}

export class DeepLinksOpened extends Schema.TaggedClass<DeepLinksOpened>()("DeepLinksOpened", {
  urls: Schema.Array(Schema.String),
}) {}

export class MenuCommandTriggered extends Schema.TaggedClass<MenuCommandTriggered>()("MenuCommandTriggered", {
  id: Schema.String,
}) {}

export class UpdaterStateChanged extends Schema.TaggedClass<UpdaterStateChanged>()("UpdaterStateChanged", {
  state: UpdaterStateSchema,
}) {}

export class WslServersChanged extends Schema.TaggedClass<WslServersChanged>()("WslServersChanged", {
  event: WslServersEventSchema,
}) {}

export class WindowFullscreenChanged extends Schema.TaggedClass<WindowFullscreenChanged>()("WindowFullscreenChanged", {
  fullscreen: Schema.Boolean,
}) {}

export class WindowPinchZoomChanged extends Schema.TaggedClass<WindowPinchZoomChanged>()("WindowPinchZoomChanged", {
  enabled: Schema.Boolean,
}) {}

export class WindowZoomChanged extends Schema.TaggedClass<WindowZoomChanged>()("WindowZoomChanged", {
  factor: Schema.Number,
}) {}

// Another window wrote to a storage namespace; recipients refresh their in-memory copy.
export class StorageChanged extends Schema.TaggedClass<StorageChanged>()("StorageChanged", {
  name: Schema.String,
  insert: Schema.Record(Schema.String, Schema.String),
  remove: Schema.Array(Schema.String),
  revision: Schema.Number,
}) {}

export const DesktopEvent = Schema.Union([
  BrowserPaneEvent,
  DeepLinksOpened,
  MenuCommandTriggered,
  UpdaterStateChanged,
  WslServersChanged,
  SshChanged,
  WindowFullscreenChanged,
  WindowPinchZoomChanged,
  WindowZoomChanged,
  StorageChanged,
])
export type DesktopEvent = Schema.Schema.Type<typeof DesktopEvent>

export const DesktopEvents = Rpc.make("DesktopEvents", { success: DesktopEvent, stream: true })
export const EventRpcs = RpcGroup.make(DesktopEvents, BrowserPaneRpc)
