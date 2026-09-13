import { Effect } from "effect"
import { fn, type Method, methods, receiver } from "./native.js"
import { type AstNode, AsyncIteratorSymbol, type GeneratorRequestKind, IteratorSymbol } from "./model.js"
import { define, hidden, ProgramGenerator } from "./objects.js"
import type { PromiseRuntime } from "./promises.js"
import type { Runner } from "./runner.js"

/** `next`/`return`/`throw` on the generator prototypes; async generators answer with promises. */
export const generatorGlobals = <R>(runner: Runner<R>, promises: PromiseRuntime<R>): void => {
  const protos = runner.prototypes
  const install = (asynchronous: boolean) => {
    const proto = asynchronous ? protos.AsyncGenerator : protos.Generator
    const label = asynchronous ? "AsyncGenerator" : "Generator"
    const request = (kind: GeneratorRequestKind): Method => [
      kind,
      1,
      (thisValue: unknown, args: Array<unknown>, node: AstNode) => {
        const generator = receiver(ProgramGenerator, thisValue, `${label}.prototype.${kind}`, node)
        const requested = generator.request(kind, args[0], node) as Effect.Effect<unknown, unknown, R>
        return generator.asynchronous ? promises.create(requested) : requested
      },
    ]
    methods(protos, proto, [request("next"), request("return"), request("throw")])
    define(
      asynchronous ? protos.AsyncIterator : protos.Iterator,
      asynchronous ? AsyncIteratorSymbol : IteratorSymbol,
      fn(protos, asynchronous ? "[Symbol.asyncIterator]" : "[Symbol.iterator]", 0, (thisValue) => thisValue),
      hidden,
    )
  }
  install(false)
  install(true)
}
