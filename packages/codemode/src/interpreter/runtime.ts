import type {
  ArrayExpression,
  ArrayPattern,
  AssignmentPattern,
  ArrowFunctionExpression,
  AssignmentExpression,
  AssignmentProperty,
  BinaryExpression,
  BlockStatement,
  BreakStatement,
  CallExpression,
  ConditionalExpression,
  ContinueStatement,
  DoWhileStatement,
  Expression,
  ForInStatement,
  ForOfStatement,
  ForStatement,
  FunctionDeclaration,
  FunctionExpression,
  IfStatement,
  LabeledStatement,
  LogicalExpression,
  MemberExpression,
  ModuleDeclaration,
  NewExpression,
  ObjectExpression,
  Pattern,
  Program,
  Property,
  SpreadElement,
  Statement,
  Super,
  SwitchStatement,
  TemplateLiteral,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VariableDeclaration,
  WhileStatement,
  YieldExpression,
} from "acorn"
import { Cause, Deferred, Effect, Exit } from "effect"
import { toProgram } from "../data.js"
import { ToolReference } from "../tool-runtime.js"
import {
  type AstNode,
  AsyncIteratorSymbol,
  type Binding,
  type GeneratorRequestKind,
  GeneratorReturn,
  InterpreterRuntimeError,
  IteratorSymbol,
  locate,
  OptionalShortCircuit,
  ProgramThrow,
  rangeError,
  type StatementResult,
  unsupportedSyntax,
} from "./model.js"
import { caughtErrorValue } from "./errors.js"
import type { Prototypes } from "./intrinsics.js"
import { globals, type Host } from "./globals.js"
import {
  assign,
  Callable,
  define,
  get,
  has,
  hasPrototype,
  keys,
  NativeFunction,
  parseArrayIndex,
  ProgramArray,
  ProgramDate,
  ProgramFunction,
  ProgramGenerator,
  ProgramMap,
  ProgramObject,
  ProgramPromise,
  ProgramSet,
  ProgramURLSearchParams,
  record,
  remove,
  set,
} from "./objects.js"
import { preserveConsumerError, type Runner } from "./runner.js"
import { PromiseRuntime, resolvePromise, resolvePromiseValue } from "./promises.js"
import { containsOpaqueReference, describeValue, rejectCircularInsertion, typeofValue } from "./references.js"
import { ScopeStack } from "./scope.js"
import { constructRegExp } from "../stdlib/regexp.js"
import { enumerableSource } from "../stdlib/object.js"
import { coerceToNumber, coerceToString, compoundOperators } from "../stdlib/value.js"

// What a loop does with its body's result: exit with a StatementResult, or undefined to keep iterating.
// Unlabelled break ends this loop; a label the loop does not carry propagates outward.
const loopExit = (result: StatementResult, labels: ReadonlySet<string> | undefined): StatementResult | undefined => {
  if (result.kind === "return") return result
  if (result.kind === "break") {
    if (result.label !== undefined && !labels?.has(result.label)) return result
    return { kind: "none" }
  }
  if (result.kind === "continue" && result.label !== undefined && !labels?.has(result.label)) return result
  return undefined
}

const calleeDescription = (callee: Expression | Super | undefined): string => {
  if (callee?.type === "Identifier") return callee.name
  if (callee?.type === "MemberExpression") {
    const object = callee.object
    const property = callee.property
    const key =
      !callee.computed && property.type === "Identifier"
        ? property.name
        : property.type === "Literal" && typeof property.value === "string"
          ? property.value
          : undefined
    if (object.type === "Identifier" && key !== undefined) return `${object.name}.${key}`
  }
  return "The called value"
}

// OrdinaryHasInstance: walk the left operand's chain looking for the constructor's `prototype`.
const instanceofValue = (lhs: unknown, rhs: unknown, node: AstNode): boolean => {
  if (!(rhs instanceof Callable)) {
    throw new InterpreterRuntimeError("The right-hand side of 'instanceof' is not callable.", node)
  }
  const prototype = get(rhs, "prototype")
  if (!(prototype instanceof ProgramObject)) {
    throw new InterpreterRuntimeError("The right-hand side of 'instanceof' has no 'prototype' object.", node)
  }
  return hasPrototype(lhs, prototype)
}

const collectPatternNames = (pattern: Pattern, out: Array<string> = []): Array<string> => {
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name)
      break
    case "AssignmentPattern":
      collectPatternNames(pattern.left, out)
      break
    case "RestElement":
      collectPatternNames(pattern.argument, out)
      break
    case "ArrayPattern":
      for (const element of pattern.elements) {
        if (element !== null) collectPatternNames(element, out)
      }
      break
    case "ObjectPattern":
      for (const prop of pattern.properties) {
        collectPatternNames(prop.type === "RestElement" ? prop.argument : prop.value, out)
      }
      break
  }
  return out
}

// `var` names declared anywhere in a function body except inside nested functions, which own theirs.
// Memoized per body: a function's var names never change, and hoisting runs on every call.
const varNames = new WeakMap<ReadonlyArray<Statement | ModuleDeclaration>, ReadonlyArray<string>>()
const collectVarNames = (
  node: Statement | ModuleDeclaration | null | undefined,
  out: Array<string> = [],
): Array<string> => {
  if (!node) return out
  switch (node.type) {
    case "VariableDeclaration":
      if (node.kind === "var") for (const declaration of node.declarations) collectPatternNames(declaration.id, out)
      break
    case "BlockStatement":
      for (const statement of node.body) collectVarNames(statement, out)
      break
    case "IfStatement":
      collectVarNames(node.consequent, out)
      collectVarNames(node.alternate, out)
      break
    case "ForStatement":
      if (node.init?.type === "VariableDeclaration") collectVarNames(node.init, out)
      collectVarNames(node.body, out)
      break
    case "ForInStatement":
    case "ForOfStatement":
      if (node.left.type === "VariableDeclaration") collectVarNames(node.left, out)
      collectVarNames(node.body, out)
      break
    case "WhileStatement":
    case "DoWhileStatement":
    case "LabeledStatement":
      collectVarNames(node.body, out)
      break
    case "SwitchStatement":
      for (const item of node.cases) for (const statement of item.consequent) collectVarNames(statement, out)
      break
    case "TryStatement":
      collectVarNames(node.block, out)
      collectVarNames(node.handler?.body, out)
      collectVarNames(node.finalizer, out)
      break
  }
  return out
}

const loopDeclaration = (left: VariableDeclaration | Pattern, statement: "for...of" | "for...in") => {
  if (left.type !== "VariableDeclaration") return undefined
  const declaration = left.declarations.length === 1 ? left.declarations[0] : undefined
  if (declaration === undefined) {
    throw new InterpreterRuntimeError(`${statement} supports one declared binding.`, left)
  }
  const kind = left.kind
  return {
    pattern: declaration.id,
    mutable: kind !== "const",
    lexical: kind !== "var",
  }
}

type CustomIterator = {
  iterator: ProgramObject
  next: unknown
  asynchronous: boolean
}

/** A resolved member: the object to read through and the receiver that inherited accessors see. */
type MemberReference = {
  target: ProgramObject
  key: PropertyKey
  receiver: unknown
}

type GeneratorRequest = {
  kind: GeneratorRequestKind
  value: unknown
  response: Deferred.Deferred<unknown, unknown>
}

type GeneratorState = {
  started: boolean
  completed: boolean
  draining: boolean
  active?: GeneratorRequest
  pending: Array<GeneratorRequest>
  pendingIndex: number
  available?: Deferred.Deferred<void>
}

const promiseResolutionNode: AstNode = { type: "PromiseResolution", start: 0, end: 0 }

/** One program execution: the tool bridge, promise scheduler, captured logs, and the global scope built once. */
export class Runtime<R> {
  readonly runner: Runner<R>
  private readonly root: Frame<R>

  constructor(
    readonly executeTool: (path: ReadonlyArray<string>, args: Array<unknown>) => Effect.Effect<unknown, unknown, R>,
    readonly search: (args: Array<unknown>) => Effect.Effect<unknown, unknown, R>,
    readonly toolKeys: (path: ReadonlyArray<string>) => ReadonlyArray<string>,
    readonly promises: PromiseRuntime<R>,
    readonly prototypes: Prototypes,
    readonly logs: Array<string> = [],
    extraGlobals: (host: Host<R>) => ReadonlyArray<readonly [string, unknown]> = () => [],
  ) {
    const globalScope = new Map<string, Binding>()
    // Calling back into the program never reads frame state, so any frame serves; the root is always alive.
    this.root = new Frame(this, new ScopeStack([globalScope]))
    this.runner = {
      invokeCallable: (callable, thisValue, args, node) => this.root.invokeCallable(callable, thisValue, args, node),
      settlePromise: (promise) => this.root.settlePromise(promise),
      syncIterator: (value, node) => this.root.syncIterator(value, node),
      prototypes,
    }
    for (const [name, value] of [...globals(this), ...extraGlobals(this)]) {
      globalScope.set(name, { mutable: false, value })
    }
  }

  run(program: Program): Effect.Effect<unknown, unknown, R> {
    return this.root.run(program)
  }
}

/** One activation: the top-level program or a single function call, evaluating against its own scope chain. */
class Frame<R> {
  private generatorState?: GeneratorState
  private generatorAsync = false

  constructor(
    private readonly runtime: Runtime<R>,
    private scopes: ScopeStack,
  ) {}

