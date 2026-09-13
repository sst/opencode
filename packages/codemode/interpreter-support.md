# CodeMode Interpreter Support

This is the checkable support matrix for CodeMode's confined JavaScript interpreter. It tracks the language and
standard-library surface that programs can use today, plus concrete gaps that may be implemented later.

- `[x]` means the feature is implemented at the scope described here.
- `[ ]` means a concrete compatibility gap remains.
- Checked items do not promise complete ECMAScript edge-case parity; known differences are stated explicitly.
- Intentional boundaries are not listed as compatibility work.

When behavior changes, update this file and the tests in the same change. The implementation and tests remain the
ultimate source of truth. Upstream test262 files run verbatim from `test/test262`; a failing file is listed in
`test/test262/skipped.txt` and its gap is an unchecked item here (see `test/test262/README.md`).

## Source and execution model

- [x] JavaScript parsed with the latest syntax accepted by Acorn, then restricted by the interpreter allowlist.
- [x] Erasable TypeScript syntax, including type annotations, type declarations, assertions, and non-null assertions.
      TypeScript is transpiled first; the emitted JavaScript must still use the supported subset.
- [x] Top-level `await` and `return` through the program's implicit async-function scope.
- [x] Explicit `return`, final top-level expression as a REPL-style result, and `null` when no value is produced.
- [x] Program results use JSON-like boundaries, with `undefined` and non-finite numbers normalized to `null`. Tool
      arguments follow JSON serialization semantics before their schema applies (see the tools section).
- [x] Live Date, RegExp, Map, Set, URL, and URLSearchParams values inside CodeMode.
- [x] Tool calls through the host-provided `tools` tree only.
- [x] The global `search(...)` built-in: synchronous tool discovery that counts as an admitted tool call and is
      shadowable by program declarations like other globals.
- [x] Cooperative timeout, an optional total tool-call limit, output bounding, and unrestricted tool-call concurrency.
- [ ] Strict-mode early errors: duplicate parameter names, `yield` as an identifier, and a trailing comma after a
      rest parameter are accepted unless the program itself begins with `"use strict"`.
- [ ] Valid JavaScript rejected by TypeScript transpilation before interpretation, such as `in` inside a destructuring
      default in a `for...of` head and Unicode-escaped keywords.

## Values and literals

- [x] `null`, `undefined`, booleans, finite and non-finite numbers, and strings.
- [x] Array literals, including holes and spread from arrays, strings, Maps, Sets, URLSearchParams, custom synchronous
      iterators, and synchronous generators.
- [x] Object literals with shorthand, computed string/number keys, and spread following ToObject: data objects and
      arrays copy own enumerable keys, strings copy index keys, and other values contribute nothing.
- [x] Template literals with interpolation.
- [x] Regular-expression literals.
- [x] `NaN` and `Infinity` globals.
- [ ] BigInt literals and in-interpreter BigInt arithmetic; BigInt remains invalid at JSON-like host boundaries.
- [ ] Arbitrary Symbol primitive values and symbol-keyed properties. The confined `Symbol.iterator` and
      `Symbol.asyncIterator` keys are available only for custom iterator protocols.
- [ ] Tagged-template calls.
- [ ] Getter and setter definitions in object literals.

## Bindings and destructuring

- [x] `const`, `let`, and `var` declarations.
- [x] Object and array destructuring in declarations, parameters, assignment expressions, and `for...of` bindings.
- [x] Nested patterns, defaults, elisions, and rest elements.
- [x] Assignment to identifiers, plain-object fields, non-negative integer array indexes, and writable URL
      fields.
- [x] Direct function declarations are hoisted in program and block statement lists.
- [x] Parameter defaults observe a temporal dead zone for later parameters.
- [x] `var` is function-scoped and hoisted: names declared anywhere in a function or program body, including loop
      heads, blocks, `switch` cases, and `try`/`catch`, read as `undefined` before their statement runs; redeclaration
      assigns the one binding; a same-named parameter keeps its argument; closures in parameter defaults see outer
      names rather than body `var`s.
