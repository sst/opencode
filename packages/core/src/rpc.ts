export * as Rpc from "./rpc.js"
export { define } from "@opencode/schema/rpc"
export type { Definition, EventPayload, Failure } from "@opencode/schema/rpc"

import type { RpcClient, RpcDomain, RpcHandlers } from "@opencode/plugin/effect/rpc"
import type { Rpc } from "@opencode/schema/rpc"
import { Event } from "@opencode/schema/event"
import type { Tool } from "@opencode/schema/tool"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Deferred, Effect, JsonSchema, Layer, Schema, SchemaRepresentation, Stream } from "effect"
import { Bus } from "./bus.js"
import { Location } from "./location.js"
import { optional, statics } from "./schema.js"

export interface Interface {
  readonly register: RpcDomain["register"]
  readonly client: <D extends Rpc.Definition>(definition: D) => RpcClient<D, Rpc.SystemError, never, unknown>
  readonly call: (rpcID: string, method: string, input: unknown) => Effect.Effect<unknown, Rpc.Failure>
  readonly close: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Rpc") {}

class DeclaredError extends Error {
  constructor(
    readonly type: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const ref = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
    const closed = yield* Deferred.make<void>()
    const callContext = {
      error: (type: string, message: string, data?: unknown) => new DeclaredError(type, message, data),
    }
    const registrations = new Map<
      string,
      Array<{
        readonly definition: Rpc.Definition
        readonly handlers: Readonly<Record<string, Function>>
      }>
    >()
    const definitions = new WeakMap<
      Rpc.Definition,
      ReadonlyMap<string, { readonly event: Rpc.EventDefinition; readonly definition: Event.Definition }>
    >()
    const eventsFor = (definition: Rpc.Definition) => {
      const existing = definitions.get(definition)
      if (existing) return existing
      const events = new Map(
        Object.entries(definition.events).map(([name, event]) => [
          name,
          { event, definition: eventDefinition(definition, name) },
        ]),
      )
      definitions.set(definition, events)
      return events
    }

    const register = Effect.fn("Rpc.register")(function* <const D extends Rpc.Definition>(
      definition: D,
      handlers: RpcHandlers<NoInfer<D>>,
    ) {
      const entry = { definition, handlers }
      const dispose = Effect.sync(() => {
        const remaining = (registrations.get(definition.id) ?? []).filter((candidate) => candidate !== entry)
        if (remaining.length === 0) {
          registrations.delete(definition.id)
          return
        }
        registrations.set(definition.id, remaining)
      })
      yield* Effect.acquireRelease(
        Effect.sync(() => registrations.set(definition.id, [...(registrations.get(definition.id) ?? []), entry])),
        () => dispose,
      )

      const events = eventsFor(definition)
      return {
        dispose,
        events: {
          emit: Effect.fn("Rpc.emit")(function* (...args: Rpc.EventInput<D>) {
            const registered = events.get(args[0])
            if (!registered) return yield* Effect.fail(new Error(`Unknown RPC event: ${definition.id}.${args[0]}`))
            const event = registered.event
            // SAFETY: The public event-schema contract guarantees an object encoded/output type.
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
            const data = (yield* encode(event.schema, args[1])) as Readonly<Record<string, unknown>>
            return yield* bus
              .publish(registered.definition, data, {
                location: Location.Ref.make({ directory: ref.directory, workspaceID: ref.workspaceID }),
              })
              .pipe(Effect.asVoid)
          }),
        },
      }
    })

    const call = Effect.fn("Rpc.call")(function* (rpcID: string, name: string, input: unknown) {
      if (yield* Deferred.isDone(closed))
        return yield* Effect.fail(failure("rpc.unavailable", `RPC is unavailable: ${rpcID}`))
      const entry = registrations.get(rpcID)?.at(-1)
      if (!entry) return yield* Effect.fail(failure("rpc.unavailable", `RPC is unavailable: ${rpcID}`))
      if (!Object.hasOwn(entry.definition.methods, name) || !Object.hasOwn(entry.handlers, name))
        return yield* Effect.fail(failure("rpc.method_not_found", `Unknown RPC method: ${rpcID}.${name}`))
      const method = entry.definition.methods[name]
      const handler = entry.handlers[name]
      const parsed = yield* parse(method.input, input).pipe(
        Effect.mapError((error) => failure("rpc.invalid_input", errorMessage(error, "Invalid RPC input"))),
      )
      const result = yield* Effect.suspend(() => {
        // The heterogeneous registry erases handlers after their selected schema validates input.
        const execution: Effect.Effect<unknown, unknown> = Reflect.apply(handler, undefined, [parsed, callContext])
        return execution
      }).pipe(
        Effect.catch((error) => encodeError(method, error)),
        // Normalize handler bugs here so direct callers can recover just like HTTP callers.
        Effect.catchDefect((defect) =>
          Effect.logError("rpc handler failed", { rpc: rpcID, method: name, defect }).pipe(
            Effect.andThen(Effect.fail(failure("rpc.internal", "RPC call failed"))),
          ),
        ),
        // A long-lived RPC must release its location when the routing cache invalidates it.
        Effect.raceFirst(
          Deferred.await(closed).pipe(
            Effect.andThen(Effect.fail(failure("rpc.unavailable", `RPC is unavailable: ${rpcID}`))),
          ),
        ),
      )
      return yield* encode(method.output, result).pipe(
        Effect.mapError((error) => failure("rpc.invalid_output", errorMessage(error, "Invalid RPC output"))),
      )
    })

    const client = <D extends Rpc.Definition>(definition: D): RpcClient<D, Rpc.SystemError, never, unknown> => {
      const events = eventsFor(definition)
      const methods = Object.fromEntries(
        Object.entries(definition.methods).map(([name, method]) => [
          name,
          (input: unknown) =>
            call(definition.id, name, input).pipe(
              Effect.catch((error) => decodeError(method, error)),
              Effect.flatMap((value) => read(method.output, value).pipe(Effect.catch((cause) => Effect.die(cause)))),
            ),
        ]),
      )
      // SAFETY: Every runtime key comes from this definition, and each method delegates through its corresponding schema.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      return {
        ...methods,
        events: {
          subscribe: <Name extends keyof D["events"] & string>(name: Name) => {
            const registered = events.get(name)
            if (!registered) return Stream.fail(new Error(`Unknown RPC event: ${definition.id}.${name}`))
            return bus.subscribe(registered.definition).pipe(
              Stream.provideService(Location.Service, location),
              Stream.mapEffect((payload) => logicalEvent(definition, name, payload, ref)),
            )
          },
        },
      } as RpcClient<D, Rpc.SystemError, never, unknown>
    }

