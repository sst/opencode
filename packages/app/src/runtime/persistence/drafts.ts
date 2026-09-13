import type { AsyncStorage } from "@solid-primitives/storage"
import { Option, Schema } from "effect"

export type BlobReference = { id: string; url: string }

type Driver = {
  get(key: string): Promise<string | null>
  /**
   * Store the document and report every blob id it references that the store does not hold. A
   * strict write is refused (nothing stored) when any are missing, so a document is never visible
   * with dangling references while its blobs are being restored.
   */
  set(key: string, value: string, strict: boolean): Promise<readonly string[]>
  remove(key: string): Promise<void>
  putBlob(blob: Blob): Promise<string>
  getBlob(id: string): Promise<Blob | null>
}

export type DraftStore = AsyncStorage & {
  putBlob(blob: Blob): Promise<BlobReference>
  /** Persist an already-encoded document without re-parsing its serialized form. */
  setDocument(key: string, document: unknown): Promise<void>
}

// Strings at least this long leave the document as fixed-size content-addressed chunks. Typing
// after a large paste changes only the final chunk, so a save uploads one chunk, not the paste.
export const draftTextThreshold = 16 * 1024
export const draftTextChunk = 64 * 1024
const textCacheLimit = 64

// Decoded image bytes the renderer pins through object URLs. Every consumer of a `blob.url` is a
// persisted draft document (composer prompt, prompt history), so an image is pinned exactly while a
// stored document references it. Once the last reference disappears (removed from a draft, sent, or
// a discarded duplicate paste) the URL is revoked after this grace, which covers the persist delay
// between a paste and the save that references it, and the submit → history handoff.
export const retainedBlobGrace = 30_000

type Retained = { blob: Blob; url: string; release: ReturnType<typeof setTimeout> | undefined }
const retained = new Map<string, Retained>()
// Document keys that reference each image id; an id with no keys is released after the grace.
const refs = new Map<string, Set<string>>()
// Image ids that were restored under a different id (a store without WebCrypto assigns fresh
// ones); live references still carry the original.
const aliases = new Map<string, string>()

function blobUrl(id: string, blob: Blob, grace?: number) {
  const existing = retained.get(id)
  if (existing) return existing.url
  const url = URL.createObjectURL(blob)
  // Without a grace the image has no store to reference it from and stays for the page's lifetime.
  const release = grace === undefined || refs.get(id)?.size ? undefined : setTimeout(() => revoke(id), grace)
  retained.set(id, { blob, url, release })
  return url
}

// Record which image ids `key` now references; ids it dropped are released once no other document
// references them, ids it gained stay pinned.
function retain(key: string, ids: ReadonlySet<string>, grace: number) {
  for (const [id, keys] of refs) {
    if (ids.has(id) || !keys.delete(key) || keys.size) continue
    refs.delete(id)
    const entry = retained.get(id)
    if (entry) entry.release = setTimeout(() => revoke(id), grace)
  }
  for (const id of ids) {
    const keys = refs.get(id) ?? new Set<string>()
    keys.add(key)
    refs.set(id, keys)
    const entry = retained.get(id)
    if (!entry) continue
    clearTimeout(entry.release)
    entry.release = undefined
  }
}

function revoke(id: string) {
  const entry = retained.get(id)
  if (!entry) return
  URL.revokeObjectURL(entry.url)
  retained.delete(id)
  for (const [from, to] of aliases) if (to === id) aliases.delete(from)
}

// Image ids a document references: `{ blob: { id } }` parts, not text chunk lists.
function imageIDs(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((entry) => imageIDs(entry, into))
    return into
  }
  if (!value || typeof value !== "object") return into
  const item = value as Record<string, unknown>
  const blob = item.blob
  if (blob && typeof blob === "object" && !("kind" in blob)) {
    const id = (blob as Record<string, unknown>).id
    if (typeof id === "string") into.add(id)
    return into
  }
  Object.values(item).forEach((entry) => imageIDs(entry, into))
  return into
}

async function blobID(blob: Blob) {
  const bytes = crypto.subtle
    ? new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))
    : crypto.getRandomValues(new Uint8Array(16))
  const id = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return id
}

export async function createBlobReference(blob: Blob): Promise<BlobReference> {
  const id = await blobID(blob)
  return { id, url: blobUrl(id, blob) }
}

