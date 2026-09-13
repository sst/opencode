import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { LocationServiceMap } from "../../../core/src/location-services"
import { Location } from "../../../core/src/location"
import { AbsolutePath } from "../../../core/src/schema"
import { createRoutes } from "../../../server/src/routes"

const stopped = Promise.withResolvers<void>()
process.on("message", (message) => {
  if (message === "stop") stopped.resolve()
})
await Effect.gen(function* () {
  const context = yield* Layer.build(
    createRoutes({
      password: process.env.SMOKE_PASSWORD,
      app: { name: "browser-idle-test", version: "test", channel: "test" },
      database: { path: ":memory:" },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
      config: {
        directory: process.env.OPENCODE_CONFIG_DIR!,
        project: false,
        content: JSON.stringify({
          plugins: ["-opencode.provider.*", path.join(import.meta.dir, "plugin")],
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
        }),
      },
    }).pipe(Layer.provide(HttpServer.layerServices)),
  )
  const locations = Context.get(context, LocationServiceMap.Service)
  const handler = Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(HttpEffect.toWebHandlerWith(context))
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/__test/evict") return handler(request)
      if (
        request.method !== "POST" ||
        request.headers.get("authorization") !== `Basic ${btoa(`opencode:${process.env.SMOKE_PASSWORD}`)}`
      )
        return new Response(null, { status: 401 })
      await Effect.runPromise(
        locations.invalidate(Location.Ref.make({ directory: AbsolutePath.make(process.env.SMOKE_SERVER_FILES!) })),
      )
      return new Response(null, { status: 204 })
    },
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
  process.send?.(server.url.href)
  yield* Effect.promise(() => stopped.promise)
}).pipe(Effect.scoped, Effect.runPromise)
process.disconnect?.()
