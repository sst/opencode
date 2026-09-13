import type { BlockStatement, Expression, Pattern } from "acorn"
import type { Effect, Fiber } from "effect"
import { type AstNode, AsyncIteratorSymbol, type Binding, type GeneratorRequestKind, IteratorSymbol } from "./model.js"

/** Property attributes, as in a JS property descriptor. */
export type Attributes = {
  readonly writable: boolean
  readonly enumerable: boolean
  readonly configurable: boolean
}

export type Getter = (receiver: unknown) => unknown
export type Setter = (receiver: unknown, value: unknown) => void

/** One own property: a data slot or a native accessor pair. */
export type Slot =
  | { value: unknown; writable: boolean; enumerable: boolean; configurable: boolean }
  | { get: Getter | undefined; set: Setter | undefined; enumerable: boolean; configurable: boolean }

/** Ordinary assignment: writable, enumerable, configurable. */
export const data: Attributes = { writable: true, enumerable: true, configurable: true }
/** Built-in methods and `constructor`: writable and configurable but hidden from enumeration. */
export const hidden: Attributes = { writable: true, enumerable: false, configurable: true }
/** Function `name` and `length`: read-only but deletable. */
export const readonly: Attributes = { writable: false, enumerable: false, configurable: true }
/** Constants such as `Math.PI` and a constructor's `prototype`. */
export const frozen: Attributes = { writable: false, enumerable: false, configurable: false }

/** An object owned by the program: own properties plus a prototype link. */
export class ProgramObject {
  readonly props = new Map<string | symbol, Slot>()
  constructor(public proto: ProgramObject | null) {}
}

export class ProgramArray extends ProgramObject {
  constructor(
    proto: ProgramObject,
    readonly items: Array<unknown> = [],
  ) {
    super(proto)
  }
}

/** An object with the [[ErrorData]] slot: what `Error.prototype.toString` and the host boundary recognize as an error. */
export class ProgramError extends ProgramObject {}

export abstract class Callable extends ProgramObject {
  constructor(proto: ProgramObject, name: string, length: number) {
    super(proto)
    define(this, "length", length, readonly)
    define(this, "name", name, readonly)
  }
}

export class ProgramFunction extends Callable {
  constructor(
    proto: ProgramObject,
    name: string,
    readonly parameters: ReadonlyArray<Pattern>,
    readonly body: BlockStatement | Expression,
    readonly capturedScopes: ReadonlyArray<Map<string, Binding>>,
    readonly async: boolean,
    readonly generator: boolean,
  ) {
    const optional = parameters.findIndex((p) => p.type === "AssignmentPattern" || p.type === "RestElement")
    super(proto, name, optional === -1 ? parameters.length : optional)
  }
}

export type NativeCall<R> = (
  thisValue: unknown,
  args: Array<unknown>,
  node: AstNode,
) => Effect.Effect<unknown, unknown, R>
export type NativeConstruct<R> = (
  args: Array<unknown>,
  newTarget: Callable,
  node: AstNode,
) => Effect.Effect<unknown, unknown, R>

export type NativeOptions<R> = {
  readonly name: string
  readonly length?: number
  readonly call: NativeCall<R>
  /** `new name(...)`; without it the function is not a constructor. */
  readonly construct?: NativeConstruct<R>
  /** Whether callback sites (array methods, replacers, promise reactions) admit this function. Defaults to true. */
  readonly callback?: boolean
}

export class NativeFunction<R = never> extends Callable {
  readonly call: NativeCall<R>
  readonly construct: NativeConstruct<R> | undefined
  readonly callback: boolean

  constructor(proto: ProgramObject, options: NativeOptions<R>) {
    super(proto, options.name, options.length ?? 0)
    this.call = options.call
    this.construct = options.construct
    this.callback = options.callback ?? true
  }
}

export class ProgramPromise extends ProgramObject {
  constructor(
    proto: ProgramObject,
    readonly fiber: Fiber.Fiber<unknown, unknown>,
  ) {
    super(proto)
  }
}

export class ProgramGenerator extends ProgramObject {
  constructor(
    proto: ProgramObject,
    readonly asynchronous: boolean,
    readonly request: (
      kind: GeneratorRequestKind,
      value: unknown,
      node: AstNode,
    ) => Effect.Effect<unknown, unknown, unknown>,
  ) {
    super(proto)
  }
}

