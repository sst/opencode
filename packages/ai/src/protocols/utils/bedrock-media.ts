import { Effect, Encoding, Schema } from "effect"
import type { MediaPart } from "../../schema/index.js"
import { ProviderShared } from "../shared.js"

// Bedrock Converse accepts image `format` as the file extension and
// `source.bytes` as base64 in the JSON wire format.
export const ImageFormat = Schema.Literals(["png", "jpeg", "gif", "webp"])
export type ImageFormat = Schema.Schema.Type<typeof ImageFormat>

export const ImageBlock = Schema.Struct({
  image: Schema.Struct({
    format: ImageFormat,
    source: Schema.Struct({ bytes: Schema.String }),
  }),
})
export type ImageBlock = Schema.Schema.Type<typeof ImageBlock>

// Bedrock document blocks require a user-facing name so the model can refer to
// the uploaded document.
export const DocumentFormat = Schema.Literals(["pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"])
export type DocumentFormat = Schema.Schema.Type<typeof DocumentFormat>

export const DocumentBlock = Schema.Struct({
  document: Schema.Struct({
    format: DocumentFormat,
    name: Schema.String,
    source: Schema.Struct({ bytes: Schema.String }),
  }),
})
export type DocumentBlock = Schema.Schema.Type<typeof DocumentBlock>

const IMAGE_FORMATS = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const satisfies Record<string, ImageFormat>

const DOCUMENT_FORMATS = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/html": "html",
  "text/plain": "txt",
  "text/markdown": "md",
} as const satisfies Record<string, DocumentFormat>

const documentBlock = (name: string, format: DocumentFormat, bytes: string): DocumentBlock => ({
  document: {
    format,
    name,
    source: { bytes },
  },
})

function documentName(filename: string | undefined, names: Set<string>) {
  const base =
    (filename ?? "")
      .replace(/\.[^.]*$/, "")
      .replace(/[^a-zA-Z0-9 ()[\]-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200)
      .trim() || "document"
  let name = base
  // Converse requires labels to be unique across the entire request, including tool results.
  for (let index = 2; names.has(name); index++) {
    const suffix = ` ${index}`
    name = `${base.slice(0, 200 - suffix.length).trimEnd()}${suffix}`
  }
  names.add(name)
  return name
}

const mediaBase64 = Effect.fn("BedrockMedia.mediaBase64")(function* (part: MediaPart) {
  const media = ProviderShared.normalizeMedia(part)
  const bytes = yield* Effect.fromResult(Encoding.decodeBase64(media.base64)).pipe(
    Effect.mapError((cause) =>
      ProviderShared.invalidRequest("Bedrock Converse media data must be valid base64", cause),
    ),
  )
  return Encoding.encodeBase64(bytes)
})

// Route by MIME. Known image/document formats lower into a typed block; anything
// else fails with a clear error instead of silently degrading to a malformed
// document block. Image MIME types not in `IMAGE_FORMATS` (e.g. `image/svg+xml`)
// get an image-specific error so the caller knows it's a format-support issue,
// not a kind-detection issue.
export const lower = Effect.fn("BedrockMedia.lower")(function* (part: MediaPart, documentNames: Set<string>) {
  const mime = part.mediaType.toLowerCase()
  const imageFormat = IMAGE_FORMATS[mime as keyof typeof IMAGE_FORMATS]
  if (imageFormat) {
    return [{ image: { format: imageFormat, source: { bytes: yield* mediaBase64(part) } } } satisfies ImageBlock]
  }
  if (mime.startsWith("image/"))
    return yield* ProviderShared.invalidRequest(`Bedrock Converse does not support image media type ${part.mediaType}`)
  const documentFormat = DOCUMENT_FORMATS[mime as keyof typeof DOCUMENT_FORMATS]
  if (documentFormat) {
    const name = documentName(part.filename, documentNames)
    const block = documentBlock(name, documentFormat, yield* mediaBase64(part))
    return part.filename !== undefined && part.filename !== name
      ? [
          {
            text: `Attached file ${ProviderShared.encodeJson(part.filename)} has document label ${ProviderShared.encodeJson(name)}.`,
          },
          block,
        ]
      : [block]
  }
  return yield* ProviderShared.invalidRequest(`Bedrock Converse does not support media type ${part.mediaType}`)
})

export * as BedrockMedia from "./bedrock-media.js"