- [x] Predeclare `let` and `const` bindings in every lexical scope, including program/block bodies, switch bodies, and
      loop headers, so reads before initialization and self- or cross-referential initializers observe the JavaScript
      temporal dead zone.
- [x] Function declarations are hoisted across all cases of a `switch`, like any other statement list.
- [x] Computed object destructuring keys such as `const { [field]: value } = record`.
- [x] Object destructuring from arrays, such as `const { length } = values`.
- [x] Array binding and assignment destructuring from strings, Maps, Sets, URLSearchParams, custom synchronous
      iterators, and synchronous generators, including stepwise elisions/rest and `IteratorClose` on early completion
      or binding/default failure.
- [ ] Object destructuring from primitives follows ToObject (`const { length } = "abc"`, `const {} = 1`); non-object
      sources are rejected.
- [x] Destructuring reads through the prototype chain like member access: `const { constructor } = error` and
      `const { slice } = values` find the inherited built-in.
- [ ] Member expressions as `for...in` targets (`for (x.y in obj)`).
- [ ] `IteratorClose` during destructuring should throw a `TypeError` when `return()` yields a non-object.

## Statements and control flow

- [x] Blocks and empty statements.
- [x] `if`/`else` and conditional expressions.
- [x] `switch`, including default clauses and fallthrough.
- [x] `for`, `while`, and `do...while`.
- [x] `for...of` over arrays, strings, Maps, Sets, URLSearchParams, custom synchronous iterators, and confined
      synchronous generators. Abrupt completion invokes the iterator's optional `return()`.
- [x] `for...in` over own keys of plain objects, arrays, strings, and tool references; other values iterate nothing.
- [x] Unlabeled `break` and `continue`.
- [x] `try`, `catch`, optional catch bindings, and `finally`.
- [x] `throw` with arbitrary values.
- [x] Labeled statements, labeled `break`, and labeled `continue`.
- [x] `for await...of` over the supported synchronous collections and custom iterator objects using
      `Symbol.asyncIterator` or the `Symbol.iterator` fallback. Each iterator step is sequential, yielded promises and
      plain values from synchronous collections and sync iterators are awaited before binding, and abrupt loop
      completion invokes the iterator's optional `return()`. Custom async iterators control their yielded values, as in
      JavaScript; only their `next()` results are awaited. Confined sync and async generators are iterable here.

## Functions and callbacks

- [x] Function declarations, function expressions, and arrow functions.
- [x] Synchronous and `async` functions.
- [x] Closures, recursion, default parameters, rest parameters, and destructured parameters.
- [x] Expression and block function bodies.
- [x] User callbacks for the supported Array, Map, Set, URLSearchParams, sort, string-replacement, and `Array.from`
      mapper APIs, with one shared acceptance rule everywhere including promise reactions.
- [x] `Boolean`, `Number`, `String`, `parseInt`, `parseFloat`, `isFinite`, `isNaN`, and URI helpers as callbacks.
- [x] Built-in method references as callbacks, such as `values.map(Math.abs)`, `records.map(JSON.stringify)`,
      `items.forEach(console.log)`, and `Promise.resolve(-1).then(Math.abs)`. Extra callback arguments a built-in
      does not consume are ignored, like JS; consumed arguments stay strictly validated (`Math.floor` still rejects a
      string). A detached method loses its receiver, as in JS: `values.filter("abc".includes)` is a `TypeError`
      because `includes` is called without a string `this`.
- [x] Constructors work as callbacks with JS call semantics: `Error` types construct (`messages.map(Error)`),
      and new-requiring constructors (`Map`, `Set`, `URL`, `URLSearchParams`, `Promise`) throw a `TypeError`,
      like JS.
- [x] Tool references and detached `Promise` statics are rejected as callbacks with a hint to wrap them in an
      arrow function.
- [x] Promise-returning string replacers are coerced synchronously to `"[object Promise]"`, like JavaScript; they are
      not automatically awaited.
- [x] The optional `thisArg` of iteration methods is accepted and ignored: CodeMode functions have no `this`, so
      ignoring it matches JS arrow-function semantics exactly.