export class ProgramDate extends ProgramObject {
  constructor(
    proto: ProgramObject,
    public time: number,
  ) {
    super(proto)
  }
}

export class ProgramRegExp extends ProgramObject {
  readonly regex: RegExp
  constructor(proto: ProgramObject, pattern: string, flags: string) {
    super(proto)
    this.regex = new RegExp(pattern, flags)
    define(this, "lastIndex", 0, { writable: true, enumerable: false, configurable: false })
  }
}

export class ProgramMap extends ProgramObject {
  readonly map = new Map<unknown, unknown>()
}

export class ProgramSet extends ProgramObject {
  readonly set = new Set<unknown>()
}

export class ProgramURLSearchParams extends ProgramObject {
  constructor(
    proto: ProgramObject,
    readonly params: URLSearchParams,
  ) {
    super(proto)
  }
}

export class ProgramURL extends ProgramObject {
  readonly searchParams: ProgramURLSearchParams
  constructor(
    proto: ProgramObject,
    searchParamsProto: ProgramObject,
    readonly url: URL,
  ) {
    super(proto)
    this.searchParams = new ProgramURLSearchParams(searchParamsProto, url.searchParams)
  }
}

/** Built-in objects that wrap a host value; data-like, but never plain data. */
export const isWrapper = (
  value: unknown,
): value is ProgramDate | ProgramRegExp | ProgramMap | ProgramSet | ProgramURL | ProgramURLSearchParams =>
  value instanceof ProgramDate ||
  value instanceof ProgramRegExp ||
  value instanceof ProgramMap ||
  value instanceof ProgramSet ||
  value instanceof ProgramURL ||
  value instanceof ProgramURLSearchParams

const MAX_ARRAY_LENGTH = 4_294_967_295

export const parseArrayIndex = (key: string | number): number | undefined => {
  const property = String(key)
  if (!/^(0|[1-9]\d*)$/.test(property)) return undefined
  const index = Number(property)
  return index < MAX_ARRAY_LENGTH ? index : undefined
}

const canonical = (key: PropertyKey): string | symbol => (typeof key === "symbol" ? key : String(key))

const index = (target: ProgramObject, key: string | symbol): number | undefined =>
  target instanceof ProgramArray && typeof key === "string" ? parseArrayIndex(key) : undefined

/** The own property under `key`, including an array's live indexes and `length`. */
export const own = (target: ProgramObject, key: PropertyKey): Slot | undefined => {
  const name = canonical(key)
  if (target instanceof ProgramArray) {
    const at = index(target, name)
    if (at !== undefined) {
      return at in target.items ? { value: target.items[at], ...data } : undefined
    }
    if (name === "length") return { value: target.items.length, writable: true, enumerable: false, configurable: false }
  }
  return target.props.get(name)
}

const read = (slot: Slot, receiver: unknown): unknown =>
  "value" in slot ? slot.value : slot.get === undefined ? undefined : slot.get(receiver)

export const hasOwn = (target: ProgramObject, key: PropertyKey): boolean => own(target, key) !== undefined

export const getOwn = (target: ProgramObject, key: PropertyKey): unknown => {
  const slot = own(target, key)
  return slot === undefined ? undefined : read(slot, target)
}

/** [[Get]]: walks the prototype chain; accessors see `receiver`, which is the primitive for wrapper prototypes. */
export const get = (target: ProgramObject, key: PropertyKey, receiver: unknown = target): unknown => {
  for (let current: ProgramObject | null = target; current !== null; current = current.proto) {
    const slot = own(current, key)
    if (slot !== undefined) return read(slot, receiver)
  }
  return undefined
}

export const has = (target: ProgramObject, key: PropertyKey): boolean => {
  for (let current: ProgramObject | null = target; current !== null; current = current.proto) {
    if (own(current, key) !== undefined) return true
  }
  return false
}

export const hasPrototype = (value: unknown, proto: ProgramObject): boolean => {
  for (let current = value instanceof ProgramObject ? value.proto : null; current !== null; current = current.proto) {
    if (current === proto) return true
  }
  return false
}