  run(program: Program): Effect.Effect<unknown, unknown, R> {
    const self = this
    // Keep top-level declarations separate so they can shadow builtins.
    this.scopes.push()
    return Effect.gen(function* () {
      self.predeclareLexical(program.body)
      self.hoistFunctions(program.body)
      self.hoistVars(program.body)
      let value: unknown = undefined
      for (const [index, statement] of program.body.entries()) {
        if (index === program.body.length - 1 && statement.type === "ExpressionStatement") {
          value = yield* self.evaluateExpression(statement.expression)
          break
        }
        const result = yield* self.evaluateStatement(statement)

        if (result.kind === "return") {
          value = result.value
          break
        }

        if (result.kind === "break" || result.kind === "continue") {
          throw new InterpreterRuntimeError(`Unexpected '${result.kind}' outside of a loop.`, statement)
        }
      }

      // The implicit async body adopts returned promises before copy-out.
      value = yield* resolvePromiseValue(self.runtime.runner, value, program)
      return value
    }).pipe(Effect.ensuring(Effect.sync(() => self.scopes.pop())))
  }

  // Fork at the call site so admission and hooks occur when the call is made.
  private createToolCallPromise(
    path: ReadonlyArray<string>,
    args: Array<unknown>,
  ): Effect.Effect<ProgramPromise, never, R> {
    return this.runtime.promises.create(Effect.suspend(() => this.runtime.executeTool(path, args)))
  }

  // Fiber exits make settlement idempotent; yielding prevents inline continuation.
  settlePromise(promise: ProgramPromise): Effect.Effect<unknown, unknown, never> {
    const promises = this.runtime.promises
    return Effect.suspend(() => {
      promises.markObserved(promise)
      return Effect.flatMap(promises.await(promise), (exit) => Effect.andThen(Effect.yieldNow, exit))
    })
  }

  private evaluateStatement(node: Statement | ModuleDeclaration): Effect.Effect<StatementResult, unknown, R> {
    switch (node.type) {
      case "ExpressionStatement":
        return Effect.as(this.evaluateExpression(node.expression), { kind: "none" })
      case "VariableDeclaration":
        return Effect.map(this.evaluateVariableDeclaration(node), () => ({ kind: "none" }))
      case "ReturnStatement": {
        const argumentNode = node.argument
        return argumentNode
          ? Effect.map(this.evaluateExpression(argumentNode), (value) => ({ kind: "return", value }))
          : Effect.succeed({ kind: "return", value: undefined })
      }
      case "BlockStatement":
        return this.evaluateBlock(node)
      case "IfStatement":
        return this.evaluateIfStatement(node)
      case "SwitchStatement":
        return this.evaluateSwitchStatement(node)
      case "LabeledStatement":
        return this.evaluateLabeledStatement(node)
      case "WhileStatement":
        return this.evaluateWhileStatement(node)
      case "DoWhileStatement":
        return this.evaluateDoWhileStatement(node)
      case "ForStatement":
        return this.evaluateForStatement(node)
      case "ForOfStatement":
        return this.evaluateForOfStatement(node)
      case "ForInStatement":
        return this.evaluateForInStatement(node)
      case "BreakStatement":
        return Effect.succeed(this.evaluateBreakStatement(node))
      case "ContinueStatement":
        return Effect.succeed(this.evaluateContinueStatement(node))
      case "ThrowStatement":
        return this.evaluateThrowStatement(node)
      case "TryStatement":
        return this.evaluateTryStatement(node)
      case "EmptyStatement":
        return Effect.succeed({ kind: "none" })
      case "FunctionDeclaration":
        return Effect.succeed({ kind: "none" })
      default:
        throw unsupportedSyntax(node.type, node)
    }
  }

  private evaluateBlock(node: BlockStatement): Effect.Effect<StatementResult, unknown, R> {
    this.scopes.push()
    const self = this
    return Effect.gen(function* () {
      const body = node.body
      self.predeclareLexical(body)
      self.hoistFunctions(body)

      for (const statement of body) {
        const result = yield* self.evaluateStatement(statement)

        if (result.kind !== "none") {
          return result
        }
      }

      return { kind: "none" } satisfies StatementResult
    }).pipe(Effect.ensuring(Effect.sync(() => self.scopes.pop())))
  }

  private createFunction(
    node: FunctionDeclaration | FunctionExpression | ArrowFunctionExpression,
    name = node.type === "ArrowFunctionExpression" ? "" : (node.id?.name ?? ""),
  ): ProgramFunction {
    return new ProgramFunction(
      this.runtime.prototypes.Function,
      name,
      node.params,
      node.body,
      this.scopes.capture(),
      node.async,
      node.generator,
    )
  }

  // NamedEvaluation: an anonymous function definition takes the name of what it is assigned to.
  private evaluateNamed(node: Expression, name: string): Effect.Effect<unknown, unknown, R> {
    if (node.type === "ArrowFunctionExpression" || (node.type === "FunctionExpression" && !node.id)) {
      return Effect.sync(() => this.createFunction(node, name))
    }
    return this.evaluateExpression(node)
  }

  private hoistFunctions(statements: ReadonlyArray<Statement | ModuleDeclaration>): void {
    for (const node of statements) {
      if (node.type !== "FunctionDeclaration") continue
      this.scopes.declare(node.id.name, this.createFunction(node), true, node)
    }
  }

  // Hoisted `var` bindings start undefined, or copy a same-named parameter. Function bodies hoist
  // into their own scope above the parameters so closures in parameter defaults keep seeing outer names.
  private hoistVars(statements: ReadonlyArray<Statement | ModuleDeclaration>, parameters?: Map<string, Binding>): void {
    const names =
      varNames.get(statements) ??
      statements.reduce<Array<string>>((out, statement) => collectVarNames(statement, out), [])
    varNames.set(statements, names)
    const scope = this.scopes.current()
    for (const name of names) {
      if (scope.has(name)) continue
      scope.set(name, { mutable: true, value: parameters?.get(name)?.value, initialized: true })
    }
  }

  private predeclareLexical(statements: ReadonlyArray<Statement | ModuleDeclaration>): void {
    for (const statement of statements) {
      if (statement.type !== "VariableDeclaration") continue
      const kind = statement.kind
      if (kind === "var") continue
      for (const declaration of statement.declarations) {
        for (const name of collectPatternNames(declaration.id)) {
          this.scopes.reserve(name, kind !== "const", declaration)
        }
      }
    }
  }

  private predeclarePattern(pattern: Pattern, mutable: boolean, node: AstNode): void {
    for (const name of collectPatternNames(pattern)) this.scopes.reserve(name, mutable, node)
  }

  private evaluateIfStatement(node: IfStatement): Effect.Effect<StatementResult, unknown, R> {
    return Effect.flatMap(this.evaluateExpression(node.test), (test) =>
      test
        ? this.evaluateStatement(node.consequent)
        : node.alternate
          ? this.evaluateStatement(node.alternate)
          : Effect.succeed({ kind: "none" }),
    )
  }

  private evaluateSwitchStatement(node: SwitchStatement): Effect.Effect<StatementResult, unknown, R> {
    const self = this
    return Effect.gen(function* () {
      const discriminant = yield* self.evaluateExpression(node.discriminant)
      if (containsOpaqueReference(discriminant)) {
        throw new InterpreterRuntimeError("Switch discriminants must be data values.", node, "InvalidDataValue")
      }
      self.scopes.push()
      return yield* Effect.gen(function* () {
        const cases = node.cases
        const statements = cases.flatMap((branch) => branch.consequent)
        self.predeclareLexical(statements)
        self.hoistFunctions(statements)
        let defaultIndex: number | undefined
        let selected: number | undefined
        for (const [index, branch] of cases.entries()) {
          const test = branch.test
          if (!test) {
            defaultIndex = index
            continue
          }
          const candidate = yield* self.evaluateExpression(test)
          if (containsOpaqueReference(candidate)) {
            throw new InterpreterRuntimeError("Switch case values must be data values.", test, "InvalidDataValue")
          }
          if (candidate === discriminant) {
            selected = index
            break
          }
        }
        const start = selected ?? defaultIndex
        if (start === undefined) return { kind: "none" } satisfies StatementResult
        for (let index = start; index < cases.length; index += 1) {
          for (const statement of cases[index]!.consequent) {
            const result = yield* self.evaluateStatement(statement)
            if (result.kind === "break") {
              if (result.label === undefined) return { kind: "none" } satisfies StatementResult
              return result
            }
            if (result.kind === "return" || result.kind === "continue") return result
          }
        }
        return { kind: "none" } satisfies StatementResult
      }).pipe(Effect.ensuring(Effect.sync(() => self.scopes.pop())))
    })
  }

  private evaluateWhileStatement(
    node: WhileStatement,
    labels?: ReadonlySet<string>,
  ): Effect.Effect<StatementResult, unknown, R> {
    const self = this
    return Effect.gen(function* () {
      while (yield* self.evaluateExpression(node.test)) {
        const exit = loopExit(yield* self.evaluateStatement(node.body), labels)
        if (exit !== undefined) return exit
      }

      return { kind: "none" } satisfies StatementResult
    })
  }

  private evaluateDoWhileStatement(
    node: DoWhileStatement,
    labels?: ReadonlySet<string>,
  ): Effect.Effect<StatementResult, unknown, R> {
    const self = this
    return Effect.gen(function* () {
      do {
        const exit = loopExit(yield* self.evaluateStatement(node.body), labels)
        if (exit !== undefined) return exit
      } while (yield* self.evaluateExpression(node.test))

      return { kind: "none" } satisfies StatementResult
    })
  }

