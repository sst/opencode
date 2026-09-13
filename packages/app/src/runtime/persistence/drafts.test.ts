import { describe, expect, test } from "bun:test"
import { createDraftStore, draftTextChunk, draftTextThreshold } from "./drafts"

function memoryDriver() {
  const documents = new Map<string, string>()
  const blobs = new Map<string, Blob>()
  let puts = 0
  return {
    documents,
    blobs,
    puts: () => puts,
    driver: {
      get: async (key: string) => documents.get(key) ?? null,
      // Like the real stores: report referenced blobs that are not held; a strict write with any
      // missing is refused.
      set: async (key: string, value: string, strict: boolean) => {
        const ids = new Set<string>()
        JSON.parse(value, (_key, item) => {
          if (item?.blob && typeof item.blob.id === "string") ids.add(item.blob.id)
          if (item?.blob && Array.isArray(item.blob.ids)) item.blob.ids.forEach((id: unknown) => ids.add(String(id)))
          return item
        })
        const missing = [...ids].filter((id) => !blobs.has(id))
        if (!strict || missing.length === 0) documents.set(key, value)
        return missing
      },
      remove: async (key: string) => void documents.delete(key),
      putBlob: async (blob: Blob) => {
        puts++
        const id = `blob-${await blob.text().then((text) => Bun.hash(text).toString(16))}`
        blobs.set(id, blob)
        return id
      },
      getBlob: async (id: string) => blobs.get(id) ?? null,
    },
  }
}

const large = "x".repeat(draftTextThreshold)
const paste = Array.from({ length: 3 * draftTextChunk }, (_, i) => String.fromCharCode(97 + (i % 26))).join("")