const writeArray = (target: ProgramArray, name: string | symbol, value: unknown): boolean | undefined => {
  const at = index(target, name)
  if (at !== undefined) {
    target.items[at] = value
    return true
  }
  if (name !== "length") return undefined
  const length = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH) return false
  target.items.length = length
  return true
}

/** [[Set]]: an inherited setter or read-only property decides before an own data property is created. */
export const set = (target: ProgramObject, key: PropertyKey, value: unknown): boolean => {
  const name = canonical(key)
  for (let current: ProgramObject | null = target; current !== null; current = current.proto) {
    const slot = own(current, name)
    if (slot === undefined) continue
    if (!("value" in slot)) {
      if (slot.set === undefined) return false
      slot.set(target, value)
      return true
    }
    if (!slot.writable) return false
    if (current !== target) break
    if (target instanceof ProgramArray) {
      const written = writeArray(target, name, value)
      if (written !== undefined) return written
    }
    slot.value = value
    return true
  }
  if (target instanceof ProgramArray) {
    const written = writeArray(target, name, value)
    if (written !== undefined) return written
  }
  target.props.set(name, { value, ...data })
  return true
}

/** [[DefineOwnProperty]] for a data property, ignoring the chain. */
export const define = (target: ProgramObject, key: PropertyKey, value: unknown, attrs: Attributes = data): void => {
  const name = canonical(key)
  if (target instanceof ProgramArray && writeArray(target, name, value) !== undefined) return
  target.props.set(name, { value, ...attrs })
}

export const defineAccessor = (target: ProgramObject, key: PropertyKey, get: Getter, set?: Setter): void => {
  target.props.set(canonical(key), { get, set, enumerable: false, configurable: true })
}

export const remove = (target: ProgramObject, key: PropertyKey): boolean => {
  const name = canonical(key)
  if (target instanceof ProgramArray) {
    const at = index(target, name)
    if (at !== undefined) return delete target.items[at]
    if (name === "length") return false
  }
  const slot = target.props.get(name)
  if (slot === undefined) return true
  if (!slot.configurable) return false
  target.props.delete(name)
  return true
}

// JS order: array indexes, integer-like keys ascending, other strings, then symbols.
export const ownKeys = (target: ProgramObject): Array<string | symbol> => {
  const strings = [...target.props.keys()].filter((key): key is string => typeof key === "string")
  const symbols = [...target.props.keys()].filter((key): key is symbol => typeof key === "symbol")
  return [
    ...(target instanceof ProgramArray ? [...Object.keys(target.items), "length"] : []),
    ...strings.filter((key) => parseArrayIndex(key) !== undefined).sort((a, b) => Number(a) - Number(b)),
    ...strings.filter((key) => parseArrayIndex(key) === undefined),
    ...symbols,
  ]
}

const enumerable = (target: ProgramObject, key: string | symbol): boolean => own(target, key)?.enumerable === true

/** Own enumerable keys, including the iterator symbols; what spread and `Object.assign` copy. */
export const enumerableKeys = (target: ProgramObject): Array<string | symbol> =>
  ownKeys(target).filter(
    (key) =>
      (typeof key === "string" || key === IteratorSymbol || key === AsyncIteratorSymbol) && enumerable(target, key),
  )

/** Own enumerable string keys: `Object.keys`. */
export const keys = (target: ProgramObject): Array<string> =>
  ownKeys(target).filter((key): key is string => typeof key === "string" && enumerable(target, key))

/** Own enumerable string entries: `Object.entries` and serialization. */
export const entries = (target: ProgramObject): Array<[string, unknown]> =>
  keys(target).map((key) => [key, getOwn(target, key)])

export const record = (proto: ProgramObject, fields: Record<string, unknown>): ProgramObject => {
  const target = new ProgramObject(proto)
  for (const [key, value] of Object.entries(fields)) define(target, key, value)
  return target
}

export const assign = (target: ProgramObject, source: ProgramObject, skip?: ReadonlySet<PropertyKey>): void => {
  for (const key of enumerableKeys(source)) {
    if (skip?.has(key)) continue
    set(target, key, getOwn(source, key))
  }
}