export function createDraftStore(driver: Driver, options: { grace?: number } = {}): DraftStore {
  const grace = options.grace ?? retainedBlobGrace
  const versions = new Map<string, number>()
  const loading = new Map<string, Promise<string | undefined>>()
  const loadBlobUrl = (id: string) => {
    const existing = retained.get(id)
    if (existing) return existing.url
    const pending = loading.get(id)
    if (pending) return pending
    const next = driver
      .getBlob(id)
      .then((blob) => (blob ? blobUrl(id, blob, grace) : undefined))
      .finally(() => loading.delete(id))
    loading.set(id, next)
    return next
  }
  const putBlob = async (blob: Blob) => {
    const id = await driver.putBlob(blob)
    return { id, url: blobUrl(id, blob, grace) }
  }
  // Keyed by chunk content so unchanged chunks are never hashed or sent again while the draft is
  // edited. Bounded because each entry pins up to draftTextChunk characters. A hit is safe even if
  // the store has since collected the blob: the write reports it missing and it is uploaded again.
  const chunkIds = new Map<string, Promise<string>>()
  const chunks = new Map<string, string>()
  const remember = <V>(cache: Map<string, V>, key: string, value: V) => {
    cache.set(key, value)
    if (cache.size > textCacheLimit) cache.delete(cache.keys().next().value!)
    return value
  }
  const upload = (chunk: string) => {
    const id = driver.putBlob(new Blob([chunk])).then(
      (id) => {
        remember(chunks, id, chunk)
        return id
      },
      (error: unknown) => {
        // A failed upload must not be reused as the answer for this content on later saves.
        if (chunkIds.get(chunk) === id) chunkIds.delete(chunk)
        throw error
      },
    )
    return remember(chunkIds, chunk, id)
  }
  const externalize = (text: string) => Promise.all(split(text).map((chunk) => chunkIds.get(chunk) ?? upload(chunk)))
  const loadChunk = async (id: string) => {
    const cached = chunks.get(id)
    if (cached !== undefined) return cached
    const blob = await driver.getBlob(id)
    // A missing chunk loses that text but keeps the rest of the document decodable.
    return remember(chunks, id, blob ? await blob.text() : "")
  }
  // `sources` collects, for every blob id the encoded document references, a way to produce its
  // bytes again: the chunk text itself, or the image Blob (or object URL) the reference carries.
  type Sources = Map<string, { blob: () => Promise<Blob>; chunk?: string }>
  const encode = async (value: unknown, sources: Sources): Promise<unknown> => {
    if (typeof value === "string" && value.length >= draftTextThreshold) {
      const pieces = split(value)
      const ids = await externalize(value)
      ids.forEach((id, index) =>
        sources.set(id, { blob: async () => new Blob([pieces[index]!]), chunk: pieces[index] }),
      )
      return { blob: { kind: "text", ids } }
    }
    if (Array.isArray(value)) return Promise.all(value.map((entry) => encode(entry, sources)))
    if (!value || typeof value !== "object") return value
    const item = value as Record<string, unknown>
    if (item.type === "image" && typeof item.dataUrl === "string") {
      const blob = await fetch(item.dataUrl).then((response) => response.blob())
      const { dataUrl: _, ...rest } = item
      const id = await driver.putBlob(blob)
      sources.set(id, { blob: async () => blob })
      return { ...rest, blob: { id } }
    }
    if ("blob" in item && item.blob && typeof item.blob === "object") {
      const blob = item.blob as Record<string, unknown>
      if (blob.kind === "text") return item
      if (typeof blob.id === "string" && blob.id.startsWith("data:")) {
        const data = await fetch(blob.id).then((response) => response.blob())
        const id = await driver.putBlob(data)
        sources.set(id, { blob: async () => data })
        return { ...item, blob: { id } }
      }
      if (typeof blob.id === "string") {
        // A live reference keeps the id it was created with; publish the id its bytes now live under.
        const id = aliases.get(blob.id) ?? blob.id
        const kept = retained.get(id)?.blob
        const url = typeof blob.url === "string" ? blob.url : retained.get(id)?.url
        if (kept) sources.set(id, { blob: async () => kept })
        else if (url) sources.set(id, { blob: () => fetch(url).then((response) => response.blob()) })
        return { ...item, blob: { id } }
      }
      return { ...item, blob: { id: blob.id } }
    }
    return Object.fromEntries(
      await Promise.all(Object.entries(item).map(async ([key, entry]) => [key, await encode(entry, sources)])),
    )
  }
  const decode = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(decode))
    if (!value || typeof value !== "object") return value
    const item = value as Record<string, unknown>
    if (item.blob && typeof item.blob === "object") {
      const ref = item.blob as Record<string, unknown>
      if (ref.kind === "text" && Array.isArray(ref.ids)) {
        return (await Promise.all(ref.ids.map((id) => loadChunk(String(id))))).join("")
      }
      if (typeof ref.id === "string") {
        const url = await loadBlobUrl(ref.id)
        if (url) return { ...item, blob: { id: ref.id, url } }
      }
    }
    return Object.fromEntries(
      await Promise.all(Object.entries(item).map(async ([key, entry]) => [key, await decode(entry)])),
    )
  }
  // Upload the bytes behind `ids` again and return the ids they were stored under. Ids are
  // usually content hashes and come back unchanged, but a store without WebCrypto assigns fresh
  // ones, so callers must rename references rather than assume.
  const restore = async (ids: readonly string[], sources: Sources) => {
    const renamed = new Map<string, string>()
    await Promise.all(
      ids.map(async (id) => {
        const source = sources.get(id)
        if (!source) return
        const blob = await source.blob()
        const next = await driver.putBlob(blob)
        renamed.set(id, next)
        if (source.chunk !== undefined) {
          remember(chunkIds, source.chunk, Promise.resolve(next))
          remember(chunks, next, source.chunk)
          return
        }
        blobUrl(next, blob, grace)
        if (next === id) return
        // Later encodes of the still-live reference resolve straight to the new id. Re-point any
        // earlier alias chain so lookups stay one step.
        for (const [from, to] of aliases) if (to === id) aliases.set(from, next)
        aliases.set(id, next)
      }),
    )
    return renamed
  }
  const rename = (value: unknown, renamed: Map<string, string>): unknown => {
    if (Array.isArray(value)) return value.map((entry) => rename(entry, renamed))
    if (!value || typeof value !== "object") return value
    const item = value as Record<string, unknown>
    if (item.blob && typeof item.blob === "object") {
      const ref = item.blob as Record<string, unknown>
      if (Array.isArray(ref.ids))
        return { ...item, blob: { ...ref, ids: ref.ids.map((id) => renamed.get(String(id)) ?? id) } }
      if (typeof ref.id === "string") return { ...item, blob: { ...ref, id: renamed.get(ref.id) ?? ref.id } }
    }
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, rename(entry, renamed)]))
  }
  const setDocument = async (key: string, document: unknown) => {
    const version = (versions.get(key) ?? 0) + 1
    versions.set(key, version)
    const sources: Sources = new Map()
    const encoded = await encode(document, sources)
    if (versions.get(key) !== version) return
    // The store refuses the write while any referenced blob is missing, so the previous document
    // stays visible until the bytes are back. Covers a blob collected while a cache, another tab,
    // or the composer's history still held its id.
    const missing = await driver.set(key, JSON.stringify(encoded), true)
    if (missing.length === 0) {
      retain(key, imageIDs(encoded), grace)
      return
    }
    const renamed = await restore(missing, sources)
    if (versions.get(key) !== version) return
    const unrestored = missing.filter((id) => !renamed.has(id))
    if (unrestored.length)
      console.error(`[persistence] draft ${key} references blobs with no bytes to restore`, unrestored)
    // Anything still missing has no bytes anywhere; the owning codec drops such references on read.
    const final = rename(encoded, renamed)
    await driver.set(key, JSON.stringify(final), false)
    retain(key, imageIDs(final), grace)
  }
  return {
    getItem: async (key) => {
      const value = await driver.get(key)
      if (value === null) return null
      const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(value)
      // Let the owning persistence codec apply its invalid-document policy.
      if (Option.isNone(parsed)) return value
      // A loaded document is live in the composer: pin its images before decode mints their URLs.
      retain(key, imageIDs(parsed.value), grace)
      return JSON.stringify(await decode(parsed.value))
    },
    setItem: (key, value) => setDocument(key, JSON.parse(value)),
    setDocument,
    removeItem: async (key) => {
      versions.set(key, (versions.get(key) ?? 0) + 1)
      await driver.remove(key)
      retain(key, new Set(), grace)
    },
    putBlob,
  }
}

