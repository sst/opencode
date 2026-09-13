import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { createHash } from "node:crypto"
import path from "node:path"
import { app, BrowserWindow, nativeImage } from "electron"
import { Browser } from "@opencode/plugin-browser/rpc"
import { OpenCode } from "@opencode/client"
import { Effect, Fiber, Schema, Stream } from "effect"
import { createBrowserPane } from "../../src/main/browser-pane"
import { bindIpcEvents, ipcEventStream } from "../../src/main/ipc-events"
import { Smoke } from "./contract"
import { verifyTargets } from "./targets"
import { openDatabase } from "../../src/main/storage/database"
import { createStateStore } from "../../src/main/storage/state"

type Output<Name extends Browser.Method> = Schema.Schema.Type<Extract<Browser.Operation, { name: Name }>["output"]>

// Fail the disposable fixture in stderr instead of opening Electron's error dialog.
process.on("uncaughtException", (error) => {
  console.error(error)
  app.exit(1)
})
process.on("unhandledRejection", (error) => {
  console.error(error)
  app.exit(1)
})

async function main() {
  const root = process.env.SMOKE_ROOT!
  app.setPath("userData", path.join(root, "electron-data"))
  app.on("window-all-closed", () => {})
  await app.whenReady()
  const web = createServer((request, response) => {
    if (request.url === "/cors-allowed" || request.url === "/cors-denied") {
      if (request.url === "/cors-allowed") response.setHeader("access-control-allow-origin", "*")
      response.setHeader("content-type", "text/plain")
      response.end("cors proof")
      return
    }
    if (request.url === "/api/test") {
      response.setHeader("content-type", "application/json")
      response.end('{"message":"network body"}')
      return
    }
    if (request.url === "/missing") {
      response.writeHead(404, { "content-type": "text/plain" })
      response.end("not found")
      return
    }
    if (request.url === "/download") {
      response.setHeader("content-disposition", 'attachment; filename="report.txt"')
      response.setHeader("content-type", "text/plain")
      response.end("desktop download bytes")
      return
    }
    if (request.url === "/frame") {
      response.setHeader("content-type", "text/html")
      response.end("<button onclick=\"this.textContent='Frame clicked'\">Frame button</button>")
      return
    }
    // A same-origin child inside a cross-origin frame shares its parent's renderer and has no CDP target.
    if (request.url === "/nested") {
      response.setHeader("content-type", "text/html")
      response.end('<iframe name="inner" title="Inner frame" src="/frame"></iframe>')
      return
    }
    // One Chromium request ID spans both hops; each hop must keep its own wire headers.
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/redirected", "set-cookie": "hop=1; Path=/" })
      response.end()
      return
    }
    if (request.url === "/redirected") {
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("landed")
      return
    }
    // Fetched twice: the second 301 comes from Chromium's cache without ExtraInfo events, while
    // the uncacheable target still emits them for the same request ID.
    if (request.url === "/moved") {
      response.writeHead(301, { location: "/moved-target", "cache-control": "max-age=60" })
      response.end()
      return
    }
    if (request.url === "/moved-target") {
      response.writeHead(201, { "content-type": "text/plain", "cache-control": "no-store", "x-hop": "target" })
      response.end("moved")
      return
    }
    // Revalidation: the wire answers 304 while the renderer reports the cached 200.
    if (request.url === "/etag") {
      if (request.headers["if-none-match"] === '"v1"') {
        response.writeHead(304)
        response.end()
        return
      }
      response.writeHead(200, { etag: '"v1"', "cache-control": "no-cache", "content-type": "text/plain" })
      response.end("etag body")
      return
    }
    const crossOrigin = `http://${request.headers.host?.replace(/^[^:]+/, "localhost")}`
    response.setHeader("content-type", "text/html")
    response.end(
      `<!doctype html><html lang="en"><head><title>Browser suite</title><meta name="description" content="Native browser test"><style>body{font:16px sans-serif;padding:20px}input,button,select{margin:6px}#space{height:1400px}</style></head><body><h1>Browser suite</h1><label>Name<input aria-label="Name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply</button><output>Waiting</output><input type="checkbox" aria-label="Remember"><select aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select><input type="file" aria-label="Upload"><button onclick="alert('hello dialog')">Dialog</button><form onsubmit="event.preventDefault();document.querySelector('output').textContent='submitted:'+this.q.value"><input name="q" aria-label="Query"></form><a href="/download">Download</a><a href="/frame" target="_blank">Popup</a><iframe title="Child frame" src="/frame"></iframe><iframe name="scaled" title="Scaled frame" src="/frame" style="transform:scale(0.5);transform-origin:0 0"></iframe><iframe name="outer" title="Nested frame" src="${crossOrigin}/nested"></iframe><input aria-label="Validated" onchange="alert('invalid value')"><input aria-label="After"><input type="date" aria-label="Date"><input type="time" aria-label="Time"><div id="space">Scroll content</div><script>console.log('fixture log'); console.error('fixture error'); fetch('/api/test'); fetch('/missing'); window.heapFixture={value:'heap marker'};</script></body></html>`,
    )
  })
  web.on("upgrade", (request, socket) => {
    socket.on("error", () => socket.destroy())
    const accept = createHash("sha1")
      .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64")
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const message = Buffer.from("rpc websocket proof")
    socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]))
    socket.once("data", () => socket.end(Buffer.from([0x88, 0])))
  })
  await once(web.listen(0, "127.0.0.1"), "listening")
  const address = web.address()
  assert(address && typeof address !== "string")
  const fixture = `http://127.0.0.1:${address.port}`
  const client = OpenCode.make({
    baseUrl: process.env.SMOKE_URL!,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${process.env.SMOKE_PASSWORD}`).toString("base64")}` },
  })
  const location = { directory: process.env.SMOKE_SERVER_FILES! }
  const rpc = client.rpc(Smoke)
  const session = await client.session.create({ title: "Browser suite", location })
  const database = openDatabase(path.join(root, "browser.sqlite"))
  const storage = createStateStore(database.db)
  const pane = createBrowserPane(storage)
  let restored: ReturnType<typeof createBrowserPane> | undefined
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true } })
  const readyToShow = once(win, "ready-to-show")
  await win.loadURL("about:blank")
  await readyToShow
  win.setTitle("Browser suite (isolated test)")
  win.showInactive()
  await win.webContents.executeJavaScript(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))",
  )
  const ipcErrors: string[] = []
  const replaced: string[] = []
  const focusEvents: string[] = []
  const inventories = new Map<string, Browser.State | null>()
  const unbind = await Effect.runPromise(bindIpcEvents(win.webContents.id))
  const events = Effect.runFork(
    ipcEventStream(win.webContents.id).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event._tag !== "BrowserPaneEvent") return
          if (event.event.type === "state") {
            if (event.event.error === "browser.pane.replaced") replaced.push(event.bindingID)
            inventories.set(event.bindingID, event.event.state)
            return
          }
          focusEvents.push(event.event.tabID)
          if (!inventories.get(event.bindingID)?.tabs.some((tab) => tab.id === event.event.tabID))
            ipcErrors.push("Focus arrived before its tab inventory")
          pane.layout(win, event.bindingID, {
            tabID: event.event.tabID,
            visible: true,
            bounds: { x: 0, y: 0, width: 1000, height: 700 },
          })
        }),
      ),
    ),
  )
  const visited = new Set<Browser.Method>()
  async function call<Name extends Browser.Method>(
    name: Name,
    input: Omit<Extract<Browser.Action, { type: Name }>, "type">,
  ): Promise<Output<Name>> {
    console.log(`BROWSER ${name}`)
    const result = await rpc.execute(
      { sessionID: session.id, code: `return await tools.browser.${name}(${JSON.stringify(input)})` },
      { location },
    )
    assert(!result.error, result.output)
    const operation = Browser.Operations.find((operation) => operation.name === name)
    assert(operation)
    visited.add(name)
    return Schema.decodeUnknownSync(operation.output)(JSON.parse(result.output)) as Output<Name>
  }
  async function fails(name: Browser.Method, input: object, expected: RegExp) {
    const result = await rpc.execute(
      { sessionID: session.id, code: `return await tools.browser.${name}(${JSON.stringify(input)})` },
      { location },
    )
    assert.equal(result.error, true, `Expected browser.${name} to fail`)
    assert.match(result.output, expected)
  }
  try {
    await verifyTargets(win, fixture)
    await pane.register(win, "suite", {
      serverKey: "browser-suite",
      sessionID: session.id,
      endpoint: { url: process.env.SMOKE_URL!, password: process.env.SMOKE_PASSWORD },
    })
    const first = await call("tabs.open", { url: fixture })
    const second = await call("tabs.open", { url: `${fixture}/other`, focus: false })
    assert.equal((await call("tabs.list", {})).tabs.length, 2)
    const tabID = first.id
    assert.equal(first.url, fixture + "/")
    const networkProof = await call("evaluate", {
      tabID,
      script: `(async () => ({
        origin: location.origin,
        denied: await fetch('http://localhost:${address.port}/cors-denied').then(() => false, () => true),
        allowed: await fetch('http://localhost:${address.port}/cors-allowed').then(response => response.text()),
        websocket: await new Promise((resolve, reject) => { const socket = new WebSocket('ws://localhost:${address.port}/hmr'); socket.onmessage = event => { resolve(event.data); socket.close(); }; socket.onerror = () => reject(new Error('WebSocket failed')); }),
        cookie: (document.cookie = 'wire=1', await fetch('/api/test?cookie').then(response => response.ok)),
        etag: [await fetch('/etag').then(response => response.status), await fetch('/etag').then(response => response.status)],
        redirect: await fetch('/redirect').then(response => response.text()),
        moved: [await fetch('/moved').then(response => response.status), await fetch('/moved').then(response => response.status)],
        refused: await new Promise((resolve) => { const socket = new WebSocket('ws://127.0.0.1:1/refused'); socket.onerror = () => resolve('refused'); socket.onopen = () => resolve('opened'); }),
      }))()`,
    })
    assert.deepEqual(networkProof.value, {
      origin: fixture,
      denied: true,
      allowed: "cors proof",
      websocket: "rpc websocket proof",
      cookie: true,
      etag: [200, 200],
      redirect: "landed",
      moved: [201, 201],
      refused: "refused",
    })
    const sockets = await call("network.list", { tabID, resourceType: "websocket" })
    const opened = sockets.requests.find((request) => request.url.includes("/hmr"))
    const refused = sockets.requests.find((request) => request.url.includes("/refused"))
    assert.equal(opened?.statusCode, 101, JSON.stringify(sockets))
    assert.equal(opened?.state, "completed")
    assert.equal(refused?.state, "failed", JSON.stringify(refused))
    assert(
      refused?.state === "failed" && refused.durationMs >= 0 && refused.durationMs < 60_000,
      JSON.stringify(refused),
    )
    const chain = await call("network.list", { tabID, urlContains: "/redirect" })
    assert.deepEqual(
      chain.requests.map((request) => [request.url.endsWith("/redirect"), request.statusCode]),
      [
        [true, 302],
        [false, 200],
      ],
      JSON.stringify(chain),
    )
    const hop = await call("network.get", { tabID, id: chain.requests[0].id })
    const landed = await call("network.get", { tabID, id: chain.requests[1].id })
    const names = (headers: { name: string }[]) => headers.map((header) => header.name)
    assert(names(hop.responseHeaders).includes("set-cookie"), JSON.stringify(hop.responseHeaders))
    assert(names(hop.responseHeaders).includes("location"), JSON.stringify(hop.responseHeaders))
    assert(!names(landed.responseHeaders).includes("location"), JSON.stringify(landed.responseHeaders))
    assert(
      hop.responseHeaders.every((header) => header.name !== "set-cookie" || header.value === "<redacted>"),
      JSON.stringify(hop.responseHeaders),
    )
    const moved = await call("network.list", { tabID, urlContains: "/moved" })
    assert.deepEqual(
      moved.requests.map((request) => request.statusCode),
      [301, 201, 301, 201],
      JSON.stringify(moved),
    )
    const cachedHop = await call("network.get", { tabID, id: moved.requests[2].id })
    assert(!names(cachedHop.responseHeaders).includes("x-hop"), JSON.stringify(cachedHop.responseHeaders))
    const revalidated = await call("network.list", { tabID, urlContains: "/etag" })
    assert.deepEqual(
      revalidated.requests.map((request) => request.statusCode),
      [200, 304],
      JSON.stringify(revalidated),
    )
    const withCookie = await call("network.list", { tabID, urlContains: "/api/test?cookie" })
    const cookieDetail = await call("network.get", { tabID, id: withCookie.requests[0].id })
    // The wire header proves the cookie was sent; its value never reaches the model.
    assert(
      cookieDetail.requestHeaders.some((header) => header.name === "cookie" && header.value === "<redacted>"),
      JSON.stringify(cookieDetail.requestHeaders),
    )
    assert(!cookieDetail.requestHeaders.some((header) => header.name !== header.name.toLowerCase()))
    const upload = await rpc.write({ text: "server upload bytes" }, { location })
    await fails("trace.stop", { tabID }, /browser\.trace\.start/)
    await fails("cpu.stop", { tabID }, /browser\.cpu\.start/)
    await fails("evaluate", { tabID, frameID: "missing-frame", script: "1" }, /browser\.frames/)
    await fails("evaluate", { tabID, script: "throw new Error('fixture exception')" }, /Check the script and frameID/)
    await fails("press", { tabID, key: "ControlOrMeta+A" }, /Supported modifiers are Alt, Control, Meta, and Shift/)
    await fails("wait", { tabID, condition: "text" }, /requires non-empty text/)
    await fails("wait", { tabID, condition: "text", text: "not-on-the-page", timeoutMs: 1 }, /check text\/frameID/)
    await fails("files.get", { tabID, fileID: `file_${crypto.randomUUID()}` }, /not a server path or request ID/)
    await call("evaluate", {
      tabID,
      script: `(async () => {
      const radio=document.createElement('input'); radio.type='radio'; radio.checked=true; radio.setAttribute('aria-label','Selected radio'); document.querySelector('select').after(radio);
      const source=document.createElement('div'); source.draggable=true; source.tabIndex=0; source.setAttribute('role','button'); source.textContent='Drag source'; source.ondragstart=e=>e.dataTransfer.setData('text/plain','element dropped'); document.body.prepend(source);
      const drop=document.createElement('div'); drop.tabIndex=0; drop.setAttribute('role','button'); drop.textContent='Drop target'; drop.style.cssText='height:40px;width:300px;background:#ddd'; drop.ondragover=e=>e.preventDefault(); drop.ondrop=async e=>{e.preventDefault();document.querySelector('output').textContent=e.dataTransfer.files.length?await e.dataTransfer.files[0].text():e.dataTransfer.getData('text/plain')}; document.body.prepend(drop);
      await new Promise(resolve=>{const frame=document.querySelector('iframe'); frame.onload=()=>resolve(null); frame.src=${JSON.stringify(`http://localhost:${address.port}/frame`)};});
    })()`,
    })
    pane.layout(win, "suite", { tabID, visible: true, bounds: { x: 0, y: 0, width: 1000, height: 700 } })
    await call("tabs.focus", { tabID: second.id })
    pane.layout(win, "suite", { tabID: second.id, visible: true, bounds: { x: 0, y: 0, width: 1000, height: 700 } })
    const snap = await call("snapshot", { tabID, boxes: true })
    const ref = (text: string) => {
      const match = snap.content
        .split("\n")
        .find((line) => /@e\d+/.test(line) && line.includes(`"${text}"`))
        ?.match(/@e\d+/)?.[0]
      assert(match, `Missing ${text}: ${snap.content}`)
      return Browser.Ref.make(match)
    }
    await call("fill", { tabID, ref: ref("Name"), text: "remote browser" })
    await fails("fill", { tabID, ref: ref("Apply"), text: "wrong target" }, /choose a textbox/)
    await fails("fill", { tabID, ref: ref("Upload"), text: "wrong target" }, /browser\.files\.upload/)
    await fails("check", { tabID, ref: ref("Selected radio"), checked: false }, /Select a different radio/)
    await call("check", { tabID, ref: ref("Selected radio"), checked: true })
    await fails("files.upload", { tabID, ref: ref("Apply"), paths: [upload] }, /choose an input\[type=file\] ref/)
    await fails("select", { tabID, ref: ref("Color"), values: ["missing-option"] }, /values are not visible labels/)
    await fails("click", { tabID, ref: "e999999999" }, /tab's newest snapshot/)
    await fails("screenshot", { tabID, ref: ref("Name"), fullPage: true }, /Remove the other argument/)
    await call("hover", { tabID, ref: ref("Apply") })
    await call("click", { tabID, ref: ref("Apply") })
    assert.equal(
      (await call("evaluate", { tabID, script: "document.querySelector('output').textContent" })).value,
      "remote browser",
    )
    assert.equal(
      (await call("evaluate", { tabID: second.id, script: "document.querySelector('input').value" })).value,
      "",
    )
    assert.equal((await call("tabs.list", {})).focusedTabID, second.id)
    const wrongTab = await rpc.execute(
      {
        sessionID: session.id,
        code: `return await tools.browser.click({tabID:${JSON.stringify(second.id)},ref:${JSON.stringify(ref("Apply"))}})`,
      },
      { location },
    )
    assert(wrongTab.error && wrongTab.output.includes("another tab"))
    await call("check", { tabID, ref: ref("Remember"), checked: true })
    await call("select", { tabID, ref: ref("Color"), values: ["blue"] })
    await call("fill_form", {
      tabID,
      fields: [
        { type: "text", ref: ref("Name"), value: "batch" },
        { type: "check", ref: ref("Remember"), checked: false },
      ],
    })
    await call("press", { tabID, key: "Tab" })
    await call("fill", { tabID, ref: ref("Query"), text: "typed" })
    await call("press", { tabID, key: "Space" })
    await call("press", { tabID, key: "Enter" })
    assert.equal(
      (await call("evaluate", { tabID, script: "document.querySelector('output').textContent" })).value,
      "submitted:typed ",
    )
    await call("scroll", { tabID, deltaY: 100 })
    await call("wait", { tabID, condition: "text", text: "Scroll content" })
    await call("drag", { tabID, from: ref("Drag source"), to: ref("Drop target") })
    assert.equal(
      (await call("evaluate", { tabID, script: "document.querySelector('output').textContent" })).value,
      "element dropped",
    )
    // The first field's change validation alerts while the second takes focus; once the dialog
    // is dismissed the second field must still be untouched.
    await fails(
      "fill_form",
      {
        tabID,
        fields: [
          { type: "text", ref: ref("Validated"), value: "first" },
          { type: "text", ref: ref("After"), value: "late mutation" },
        ],
      },
      /Inspect it with browser\.dialog/,
    )
    await call("dialog", { tabID, action: "dismiss" })
    // Date and time controls take their value directly; keyboard input cannot compose it.
    await call("fill", { tabID, ref: ref("Date"), text: "2026-09-07" })
    await call("fill", { tabID, ref: ref("Time"), text: "14:45" })
    await fails("fill", { tabID, ref: ref("Date"), text: "next week" }, /Use its required format/)
    assert.deepEqual(
      (
        await call("evaluate", {
          tabID,
          script:
            "[...document.querySelectorAll('[aria-label=Validated],[aria-label=After],[type=date],[type=time]')].map(input => input.value)",
        })
      ).value,
      ["first", "", "2026-09-07", "14:45"],
    )
    const frames = await call("frames", { tabID })
    const child = frames.frames.find((frame) => frame.parentID && !frame.name)
    assert(child)
    assert.equal(
      (await call("evaluate", { tabID, frameID: child.id, script: "document.querySelector('button').textContent" }))
        .value,
      "Frame button",
    )
    const childSnapshot = await call("snapshot", { tabID, frameID: child.id })
    const childRef = childSnapshot.content
      .split("\n")
      .find((line) => line.includes('[button] "Frame button"'))
      ?.match(/@e\d+/)?.[0]
    assert(childRef, childSnapshot.content)
    await call("click", { tabID, ref: Browser.Ref.make(childRef) })
    assert.equal(
      (await call("evaluate", { tabID, frameID: child.id, script: "document.querySelector('button').textContent" }))
        .value,
      "Frame clicked",
    )
    const frameButton = (content: string) =>
      Browser.Ref.make(
        content
          .split("\n")
          .find((line) => line.includes('[button] "Frame button"'))
          ?.match(/@e\d+/)?.[0] ?? assert.fail(content),
      )
    // Input coordinates must follow the iframe's CSS transform, not only its offset.
    const scaled = frames.frames.find((frame) => frame.name === "scaled")
    assert(scaled)
    await call("click", { tabID, ref: frameButton((await call("snapshot", { tabID, frameID: scaled.id })).content) })
    assert.equal(
      (await call("evaluate", { tabID, frameID: scaled.id, script: "document.querySelector('button').textContent" }))
        .value,
      "Frame clicked",
    )
    // The inner frame shares its cross-origin parent's renderer, so it has no CDP target of its own.
    const inner = frames.frames.find((frame) => frame.name === "inner")
    assert(inner?.parentID && frames.frames.find((frame) => frame.id === inner.parentID)?.parentID)
    frameButton((await call("snapshot", { tabID, frameID: inner.id })).content)
    const found = await call("find", { tabID, text: "Apply" })
    assert(found.content.includes("Apply"))
    await fails("screenshot", { tabID }, /Screenshot needs a visible tab/)
    await call("tabs.focus", { tabID })
    const screenshot = await call("screenshot", { tabID, fullPage: true, maxWidth: 1000 })
    const screenshotBytes = await rpc.read({ path: screenshot.files[0].path }, { location })
    assert(
      Buffer.from(screenshotBytes, "base64")
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    )
    assert(screenshot.files[0].path.startsWith(process.env.SMOKE_SERVER_FILES!))
    const logs = await call("console", { tabID, level: "debug" })
    assert(logs.messages.some((message) => message.text.includes("fixture error")))
    // Chromium's own report of the failed /missing fetch is a Log entry, not a console call.
    const errors = await call("console", { tabID, level: "error" })
    assert(
      errors.messages.some((message) => message.text.includes("404") && message.source?.url.endsWith("/missing")),
      JSON.stringify(errors),
    )
    const network = await call("network.list", { tabID, urlContains: "/api/test" })
    assert(network.requests.length)
    const detail = await call("network.get", { tabID, id: network.requests[0].id, includeBody: true })
    assert.equal(detail.responseBody.state, "text")
    await fails("network.get", { tabID, id: "unknown-request" }, /Do not reload or resend/)
    const fileSnap = await call("snapshot", { tabID })
    const input = fileSnap.content
      .split("\n")
      .find((line) => line.includes('"Upload"'))
      ?.match(/@e\d+/)?.[0]
    assert(input, fileSnap.content)
    await call("scroll", { tabID, deltaY: 500 })
    const elementImage = await call("screenshot", {
      tabID,
      ref: Browser.Ref.make(input),
      format: "jpeg",
      quality: 70,
      maxWidth: 100,
    })
    const imageBytes = Buffer.from(await rpc.read({ path: elementImage.files[0].path }, { location }), "base64")
    assert.equal(imageBytes[0], 255)
    assert.equal(imageBytes[1], 216)
    assert(nativeImage.createFromBuffer(imageBytes).getSize().width <= 100)
    await call("files.upload", { tabID, ref: Browser.Ref.make(input), paths: [upload] })
    assert.equal(
      (await call("evaluate", { tabID, script: "document.querySelector('input[type=file]').files[0].name" })).value,
      "upload.txt",
    )
    assert.equal(
      (await call("evaluate", { tabID, script: "document.querySelector('input[type=file]').files[0].text()" })).value,
      "server upload bytes",
    )
    // The page reads the temp file's basename as File.name, so spaces and non-ASCII must survive.
    const named = await rpc.write({ text: "q1", name: "Quarter 1 日本語.csv" }, { location })
    await call("files.upload", { tabID, ref: Browser.Ref.make(input), paths: [named] })
    assert.equal(
      (await call("evaluate", { tabID, script: "document.querySelector('input[type=file]').files[0].name" })).value,
      "Quarter 1 日本語.csv",
    )
    const drop = fileSnap.content
      .split("\n")
      .find((line) => line.includes('[button] "Drop target"'))
      ?.match(/@e\d+/)?.[0]
    assert(drop, fileSnap.content)
    await call("files.drop", { tabID, ref: Browser.Ref.make(drop), paths: [upload] })
    await call("wait", { tabID, condition: "text", text: "server upload bytes" })
    await call("evaluate", { tabID, script: "document.querySelector('a[href=\"/download\"]').click()" })
    const downloads = await until(async () => {
      const result = await call("files.list", { tabID })
      return result.files.find((file) => file.name === "report.txt" && file.state === "completed")
    })
    const download = await call("files.get", { tabID, fileID: downloads.id })
    assert.equal(
      Buffer.from(await rpc.read({ path: download.files[0].path }, { location }), "base64").toString(),
      "desktop download bytes",
    )
    await call("evaluate", { tabID, script: "setTimeout(()=>alert('hello dialog'),0); null" })
    await until(async () => (await call("dialog", { tabID, action: "get" })).dialog)
    await fails("evaluate", { tabID, script: "1" }, /Inspect it with browser\.dialog/)
    await call("dialog", { tabID, action: "dismiss" })
    await fails("dialog", { tabID, action: "accept" }, /no JavaScript dialog to handle/)
    await call("evaluate", { tabID, script: "window.open('/frame'); null" })
    await until(async () => (await call("tabs.list", {})).tabs.length === 3)
    await call("navigate", { tabID, url: `${fixture}/next` })
    await call("back", { tabID })
    await call("forward", { tabID })
    await call("trace.start", { tabID, durationMs: 30_000 })
    await fails("trace.start", { tabID }, /browser\.trace\.stop/)
    await fails("trace.start", { tabID: second.id }, /do not stop or replace another tab's recording/)
    await call("reload", { tabID })
    await call("evaluate", {
      tabID,
      script: "performance.mark('browser-suite-marker'); let n=0; for(let i=0;i<100000;i++) n+=i; n",
    })
    const trace = await call("trace.stop", { tabID })
    const traceAnalysis = await call("trace.analyze", { tabID, fileID: trace.files[0].id })
    assert(traceAnalysis.metrics[0].value > 0)
    await call("cpu.start", { tabID })
    await fails("cpu.start", { tabID }, /browser\.cpu\.stop/)
    await call("evaluate", { tabID, script: "Array.from({length:100000},(_,i)=>Math.sqrt(i)).reduce((a,b)=>a+b,0)" })
    const cpu = await call("cpu.stop", { tabID })
    await call("cpu.analyze", { tabID, fileID: cpu.files[0].id })
    const heap = await call("heap.snapshot", { tabID })
    const heapID = heap.files[0].id
    assert((await call("heap.summary", { tabID, fileID: heapID })).nodes > 0)
    const query = await call("heap.query", { tabID, fileID: heapID, name: "Object", limit: 3 })
    assert(query.nodes.length)
    await call("heap.object", { tabID, fileID: heapID, id: query.nodes[0].id })
    await fails(
      "heap.object",
      { tabID, fileID: heapID, id: Number.MAX_SAFE_INTEGER },
      /Object IDs cannot be reused across snapshots/,
    )
    assert.equal((await call("heap.compare", { tabID, before: heapID, after: heapID })).classes.length, 0)
    const audit = await call("lighthouse", { tabID })
    assert(audit.scores.some((score) => score.id === "accessibility"))
    await call("stop", { tabID })
    await call("tabs.close", { tabID: second.id })
    assert.equal((await call("tabs.list", {})).tabs.length, 2)
    assert.deepEqual(
      Browser.Operations.map((operation) => operation.name).filter((name) => !visited.has(name)),
      [],
    )
    assert.deepEqual(ipcErrors, [])
    await pane.register(win, "replacement", {
      serverKey: "browser-suite",
      sessionID: session.id,
      endpoint: { url: process.env.SMOKE_URL!, password: process.env.SMOKE_PASSWORD },
    })
    await until(async () => replaced.includes("suite"))
    await until(async () => {
      const state = await call("tabs.list", {})
      return state.tabs.length === 2 && state.tabs.every((tab) => !tab.loading && tab.url !== "about:blank")
    })
    const saved = await call("tabs.list", {})
    assert.equal(saved.tabs.length, 2)
    await call("evaluate", { tabID, script: "window.restoreOnlyInMemory = true; null" })
    await pane.dispose()
    storage.flush()
    restored = createBrowserPane(storage)
    const focusCount = focusEvents.length
    await restored.register(win, "restored", {
      serverKey: "browser-suite",
      sessionID: session.id,
      endpoint: { url: process.env.SMOKE_URL!, password: process.env.SMOKE_PASSWORD },
    })
    await until(async () => {
      const state = await call("tabs.list", {})
      return (
        state.tabs.length === saved.tabs.length && state.tabs.every((tab) => !tab.loading && tab.url !== "about:blank")
      )
    })
    const reopened = await call("tabs.list", {})
    assert.deepEqual(
      reopened.tabs.map((tab) => ({ id: tab.id, url: tab.url })),
      saved.tabs.map((tab) => ({ id: tab.id, url: tab.url })),
    )
    assert.equal(reopened.focusedTabID, saved.focusedTabID)
    await Promise.all(
      saved.tabs.map(async (tab) => {
        assert.equal((await call("evaluate", { tabID: tab.id, script: "location.href" })).value, tab.url)
      }),
    )
    assert.equal((await call("evaluate", { tabID, script: "typeof window.restoreOnlyInMemory" })).value, "undefined")
    assert.equal(focusEvents.length, focusCount, "Restoring URLs must not select Browser over the saved pane tab")
    console.log(
      `PASS ${visited.size} browser operations over physical authenticated HTTP, including file bytes in both directions`,
    )
  } finally {
    await restored?.dispose()
    await pane.dispose()
    storage.close()
    database.close()
    await Effect.runPromise(Fiber.interrupt(events))
    await Effect.runPromise(unbind)
    win.destroy()
    web.closeAllConnections()
    await new Promise<void>((resolve) => web.close(() => resolve()))
    app.quit()
  }
}

async function until<T>(read: () => Promise<T>) {
  const deadline = Date.now() + 10_000
  while (true) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("Condition timed out")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})