- [ ] `this` in non-arrow CodeMode functions and callbacks.
- [ ] User-defined constructor calls.
- [ ] `Function.prototype.call`, `apply`, and `bind` for CodeMode functions.
- [ ] Classes and private fields.
- [x] Functions are objects: they hold own properties (`fn.count = 1`), enumerate them, and expose read-only `name`
      and `length`. Names follow JavaScript's NamedEvaluation: declarations, named expressions, bindings,
      assignments, object literal keys, and destructuring or parameter defaults.
- [x] Built-in functions are objects too, with `name` and `length` (`Math.max.length === 2`,
      `Array.prototype.push.name === "push"`).
- [ ] A named function expression's name is not bound inside its own body.
- [ ] Redeclaring a function in the same scope is rejected; in JavaScript the last declaration wins.
- [ ] A line terminator between `async function` and the function name.
- [ ] Generator and async generator functions evaluate parameter defaults and destructuring at the first `next()`
      rather than at the call, so their errors are not thrown synchronously.
- [x] Synchronous and async generator declarations/expressions, `yield`, and `yield*`, including lazy bodies,
      `next(value)`, `return(value)`, `throw(value)`, exhaustion, promise adoption, async request ordering,
      `try`/`catch`/`finally`, and sync/async iterator symbols. Async `yield*` awaits values while adapting a sync
      iterator but preserves values supplied by a manually implemented async iterator. Generator values are opaque
      runtime references.
- [x] Synchronous generators and custom synchronous iterators are consumed stepwise by array/argument spread, array
      destructuring, `Array.from`, Map/Set/URLSearchParams construction, `Object.fromEntries`, Object/Map `groupBy`,
      Promise combinators, `AggregateError`, and `Math.sumPrecise`. Mapper/grouping callbacks interleave with iterator
      steps; synchronous consumers preserve yielded promise objects rather than awaiting them. Async generators are
      rejected by every synchronous consumer.
- [x] Synchronous iterator acquisition and result validation follow `IteratorClose` boundaries: consumer errors and
      intentional early stops invoke `return()`, acquisition/`next()` failures do not, and an original consumer error
      wins over a cleanup failure. Async iterator consumption remains limited to `for await...of` and async `yield*`.
- [x] Portable generator protocol coverage is adapted from pinned Test262 cases for suspended-start, suspended-yield,
      and completed states; sync and async `next`/`return`/`throw`; finally yields and completion overrides; rejected
      yielded promises; mixed async request queues; sync and async `yield*` forwarding; malformed methods/results;
      and declaration, expression, and object-method forms with closure and parameter behavior. The adapted suite
      deliberately skips Test262 variants whose observation mechanism requires unsupported getter definitions,
      proxies, prototype inspection or mutation, non-arrow `this`, classes, or arbitrary symbols. It also skips tests
      asserting exact promise reaction-turn counts beyond the observable ordering guarantee documented below. These
      are interpreter-surface boundaries, not claims that the corresponding full Test262 families pass unchanged.

## Expressions and operators

- [x] Property access with dot or computed bracket syntax.
- [x] Optional property access and optional calls.
- [x] Function/tool calls and spread arguments.
- [x] Sequence expressions (the comma operator).
- [x] `await` for CodeMode promises and callable thenables; a plain value passes through unchanged, though every
      `await` still defers its continuation one reaction turn.
- [x] `new` for Array, Object, Error types, Date, RegExp, Map, Set, URL, URLSearchParams, and Promise. `new` on any
      other value throws a catchable `TypeError` naming the callee: other built-in functions such as `Number` say
      `new` is unsupported and point at the plain call, user-defined functions report the constructor gap below, and
      non-callable values are not constructors.
- [x] Arithmetic operators: `+`, `-`, `*`, `/`, `%`, and `**`.
- [x] Equality and ordering: `==`, `!=`, `===`, `!==`, `<`, `<=`, `>`, and `>=`.
- [x] Bitwise operators: `&`, `|`, `^`, `~`, `<<`, `>>`, and `>>>`.
- [x] Logical operators: `&&`, `||`, `??`, and `!`, with short-circuiting.
- [x] Unary `+`, unary `-`, `void`, `typeof`, `instanceof` (through the constructor's `prototype`, so
      `[] instanceof Object` holds), and `in` across the prototype chain.
