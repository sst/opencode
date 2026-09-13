import { constructor, constants, methods } from "../interpreter/native.js"
import { type AstNode, InterpreterRuntimeError, rangeError } from "../interpreter/model.js"
import type { Runner } from "../interpreter/runner.js"
import { coercion, coerceToString } from "./value.js"

export const numberGlobal = <R>(runner: Runner<R>) => {
  const protos = runner.prototypes
  const number = constructor<R>(protos, protos.Number, {
    name: "Number",
    length: 1,
    call: coercion(runner, "Number").call,
  })
  constants(number, {
    MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
    MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
    MAX_VALUE: Number.MAX_VALUE,
    MIN_VALUE: Number.MIN_VALUE,
    EPSILON: Number.EPSILON,
    NaN: Number.NaN,
    POSITIVE_INFINITY: Number.POSITIVE_INFINITY,
    NEGATIVE_INFINITY: Number.NEGATIVE_INFINITY,
  })
  methods(protos, number, [
    ["isInteger", 1, (_, args) => Number.isInteger(args[0])],
    ["isFinite", 1, (_, args) => Number.isFinite(args[0])],
    ["isNaN", 1, (_, args) => Number.isNaN(args[0])],
    ["isSafeInteger", 1, (_, args) => Number.isSafeInteger(args[0])],
    [
      "parseInt",
      2,
      (_, args, node) => {
        const radix = args[1]
        if (radix !== undefined && typeof radix !== "number") {
          throw new InterpreterRuntimeError("Number.parseInt expects a numeric radix.", node)
        }
        return parseInt(coerceToString(args[0]), radix)
      },
    ],
    ["parseFloat", 1, (_, args) => parseFloat(coerceToString(args[0]))],
  ])

  const self = (thisValue: unknown, name: string, node: AstNode): number => {
    if (typeof thisValue === "number") return thisValue
    throw new InterpreterRuntimeError(`Number.prototype.${name} requires that 'this' be a Number.`, node)
  }
  const optNum = (name: string, arg: unknown, node: AstNode): number | undefined => {
    if (arg === undefined) return undefined
    if (typeof arg !== "number") throw new InterpreterRuntimeError(`Number.${name} expects a number argument.`, node)
    return arg
  }
  methods(protos, protos.Number, [
    [
      "toFixed",
      1,
      (thisValue, args, node) => self(thisValue, "toFixed", node).toFixed(optNum("toFixed", args[0], node)),
    ],
    [
      "toExponential",
      1,
      (thisValue, args, node) =>
        self(thisValue, "toExponential", node).toExponential(optNum("toExponential", args[0], node)),
    ],
    [
      "toPrecision",
      1,
      (thisValue, args, node) => {
        const value = self(thisValue, "toPrecision", node)
        const digits = optNum("toPrecision", args[0], node)
        return digits === undefined ? value.toString() : value.toPrecision(digits)
      },
    ],
    [
      "toString",
      1,
      (thisValue, args, node) => {
        const value = self(thisValue, "toString", node)
        const radix = optNum("toString", args[0], node)
        if (radix !== undefined && (radix < 2 || radix > 36)) {
          throw rangeError("Number.toString radix must be between 2 and 36.", node)
        }
        return value.toString(radix)
      },
    ],
    ["valueOf", 0, (thisValue, _, node) => self(thisValue, "valueOf", node)],
  ])
  return number
}

export const booleanGlobal = <R>(runner: Runner<R>) => {
  const protos = runner.prototypes
  const boolean = constructor<R>(protos, protos.Boolean, {
    name: "Boolean",
    length: 1,
    call: coercion(runner, "Boolean").call,
  })
  const self = (thisValue: unknown, name: string, node: AstNode): boolean => {
    if (typeof thisValue === "boolean") return thisValue
    throw new InterpreterRuntimeError(`Boolean.prototype.${name} requires that 'this' be a Boolean.`, node)
  }
  methods(protos, protos.Boolean, [
    ["toString", 0, (thisValue, _, node) => String(self(thisValue, "toString", node))],
    ["valueOf", 0, (thisValue, _, node) => self(thisValue, "valueOf", node)],
  ])
  return boolean
}
