export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  mode: Schema.Literals(["prepend", "suffix"]).pipe(Schema.optional).annotate({
    description: "Compaction request mode. Suffix is experimental and off by default; prepend remains the default.",
  }),
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
}) {}
