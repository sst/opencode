import { Option, Schema } from "effect"
import { getOwner, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { Platform } from "@/runtime/platform/platform"

const key = "opencode.global.dat:appearance.background-image"
const maxBytes = 20 * 1024 * 1024
const mime = new Map([
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])
const accepted = new Set(mime.values())
const documentSchema = Schema.Struct({
  image: Schema.optional(
    Schema.Struct({
      mime: Schema.String,
      blob: Schema.Struct({ id: Schema.String, url: Schema.optional(Schema.String) }),
    }),
  ),
})
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(documentSchema))

export class BackgroundImageSelectionError extends Error {
  constructor(readonly reason: "unsupported" | "too-large") {
    super(reason)
    this.name = "BackgroundImageSelectionError"
  }
}

export function createBackgroundImageSettings(platform: Platform, sync = true) {
  const [state, setState] = createStore<{
    image: { mime: string; blob: { id: string; url: string } } | undefined
  }>({ image: undefined })
  const channel = sync && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(key) : undefined
  let revision = 0

  const load = async () => {
    const current = ++revision
    const raw = await platform.draftStore?.getItem(key)
    if (current !== revision || !raw) {
      if (current === revision) setState("image", undefined)
      return
    }
    const parsed = decode(raw)
    const image = Option.isSome(parsed) ? parsed.value.image : undefined
    if (current !== revision) return
    setState(
      "image",
      image?.blob.url?.startsWith("blob:") && accepted.has(image.mime)
        ? { mime: image.mime, blob: { id: image.blob.id, url: image.blob.url } }
        : undefined,
    )
  }

  channel?.addEventListener("message", () => void load().catch(() => undefined))
  if (getOwner()) onCleanup(() => channel?.close())
  const ready = load().catch(() => undefined)

  return {
    ready,
    available: !!platform.draftStore,
    active: () => !!state.image,
    url: () => state.image?.blob.url,
    async select(title: string) {
      const file = await pick(platform, title)
      if (!file) return
      const type = file.type.toLowerCase()
      const extension = file.name.split(".").at(-1)?.toLowerCase()
      const contentType = accepted.has(type) ? type : extension ? mime.get(extension) : undefined
      if (!contentType) throw new BackgroundImageSelectionError("unsupported")
      if (file.size > maxBytes) throw new BackgroundImageSelectionError("too-large")
      const store = platform.draftStore
      if (!store) return
      revision++
      const blob = await store.putBlob(file)
      await store.setDocument(key, { image: { mime: contentType, blob } })
      revision++
      setState("image", { mime: contentType, blob })
      channel?.postMessage(null)
    },
    async clear() {
      revision++
      await platform.draftStore?.removeItem(key)
      revision++
      setState("image", undefined)
      channel?.postMessage(null)
    },
  }
}

async function pick(platform: Platform, title: string) {
  if (platform.openAttachmentPickerDialog) {
    let selected: File | undefined
    await platform.openAttachmentPickerDialog(
      { title, extensions: [...mime.keys()], accept: [...accepted] },
      async (file) => {
        selected ??= file
      },
    )
    return selected
  }
  return new Promise<File | undefined>((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = [...accepted].join(",")
    input.addEventListener("change", () => resolve(input.files?.[0]), { once: true })
    input.addEventListener("cancel", () => resolve(undefined), { once: true })
    input.click()
  })
}