  private evaluateForStatement(
    node: ForStatement,
    labels?: ReadonlySet<string>,
  ): Effect.Effect<StatementResult, unknown, R> {
    this.scopes.push()
    const self = this
    return Effect.gen(function* () {
      const initNode = node.init
      const testNode = node.test
      const updateNode = node.update

      if (initNode?.type === "VariableDeclaration" && initNode.kind !== "var") {
        self.predeclareLexical([initNode])
      }

      if (initNode) {
        if (initNode.type === "VariableDeclaration") {
          yield* self.evaluateVariableDeclaration(initNode)
        } else {
          yield* self.evaluateExpression(initNode)
        }
      }

      const perIterationBindings =
        initNode?.type === "VariableDeclaration" && initNode.kind !== "var"
          ? Array.from(self.scopes.current().keys())
          : []

      const nextIteration = () => {
        if (perIterationBindings.length === 0) return
        const current = self.scopes.current()
        self.scopes.pop()
        self.scopes.push(
          new Map(perIterationBindings.map((name): [string, Binding] => [name, { ...current.get(name)! }])),
        )
      }
      nextIteration()

      while (testNode ? yield* self.evaluateExpression(testNode) : true) {
        const exit = loopExit(yield* self.evaluateStatement(node.body), labels)
        if (exit !== undefined) return exit

        nextIteration()
        if (updateNode) {
          yield* self.evaluateExpression(updateNode)
        }
      }

      return { kind: "none" } satisfies StatementResult
    }).pipe(Effect.ensuring(Effect.sync(() => self.scopes.pop())))
  }

