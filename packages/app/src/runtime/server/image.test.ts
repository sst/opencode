import { describe, expect, test } from "bun:test"
import { createApiForServer } from "./api"
import { readLocalImage } from "./image"

function setup(
  respond: (init?: RequestInit) => Response | Promise<Response> = () => new Response(new Uint8Array([0, 127, 255])),
) {
  const requests: Array<{ url: URL; init?: RequestInit }> = []
  const api = createApiForServer({
    server: { url: "https://server.example:4096", password: "secret" },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: new URL(input instanceof Request ? input.url : input), init })
      return respond(init)
    }) as typeof fetch,
  })
  return { api, requests }
}

describe("readLocalImage", () => {
  test.each([
    ["images/screen #1 + 50% ?.PNG", "/workspace/project", "images/screen%20%231%20%2B%2050%25%20%3F.PNG"],
    ["C:/tmp/opencode/screen #1.png", "C:/tmp/opencode/", "screen%20%231.png"],
    ["d:/screen.png", "d:/", "screen.png"],
    ["D:/charts/screen.png", "D:/charts/", "screen.png"],
    ["Z:/charts/screen.png", "Z:/charts/", "screen.png"],
    ["/tmp/opencode/screen #1.png", "/tmp/opencode/", "screen%20%231.png"],
    ["/screen.png", "/", "screen.png"],
  ])("reads %s with the correct location and authentication", async (path, directory, encoded) => {
    const { api, requests } = setup()
    const signal = new AbortController().signal
    const blob = await readLocalImage(api, "/workspace/project", path, signal)

    expect(blob).toBeInstanceOf(Blob)
    expect(blob?.type).toBe("image/png")
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([0, 127, 255]))
    expect(requests).toHaveLength(1)
    expect(requests[0].url.origin).toBe("https://server.example:4096")
    expect(requests[0].url.pathname).toBe(`/api/fs/read/${encoded}`)
    expect([...requests[0].url.searchParams]).toEqual([["location[directory]", directory]])
    expect(requests[0].init?.method).toBe("GET")
    expect(new Headers(requests[0].init?.headers).get("authorization")).toBe(`Basic ${btoa("opencode:secret")}`)
    expect(requests[0].init?.signal).toBe(signal)
  })

  test("preserves literal percent escapes and encodes the supplied relative location", async () => {
    const { api, requests } = setup()
    await readLocalImage(api, "C:/project #1 + 50%", "images/literal%20name.png", new AbortController().signal)

    expect(requests[0].url.href).toBe(
      "https://server.example:4096/api/fs/read/images/literal%2520name.png?location%5Bdirectory%5D=C%3A%2Fproject+%231+%2B+50%25",
    )
  })

  test.each([
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["JPG", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["SVG", "image/svg+xml"],
    ["avif", "image/avif"],
    ["bmp", "image/bmp"],
    ["ico", "image/x-icon"],
  ])("uses the MIME type for .%s rather than the response header", async (extension, type) => {
    const { api } = setup(
      () => new Response("image bytes", { headers: { "content-type": "application/octet-stream" } }),
    )
    const blob = await readLocalImage(api, "/repo", `image.${extension}`, new AbortController().signal)
    expect(blob?.type).toBe(type)
    expect(await blob?.text()).toBe("image bytes")
  })

  test.each([
    "https://example.com/image.png",
    "HTTP://example.com/image.png",
    "file:///tmp/image.png",
    "data:image/png;base64,image.png",
    "blob:https://example.com/image.png",
    "custom+scheme:image.png",
    "C:image.png",
    "//server/share/image.png",
    "\\\\server\\share\\image.png",
    "//?/C:/image.png",
    "///server/share/image.png",
    "image.txt",
    "image.html",
    "image.constructor",
    "image.png.txt",
    "image",
    "images.png/image",
    "image.png/",
    "",
  ])("does not request unsupported input %s", async (path) => {
    const { api, requests } = setup()
    expect(await readLocalImage(api, "/repo", path, new AbortController().signal)).toBeUndefined()
    expect(requests).toHaveLength(0)
  })

  test.each([400, 401])("propagates declared API errors (%s)", async (status) => {
    const error = { _tag: "RequestError", message: "Cannot read image" }
    const { api } = setup(() => Response.json(error, { status }))
    await expect(readLocalImage(api, "/repo", "image.png", new AbortController().signal)).rejects.toEqual(error)
  })

  test("propagates missing-file errors", async () => {
    const error = { _tag: "FileNotFoundError", path: "image.png", message: "File not found: image.png" }
    const { api } = setup(() => Response.json(error, { status: 404 }))
    await expect(readLocalImage(api, "/repo", "image.png", new AbortController().signal)).rejects.toEqual(error)
  })

  test("does not turn an unexpected HTTP status into a Blob", async () => {
    const status = 500
    const { api } = setup(() => new Response("Not an image", { status }))
    await expect(readLocalImage(api, "/repo", "image.png", new AbortController().signal)).rejects.toMatchObject({
      reason: "UnexpectedStatus",
      cause: { status },
    })
  })

  test("propagates transport failures", async () => {
    const error = new Error("Connection lost")
    const { api } = setup(() => Promise.reject(error))
    await expect(readLocalImage(api, "/repo", "image.png", new AbortController().signal)).rejects.toMatchObject({
      reason: "Transport",
      cause: error,
    })
  })

  test("forwards cancellation to an in-flight fetch", async () => {
    const controller = new AbortController()
    const { api, requests } = setup(
      (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        }),
    )
    const result = readLocalImage(api, "/repo", "image.png", controller.signal)
    expect(requests[0].init?.signal).toBe(controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({ reason: "Transport", cause: controller.signal.reason })
  })
})