- [x] Prefix and postfix `++` and `--`.
- [x] Plain, arithmetic, bitwise, and logical assignment operators.
- [x] Property deletion on plain data objects and arrays, including computed and optional forms; deleting an array index
      creates a hole without changing its length. Deleting a non-configurable property (`length`, `lastIndex`) or
      assigning a read-only one (`Math.PI`, `fn.name`) throws a `TypeError`, as in strict mode.
- [ ] Operators, `switch` discriminants, template interpolation, and coercion helpers such as `String` and `isNaN`
      applied to functions and namespaces; JavaScript coerces them, the interpreter rejects non-data operands.
- [ ] ToPrimitive on object operands: operators, `Error(message)`, `Date` arguments, and `parseInt` radix should call
      `valueOf`/`toString` in spec order and surface their throws.
- [ ] Property keys follow ToPropertyKey: `x[null]`, `x[true]`, and objects (via `toString`) become string keys; only
      strings and numbers are accepted.

## Promises and tools

- [x] Tool calls start eagerly and return supervised, run-once CodeMode promises.
- [x] Direct `await`, repeated awaits, and recursive thenable assimilation when a promise or thenable is returned from
      a function/program.
- [x] `Promise.resolve` and `Promise.reject`.
- [x] `Promise.all`, `Promise.allSettled`, `Promise.race`, and `Promise.any` over finite collections, custom synchronous
      iterators, and synchronous generators containing promises and plain values.
- [x] `Promise.all` preserves result order and rejects on the first observed failure without cancelling siblings.
- [x] `Promise.allSettled` returns plain fulfilled/rejected outcome records.
- [x] `Promise.race` settles from the first result without cancelling losers at settlement time.
- [x] Real promise values from `Promise.all`, `Promise.allSettled`, and `Promise.race`; separately constructed
      combinator batches overlap as in normal JavaScript.
- [x] Promise chaining with `.then`, `.catch`, and `.finally`: handlers run deferred in attach order, returned
      promises are adopted, handler throws reject the derived promise, `.finally` preserves the original settlement
      unless its cleanup fails, and direct self-resolution rejects with a `TypeError`.
- [x] Every `await` (including of plain values and already-settled promises) defers its continuation one reaction
      turn, so concurrent async functions interleave at await points as in JavaScript.
- [x] Combinators settle one reaction turn after their deciding member (V8-observable ordering): reactions already
      attached to members run first, and an aggregate cannot beat a plain value settling in the same turn into a
      `Promise.race`. Exact microtask-count parity beyond this observable ordering is not a documented guarantee.
- [x] All still-pending work (race losers, fail-fast `Promise.all` stragglers, and un-awaited calls alike) is
      interrupted when the program returns; rejections that settled un-awaited become `Success.warnings`
      diagnostics. A combinator abandoned inside its final settlement turn counts as pending and is interrupted
      without a warning.
- [x] `try`/`catch` can handle awaited tool and promise failures.
- [x] `Promise.any`: first fulfillment wins; all-rejected rejects with an `AggregateError` whose `errors` array holds
      the catch-normalized reasons in input order, and empty input rejects with an empty `AggregateError`.
- [x] `new Promise((resolve, reject) => ...)`: the executor runs synchronously and receives first-class resolve/reject
      callables that settle the promise exactly once (they may escape the executor and settle later); an executor
      throw rejects unless the promise already settled, resolving with a promise or callable thenable adopts it, and
      resolving with the promise itself rejects with a `TypeError`. Resolver callables work anywhere callbacks are
      accepted, including `.then`/`.catch` handlers and collection callbacks, but remain opaque references that cannot
      cross the data boundary.
- [x] Recursive assimilation of objects with an own callable `then` field across `Promise.resolve`, combinators,
      constructors, reactions, `finally`, `await`, and async returns. Thenable methods run deferred, receive
      first-call-wins resolve/reject functions, and ignore throws after settlement. Inherited/accessor `then` fields
      and a JavaScript `this` receiver remain outside the supported object/function model.
- [x] Dotted tool names are canonicalized into namespace paths; a path can be both callable and a namespace, and the
      last tool supplied for a canonical path wins.
