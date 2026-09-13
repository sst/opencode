import { Effect, FileSystem, Scope } from "effect"
import { CliConfig, Command, GlobalFlag } from "effect/unstable/cli"
import { PrintLogs } from "../commands/commands"
import { Spec } from "./spec"
import { Global } from "@opencode/util/global"
import { Updater } from "../services/updater"
import { Config } from "../config"
import { Npm } from "@opencode/util/npm"

export type Input<Value> =
  Value extends Spec.Node<infer _Name, infer Command, infer _Commands>
    ? Input<Command>
    : Value extends Command.Command<infer _Name, infer Input, infer _Context, infer _Error, infer _Requirements>
      ? Input
      : never

type RuntimeHandler = (
  input: unknown,
) => Effect.Effect<
  void,
  unknown,
  FileSystem.FileSystem | Global.Service | Npm.Service | Updater.Service | Config.Service | Scope.Scope
>
type Loader<Node extends Spec.Any> = () => Promise<{
  default: (
    input: Input<Node>,
  ) => Effect.Effect<
    void,
    any,
    FileSystem.FileSystem | Global.Service | Npm.Service | Updater.Service | Config.Service | Scope.Scope
  >
}>
type ProvidedCommand = Command.Command<
  string,
  unknown,
  unknown,
  unknown,
  FileSystem.FileSystem | Global.Service | Npm.Service | Updater.Service | Config.Service | Scope.Scope
>

export type Handlers<Node extends Spec.Any> = keyof Node["commands"] extends never
  ? Loader<Node>
  : { readonly $?: Loader<Node> } & { readonly [Key in keyof Node["commands"]]: Handlers<Node["commands"][Key]> }

interface LazyHandler {
  readonly spec: Command.Command.Any
  readonly load: () => Promise<{ default: RuntimeHandler }>
}

type RuntimeHandlers =
  | (() => Promise<{ default: RuntimeHandler }>)
  | {
      readonly $?: () => Promise<{ default: RuntimeHandler }>
      readonly [key: string]: RuntimeHandlers | (() => Promise<{ default: RuntimeHandler }>) | undefined
    }

export function handler<const Node extends Spec.Any, Error, Requirements>(
  _node: Node,
  run: (input: Input<Node>) => Effect.Effect<void, Error, Requirements>,
) {
  return run
}

export function handlers<const Root extends Spec.Any>(root: Root, handlers: Handlers<Root>) {
  const result: LazyHandler[] = []

  function add(node: Spec.Any, value: RuntimeHandlers) {
    if (typeof value === "function") {
      result.push({ spec: node.spec, load: value as () => Promise<{ default: RuntimeHandler }> })
      for (const alias of node.aliases) result.push({ spec: alias.spec, load: value as () => Promise<{ default: RuntimeHandler }> })
      return
    }
    if (value.$) {
      result.push({ spec: node.spec, load: value.$ as () => Promise<{ default: RuntimeHandler }> })
      for (const alias of node.aliases) result.push({ spec: alias.spec, load: value.$ as () => Promise<{ default: RuntimeHandler }> })
    }
    for (const [name, child] of Object.entries(node.commands)) add(child, value[name] as RuntimeHandlers)
  }

  add(root, handlers as RuntimeHandlers)
  return result
}

export function run(commands: Spec.Any, handlers: ReadonlyArray<LazyHandler>, options: { readonly version: string }) {
  return Command.run(provide(commands, handlers).pipe(Command.withGlobalFlags([PrintLogs])), options).pipe(
    Effect.provide(
      CliConfig.layer({
        builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions],
      }),
    ),
  ) as Effect.Effect<void, unknown, Command.Environment>
}

function provide(node: Spec.Any, handlers: ReadonlyArray<LazyHandler>): ProvidedCommand {
  const handler = handlers.find((handler) => handler.spec === node.spec)
  const spec = handler
    ? node.spec.pipe(
        Command.withHandler((input) =>
          Effect.gen(function* () {
            if (yield* PrintLogs) process.env.OPENCODE_PRINT_LOGS = "1"
            const module = yield* Effect.promise(handler.load)
            return yield* module.default(input)
          }),
        ),
      )
    : node.spec
  if (!Object.keys(node.commands).length) return spec as ProvidedCommand
  const children = Object.values(node.commands)
  return spec.pipe(
    Command.withSubcommands([
      ...children.map((child) => provide(child, handlers)),
      ...children.flatMap((child) => child.aliases.map((alias) => provide(alias, handlers))),
    ]),
  ) as ProvidedCommand
}

export * as Runtime from "./runtime"
