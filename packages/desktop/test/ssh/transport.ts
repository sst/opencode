import { file, serve } from "bun"

// Process-level SSH fixture: discovery reads a fixture registration,
// and forwarding stays alive independently of the remote HTTP server.
const [registration, ...args] = process.argv.slice(2)
if (!registration) throw new Error("Missing fixture registration")
if (args.includes("-G")) {
  console.log("hostname fixture\nuser fixture\nport 22")
  process.exit(0)
}
if (args.includes("-O")) process.exit(0)
const forward = args[args.indexOf("-L") + 1]
if (args.includes("-L") && forward) {
  const [, port, host, remotePort] = forward.split(":")
  const server = serve({
    hostname: "127.0.0.1",
    port: Number(port),
    fetch: (request) => fetch(new Request(`http://${host}:${remotePort}${new URL(request.url).pathname}`, request)),
    error: () => new Response(null, { status: 502 }),
  })
  await Bun.stdin.text()
  await server.stop(true)
  process.exit(0)
}
await Bun.stdin.text()
const info = await file(registration).json()
console.log(
  `OPENCODE_SSH_STATUS=${info.url}\nOPENCODE_SSH_REGISTRATION_BEGIN\n${JSON.stringify(info)}\nOPENCODE_SSH_REGISTRATION_END`,
)