    return Service.of({ register, call, client, close: Deferred.succeed(closed, undefined).pipe(Effect.asVoid) })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Location.node] })

const fields = {
  id: Event.ID,
  created: Schema.Finite,
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
  location: optional(Location.Ref),
}
const EventData = Schema.Record(Schema.String, Schema.Unknown)
const jsonSchemas = new WeakMap<JsonSchema.JsonSchema, Schema.Codec<unknown>>()

function eventType<const D extends Rpc.Definition, const Name extends keyof D["events"] & string>(
  definition: D,
  name: Name,
): `rpc.${D["id"]}.${Name}` {
  return `rpc.${definition.id}.${name}`
}

function eventDefinition(definition: Rpc.Definition, name: string): Event.Definition {
  const type = eventType(definition, name)
  const data = EventData
  return Schema.Struct({ ...fields, type: Schema.Literal(type), data }).pipe(
    statics(() => ({ type, durability: "ephemeral" as const, durable: undefined, data })),
  ) satisfies Event.EphemeralDefinition<string, typeof data>
}

function parse(schema: Tool.ValueSchema, value: unknown): Effect.Effect<unknown, unknown> {
  if (Schema.isSchema(schema)) return Schema.decodeUnknownEffect(schema)(value)
  if (isStandardSchema(schema)) {
    return Effect.gen(function* () {
      const parsed = yield* Effect.try({ try: () => schema["~standard"].validate(value), catch: (cause) => cause })
      const result =
        parsed instanceof Promise ? yield* Effect.tryPromise({ try: () => parsed, catch: (cause) => cause }) : parsed
      if (result.issues) return yield* Effect.fail(new Error(result.issues.map((issue) => issue.message).join("\n")))
      return result.value
    })
  }
  return Effect.try({
    try: () => {
      const existing = jsonSchemas.get(schema)
      if (existing) return existing
      const codec = Schema.make<Schema.Codec<unknown>>(
        SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(schema)).ast,
      )
      jsonSchemas.set(schema, codec)
      return codec
    },
    catch: (cause) => cause,
  }).pipe(Effect.flatMap((codec) => Schema.decodeUnknownEffect(codec)(value)))
}

function encode(schema: Tool.ValueSchema, value: unknown): Effect.Effect<unknown, unknown> {
  return Schema.isSchema(schema) ? Schema.encodeUnknownEffect(schema)(value) : parse(schema, value)
}

function encodeError(method: Rpc.Method, error: unknown): Effect.Effect<never, Rpc.Failure> {
  if (!(error instanceof DeclaredError)) return Effect.die(error)
  if (!method.errors || !Object.hasOwn(method.errors, error.type)) {
    return Effect.die(new Error(`Undeclared RPC error: ${error.type}`))
  }
  return encode(method.errors[error.type], error.data).pipe(
    Effect.catch((cause) => Effect.die(cause)),
    Effect.flatMap((data) => Effect.fail(failure(error.type, error.message, data))),
  )
}

function decodeError(method: Rpc.Method, error: Rpc.Failure): Effect.Effect<never, Rpc.Failure> {
  if (!method.errors || !Object.hasOwn(method.errors, error.type)) return Effect.fail(error)
  return read(method.errors[error.type], error.data).pipe(
    Effect.catch((cause) => Effect.die(cause)),
    Effect.flatMap((data) => Effect.fail(failure(error.type, error.message, data))),
  )
}

function failure(type: string, message: string, data?: unknown): Rpc.Failure {
  return data === undefined ? { type, message } : { type, message, data }
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return fallback
}

function isStandardSchema(schema: Tool.ValueSchema): schema is Extract<Tool.ValueSchema, StandardSchemaV1> {
  return "~standard" in schema
}

function read(schema: Tool.ValueSchema, value: unknown): Effect.Effect<unknown, unknown> {
  // Standard Schema results were already parsed by the publisher; don't apply transforms twice.
  return Schema.isSchema(schema) ? Schema.decodeUnknownEffect(schema)(value) : Effect.succeed(value)
}

const logicalEvent = Effect.fn("Rpc.logicalEvent")(function* <
  D extends Rpc.Definition,
  Name extends keyof D["events"] & string,
>(
  definition: D,
  name: Name,
  payload: Event.Payload,
  ref: Location.Ref,
): Effect.fn.Return<Rpc.EventPayload<D, Name>, unknown> {
  const event = definition.events[name]
  const data = yield* read(event.schema, payload.data)
  // SAFETY: The private Bus definition owns the envelope and location.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return {
    ...payload,
    type: eventType(definition, name),
    data,
    location: Location.Ref.make({ directory: ref.directory, workspaceID: ref.workspaceID }),
  } as Rpc.EventPayload<D, Name>
})