- [x] Tool path segments may be named `constructor`, `prototype`, or `__proto__` because paths use inert Map keys.
- [x] Outbound tool arguments follow JSON serialization semantics, like `JSON.stringify`: object properties with
      `undefined` values are dropped, `undefined` array elements and non-finite numbers become `null`, and sparse
      arrays densify. Tools never receive `undefined` inside their input object, though a bare `tools.t(undefined)`
      argument still reaches schema decoding as `undefined`. Program results keep the stricter
      normalization where every `undefined` becomes `null`.
- [ ] Tokenize and case-fold non-ASCII tool paths, descriptions, and queries for tool search.

## Objects and properties

- [x] Own-field reads and writes on plain data objects.
- [x] `new` dispatches on the evaluated constructor value, so aliases (`const D = Date; new D()`), constructors held in
      objects, and constructors passed as arguments work, while a shadowed name (`const Date = 5; new Date()`) does
      not construct.
- [x] `Object()` and `new Object()` return `{}` for nullish arguments and pass objects through unchanged;
      primitive wrapper objects (`Object(1)`) are rejected explicitly.
- [x] Computed property names and object spread.
- [x] `Object.keys`, `Object.values`, `Object.entries`, `Object.hasOwn`, `Object.assign`, and `Object.fromEntries`, with
      synchronous iterator support for `fromEntries`. Sources follow ToObject: strings enumerate by index, other
      primitives and wrappers contribute nothing, and `null`/`undefined` throw. `Object.assign` accepts array
      targets for index keys only; a primitive target is a `TypeError` rather than a boxed object.
- [x] `Object.keys` over arrays and tool references.
- [x] Object identity is preserved by in-CodeMode Object helpers.
- [x] Every value has a real prototype chain built fresh for each run: `Object.prototype`, `Array.prototype`,
      `String.prototype`, `Error.prototype` → `TypeError.prototype`, and so on hold the built-in methods as
      non-enumerable properties, and each constructor's `prototype` points at it (`[].constructor === Array`,
      `Object.getPrototypeOf` is not exposed). Programs may read and even overwrite these prototypes; the change is
      confined to that run. `__proto__` is an ordinary own data key, so `o.__proto__ = x` never changes the chain, and
      `Object.groupBy` results have no prototype at all, as in JS.
- [x] Circular references are rejected when created (`o.self = o`, `array.push(array)`), not at serialization as in JS.
- [x] `Object.is` for supported data values.
- [x] `Object.groupBy` over finite collections and custom synchronous iterators/generators, with string-key coercion
      and plain-object results.
- [x] `Object.prototype` methods on values: `toString` (`"[object Array]"`), `toLocaleString`, `valueOf`,
      `hasOwnProperty`, `isPrototypeOf`, and `propertyIsEnumerable`.

## Arrays

- [x] The `Array` constructor with or without `new`: `Array(a, b)` collects arguments and `Array(n)` creates a sparse
      array of that length; invalid lengths throw `RangeError`. Iteration, spread, join, and JSON handle holes like
      JavaScript, and host results normalize holes to `null`.
- [x] Static methods: `Array.isArray`, `Array.of`, and `Array.from`, including the `Array.from` mapper form with
      `(value, index)` arguments and stepwise synchronous iterator consumption.
- [x] Iteration/transformation: `map`, `filter`, `flatMap`, and `forEach`.
- [x] Searching/tests: `find`, `findIndex`, `findLast`, `findLastIndex`, `some`, `every`, `includes`, `indexOf`, and
      `lastIndexOf`.
- [x] Aggregation: `reduce` and `reduceRight`.
- [x] Ordering: `sort`, `toSorted`, `reverse`, and `toReversed`.
- [x] Access/copying: `at`, `slice`, `concat`, `flat`, `with`, and `join`.
- [x] Mutation: `push`, `pop`, `shift`, `unshift`, `splice`, `fill`, and `copyWithin`.
- [x] Materialized iteration helpers: `keys`, `values`, and `entries` return arrays rather than iterators.
- [x] `length`, numeric indexing, index assignment, spread, and `for...of`.
- [x] The `thisArg` argument of `Array.from` is accepted and ignored, like JS arrows.
- [x] `Array.prototype.toSpliced`.
- [x] Canonical array/string index parsing: keys such as `"01"` are ordinary properties rather than aliases of index
      `1`.