// Fixed-size pieces, except that a piece never ends between the two halves of a surrogate pair:
// each piece becomes its own Blob, and an unpaired surrogate would be encoded as U+FFFD.
function split(text: string) {
  const pieces: string[] = []
  for (let start = 0; start < text.length; ) {
    const end = Math.min(start + draftTextChunk, text.length)
    const code = text.charCodeAt(end - 1)
    const stop = end < text.length && code >= 0xd800 && code <= 0xdbff ? end + 1 : end
    pieces.push(text.slice(start, stop))
    start = stop
  }
  return pieces
}

export function createBrowserDraftStore(): DraftStore {
  const request = indexedDB.open("opencode-drafts", 1)
  request.addEventListener("upgradeneeded", () => {
    request.result.createObjectStore("documents")
    request.result.createObjectStore("blobs")
  })
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener("success", () => {
      const database = request.result
      const transaction = database.transaction(["documents", "blobs"], "readwrite")
      const documents = transaction.objectStore("documents").getAll()
      documents.addEventListener("success", () => {
        const used = referenced(`[${documents.result.join(",")}]`)
        const store = transaction.objectStore("blobs")
        const blobs = store.openKeyCursor()
        blobs.addEventListener("success", () => {
          const cursor = blobs.result
          if (!cursor) return
          if (!used.has(String(cursor.key))) store.delete(cursor.key)
          cursor.continue()
        })
      })
      transaction.addEventListener("complete", () => resolve(database))
      transaction.addEventListener("abort", () => resolve(database))
    })
    request.addEventListener("error", () => reject(request.error))
  })
  const get = async (store: string, key: string) => {
    const result = (await db).transaction(store).objectStore(store).get(key)
    return new Promise<unknown>((resolve, reject) => {
      result.addEventListener("success", () => resolve(result.result))
      result.addEventListener("error", () => reject(result.error))
    })
  }
  const write = async (store: string, key: string, value?: unknown) => {
    const transaction = (await db).transaction(store, "readwrite")
    if (value === undefined) transaction.objectStore(store).delete(key)
    else transaction.objectStore(store).put(value, key)
    return new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve())
      transaction.addEventListener("error", () => reject(transaction.error))
    })
  }
  return createDraftStore({
    get: async (key) => ((await get("documents", key)) as string | undefined) ?? null,
    set: async (key, value, strict) => {
      // One readwrite transaction over both stores: IndexedDB serialises overlapping readwrite
      // transactions in creation order, so a later save or removal cannot commit between the
      // reference check and this write. The put is issued from the last lookup's callback so the
      // transaction is never left without a pending request.
      const ids = [...referenced(value)]
      const transaction = (await db).transaction(["blobs", "documents"], "readwrite")
      const missing: string[] = []
      const publish = () => {
        if (!strict || missing.length === 0) transaction.objectStore("documents").put(value, key)
      }
      let remaining = ids.length
      if (remaining === 0) publish()
      for (const id of ids) {
        const lookup = transaction.objectStore("blobs").getKey(id)
        lookup.addEventListener("success", () => {
          if (lookup.result === undefined) missing.push(id)
          if (--remaining === 0) publish()
        })
      }
      return new Promise<string[]>((resolve, reject) => {
        transaction.addEventListener("complete", () => resolve(missing))
        transaction.addEventListener("error", () => reject(transaction.error))
        transaction.addEventListener("abort", () => reject(transaction.error))
      })
    },
    remove: (key) => write("documents", key),
    putBlob: async (blob) => {
      const id = await blobID(blob)
      await write("blobs", id, blob)
      return id
    },
    getBlob: async (id) => ((await get("blobs", id)) as Blob | undefined) ?? null,
  })
}

// Every blob id a serialized document (or array of documents) references.
function referenced(json: string) {
  const ids = new Set<string>()
  JSON.parse(json, (_key, item) => {
    if (item?.blob && typeof item.blob.id === "string") ids.add(item.blob.id)
    if (item?.blob && Array.isArray(item.blob.ids)) item.blob.ids.forEach((id: unknown) => ids.add(String(id)))
    return item
  })
  return ids
}

export async function blobDataUrl(blob: BlobReference, mime: string) {
  const kept = retained.get(aliases.get(blob.id) ?? blob.id)
  const data = kept ? kept.blob : await fetch(blob.url).then((response) => response.blob())
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => reject(reader.error))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      resolve(`data:${mime};base64,${value.slice(value.indexOf(",") + 1)}`)
    })
    reader.readAsDataURL(data)
  })
}

export function createLegacyBlobReference(dataUrl: string): BlobReference {
  return { id: dataUrl, url: dataUrl }
}