  private evaluateForOfStatement(
    node: ForOfStatement,
    labels?: ReadonlySet<string>,
  ): Effect.Effect<StatementResult, unknown, R> {
    const awaiting = node.await
    const left = node.left
    const declared = loopDeclaration(left, "for...of")
    if (declared?.lexical) this.scopes.push()

    const self = this
    return Effect.gen(function* () {
      if (declared?.lexical) self.predeclarePattern(declared.pattern, declared.mutable, left)
      const right = yield* self.evaluateExpression(node.right)

      const iterator = yield* self.customIterator(right, node, awaiting)
      const cursor = iterator === undefined ? yield* self.syncIterator(right, node) : undefined
      if (iterator === undefined && cursor === undefined) {
        throw new InterpreterRuntimeError(
          `${awaiting ? "for await...of" : "for...of"} requires an array, string, Map, Set, or URLSearchParams, or custom iterator value.`,
          node,
        )
      }
      const close = () =>
        iterator
          ? self.closeIterator(iterator, node, awaiting)
          : awaiting
            ? Effect.andThen(cursor?.close ?? Effect.void, Effect.yieldNow)
            : (cursor?.close ?? Effect.void)

      if (left.type === "RestElement" || left.type === "AssignmentPattern") {
        throw new InterpreterRuntimeError("Unsupported for...of binding.", left)
      }
      const assignment = left.type === "VariableDeclaration" ? undefined : left

      const evaluateBody = (value: unknown) =>
        Effect.gen(function* () {
          if (declared?.lexical) {
            self.scopes.push()
            self.predeclarePattern(declared.pattern, declared.mutable, left)
            yield* self.declarePattern(declared.pattern, value, declared.mutable, left, true)
          } else if (declared) {
            yield* self.assignPattern(declared.pattern, value, left)
          } else if (assignment) {
            yield* self.assignPattern(assignment, value, left)
          }
          return yield* self.evaluateStatement(node.body)
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (declared?.lexical) self.scopes.pop()
            }),
          ),
        )

      while (true) {
        const current = iterator
          ? yield* self.nextIteratorResult(iterator, node, awaiting)
          : yield* cursor?.next ?? Effect.fail(new InterpreterRuntimeError("Iterator is unavailable.", node))
        const step = cursor && awaiting ? { done: current.done, value: yield* self.awaitValue(current.value) } : current
        if (step.done) return { kind: "none" } satisfies StatementResult
        const bodyExit = yield* Effect.exit(evaluateBody(step.value))
        if (!Exit.isSuccess(bodyExit)) {
          // Process interruption must remain prompt; user cleanup cannot extend a timeout.
          if (!Cause.hasInterruptsOnly(bodyExit.cause)) {
            yield* Effect.exit(close())
          }
          return yield* Effect.failCause(bodyExit.cause)
        }
        const exit = loopExit(bodyExit.value, labels)
        if (exit !== undefined) {
          yield* close()
          return exit
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (declared?.lexical) self.scopes.pop()
        }),
      ),
    )
  }

  private awaitValue(value: unknown, node: AstNode = promiseResolutionNode): Effect.Effect<unknown, unknown, R> {
    return Effect.flatMap(resolvePromise(this.runtime.runner, this.runtime.promises, value, node), (promise) =>
      this.settlePromise(promise),
    )
  }

  private awaitAsyncFromSyncValue(
    iterator: CustomIterator,
    value: unknown,
    node: AstNode,
    closeOnRejection: boolean,
  ): Effect.Effect<unknown, unknown, R> {
    const self = this
    return Effect.gen(function* () {
      const settled = yield* Effect.exit(self.awaitValue(value))
      if (Exit.isSuccess(settled)) return settled.value
      if (closeOnRejection && !Cause.hasInterruptsOnly(settled.cause)) {
        yield* Effect.exit(self.closeIterator(iterator, node, false))
      }
      return yield* Effect.failCause(settled.cause)
    })
  }

  syncIterator(value: unknown, node: AstNode) {
    const iterator =
      value instanceof ProgramArray
        ? value.items[Symbol.iterator]()
        : typeof value === "string"
          ? value[Symbol.iterator]()
          : value instanceof ProgramMap
            ? value.map.entries()
            : value instanceof ProgramSet
              ? value.set.values()
              : value instanceof ProgramURLSearchParams
                ? value.params.entries()
                : undefined
    if (iterator !== undefined) {
      const proto = this.runtime.prototypes.Array
      return Effect.succeed({
        next: Effect.sync(() => {
          const step = iterator.next()
          return {
            done: Boolean(step.done),
            value: Array.isArray(step.value) ? new ProgramArray(proto, step.value) : step.value,
          }
        }),
        close: Effect.void,
      })
    }
    const self = this
    return Effect.map(this.customIterator(value, node, false), (iterator) =>
      iterator === undefined
        ? undefined
        : {
            next: self.nextIteratorResult(iterator, node, false),
            close: Effect.suspend(() => self.closeIterator(iterator, node, false)),
          },
    )
  }

  private customIterator(value: unknown, node: AstNode, allowAsync = true) {
    if (!(value instanceof ProgramObject)) return Effect.undefined
    const asyncMethod = allowAsync ? get(value, AsyncIteratorSymbol) : undefined
    const method = asyncMethod ?? get(value, IteratorSymbol)
    if (method === undefined || method === null) return Effect.undefined
    const self = this
    return Effect.map(
      this.invokeCallable(this.requireIteratorMethod(method, "Iterator method", node), value, [], node),
      (iterator) => {
        const object = self.requireIteratorObject(iterator, "Iterator method result", node)
        return {
          iterator: object,
          next: self.requireIteratorMethod(get(object, "next"), "Iterator next", node),
          asynchronous: asyncMethod !== undefined && asyncMethod !== null,
        }
      },
    )
  }

  private nextIteratorResult(iterator: CustomIterator, node: AstNode, awaiting: boolean) {
    const self = this
    return Effect.gen(function* () {
      if (iterator.asynchronous) {
        const object = self.requireIteratorObject(
          yield* self.awaitValue(yield* self.invokeCallable(iterator.next, iterator.iterator, [], node)),
          "Iterator next() result",
          node,
        )
        return { done: Boolean(get(object, "done")), value: get(object, "value") }
      }

      const called = yield* Effect.exit(self.invokeCallable(iterator.next, iterator.iterator, [], node))
      if (!Exit.isSuccess(called)) {
        if (awaiting) yield* Effect.yieldNow
        return yield* Effect.failCause(called.cause)
      }
      const captured = yield* Effect.exit(
        Effect.sync(() => {
          const object = self.requireIteratorObject(called.value, "Iterator next() result", node)
          return { done: Boolean(get(object, "done")), value: get(object, "value") }
        }),
      )
      if (!Exit.isSuccess(captured)) {
        if (awaiting) yield* Effect.yieldNow
        return yield* Effect.failCause(captured.cause)
      }
      return {
        done: captured.value.done,
        value: awaiting
          ? yield* self.awaitAsyncFromSyncValue(iterator, captured.value.value, node, !captured.value.done)
          : captured.value.value,
      }
    })
  }

  private closeIterator(iterator: CustomIterator, node: AstNode, awaiting = true): Effect.Effect<void, unknown, R> {
    const close = get(iterator.iterator, "return")
    if (close === undefined || close === null) return iterator.asynchronous || !awaiting ? Effect.void : Effect.yieldNow
    const self = this
    return Effect.gen(function* () {
      const method = self.requireIteratorMethod(close, "Iterator return", node)
      if (iterator.asynchronous) {
        self.requireIteratorObject(
          yield* self.awaitValue(yield* self.invokeCallable(method, iterator.iterator, [], node)),
          "Iterator return() result",
          node,
        )
        return
      }

      const called = yield* Effect.exit(self.invokeCallable(method, iterator.iterator, [], node))
      if (!Exit.isSuccess(called)) {
        if (awaiting) yield* Effect.yieldNow
        return yield* Effect.failCause(called.cause)
      }
      const captured = yield* Effect.exit(
        Effect.sync(() => get(self.requireIteratorObject(called.value, "Iterator return() result", node), "value")),
      )
      if (!Exit.isSuccess(captured)) {
        if (awaiting) yield* Effect.yieldNow
        return yield* Effect.failCause(captured.cause)
      }
      if (awaiting) yield* self.awaitValue(captured.value)
    })
  }

  private requireIteratorObject(value: unknown, context: string, node: AstNode): ProgramObject {
    if (value instanceof ProgramObject) return value
    throw new InterpreterRuntimeError(`${context} must be an object.`, node)
  }

  private requireIteratorMethod(value: unknown, context: string, node: AstNode): unknown {
    if (typeofValue(value) === "function") return value
    throw new InterpreterRuntimeError(`${context} must be a function.`, node)
  }

  // for...in over null/undefined iterates nothing, like JS.
  private enumerableKeys(value: unknown, node: AstNode): Array<string> {
    if (value instanceof ToolReference) return [...this.runtime.toolKeys(value.path)]
    if (value === null || value === undefined) return []
    return keys(enumerableSource(this.runtime.runner, "for...in", value, node))
  }

  private evaluateForInStatement(
    node: ForInStatement,
    labels?: ReadonlySet<string>,
  ): Effect.Effect<StatementResult, unknown, R> {
    const left = node.left
    const declared = loopDeclaration(left, "for...in")
    if (declared?.lexical) this.scopes.push()

    const self = this
    return Effect.gen(function* () {
      if (declared?.lexical) self.predeclarePattern(declared.pattern, declared.mutable, left)
      const right = yield* self.evaluateExpression(node.right)

      const keys = self.enumerableKeys(right, node.right)

      if (left.type !== "Identifier" && left.type !== "VariableDeclaration") {
        throw new InterpreterRuntimeError("Unsupported for...in binding.", left)
      }
      const assignmentName = left.type === "Identifier" ? left.name : undefined

      for (const key of keys) {
        const result = yield* Effect.gen(function* () {
          if (declared?.lexical) {
            self.scopes.push()
            self.predeclarePattern(declared.pattern, declared.mutable, left)
            yield* self.declarePattern(declared.pattern, key, declared.mutable, left, true)
          } else if (declared) {
            yield* self.assignPattern(declared.pattern, key, left)
          } else if (assignmentName) {
            self.scopes.set(assignmentName, key, left)
          }
          return yield* self.evaluateStatement(node.body)
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (declared?.lexical) self.scopes.pop()
            }),
          ),
        )

        const exit = loopExit(result, labels)
        if (exit !== undefined) return exit
      }

      return { kind: "none" } satisfies StatementResult
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (declared?.lexical) self.scopes.pop()
        }),
      ),
    )
  }

  private evaluateBreakStatement(node: BreakStatement): StatementResult {
    return node.label ? { kind: "break", label: node.label.name } : { kind: "break" }
  }

  private evaluateContinueStatement(node: ContinueStatement): StatementResult {
    return node.label ? { kind: "continue", label: node.label.name } : { kind: "continue" }
  }

  private evaluateLabeledStatement(node: LabeledStatement): Effect.Effect<StatementResult, unknown, R> {
    const labels = new Set<string>()
    let body: Statement = node
    while (body.type === "LabeledStatement") {
      labels.add(body.label.name)
      body = body.body
    }

    const evaluated = (() => {
      if (body.type === "WhileStatement") return this.evaluateWhileStatement(body, labels)
      if (body.type === "DoWhileStatement") return this.evaluateDoWhileStatement(body, labels)
      if (body.type === "ForStatement") return this.evaluateForStatement(body, labels)
      if (body.type === "ForOfStatement") return this.evaluateForOfStatement(body, labels)
      if (body.type === "ForInStatement") return this.evaluateForInStatement(body, labels)
      return this.evaluateStatement(body)
    })()

    return Effect.map(evaluated, (result) =>
      result.kind === "break" && result.label !== undefined && labels.has(result.label)
        ? ({ kind: "none" } satisfies StatementResult)
        : result,
    )
  }

  private evaluateThrowStatement(node: ThrowStatement): Effect.Effect<StatementResult, unknown, R> {
    return Effect.flatMap(this.evaluateExpression(node.argument), (value) => Effect.fail(new ProgramThrow(value)))
  }

  private evaluateTryStatement(node: TryStatement): Effect.Effect<StatementResult, unknown, R> {
    const body = node.block
    const handler = node.handler
    const finalizer = node.finalizer
    const self = this

    const attempted = Effect.matchCauseEffect(this.evaluateStatement(body), {
      onFailure: (cause) => {
        if (cause.reasons.some(Cause.isInterruptReason) || Cause.squash(cause) instanceof GeneratorReturn || !handler) {
          return Effect.failCause(cause)
        }

        const caught = caughtErrorValue(self.runtime.runner, Cause.squash(cause))
        const parameter = handler.param
        self.scopes.push()
        return Effect.gen(function* () {
          if (parameter) yield* self.declarePattern(parameter, caught, true, handler)
          return yield* self.evaluateStatement(handler.body)
        }).pipe(Effect.ensuring(Effect.sync(() => self.scopes.pop())))
      },
      onSuccess: Effect.succeed,
    })

    if (!finalizer) return attempted

    const isAbrupt = (result: StatementResult): boolean =>
      result.kind === "return" || result.kind === "break" || result.kind === "continue"

    return Effect.matchCauseEffect(attempted, {
      onFailure: (cause) =>
        cause.reasons.some(Cause.isInterruptReason)
          ? Effect.failCause(cause)
          : Effect.flatMap(this.evaluateStatement(finalizer), (final) =>
              isAbrupt(final) ? Effect.succeed(final) : Effect.failCause(cause),
            ),
      onSuccess: (result) =>
        Effect.flatMap(this.evaluateStatement(finalizer), (final) =>
          isAbrupt(final) ? Effect.succeed(final) : Effect.succeed(result),
        ),
    })
  }

  private evaluateVariableDeclaration(node: VariableDeclaration): Effect.Effect<void, unknown, R> {
    const kind = node.kind
    const self = this
    return Effect.gen(function* () {
      for (const declaration of node.declarations) {
        if (declaration.type !== "VariableDeclarator") {
          throw new InterpreterRuntimeError("Unsupported variable declaration shape.", declaration)
        }

        const init = declaration.init
        // `var x` alone is a no-op: the binding was hoisted on function entry.
        const id = declaration.id
        const evaluate = (init: Expression) =>
          id.type === "Identifier" ? self.evaluateNamed(init, id.name) : self.evaluateExpression(init)
        if (kind === "var") {
          if (init) yield* self.assignPattern(id, yield* evaluate(init), declaration)
          continue
        }
        const value = init ? yield* evaluate(init) : undefined
        yield* self.declarePattern(declaration.id, value, kind !== "const", declaration, true)
      }
    })
  }

  private declarePattern(
    pattern: Pattern,
    value: unknown,
    mutable: boolean,
    node: AstNode,
    initialize = false,
  ): Effect.Effect<void, unknown, R> {
    const self = this
    return Effect.gen(function* () {
      if (pattern.type === "Identifier") {
        const name = pattern.name
        if (initialize) self.scopes.initialize(name, value, node)
        else self.scopes.declare(name, value, mutable, node)
        return
      }

      if (pattern.type === "AssignmentPattern") {
        const resolved = value === undefined ? yield* self.evaluateDefault(pattern) : value
        yield* self.declarePattern(pattern.left, resolved, mutable, node, initialize)
        return
      }

      if (pattern.type === "ObjectPattern") {
        if (!(value instanceof ProgramObject)) {
          throw new InterpreterRuntimeError(
            `Object destructuring requires a data object or array value, received ${describeValue(value)}.`,
            pattern,
            "InvalidDataValue",
          )
        }

        const consumed = new Set<PropertyKey>()
        for (const property of pattern.properties) {
          if (property.type === "RestElement") {
            const rest = new ProgramObject(self.runtime.prototypes.Object)
            assign(rest, value, consumed)
            yield* self.declarePattern(property.argument, rest, mutable, property, initialize)
            continue
          }

          const key = yield* self.destructuringPropertyKey(property)
          consumed.add(typeof key === "symbol" ? key : String(key))
          yield* self.declarePattern(property.value, get(value, key), mutable, property, initialize)
        }
        return
      }

      if (pattern.type === "ArrayPattern") {
        return yield* self.destructureArrayPattern(pattern, value, (target, item, context) =>
          self.declarePattern(target, item, mutable, context, initialize),
        )
      }

      throw new InterpreterRuntimeError(`Unsupported binding pattern '${pattern.type}'.`, pattern)
    })
  }

  private assignPattern(pattern: Pattern, value: unknown, node: AstNode): Effect.Effect<void, unknown, R> {
    const self = this
    return Effect.gen(function* () {
      if (pattern.type === "Identifier") {
        self.scopes.set(pattern.name, value, pattern)
        return
      }

      if (pattern.type === "MemberExpression") {
        yield* self.writeMember(pattern, value)
        return
      }

      if (pattern.type === "AssignmentPattern") {
        const resolved = value === undefined ? yield* self.evaluateDefault(pattern) : value
        yield* self.assignPattern(pattern.left, resolved, node)
        return
      }

      if (pattern.type === "ObjectPattern") {
        if (!(value instanceof ProgramObject)) {
          throw new InterpreterRuntimeError(
            `Object destructuring requires a data object or array value, received ${describeValue(value)}.`,
            pattern,
            "InvalidDataValue",
          )
        }

        const consumed = new Set<PropertyKey>()
        for (const property of pattern.properties) {
          if (property.type === "RestElement") {
            const rest = new ProgramObject(self.runtime.prototypes.Object)
            assign(rest, value, consumed)
            yield* self.assignPattern(property.argument, rest, property)
            continue
          }
          const key = yield* self.destructuringPropertyKey(property)
          consumed.add(typeof key === "symbol" ? key : String(key))
          yield* self.assignPattern(property.value, get(value, key), property)
        }
        return
      }

      if (pattern.type === "ArrayPattern") {
        return yield* self.destructureArrayPattern(pattern, value, (target, item, context) =>
          self.assignPattern(target, item, context),
        )
      }

      throw new InterpreterRuntimeError(`Unsupported assignment pattern '${pattern.type}'.`, node)
    })
  }

  private evaluateDefault(pattern: AssignmentPattern): Effect.Effect<unknown, unknown, R> {
    return pattern.left.type === "Identifier"
      ? this.evaluateNamed(pattern.right, pattern.left.name)
      : this.evaluateExpression(pattern.right)
  }

  private destructureArrayPattern(
    pattern: ArrayPattern,
    value: unknown,
    consume: (target: Pattern, value: unknown, context: AstNode) => Effect.Effect<void, unknown, R>,
  ): Effect.Effect<void, unknown, R> {
    const self = this
    return Effect.gen(function* () {
      const cursor = yield* self.syncIterator(value, pattern)
      if (cursor === undefined) {
        throw new InterpreterRuntimeError("Array destructuring requires a supported iterable value.", pattern)
      }
      let done = false
      for (const element of pattern.elements) {
        if (done) {
          if (element === null) continue
          yield* consume(
            element.type === "RestElement" ? element.argument : element,
            element.type === "RestElement" ? new ProgramArray(self.runtime.prototypes.Array) : undefined,
            element,
          )
          if (element.type === "RestElement") return
          continue
        }
        const step = yield* cursor.next
        done = step.done
        if (element === null) continue
        if (element.type === "RestElement") {
          const rest: Array<unknown> = []
          if (!step.done) rest.push(step.value)
          while (!done) {
            const next = yield* cursor.next
            done = next.done
            if (!done) rest.push(next.value)
          }
          yield* consume(element.argument, new ProgramArray(self.runtime.prototypes.Array, rest), element)
          return
        }
        const consumed = consume(element, step.done ? undefined : step.value, pattern)
        yield* step.done ? consumed : preserveConsumerError(cursor, consumed)
      }
      if (!done) yield* cursor.close
    })
  }

  private destructuringPropertyKey(property: Property | AssignmentProperty): Effect.Effect<PropertyKey, unknown, R> {
    if (property.type !== "Property" || property.kind !== "init") {
      throw new InterpreterRuntimeError("Unsupported object destructuring property.", property)
    }
    const keyNode = property.key
    if (property.computed) {
      return Effect.map(this.evaluateExpression(keyNode), (value) => this.toPropertyKey(value, keyNode))
    }
    if (keyNode.type === "Identifier") return Effect.succeed(keyNode.name)
    if (keyNode.type === "Literal") return Effect.succeed(String(keyNode.value))
    throw unsupportedSyntax(keyNode.type, keyNode)
  }

  private evaluateExpression(node: Expression): Effect.Effect<unknown, unknown, R> {
    switch (node.type) {
      case "Literal": {
        const regex = node.regex
        if (regex)
          return Effect.sync(() => constructRegExp(this.runtime.prototypes, [regex.pattern, regex.flags], node))
        return Effect.sync(() => toProgram(this.runtime.prototypes, node.value, "Literal"))
      }
      case "Identifier":
        return Effect.sync(() => this.scopes.get(node.name, node))
      case "BinaryExpression":
        return this.evaluateBinaryExpression(node)
      case "LogicalExpression":
        return this.evaluateLogicalExpression(node)
      case "UnaryExpression":
        return this.evaluateUnaryExpression(node)
      case "AssignmentExpression":
        return this.evaluateAssignmentExpression(node)
      case "SequenceExpression": {
        const self = this
        return Effect.gen(function* () {
          let result: unknown
          for (const expression of node.expressions) {
            result = yield* self.evaluateExpression(expression)
          }
          return result
        })
      }
      case "CallExpression":
        return this.evaluateCallExpression(node)
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        return Effect.sync(() => this.createFunction(node))
      case "MemberExpression":
        return this.readMember(node)
      case "ChainExpression":
        return Effect.map(this.evaluateExpression(node.expression), (value) =>
          value === OptionalShortCircuit ? undefined : value,
        )
      case "ObjectExpression":
        return this.evaluateObjectExpression(node)
      case "ArrayExpression":
        return this.evaluateArrayExpression(node)
      case "TemplateLiteral":
        return this.evaluateTemplateLiteral(node)
      case "ConditionalExpression":
        return this.evaluateConditionalExpression(node)
      case "UpdateExpression":
        return this.evaluateUpdateExpression(node)
      case "AwaitExpression": {
        // Await always suspends, including for plain values.
        return Effect.flatMap(this.evaluateExpression(node.argument), (value) => this.awaitValue(value, node))
      }
      case "YieldExpression":
        return this.evaluateYieldExpression(node)
      case "NewExpression":
        return this.evaluateNewExpression(node)
      default:
        throw unsupportedSyntax(node.type, node)
    }
  }

  private evaluateNewExpression(node: NewExpression): Effect.Effect<unknown, unknown, R> {
    const self = this
    return Effect.gen(function* () {
      const callee = yield* self.evaluateExpression(node.callee)
      // Globals are built with this interpreter's R; `instanceof` cannot recover the type argument.
      const construct = callee instanceof NativeFunction ? (callee as NativeFunction<R>).construct : undefined
      if (construct === undefined) {
        // `new` itself is supported, so a non-constructible callee is a TypeError like JS rather than
        // unsupported syntax. Built-ins like Number are real constructors in JS, so do not claim
        // otherwise; say `new` is unsupported for them and point at the plain call.
        const name = calleeDescription(node.callee)
        const message =
          callee instanceof ProgramFunction
            ? `${name} cannot be constructed: user-defined constructors and classes are not supported. Call it as a function that returns a plain object instead.`
            : callee instanceof NativeFunction
              ? `new ${name}(...) is not supported; call ${name}(...) without new instead.`
              : `${name} is not a constructor.`
        throw new InterpreterRuntimeError(message, node)
      }
      const args = yield* self.evaluateCallArguments(node.arguments)
      return yield* construct(args, callee as NativeFunction<R>, node)
    })
  }

  private evaluateBinaryExpression(node: BinaryExpression): Effect.Effect<unknown, unknown, R> {
    const operator = node.operator
    const left = node.left
    if (left.type === "PrivateIdentifier") throw unsupportedSyntax(left.type, left)
    const self = this
    return Effect.gen(function* () {
      const lhs = yield* self.evaluateExpression(left)
      const rhs = yield* self.evaluateExpression(node.right)
      if (operator === "instanceof") return instanceofValue(lhs, rhs, node)
      return toProgram(
        self.runtime.prototypes,
        self.applyBinaryOperator(operator, lhs, rhs, node),
        "Binary expression result",
      )
    })
  }

  private applyBinaryOperator(operator: string, lhs: unknown, rhs: unknown, node: AstNode): unknown {
    if (operator === "===") return lhs === rhs
    if (operator === "!==") return lhs !== rhs
    if (operator === "in" && rhs instanceof ProgramObject && !containsOpaqueReference(lhs)) {
      return has(rhs, lhs !== null && typeof lhs === "object" ? coerceToString(lhs) : (lhs as PropertyKey))
    }
    if (containsOpaqueReference(lhs) || containsOpaqueReference(rhs)) {
      throw new InterpreterRuntimeError("Binary operators require data values.", node, "InvalidDataValue")
    }
    // Null-prototype data needs explicit primitive coercion; identity and `in` retain raw objects.
    // Dates use their default string hint for addition and loose equality, and epoch time elsewhere.
    const coerceOperand = (operand: unknown): unknown => {
      if (operand instanceof ProgramDate) {
        return operator === "+" || operator === "==" || operator === "!=" ? coerceToString(operand) : operand.time
      }
      return operand !== null && typeof operand === "object" ? coerceToString(operand) : operand
    }
    const bothObjects = lhs !== null && typeof lhs === "object" && rhs !== null && typeof rhs === "object"
    const l = coerceOperand(lhs)
    const r = coerceOperand(rhs)
    switch (operator) {
      case "+":
        return (l as string) + (r as string)
      case "-":
        return (l as number) - (r as number)
      case "*":
        return (l as number) * (r as number)
      case "/":
        return (l as number) / (r as number)
      case "%":
        return (l as number) % (r as number)
      case "**":
        return (l as number) ** (r as number)
      case "==":
        return bothObjects ? lhs === rhs : l == r
      case "!=":
        return bothObjects ? lhs !== rhs : l != r
      case "<":
        return (l as string) < (r as string)
      case "<=":
        return (l as string) <= (r as string)
      case ">":
        return (l as string) > (r as string)
      case ">=":
        return (l as string) >= (r as string)
      case "&":
        return (l as number) & (r as number)
      case "|":
        return (l as number) | (r as number)
      case "^":
        return (l as number) ^ (r as number)
      case "<<":
        return (l as number) << (r as number)
      case ">>":
        return (l as number) >> (r as number)
      case ">>>":
        return (l as number) >>> (r as number)
      case "in":
        if (!(rhs instanceof ProgramObject)) {
          throw new InterpreterRuntimeError("The 'in' operator requires a data object on the right-hand side.", node)
        }
        return has(rhs, coerceOperand(lhs) as PropertyKey)
      default:
        throw new InterpreterRuntimeError(`Unsupported binary operator '${operator}'.`, node)
    }
  }

  private evaluateLogicalExpression(node: LogicalExpression): Effect.Effect<unknown, unknown, R> {
    const operator = node.operator
    return Effect.flatMap(this.evaluateExpression(node.left), (left) => {
      if (operator === "&&") return left ? this.evaluateExpression(node.right) : Effect.succeed(left)
      if (operator === "||") return left ? Effect.succeed(left) : this.evaluateExpression(node.right)
      if (operator === "??")
        return left !== null && left !== undefined ? Effect.succeed(left) : this.evaluateExpression(node.right)
      throw new InterpreterRuntimeError(`Unsupported logical operator '${operator}'.`, node)
    })
  }

  private evaluateUnaryExpression(node: UnaryExpression): Effect.Effect<unknown, unknown, R> {
    const operator = node.operator
    const argument = node.argument
    if (operator === "delete") return this.evaluateDeleteExpression(argument)
    // Undeclared names short-circuit, but declared TDZ bindings must still throw.
    if (operator === "typeof" && argument.type === "Identifier" && !this.scopes.resolve(argument.name)) {
      return Effect.succeed("undefined")
    }
    return Effect.map(this.evaluateExpression(argument), (value) => {
      if (operator === "typeof") return typeofValue(value)
      if (operator === "!") return !value
      if (operator === "void") return undefined
      if (containsOpaqueReference(value)) {
        throw new InterpreterRuntimeError("Unary operators require data values.", node, "InvalidDataValue")
      }
      const operand =
        value instanceof ProgramDate
          ? value.time
          : value !== null && typeof value === "object"
            ? coerceToString(value)
            : value
      let result: unknown
      switch (operator) {
        case "+":
          result = +(operand as number)
          break
        case "-":
          result = -(operand as number)
          break
        case "~":
          result = ~(operand as number)
          break
        default:
          throw new InterpreterRuntimeError(`Unsupported unary operator '${operator}'.`, node)
      }
      return toProgram(this.runtime.prototypes, result, "Unary expression result")
    })
  }

  private evaluateAssignmentExpression(node: AssignmentExpression): Effect.Effect<unknown, unknown, R> {
    const left = node.left
    const operator = node.operator
    const self = this
    return Effect.gen(function* () {
      if (operator === "??=" || operator === "||=" || operator === "&&=") {
        return yield* self.evaluateLogicalAssignment(node, left, operator)
      }
      if (operator === "=" && (left.type === "ObjectPattern" || left.type === "ArrayPattern")) {
        const rightValue = yield* self.evaluateExpression(node.right)
        yield* self.assignPattern(left, rightValue, node)
        return rightValue
      }
      if (left.type === "Identifier") {
        const name = left.name
        if (operator !== "=") {
          const current = self.scopes.get(name, left)
          const rightValue = yield* self.evaluateExpression(node.right)
          const next = toProgram(
            self.runtime.prototypes,
            self.applyCompoundAssignment(operator, current, rightValue, node),
            "Assignment result",
          )
          return self.scopes.set(name, next, left)
        }
        const rightValue = yield* self.evaluateNamed(node.right, name)
        return self.scopes.set(name, rightValue, left)
      }
      if (left.type === "MemberExpression") {
        return yield* self.modifyMember(left, (current) =>
          Effect.map(self.evaluateExpression(node.right), (rightValue) => {
            if (operator === "=") return { write: true, next: rightValue, result: rightValue }
            const next = toProgram(
              self.runtime.prototypes,
              self.applyCompoundAssignment(operator, current, rightValue, node),
              "Assignment result",
            )
            return { write: true, next, result: next }
          }),
        )
      }
      throw new InterpreterRuntimeError("Assignment target must be an Identifier or MemberExpression.", left)
    })
  }

  private evaluateLogicalAssignment(
    node: AssignmentExpression,
    left: Pattern,
    operator: string,
  ): Effect.Effect<unknown, unknown, R> {
    const self = this
    const shouldAssign = (current: unknown): boolean =>
      operator === "??=" ? current === null || current === undefined : operator === "||=" ? !current : Boolean(current)
    if (left.type === "Identifier") {
      const name = left.name
      return Effect.gen(function* () {
        const current = self.scopes.get(name, left)
        if (!shouldAssign(current)) return current
        const rightValue = yield* self.evaluateNamed(node.right, name)
        return self.scopes.set(name, rightValue, left)
      })
    }
    if (left.type === "MemberExpression") {
      return self.modifyMember(left, (current) =>
        shouldAssign(current)
          ? Effect.map(self.evaluateExpression(node.right), (rightValue) => ({
              write: true,
              next: rightValue,
              result: rightValue,
            }))
          : Effect.succeed({ write: false, next: current, result: current }),
      )
    }
    throw new InterpreterRuntimeError("Assignment target must be an Identifier or MemberExpression.", left)
  }

  private evaluateUpdateExpression(node: UpdateExpression): Effect.Effect<unknown, unknown, R> {
    const operator = node.operator
    const argument = node.argument
    const prefix = node.prefix

    const increment = operator === "++" ? 1 : operator === "--" ? -1 : undefined

    if (increment === undefined) {
      throw new InterpreterRuntimeError(`Unsupported update operator '${operator}'.`, node)
    }

    // CodeMode numeric coercion, not host Number(): null-prototype data objects would make
    // the host throw during ToPrimitive, and opaque runtime references must reject clearly.
    const operand = (current: unknown): number => {
      if (containsOpaqueReference(current)) {
        throw new InterpreterRuntimeError(`'${operator}' requires a data value.`, argument, "InvalidDataValue")
      }
      return coerceToNumber(current)
    }

    if (argument.type === "Identifier") {
      return Effect.sync(() => {
        const name = argument.name
        const current = operand(this.scopes.get(name, argument))
        const next = current + increment
        this.scopes.set(name, next, argument)
        return prefix ? next : current
      })
    }

    if (argument.type === "MemberExpression") {
      return this.modifyMember(argument, (current) => {
        const value = operand(current)
        const next = value + increment
        return Effect.succeed({ write: true, next, result: prefix ? next : value })
      })
    }

    throw new InterpreterRuntimeError("Update target must be an Identifier or MemberExpression.", argument)
  }

  // EvaluateCall: a member callee supplies its base object as `this`; anything else calls with undefined.
  private evaluateCallExpression(node: CallExpression): Effect.Effect<unknown, unknown, R> {
    const callee = node.callee

    const self = this
    return Effect.gen(function* () {
      if (callee.type === "Super") throw unsupportedSyntax(callee.type, callee)
      const { callable, thisValue } =
        callee.type === "MemberExpression"
          ? yield* self.readMethod(callee)
          : { callable: yield* self.evaluateExpression(callee), thisValue: undefined }
      if (callable === OptionalShortCircuit) return OptionalShortCircuit
      if ((callable === null || callable === undefined) && node.optional) return OptionalShortCircuit

      const args = yield* self.evaluateCallArguments(node.arguments)
      return yield* self.invokeCallable(callable, thisValue, args, node, callee)
    })
  }

  private readMethod(node: MemberExpression): Effect.Effect<{ callable: unknown; thisValue: unknown }, unknown, R> {
    return Effect.map(this.getMemberReference(node), (reference) => {
      if (reference === OptionalShortCircuit) return { callable: OptionalShortCircuit, thisValue: undefined }
      if (reference instanceof ToolReference) return { callable: reference, thisValue: undefined }
      if ("value" in reference) return { callable: reference.value, thisValue: undefined }
      return { callable: this.readReference(reference, node), thisValue: reference.receiver }
    })
  }

  // The single dispatch for every invocation: call expressions and callbacks share it.
  invokeCallable(
    callable: unknown,
    thisValue: unknown,
    args: Array<unknown>,
    node: AstNode,
    callee?: Expression,
  ): Effect.Effect<unknown, unknown, R> {
    const self = this
    return Effect.gen(function* () {
      if (callable instanceof ToolReference) {
        if (callable.path.length === 0) {
          throw new InterpreterRuntimeError("The tools root is not callable.", callee ?? node)
        }
        return yield* self.createToolCallPromise(callable.path, args)
      }
      if (callable instanceof ProgramFunction) return yield* self.invokeFunction(callable, args)
      if (callable instanceof NativeFunction) return yield* (callable as NativeFunction<R>).call(thisValue, args, node)
      throw new InterpreterRuntimeError(`${calleeDescription(callee)} is not a function.`, callee ?? node)
    })
  }

  private evaluateCallArguments(
    argNodes: ReadonlyArray<Expression | SpreadElement>,
  ): Effect.Effect<Array<unknown>, unknown, R> {
    const self = this
    return Effect.gen(function* () {
      const args: Array<unknown> = []
      for (const argNode of argNodes) {
        if (argNode.type === "SpreadElement") {
          const spread = yield* self.evaluateExpression(argNode.argument)
          const cursor = yield* self.syncIterator(spread, argNode)
          if (cursor === undefined)
            throw new InterpreterRuntimeError("Spread arguments require a synchronous iterable.", argNode)
          while (true) {
            const step = yield* cursor.next
            if (step.done) break
            args.push(step.value)
          }
        } else {
          args.push(yield* self.evaluateExpression(argNode))
        }
      }
      return args
    })
  }

  invokeFunction(fn: ProgramFunction, args: Array<unknown>): Effect.Effect<unknown, unknown, R> {
    const self = this
    const invocation = new Frame(this.runtime, new ScopeStack([...fn.capturedScopes, new Map()]))
    const run = Effect.gen(function* () {
      // Seed all parameters first so defaults cannot fall through to same-named outer bindings.
      const paramScope = invocation.scopes.current()
      for (const parameter of fn.parameters) {
        for (const name of collectPatternNames(parameter)) {
          paramScope.set(name, { mutable: true, value: undefined, initialized: false })
        }
      }
      for (const [index, parameter] of fn.parameters.entries()) {
        if (parameter.type === "RestElement") {
          yield* invocation.declarePattern(
            parameter.argument,
            new ProgramArray(self.runtime.prototypes.Array, args.slice(index)),
            true,
            parameter,
            true,
          )
          break
        }
        yield* invocation.declarePattern(parameter, args[index], true, parameter, true)
      }

      if (fn.body.type === "BlockStatement") {
        invocation.scopes.push()
        invocation.hoistVars(fn.body.body, paramScope)
        const result = yield* invocation.evaluateStatement(fn.body)
        return result.kind === "return" ? result.value : undefined
      }

      return yield* invocation.evaluateExpression(fn.body)
    })
    if (fn.generator) return Effect.succeed(this.createGenerator(invocation, run, fn.async))
    if (!fn.async) return run
    return this.runtime.promises.createWithSelf((self) =>
      Effect.flatMap(run, (value) => resolvePromiseValue(invocation.runtime.runner, value, fn.body, self)),
    )
  }

  private createGenerator(
    invocation: Frame<R>,
    run: Effect.Effect<unknown, unknown, R>,
    asynchronous: boolean,
  ): ProgramGenerator {
    const state: GeneratorState = { started: false, completed: false, draining: false, pending: [], pendingIndex: 0 }
    invocation.generatorState = state
    invocation.generatorAsync = asynchronous
    const protos = this.runtime.prototypes
    const result = (value: unknown, done: boolean) => record(protos.Object, { value, done })
    const request = (kind: GeneratorRequestKind, value: unknown, node: AstNode) => {
      const request = { kind, value, response: Deferred.makeUnsafe<unknown, unknown>() }
      if (!asynchronous && state.active) {
        return Effect.fail(new InterpreterRuntimeError("Generator is already running.", node))
      }
      if (asynchronous && (state.completed || (!state.started && kind !== "next"))) {
        state.started = true
        state.completed = true
        state.pending.push(request)
        if (state.draining) return Deferred.await(request.response)
        state.draining = true
        return Effect.andThen(
          this.runtime.promises.fork(
            invocation
              .completeGeneratorRequests(state, true)
              .pipe(Effect.ensuring(Effect.sync(() => (state.draining = false)))),
          ),
          Deferred.await(request.response),
        )
      }
      if (state.completed) {
        if (kind === "throw") return Effect.fail(new ProgramThrow(value))
        return Effect.succeed(result(kind === "return" ? value : undefined, true))
      }
      if (!state.started && kind !== "next") {
        state.completed = true
        if (kind === "throw") return Effect.fail(new ProgramThrow(value))
        return Effect.succeed(result(value, true))
      }

      state.pending.push(request)
      if (state.available) {
        const available = state.available
        state.available = undefined
        Deferred.doneUnsafe(available, Exit.succeed(undefined))
      }
      if (!state.started) {
        state.started = true
        const body = Effect.gen(function* () {
          state.active = yield* invocation.takeGeneratorRequest(state)
          const exit = yield* Effect.exit(
            run.pipe(
              Effect.flatMap((result) => (asynchronous ? invocation.awaitValue(result) : Effect.succeed(result))),
              Effect.catch((error) =>
                error instanceof GeneratorReturn
                  ? asynchronous
                    ? invocation.awaitValue(error.value)
                    : Effect.succeed(error.value)
                  : Effect.fail(error),
              ),
            ),
          )
          const active = state.active
          state.active = undefined
          if (active) {
            Deferred.doneUnsafe(active.response, Exit.isSuccess(exit) ? Exit.succeed(result(exit.value, true)) : exit)
          }
          yield* invocation.completeGeneratorRequests(state, asynchronous)
          state.completed = true
        })
        return Effect.andThen(this.runtime.promises.fork(body), Deferred.await(request.response))
      }
      return Deferred.await(request.response)
    }
    const generator = new ProgramGenerator(
      asynchronous ? protos.AsyncGenerator : protos.Generator,
      asynchronous,
      request,
    )
    return generator
  }

  private completeGeneratorRequests(state: GeneratorState, asynchronous: boolean): Effect.Effect<void, never, R> {
    const self = this
    const result = (value: unknown, done: boolean) => record(self.runtime.prototypes.Object, { value, done })
    return Effect.gen(function* () {
      while (true) {
        const pending = self.dequeueGeneratorRequest(state)
        if (!pending) return
        if (pending.kind === "throw") {
          Deferred.doneUnsafe(pending.response, Exit.fail(new ProgramThrow(pending.value)))
          continue
        }
        if (asynchronous && pending.kind === "return") {
          const resolved = yield* Effect.exit(self.awaitValue(pending.value))
          Deferred.doneUnsafe(
            pending.response,
            Exit.isSuccess(resolved) ? Exit.succeed(result(resolved.value, true)) : resolved,
          )
          continue
        }
        Deferred.doneUnsafe(
          pending.response,
          Exit.succeed(result(pending.kind === "return" ? pending.value : undefined, true)),
        )
      }
    })
  }

  private takeGeneratorRequest(state: GeneratorState): Effect.Effect<GeneratorRequest> {
    const next = this.dequeueGeneratorRequest(state)
    if (next) return Effect.succeed(next)
    state.available = Deferred.makeUnsafe<void>()
    return Effect.andThen(
      Deferred.await(state.available),
      Effect.sync(() => this.dequeueGeneratorRequest(state)!),
    )
  }

  private dequeueGeneratorRequest(state: GeneratorState): GeneratorRequest | undefined {
    const request = state.pending[state.pendingIndex]
    if (!request) return undefined
    state.pendingIndex += 1
    if (state.pendingIndex === state.pending.length) {
      state.pending = []
      state.pendingIndex = 0
    }
    return request
  }

  private evaluateYieldExpression(node: YieldExpression): Effect.Effect<unknown, unknown, R> {
    const argument = node.argument
    const self = this
    return Effect.gen(function* () {
      if (!self.generatorState) throw new InterpreterRuntimeError("yield is only valid inside a generator.", node)
      if (node.delegate) {
        const value = argument ? yield* self.evaluateExpression(argument) : undefined
        return yield* self.delegateYield(value, node)
      }
      const value = argument ? yield* self.evaluateExpression(argument) : undefined
      const yielded = self.generatorAsync ? yield* self.awaitValue(value) : value
      return yield* self.suspendGenerator(yielded, node)
    })
  }

  private suspendGenerator(value: unknown, node: AstNode): Effect.Effect<unknown, unknown, R> {
    const state = this.generatorState
    if (!state?.active) throw new InterpreterRuntimeError("Generator has no active request.", node)
    Deferred.doneUnsafe(
      state.active.response,
      Exit.succeed(record(this.runtime.prototypes.Object, { value, done: false })),
    )
    state.active = undefined
    return Effect.flatMap(this.takeGeneratorRequest(state), (request) => {
      state.active = request
      if (request.kind === "next") return Effect.succeed(request.value)
      if (request.kind === "throw") return Effect.fail(new ProgramThrow(request.value))
      return this.generatorAsync
        ? Effect.flatMap(this.awaitValue(request.value), (value) => Effect.fail(new GeneratorReturn(value)))
        : Effect.fail(new GeneratorReturn(request.value))
    })
  }

  private delegateYield(value: unknown, node: AstNode): Effect.Effect<unknown, unknown, R> {
    const self = this
    return Effect.gen(function* () {
      if (
        value instanceof ProgramArray ||
        typeof value === "string" ||
        value instanceof ProgramMap ||
        value instanceof ProgramSet ||
        value instanceof ProgramURLSearchParams
      ) {
        const cursor = yield* self.syncIterator(value, node)
        if (!cursor) throw new InterpreterRuntimeError("Built-in iterator is unavailable.", node)
        while (true) {
          const step = yield* cursor.next
          if (step.done) return undefined
          const resumed = yield* Effect.exit(
            self.suspendGenerator(self.generatorAsync ? yield* self.awaitValue(step.value) : step.value, node),
          )
          if (Exit.isSuccess(resumed)) continue
          const error = Cause.squash(resumed.cause)
          if (error instanceof GeneratorReturn) {
            yield* cursor.close
            return yield* Effect.fail(error)
          }
          if (error instanceof ProgramThrow) {
            yield* cursor.close
            throw new InterpreterRuntimeError("The delegated iterator does not provide a throw() method.", node)
          }
          return yield* Effect.failCause(resumed.cause)
        }
      }

      const iterator = yield* self.customIterator(value, node, self.generatorAsync)
      if (!iterator) throw new InterpreterRuntimeError("yield* requires a compatible iterable value.", node)
      let kind: GeneratorRequestKind = "next"
      let input: unknown = undefined
      while (true) {
        const method = kind === "next" ? iterator.next : get(iterator.iterator, kind)
        if (method === undefined || method === null) {
          if (kind === "return") return yield* Effect.fail(new GeneratorReturn(input))
          yield* self.closeIterator(iterator, node, self.generatorAsync)
          throw new InterpreterRuntimeError("The delegated iterator does not provide a throw() method.", node)
        }
        const called = yield* self.invokeCallable(
          self.requireIteratorMethod(method, `Iterator ${kind}`, node),
          iterator.iterator,
          [input],
          node,
        )
        const result = self.requireIteratorObject(
          iterator.asynchronous ? yield* self.awaitValue(called) : called,
          `Iterator ${kind}() result`,
          node,
        )
        const done = Boolean(get(result, "done"))
        const resultValue: unknown =
          self.generatorAsync && !iterator.asynchronous
            ? yield* self.awaitAsyncFromSyncValue(iterator, get(result, "value"), node, kind !== "return" && !done)
            : get(result, "value")
        if (done) {
          if (kind === "return") return yield* Effect.fail(new GeneratorReturn(resultValue))
          return resultValue
        }

        const resumed: Exit.Exit<unknown, unknown> = yield* Effect.exit(self.suspendGenerator(resultValue, node))
        if (Exit.isSuccess(resumed)) {
          kind = "next"
          input = resumed.value
          continue
        }
        const error: unknown = Cause.squash(resumed.cause)
        if (!(error instanceof GeneratorReturn) && !(error instanceof ProgramThrow)) {
          return yield* Effect.failCause(resumed.cause)
        }
        kind = error instanceof GeneratorReturn ? "return" : "throw"
        input = error.value
      }
    })
  }

  private evaluateObjectExpression(node: ObjectExpression): Effect.Effect<ProgramObject, unknown, R> {
    const objectValue = new ProgramObject(this.runtime.prototypes.Object)
    const self = this
    return Effect.gen(function* () {
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          const spread = yield* self.evaluateExpression(property.argument)
          if (spread === null || spread === undefined) continue
          assign(objectValue, enumerableSource(self.runtime.runner, "Object spread", spread, property))
          continue
        }

        if (property.kind !== "init") {
          throw new InterpreterRuntimeError("Only init object properties are supported.", property)
        }

        const keyNode = property.key

        let key: PropertyKey

        if (property.computed) {
          key = self.toPropertyKey(yield* self.evaluateExpression(keyNode), keyNode)
        } else if (keyNode.type === "Identifier") {
          key = keyNode.name
        } else if (keyNode.type === "Literal") {
          key = self.toPropertyKey(keyNode.value, keyNode)
        } else {
          throw new InterpreterRuntimeError("Unsupported object property key shape.", keyNode)
        }

        const name =
          key === IteratorSymbol
            ? "[Symbol.iterator]"
            : key === AsyncIteratorSymbol
              ? "[Symbol.asyncIterator]"
              : String(key)
        define(objectValue, key, yield* self.evaluateNamed(property.value, name))
      }

      return objectValue
    })
  }

  private evaluateArrayExpression(node: ArrayExpression): Effect.Effect<ProgramArray, unknown, R> {
    const values: Array<unknown> = []

    const self = this
    return Effect.gen(function* () {
      for (const element of node.elements) {
        if (element === null) {
          // A literal elision is a real hole, like JS: extend length without an own index.
          values.length += 1
          continue
        }
        if (element.type === "SpreadElement") {
          const spread = yield* self.evaluateExpression(element.argument)
          const cursor = yield* self.syncIterator(spread, element)
          if (cursor === undefined)
            throw new InterpreterRuntimeError("Array spread requires a synchronous iterable.", element)
          while (true) {
            const step = yield* cursor.next
            if (step.done) break
            values.push(step.value)
          }
        } else {
          values.push(yield* self.evaluateExpression(element))
        }
      }
      return new ProgramArray(self.runtime.prototypes.Array, values)
    })
  }

  private evaluateTemplateLiteral(node: TemplateLiteral): Effect.Effect<string, unknown, R> {
    const quasis = node.quasis
    const expressions = node.expressions

    let output = ""

    const self = this
    return Effect.gen(function* () {
      for (let index = 0; index < quasis.length; index += 1) {
        const quasi = quasis[index]!
        // acorn only omits `cooked` for invalid escapes in tagged templates, which are unsupported.
        if (typeof quasi.value.cooked !== "string") {
          throw new InterpreterRuntimeError("Invalid template literal quasi.", quasi)
        }
        output += quasi.value.cooked

        if (index < expressions.length) {
          const raw = yield* self.evaluateExpression(expressions[index])
          output += coerceToString(toProgram(self.runtime.prototypes, raw, "Template interpolation"))
        }
      }

      return output
    })
  }

  private evaluateConditionalExpression(node: ConditionalExpression): Effect.Effect<unknown, unknown, R> {
    return Effect.flatMap(this.evaluateExpression(node.test), (test) =>
      this.evaluateExpression(test ? node.consequent : node.alternate),
    )
  }

  private applyCompoundAssignment(operator: string, current: unknown, incoming: unknown, node: AstNode): unknown {
    if (!compoundOperators.has(operator)) {
      throw new InterpreterRuntimeError(`Unsupported assignment operator '${operator}'.`, node)
    }
    return this.applyBinaryOperator(operator.slice(0, -1), current, incoming, node)
  }

  private getMemberReference(
    node: MemberExpression,
  ): Effect.Effect<MemberReference | ToolReference | { value: unknown } | typeof OptionalShortCircuit, unknown, R> {
    const objectNode = node.object
    const propertyNode = node.property
    if (objectNode.type === "Super") throw unsupportedSyntax(objectNode.type, objectNode)
    if (propertyNode.type === "PrivateIdentifier") throw unsupportedSyntax(propertyNode.type, propertyNode)
    const self = this
    return Effect.gen(function* () {
      const objectValue = yield* self.evaluateExpression(objectNode)
      if (objectValue === OptionalShortCircuit) return OptionalShortCircuit
      if ((objectValue === null || objectValue === undefined) && node.optional) return OptionalShortCircuit

      const key = node.computed
        ? self.toPropertyKey(yield* self.evaluateExpression(propertyNode), propertyNode)
        : propertyNode.type === "Identifier"
          ? propertyNode.name
          : self.toPropertyKey(yield* self.evaluateExpression(propertyNode), propertyNode)

      if (objectValue instanceof ToolReference) {
        if (typeof key !== "string") {
          throw new InterpreterRuntimeError("Tool paths must use string property names.", propertyNode)
        }
        return new ToolReference([...objectValue.path, key])
      }

      if (objectValue instanceof ProgramObject) return { target: objectValue, key, receiver: objectValue }

      // Primitives read through their wrapper prototype without being boxed; strings own length and indexes.
      const protos = self.runtime.prototypes
      if (typeof objectValue === "string") {
        if (key === "length") return { value: objectValue.length }
        const index = typeof key === "symbol" ? undefined : parseArrayIndex(key)
        if (index !== undefined) return { value: objectValue[index] }
        return { target: protos.String, key, receiver: objectValue }
      }
      if (typeof objectValue === "number") return { target: protos.Number, key, receiver: objectValue }
      if (typeof objectValue === "boolean") return { target: protos.Boolean, key, receiver: objectValue }

      if (objectValue === null || objectValue === undefined) {
        throw new InterpreterRuntimeError(
          `Cannot read properties of ${objectValue} (reading '${String(key)}').`,
          objectNode,
        )
      }
      throw new InterpreterRuntimeError("Cannot access a property on a non-object value.", objectNode)
    })
  }

  private readReference(reference: MemberReference, node: MemberExpression): unknown {
    // Reject unknown promise properties so a missing await cannot hide.
    if (reference.target instanceof ProgramPromise && !has(reference.target, reference.key)) {
      throw new InterpreterRuntimeError(
        "This value is an un-awaited Promise; await it first - e.g. `const result = await tools.ns.tool(...)`.",
        node.object,
        "InvalidDataValue",
      )
    }
    try {
      return get(reference.target, reference.key, reference.receiver)
    } catch (error) {
      throw locate(error, node)
    }
  }

  private readMember(node: MemberExpression): Effect.Effect<unknown, unknown, R> {
    return Effect.map(this.getMemberReference(node), (reference) => {
      if (reference === OptionalShortCircuit) return OptionalShortCircuit
      if (reference instanceof ToolReference) return reference
      if ("value" in reference) return reference.value
      return this.readReference(reference, node)
    })
  }

  private writeMember(node: MemberExpression, value: unknown): Effect.Effect<unknown, unknown, R> {
    return this.modifyMember(node, () => Effect.succeed({ write: true, next: value, result: value }))
  }

  private evaluateDeleteExpression(argument: Expression): Effect.Effect<boolean, unknown, R> {
    const target = argument.type === "ChainExpression" ? argument.expression : argument
    if (target.type !== "MemberExpression") {
      throw new InterpreterRuntimeError("Only data fields may be deleted.", argument)
    }
    return Effect.map(this.getMemberReference(target), (reference) => {
      if (reference === OptionalShortCircuit) return true
      if (reference instanceof ToolReference || "value" in reference || reference.receiver !== reference.target) {
        throw new InterpreterRuntimeError("Only data fields may be deleted.", target, "InvalidDataValue")
      }
      if (remove(reference.target, reference.key)) return true
      throw new InterpreterRuntimeError(`Cannot delete property '${String(reference.key)}'.`, target)
    })
  }

  // Resolve side-effecting object and key expressions exactly once.
  private modifyMember(
    node: MemberExpression,
    compute: (current: unknown) => Effect.Effect<{ write: boolean; next: unknown; result: unknown }, unknown, R>,
  ): Effect.Effect<unknown, unknown, R> {
    const self = this
    return Effect.gen(function* () {
      const reference = yield* self.getMemberReference(node)
      if (reference === OptionalShortCircuit || reference instanceof ToolReference || "value" in reference) {
        throw new InterpreterRuntimeError("Only data fields may be assigned.", node)
      }
      if (reference.receiver !== reference.target) {
        throw new InterpreterRuntimeError(
          `Cannot create property '${String(reference.key)}' on ${typeof reference.receiver} '${String(reference.receiver)}'.`,
          node,
        )
      }
      const key = reference.key
      const { write, next, result } = yield* compute(self.readReference(reference, node))
      if (write) self.assignToReference(reference.target, key, next, node)
      return result
    })
  }

  private assignToReference(target: ProgramObject, key: PropertyKey, next: unknown, node: AstNode): void {
    rejectCircularInsertion(
      target,
      next,
      target instanceof ProgramArray ? "Array assignment result" : "Object assignment result",
      node,
    )
    const written = (() => {
      try {
        return set(target, key, next)
      } catch (error) {
        throw locate(error, node)
      }
    })()
    if (written) return
    if (target instanceof ProgramArray && key === "length") throw rangeError("Invalid array length", node)
    throw new InterpreterRuntimeError(`Cannot assign to read only property '${String(key)}'.`, node)
  }

  private toPropertyKey(value: unknown, node: AstNode): PropertyKey {
    if (typeof value === "string" || typeof value === "number") {
      return value
    }
    if (value === AsyncIteratorSymbol || value === IteratorSymbol) return value

    throw new InterpreterRuntimeError(
      "Property key must be a string or number, or Symbol.asyncIterator/Symbol.iterator.",
      node,
    )
  }
}