- [x] `Array.prototype.sort` preserves trailing holes, while `toSorted` densifies holes into `undefined` elements,
      like JavaScript.
- [x] Assigning `length` to truncate or extend an array; invalid lengths throw `RangeError`.
- [x] Non-index own properties on arrays (`arr.foo = 1`, `arr.constructor = null`). They are excluded from the JSON
      form, like `JSON.stringify`.
- [ ] Argument coercion for `indexOf`, `lastIndexOf`, `includes`, `fill`, `flat`, `copyWithin`, and the `join`
      separator: JavaScript applies ToIntegerOrInfinity/ToString (including `valueOf`, strings, and `undefined`), the
      interpreter requires numbers and strings; `includes()`/`indexOf()` with no argument should search for
      `undefined`.
- [ ] Iterator objects from `keys`, `values`, and `entries` with a live `next()`.

## Strings

- [x] Case/normalization: `toLowerCase`, `toUpperCase`, `normalize`.
- [x] Trimming: `trim`, `trimStart`, and `trimEnd`, plus the Annex B `trimLeft` and `trimRight` aliases.
- [x] Searching/tests: `includes`, `startsWith`, `endsWith`, `indexOf`, `lastIndexOf`, and `search`.
- [x] Slicing/access: `slice`, `substring`, Annex B `substr`, `at`, `charAt`, `charCodeAt`, and `codePointAt`.
- [x] Construction/transformation: `split`, `concat`, `repeat`, `padStart`, `padEnd`, `replace`, and `replaceAll`.
- [x] Regular-expression integration: `match`, materialized `matchAll`, `replace`, `replaceAll`, `split`, and `search`.
- [x] `localeCompare`; locale and options arguments are currently ignored.
- [x] `isWellFormed` and `toWellFormed`.
- [x] `toString`, `length`, numeric indexing, spread, and `for...of` by Unicode code point.
- [x] Static `String.fromCharCode` and `String.fromCodePoint`.
- [x] Native argument coercion for supported String methods; for example, `includes(1)` and `slice("1")` coerce like
      native JS, `split(undefined)` returns the whole string, and `includes`/`startsWith`/`endsWith` reject regular
      expressions with a native-style `TypeError`. Opaque runtime references still reject as data errors, and
      `repeat` still requires a finite non-negative count.
- [x] Native no-argument parity for `match()`, `matchAll()`, and `search()`; all behave as an empty pattern. Present
      arguments must still be a regular expression or string pattern.
- [ ] `String.raw`.
- [ ] `match`, `search`, and `split` accept any value and coerce it (objects via `toString`), like JavaScript.

## Numbers and Math

- [x] Coercion functions: `Number`, `parseInt`, and `parseFloat`.
- [x] Number predicates/parsers: `Number.isInteger`, `Number.isFinite`, `Number.isNaN`, `Number.isSafeInteger`,
      `Number.parseInt`, and `Number.parseFloat`.
- [x] Number formatting: `toFixed`, `toPrecision`, `toExponential`, `toString`, and `valueOf`.
- [x] Number constants: `MAX_SAFE_INTEGER`, `MIN_SAFE_INTEGER`, `MAX_VALUE`, `MIN_VALUE`, `EPSILON`, `NaN`,
      `POSITIVE_INFINITY`, and `NEGATIVE_INFINITY`.
- [x] Math constants: `PI`, `E`, `LN2`, `LN10`, `LOG2E`, `LOG10E`, `SQRT2`, and `SQRT1_2`.
- [x] Math methods: `random`, `max`, `min`, `abs`, `acos`, `acosh`, `asin`, `asinh`, `atan`, `atan2`, `atanh`,
      `floor`, `ceil`, `round`, `trunc`, `sign`, `sqrt`, `cbrt`, `pow`, `hypot`, `cos`, `cosh`, `sin`, `sinh`,
      `tan`, `tanh`, `log`, `log2`, `log10`, `log1p`, `exp`, `expm1`, `f16round`, `fround`, `clz32`, and `imul`.