describe("draft store text externalization", () => {
  test("large strings become chunk lists and small ones stay inline", async () => {
    const memory = memoryDriver()
    const store = createDraftStore(memory.driver)
    await store.setDocument("doc", {
      prompt: [
        { type: "text", content: paste },
        { type: "text", content: "hi" },
      ],
    })
    const stored = JSON.parse(memory.documents.get("doc")!)
    expect(stored.prompt[0].content.blob.kind).toBe("text")
    expect(stored.prompt[0].content.blob.ids).toHaveLength(3)
    expect(stored.prompt[1].content).toBe("hi")
    expect(memory.documents.get("doc")!.length).toBeLessThan(400)
    const chunks = await Promise.all(
      stored.prompt[0].content.blob.ids.map((id: string) => memory.blobs.get(id)!.text()),
    )
    expect(chunks.join("")).toBe(paste)
  })

  test("appending to a large string re-uploads only the final chunk", async () => {
    const memory = memoryDriver()
    const store = createDraftStore(memory.driver)
    await store.setDocument("doc", { prompt: [{ type: "text", content: paste }] })
    expect(memory.puts()).toBe(3)
    await store.setDocument("doc", { prompt: [{ type: "text", content: `${paste}!` }] })
    expect(memory.puts()).toBe(4)
    await store.setDocument("doc", { prompt: [{ type: "text", content: `${paste}!` }], cursor: 1 })
    expect(memory.puts()).toBe(4)
  })

  test("reads join the chunks again and reuse cached content", async () => {
    const memory = memoryDriver()
    const store = createDraftStore(memory.driver)
    await store.setDocument("doc", { prompt: [{ type: "text", content: paste }] })
    const fresh = createDraftStore(memory.driver)
    expect(JSON.parse((await fresh.getItem("doc"))!)).toEqual({ prompt: [{ type: "text", content: paste }] })
    memory.blobs.clear()
    expect(JSON.parse((await fresh.getItem("doc"))!)).toEqual({ prompt: [{ type: "text", content: paste }] })
  })

  test("a missing chunk decodes to empty text instead of failing the document", async () => {
    const memory = memoryDriver()
    memory.documents.set(
      "doc",
      JSON.stringify({ prompt: [{ type: "text", content: { blob: { kind: "text", ids: ["gone"] } } }] }),
    )
    const store = createDraftStore(memory.driver)
    expect(JSON.parse((await store.getItem("doc"))!)).toEqual({ prompt: [{ type: "text", content: "" }] })
  })

  test("a cached chunk id the store no longer holds is uploaded again on the next save", async () => {
    const memory = memoryDriver()
    const store = createDraftStore(memory.driver)
    await store.setDocument("doc", { prompt: [{ type: "text", content: large }] })
    const [id] = JSON.parse(memory.documents.get("doc")!).prompt[0].content.blob.ids
    await store.setDocument("doc", { prompt: [{ type: "text", content: `${large}!` }] })
    // Another tab collected the chunk for `large` while this tab still caches its id.
    memory.blobs.clear()
    // Undo republishes the cached id; the write reports it missing and the chunk is uploaded again.
    await store.setDocument("doc", { prompt: [{ type: "text", content: large }] })
    expect(memory.puts()).toBe(3)
    const fresh = createDraftStore(memory.driver)
    expect(JSON.parse((await fresh.getItem("doc"))!).prompt[0].content).toBe(large)
    expect(memory.blobs.has(id)).toBe(true)
  })

  test("an image reference whose blob was collected is restored from its object url", async () => {
    const memory = memoryDriver()
    const store = createDraftStore(memory.driver)
    const image = await store.putBlob(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }))
    // The composer kept this reference (for example in its history) while the store collected the bytes.
    memory.blobs.clear()
    await store.setDocument("doc", { prompt: [{ type: "image", blob: { id: image.id, url: image.url } }] })
    expect(memory.blobs.has(image.id)).toBe(true)
    expect(new Uint8Array(await memory.blobs.get(image.id)!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  test("the previous document stays visible until missing blobs are restored", async () => {
    const memory = memoryDriver()
    const store = createDraftStore(memory.driver)
    await store.setDocument("doc", { prompt: [{ type: "text", content: large }] })
    await store.setDocument("doc", { prompt: [{ type: "text", content: `${large}!` }] })
    const before = memory.documents.get("doc")
    memory.blobs.clear()
    // Hold the repair upload: while it is pending, another reader must still see the old document.
    const gate = Promise.withResolvers<void>()
    const putBlob = memory.driver.putBlob
    memory.driver.putBlob = async (blob) => {
      await gate.promise
      return putBlob(blob)
    }
    const saving = store.setDocument("doc", { prompt: [{ type: "text", content: large }] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(memory.documents.get("doc")).toBe(before)
    gate.resolve()
    await saving
    expect(JSON.parse(memory.documents.get("doc")!).prompt[0].content.blob.ids).toHaveLength(1)
    const fresh = createDraftStore(memory.driver)
    expect(JSON.parse((await fresh.getItem("doc"))!).prompt[0].content).toBe(large)
  })

  test("references are renamed when a restored blob comes back under a different id", async () => {
    const memory = memoryDriver()
    // A store without WebCrypto assigns a fresh id to every upload.
    let counter = 0
    memory.driver.putBlob = async (blob) => {
      const id = `random-${counter++}`
      memory.blobs.set(id, blob)
      return id
    }
    const store = createDraftStore(memory.driver)
    const image = await store.putBlob(new Blob([new Uint8Array([7])], { type: "image/png" }))
    await store.setDocument("doc", {
      prompt: [
        { type: "text", content: paste },
        { type: "image", blob: image },
      ],
    })
    const original = JSON.parse(memory.documents.get("doc")!)
    memory.blobs.clear()
    await store.setDocument("doc", {
      prompt: [
        { type: "text", content: paste },
        { type: "image", blob: image },
      ],
    })
    const restored = JSON.parse(memory.documents.get("doc")!)
    expect(restored.prompt[0].content.blob.ids).not.toEqual(original.prompt[0].content.blob.ids)
    expect(restored.prompt[1].blob.id).not.toBe(original.prompt[1].blob.id)
    for (const id of [...restored.prompt[0].content.blob.ids, restored.prompt[1].blob.id])
      expect(memory.blobs.has(id)).toBe(true)
    const fresh = createDraftStore(memory.driver)
    const read = JSON.parse((await fresh.getItem("doc"))!)
    expect(read.prompt[0].content).toBe(paste)
    expect(read.prompt[1].blob.id).toBe(restored.prompt[1].blob.id)
    // The renamed ids are what later encodes publish, so saves of the still-live references (the
    // composer keeps the original image id) upload nothing and keep one stable image id.
    const puts = counter
    for (const cursor of [1, 2, 3]) {
      await store.setDocument("doc", {
        prompt: [
          { type: "text", content: paste },
          { type: "image", blob: image },
        ],
        cursor,
      })
      expect(JSON.parse(memory.documents.get("doc")!).prompt[1].blob.id).toBe(restored.prompt[1].blob.id)
    }
    expect(counter).toBe(puts)
  })

  test("chunk boundaries never split a surrogate pair", async () => {
    const memory = memoryDriver()
    const store = createDraftStore(memory.driver)
    const text = "x".repeat(draftTextChunk - 1) + "😀tail"
    await store.setDocument("doc", { prompt: [{ type: "text", content: text }] })
    const stored = JSON.parse(memory.documents.get("doc")!)
    const bytes = await Promise.all(stored.prompt[0].content.blob.ids.map((id: string) => memory.blobs.get(id)!.text()))
    expect(bytes.join("")).toBe(text)
    expect(bytes[0]!.length).toBe(draftTextChunk + 1)
    const fresh = createDraftStore(memory.driver)
    expect(JSON.parse((await fresh.getItem("doc"))!).prompt[0].content).toBe(text)
  })

  test("a failed chunk upload is retried on the next save instead of being reused", async () => {
    const memory = memoryDriver()
    let failNext = true
    const putBlob = memory.driver.putBlob
    memory.driver.putBlob = async (blob) => {
      if (failNext) {
        failNext = false
        throw new Error("offline")
      }
      return putBlob(blob)
    }
    const store = createDraftStore(memory.driver)
    await expect(store.setDocument("doc", { prompt: [{ type: "text", content: paste }] })).rejects.toThrow("offline")
    await store.setDocument("doc", { prompt: [{ type: "text", content: `${paste}!` }] })
    const fresh = createDraftStore(memory.driver)
    expect(JSON.parse((await fresh.getItem("doc"))!).prompt[0].content).toBe(`${paste}!`)
  })

  test("setItem still accepts a serialized document", async () => {
    const memory = memoryDriver()
    const store = createDraftStore(memory.driver)
    await store.setItem("doc", JSON.stringify({ prompt: [{ type: "text", content: large }] }))
    expect(JSON.parse(memory.documents.get("doc")!).prompt[0].content.blob.ids).toHaveLength(1)
  })
})

describe("draft store image retention", () => {
  const image = (byte: number) => new Blob([new Uint8Array(6).fill(byte)], { type: "image/png" })
  const fresh = (grace = 0) => {
    const memory = memoryDriver()
    return { memory, store: createDraftStore(memory.driver, { grace }) }
  }
  // Release timers fire on the macrotask queue; a zero grace has fired after one tick.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
  // An image with no object URL left gets a new one when its bytes are uploaded again.
  const released = async (store: ReturnType<typeof createDraftStore>, byte: number, url: string) =>
    (await store.putBlob(image(byte))).url !== url

  test("an uploaded image no document references is released after the grace", async () => {
    const { store } = fresh()
    const orphan = await store.putBlob(image(1))
    await tick()
    expect(await released(store, 1, orphan.url)).toBe(true)
  })

  test("an image referenced within the grace is kept", async () => {
    const { store } = fresh(50)
    const pasted = await store.putBlob(image(2))
    await store.setDocument("pinned", { prompt: [{ type: "image", blob: pasted }] })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(await released(store, 2, pasted.url)).toBe(false)
  })

  test("saving a document without an image or removing the document releases it", async () => {
    const { store } = fresh()
    const dropped = await store.putBlob(image(3))
    const removed = await store.putBlob(image(4))
    await store.setDocument("edited", { prompt: [{ type: "image", blob: dropped }] })
    await store.setDocument("closed", { prompt: [{ type: "image", blob: removed }] })
    await tick()
    expect(await released(store, 3, dropped.url)).toBe(false)
    expect(await released(store, 4, removed.url)).toBe(false)
    await store.setDocument("edited", { prompt: [{ type: "text", content: "typed over it" }] })
    await store.removeItem("closed")
    await tick()
    expect(await released(store, 3, dropped.url)).toBe(true)
    expect(await released(store, 4, removed.url)).toBe(true)
  })

  test("an image referenced by two documents survives until both drop it", async () => {
    const { store } = fresh()
    const shared = await store.putBlob(image(5))
    await store.setDocument("composer", { prompt: [{ type: "image", blob: shared }] })
    await store.setDocument("history", { entries: [{ prompt: [{ type: "image", blob: shared }] }] })
    await store.setDocument("composer", { prompt: [] })
    await tick()
    expect(await released(store, 5, shared.url)).toBe(false)
    await store.setDocument("history", { entries: [] })
    await tick()
    expect(await released(store, 5, shared.url)).toBe(true)
  })

  test("loading a document pins the images it references", async () => {
    const { memory, store } = fresh()
    const id = await memory.driver.putBlob(image(6))
    memory.documents.set("loaded", JSON.stringify({ prompt: [{ type: "image", blob: { id } }] }))
    const url = JSON.parse((await store.getItem("loaded"))!).prompt[0].blob.url
    await tick()
    expect(await released(store, 6, url)).toBe(false)
    await store.removeItem("loaded")
    await tick()
    expect(await released(store, 6, url)).toBe(true)
  })
})
