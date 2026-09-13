import { describe, expect, test } from "bun:test"
import { createDraftStore, type DraftStore } from "@/runtime/persistence/drafts"
import type { Platform } from "@/runtime/platform/platform"
import { createBackgroundImageSettings } from "./background-image"

function setup(file?: File, initial?: string) {
  let value = initial ?? null
  const written: unknown[] = []
  const draftStore: DraftStore = {
    getItem: async () => value,
    setItem: async (_key, next) => {
      value = next
    },
    removeItem: async () => {
      value = null
    },
    putBlob: async () => ({ id: "blob-id", url: "blob:background" }),
    setDocument: async (_key, document) => {
      written.push(document)
      value = JSON.stringify(document)
    },
  }
  const platform: Platform = {
    platform: "web",
    draftStore,
    openExternal() {},
    restart: async () => {},
    notify: async () => {},
    openAttachmentPickerDialog: async (_options, onFile) => {
      if (file) await onFile(file)
    },
  }
  const background = createBackgroundImageSettings(platform, false)
  return { background, written, value: () => value }
}

describe("background image settings", () => {
  test("reloads an image through the document and blob store", async () => {
    const documents = new Map<string, string>()
    const blobs = new Map<string, Blob>()
    const draftStore = createDraftStore({
      get: async (key) => documents.get(key) ?? null,
      set: async (key, value) => {
        documents.set(key, value)
        return []
      },
      remove: async (key) => {
        documents.delete(key)
      },
      putBlob: async (blob) => {
        const id = crypto.randomUUID()
        blobs.set(id, blob)
        return id
      },
      getBlob: async (id) => blobs.get(id) ?? null,
    })
    const file = new File([new Uint8Array([1, 2, 3])], "background.png", { type: "image/png" })
    const value: Platform = {
      platform: "web",
      draftStore,
      openExternal() {},
      restart: async () => {},
      notify: async () => {},
      openAttachmentPickerDialog: async (_options, onFile) => {
        await onFile(file)
      },
    }

    const first = createBackgroundImageSettings(value, false)
    await first.ready
    await first.select("Choose a background image")
    const second = createBackgroundImageSettings(value, false)
    await second.ready
    expect(second.active()).toBe(true)
    expect(second.url()).toStartWith("blob:")
  })

  test("loads, replaces, and clears a persisted image", async () => {
    const current = JSON.stringify({ image: { mime: "image/png", blob: { id: "old", url: "blob:old" } } })
    const { background, written, value } = setup(new File([new Uint8Array([1, 2, 3])], "new.webp"), current)
    await background.ready
    expect(background.active()).toBe(true)
    expect(background.url()).toBe("blob:old")

    await background.select("Choose a background image")
    expect(background.url()).toBe("blob:background")
    expect(written).toEqual([{ image: { mime: "image/webp", blob: { id: "blob-id", url: "blob:background" } } }])

    await background.clear()
    expect(background.active()).toBe(false)
    expect(value()).toBeNull()
  })

  test("rejects unsupported files", async () => {
    const { background } = setup(new File(["<svg />"], "background.svg", { type: "image/svg+xml" }))
    await background.ready
    expect(background.select("Choose a background image")).rejects.toMatchObject({
      reason: "unsupported",
    })
  })

  test("rejects files larger than 20 MB", async () => {
    const { background } = setup(new File([new Uint8Array(20 * 1024 * 1024 + 1)], "background.png"))
    await background.ready
    expect(background.select("Choose a background image")).rejects.toMatchObject({
      reason: "too-large",
    })
  })
})