- [x] Native zero-argument behavior for `Number()` and `String()`: they produce `0` and `""`, while
      `Number(undefined)` stays `NaN` and `String(undefined)` stays `"undefined"`.
- [x] `++` and `--` use CodeMode numeric coercion (numeric strings increment, plain data objects become `NaN`, Dates
      use their epoch time) and reject opaque runtime references as data errors.
- [x] Unknown static members on global namespaces and on `Number`/`String`/the coercion functions read as `undefined`
      for feature detection. Calling any undefined value reports a native-style `TypeError` naming the callee, for
      example `Math.sum is not a function.` Unknown `Promise` statics keep their descriptive error.
- [x] `Math.sumPrecise` over finite collections and custom synchronous iterators/generators, rejecting non-number
      elements without coercion.
- [x] Global coercing `isFinite` and `isNaN`; opaque runtime references reject as data errors, like `Number(...)`.

## JSON and console

- [x] `JSON.parse` and `JSON.stringify` for supported data objects.
- [x] Numeric/string indentation for `JSON.stringify`.
- [x] `JSON.parse` reviver callbacks, including postorder traversal, deletion through `undefined`, and root replacement.
      Revivers receive `(key, value)` but no `this` holder because CodeMode functions intentionally have no `this`.
- [x] `JSON.stringify` function and array replacers. Function replacers receive `(key, value)` in preorder, including
      the root, but no `this` holder. Array replacers preserve requested property order, deduplicate names, coerce
      number primitives, and ignore non-string/non-number entries. Primitive wrapper entries remain unsupported.
- [x] Captured `console.log`, `console.info`, `console.debug`, `console.warn`, and `console.error`.
- [x] Captured `console.dir` and `console.table`.

## Date

- [x] `Date.now`, `Date.parse`, and `Date.UTC`.
- [x] `new Date()` from the current time, epoch milliseconds, a date string, another Date, or local components.
- [x] `Date()` without `new` returns the current time as a string, like JS, but in deterministic ISO format
      rather than the host's locale/timezone string.
- [x] `getTime`, `valueOf`, `toISOString`, `toJSON`, and deterministic ISO `toString`.
- [x] Local getters: `getFullYear`, `getMonth`, `getDate`, `getDay`, `getHours`, `getMinutes`, `getSeconds`, and
      `getMilliseconds`.
- [x] UTC getters: `getUTCFullYear`, `getUTCMonth`, `getUTCDate`, `getUTCDay`, `getUTCHours`, `getUTCMinutes`,
      `getUTCSeconds`, and `getUTCMilliseconds`.
- [x] `getTimezoneOffset`, arithmetic, relational comparison, and `instanceof Date`.
- [x] Date values serialize to ISO strings; invalid dates serialize to `null`.
- [x] Local and UTC Date setters, including native argument coercion, mutation, rollover, invalid-Date recovery, and
      `TimeClip` behavior.
- [x] `Date.prototype.toUTCString` and its `toGMTString` alias.
- [x] `toDateString` and `toTimeString` in the host's local timezone.
- [x] Native one-argument Date coercion for supported values, including booleans, null, arrays, and plain objects.
- [ ] Date setters and multi-argument construction coerce object arguments through `valueOf`/`toString` and surface
      their throws.
- [x] Native Date loose-equality and default primitive-coercion semantics, using CodeMode's deterministic ISO string
      representation for the string primitive.
- [x] Native `RangeError` branding for invalid `toISOString()` calls.

## Regular expressions

- [x] Literal and `RegExp(pattern, flags)` construction, with or without `new`.
- [x] `test`, `exec`, and `toString`.
- [x] Readable `source`, `flags`, `lastIndex`, `hasIndices`, `global`, `ignoreCase`, `multiline`, `sticky`, `unicode`,
      `unicodeSets`, and `dotAll`.
- [x] Captures, named groups, match `.index` and `.input`, and stateful global matching.
- [x] Integration with supported String methods, including function replacers.
- [x] Writable `lastIndex`.
- [x] Match `indices` metadata for the `d` flag, including named groups on `exec`, `match`, and `matchAll` results.
- [x] `RegExp.escape`.

## Map and Set

- [x] Static `Map.groupBy` over finite collections and custom synchronous iterators/generators, preserving key identity.
- [x] `new Map()` from synchronous iterables of entries.
- [x] Map `get`, `set`, `has`, `delete`, `clear`, `size`, and `forEach`.
- [x] `new Set()` from synchronous iterables.
- [x] Set `add`, `has`, `delete`, `clear`, `size`, and `forEach`.
- [x] Materialized `keys`, `values`, and `entries` arrays for Map and Set.
- [x] Spread, `for...of`, `Array.from`, and `Object.fromEntries` integration.
- [x] Map and Set values serialize to `{}` at host/JSON boundaries.
- [x] Set composition and relation methods: `union`, `intersection`, `difference`, `symmetricDifference`, `isSubsetOf`,
      `isSupersetOf`, and `isDisjointFrom`, including supported Set-like operands.

## URL and URI helpers

- [x] `encodeURI`, `encodeURIComponent`, `decodeURI`, and `decodeURIComponent`.
- [x] `new URL(input, base)`, `URL.canParse`, and `URL.parse`.
- [x] URL `toString`, `toJSON`, and linked `searchParams`.
- [x] Readable URL fields: `href`, `origin`, `protocol`, `username`, `password`, `host`, `hostname`, `port`,
      `pathname`, `search`, and `hash`.
- [x] Writable URL fields except `origin`.
- [x] `new URLSearchParams()` from query strings, data objects, synchronous iterables of pairs, and URLSearchParams.
- [x] URLSearchParams `append`, `delete`, `get`, `getAll`, `has`, `set`, `sort`, `forEach`, `keys`, `values`,
      `entries`, `toString`, and `size`.
- [x] URL values serialize to their href; URLSearchParams serialize to `{}`.

## Web platform helpers

- [x] `atob` and `btoa` with forgiving-base64 decoding and WebIDL string conversion; invalid input throws a
      `TypeError`, since there is no `DOMException`.
- [x] `crypto.randomUUID()`.
- [ ] `crypto.getRandomValues` and `crypto.subtle`, `TextEncoder`/`TextDecoder`, and `Blob`: these need a binary
      value type, which the JSON-like data model does not have yet.

## Errors and diagnostics

- [x] `Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, and `URIError`, callable with
      or without `new`.
- [x] `AggregateError` with the `(errors, message?)` signature and an own `errors` array, constructed directly or by
      an all-rejected `Promise.any`; direct construction accepts custom synchronous iterators and generators.
- [x] Error `name`/`message`, error inheritance through `instanceof`, and plain-data serialization. `message` is an own
      non-enumerable property and `name` is inherited, as in JS, so `Object.keys(err)` is `[]` while the host still
      receives `{ name, message }`. Errors have no `stack`; the diagnostic carries the source location instead.
- [x] `instanceof` against any constructor with a `prototype`, including every built-in and `Function`.
- [x] Catchable user throws, runtime failures raised during interpreted evaluation, awaited tool failures, and awaited
      tool-call-limit failures; parse/compile failures, cooperative timeout, and output bounding remain outside program
      `catch`.
- [x] Source locations on unsupported-syntax diagnostics for JavaScript-shaped input; TypeScript transpilation may
      shift them. The diagnostic names the rejected node type and attaches a short orientation to the supported
      subset; this matrix is the full reference.
- [x] Model-visible host failure messages and underlying causes, including output-validation errors.
- [x] Caught errors do not distinguish user throws, interpreter failures, and tool failures; a program sees one
      Error-shaped value with `name` and `message` in `catch`, rejection handlers, and `Promise.allSettled` reasons.
      This is deliberate: the program should handle a failure the same way regardless of where it originated.
- [x] Failures raised by the interpreter are `TypeError`s unless JavaScript names them otherwise (`RangeError`,
      `ReferenceError`, `SyntaxError`, `URIError`), so `e instanceof TypeError` and `e.constructor === TypeError`
      hold. Unsupported syntax reached at runtime is a `SyntaxError`; awaited tool failures stay plain `Error`.
