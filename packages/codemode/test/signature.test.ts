import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"
import { inputTypeScript, jsonSchemaToTypeScript, outputTypeScript } from "../src/tool-schema.js"

// A raw JSON Schema tool in the shape an MCP adapter produces: render-only input schema
// whose property descriptions and constraints must surface as JSDoc in pretty signatures.
const listIssues = Tool.make({
  description: "List issues in a repository",
  input: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      after: { type: "string", description: "Cursor from the previous response's pageInfo" },
      perPage: { type: "number", description: "Results per page", default: 30 },
      labels: { type: "array", items: { type: "string" }, description: "Filter by labels", minItems: 1, maxItems: 10 },
      state: { type: "string", enum: ["open", "closed"] },
    },
    required: ["owner"],
  },
  output: {},
  execute: () => Effect.succeed("[]"),
})

// An Effect Schema tool whose field annotations must flow through the emitted JSON Schema.
const lookupOrder = Tool.make({
  description: "Look up an order",
  input: Schema.Struct({
    id: Schema.String.annotate({ description: "Order identifier" }),
    verbose: Schema.optionalKey(Schema.Boolean),
  }),
  output: Schema.Struct({
    status: Schema.String.annotate({ description: "Current order status" }),
  }),
  execute: () => Effect.succeed({ status: "open" }),
})

describe("pretty signature rendering", () => {
  test("described fields get compact JSDoc; undescribed and unconstrained fields get none", () => {
    expect(inputTypeScript(listIssues, true)).toBe(
      [
        "{",
        "  /** Repository owner */",
        "  owner: string,",
        "  /** Cursor from the previous response's pageInfo */",
        "  after?: string,",
        "  /** Results per page. @default 30 */",
        "  perPage?: number,",
        "  /** Filter by labels. @minItems 1 @maxItems 10 */",
        "  labels?: Array<string>,",
        '  state?: "open" | "closed",',
        "}",
      ].join("\n"),
    )
  })

  test("compact mode output is unchanged by the pretty machinery", () => {
    expect(inputTypeScript(listIssues)).toBe(
      '{ owner: string; after?: string; perPage?: number; labels?: Array<string>; state?: "open" | "closed" }',
    )
    expect(inputTypeScript(lookupOrder)).toBe("{ id: string; verbose?: boolean }")
    expect(outputTypeScript(lookupOrder)).toBe("{ status: string }")
  })

  test("nested objects recurse with increasing indent and their own JSDoc", () => {
    const pretty = jsonSchemaToTypeScript(
      {
        type: "object",
        properties: {
          filter: {
            type: "object",
            description: "Search filter",
            properties: { state: { type: "string", description: "Issue state" } },
          },
        },
      },
      true,
    )
    expect(pretty).toBe(
      [
        "{",
        "  /** Search filter */",
        "  filter?: {",
        "    /** Issue state */",
        "    state?: string,",
        "  },",
        "}",
      ].join("\n"),
    )
  })

  test("Effect Schema annotations become JSDoc on input and output fields", () => {
    expect(inputTypeScript(lookupOrder, true)).toBe(
      ["{", "  /** Order identifier */", "  id: string,", "  verbose?: boolean,", "}"].join("\n"),
    )
    expect(outputTypeScript(lookupOrder, true)).toBe(
      ["{", "  /** Current order status */", "  status: string,", "}"].join("\n"),
    )
  })

  test("constraints and annotations share compact tagged JSDoc", () => {
    const pretty = jsonSchemaToTypeScript(
      {
        type: "object",
        properties: {
          legacy: { type: "string", deprecated: true },
          homepage: { type: "string", format: "uri" },
          tags: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5, default: ["a", "b"] },
        },
      },
      true,
    )
    expect(pretty).toContain("  /** @deprecated */\n  legacy?: string")
    expect(pretty).toContain("  /** @format uri */\n  homepage?: string")
    expect(pretty).toContain('  /** @default ["a","b"] @minItems 2 @maxItems 5 */\n  tags?: Array<string>')
  })

  test("skips an unserializable default rather than emitting a broken summary", () => {
    const pretty = jsonSchemaToTypeScript(
      { type: "object", properties: { size: { type: "number", default: 1n } } },
      true,
    )
    expect(pretty).toBe(["{", "  size?: number,", "}"].join("\n"))
  })

  test("labels immediate item and dictionary value metadata above the field", () => {
    const schema = {
      properties: {
        recipients: {
          type: "array",
          description: "People to notify",
          minItems: 1,
          items: { type: "string", description: "Email address", format: "email" },
        },
        scores: { type: "object", additionalProperties: { type: "number", minimum: 0 } },
        names: { type: "array", items: { type: "string", description: "Display name" } },
        plain: { type: "object", additionalProperties: { type: "string" } },
      },
    }
    expect(jsonSchemaToTypeScript(schema, true)).toBe(
      [
        "{",
        "  /**",
        "   * People to notify. @minItems 1",
        "   * Each item: Email address. @format email",
        "   */",
        "  recipients?: Array<string>,",
        "  /** Each value: @minimum 0 */",
        "  scores?: {",
        "    [key: string]: number,",
        "  },",
        "  /** Each item: Display name */",
        "  names?: Array<string>,",
        "  plain?: {",
        "    [key: string]: string,",
        "  },",
        "}",
      ].join("\n"),
    )
    expect(jsonSchemaToTypeScript(schema)).toBe(
      "{ recipients?: Array<string>; scores?: { [key: string]: number }; names?: Array<string>; plain?: { [key: string]: string } }",
    )
  })

  test("does not apply additional property metadata to named properties", () => {
    expect(
      jsonSchemaToTypeScript(
        {
          properties: {
            scores: {
              type: "object",
              properties: { title: { type: "string", description: "Score title" } },
              additionalProperties: { type: "number", minimum: 0 },
            },
          },
        },
        true,
      ),
    ).toBe(
      [
        "{",
        "  /** Each additional value: @minimum 0 */",
        "  scores?: {",
        "    /** Score title */",
        "    title?: string,",
        "    [key: string]: number,",
        "  },",
        "}",
      ].join("\n"),
    )
  })

  test("labels array and dictionary contents in type-array unions", () => {
    expect(
      jsonSchemaToTypeScript(
        {
          properties: {
            recipients: { type: ["array", "null"], items: { type: "string", format: "email" } },
            scores: { type: ["object", "null"], additionalProperties: { type: "number", minimum: 0 } },
            either: {
              type: ["array", "object"],
              items: { type: "string", minLength: 1 },
              additionalProperties: { type: "number", minimum: 0 },
            },
          },
        },
        true,
      ),
    ).toBe(
      [
        "{",
        "  /** Each item: @format email */",
        "  recipients?: Array<string> | null,",
        "  /** Each value: @minimum 0 */",
        "  scores?: {",
        "      [key: string]: number,",
        "    } | null,",
        "  /**",
        "   * Each item: @minLength 1",
        "   * Each value: @minimum 0",
        "   */",
        "  either?: Array<string> | {",
        "      [key: string]: number,",
        "    },",
        "}",
      ].join("\n"),
    )
  })

  test("keeps multiline item metadata indented under its label and escapes terminators", () => {
    expect(
      jsonSchemaToTypeScript(
        {
          properties: {
            values: {
              type: "array",
              minItems: 1,
              items: { type: "string", description: "\nFirst */ line\n\nSecond line\n", pattern: "^\\d+\n*/$" },
            },
          },
        },
        true,
      ),
    ).toBe(
      [
        "{",
        "  /**",
        "   * @minItems 1",
        "   * Each item: First * / line",
        "   *",
        "   *   Second line",
        "   *   @pattern ^\\d+",
        "   *   * /$",
        "   */",
        "  values?: Array<string>,",
        "}",
      ].join("\n"),
    )
  })

  test("does not flatten nested containers, reference targets, or branches into item metadata", () => {
    expect(
      jsonSchemaToTypeScript(
        {
          $defs: { Email: { type: "string", format: "email" } },
          properties: {
            matrix: { type: "array", items: { type: "array", minItems: 2, items: { type: "integer", minimum: 0 } } },
            refs: { type: "array", items: { $ref: "#/$defs/Email", description: "Recipient" } },
            choices: {
              type: "array",
              items: {
                anyOf: [
                  { type: "string", minLength: 1 },
                  { type: "number", minimum: 0 },
                ],
              },
            },
          },
        },
        true,
      ),
    ).toBe(
      [
        "{",
        "  /** Each item: @minItems 2 */",
        "  matrix?: Array<Array<number>>,",
        "  /** Each item: Recipient */",
        "  refs?: Array<string>,",
        "  choices?: Array<string | number>,",
        "}",
      ].join("\n"),
    )
  })

  test.each([
    [{ type: "number", minimum: 0 }, "@minimum 0", "number"],
    [{ type: "number", maximum: 0 }, "@maximum 0", "number"],
    [{ type: "number", exclusiveMinimum: 0 }, "@exclusiveMinimum 0", "number"],
    [{ type: "number", exclusiveMaximum: 0 }, "@exclusiveMaximum 0", "number"],
    [{ type: "number", multipleOf: 0.25 }, "@multipleOf 0.25", "number"],
    [{ type: "string", minLength: 0 }, "@minLength 0", "string"],
    [{ type: "string", maxLength: 0 }, "@maxLength 0", "string"],
    [{ type: "string", pattern: "^[a-z]+$" }, "@pattern ^[a-z]+$", "string"],
    [{ type: "array", minItems: 0 }, "@minItems 0", "Array<unknown>"],
    [{ type: "array", maxItems: 0 }, "@maxItems 0", "Array<unknown>"],
    [{ type: "array", uniqueItems: true }, "@uniqueItems true", "Array<unknown>"],
    [{ type: "string", minLength: 0, maxLength: 0 }, "@minLength 0 @maxLength 0", "string"],
    [{ type: "array", minItems: 0, maxItems: 0 }, "@minItems 0 @maxItems 0", "Array<unknown>"],
    [
      { type: "array", minItems: 1, maxItems: 10, uniqueItems: true },
      "@minItems 1 @maxItems 10 @uniqueItems true",
      "Array<unknown>",
    ],
  ] as const)("renders constraint %j without changing the compact type", (value, summary, type) => {
    const schema = { type: "object", properties: { value } }
    expect(jsonSchemaToTypeScript(schema, true)).toBe(
      ["{", `  /** ${summary} */`, `  value?: ${type},`, "}"].join("\n"),
    )
    expect(jsonSchemaToTypeScript(schema)).toBe(`{ value?: ${type} }`)
  })

  test("documents integer numbers without adding redundant types or requiring uniqueness when false", () => {
    expect(
      jsonSchemaToTypeScript(
        {
          type: "object",
          properties: {
            count: { type: "integer" },
            amount: { type: "number" },
            name: { type: "string" },
            enabled: { type: "boolean" },
            values: { type: "array", uniqueItems: false },
            choice: { type: ["integer", "string"] },
          },
        },
        true,
      ),
    ).toBe(
      [
        "{",
        "  /** @integer */",
        "  count?: number,",
        "  amount?: number,",
        "  name?: string,",
        "  enabled?: boolean,",
        "  values?: Array<unknown>,",
        "  choice?: number | string,",
        "}",
      ].join("\n"),
    )
  })

  test.each([false, null, ""])("preserves default %j alongside constraints", (value) => {
    expect(jsonSchemaToTypeScript({ properties: { value: { default: value, minLength: 0 } } }, true)).toContain(
      `  /** @default ${JSON.stringify(value)} @minLength 0 */\n`,
    )
  })

  test("escapes comment terminators in summary values", () => {
    expect(
      jsonSchemaToTypeScript(
        { properties: { value: { type: "string", default: "*/", format: "*/", pattern: "^a*/b$" } } },
        true,
      ),
    ).toBe(["{", '  /** @default "* /" @format * / @pattern ^a* /b$ */', "  value?: string,", "}"].join("\n"))
  })

  test("neutralizes */ inside descriptions so nothing closes the comment early", () => {
    const pretty = jsonSchemaToTypeScript(
      { type: "object", properties: { note: { type: "string", description: "Ends */ early" } } },
      true,
    )
    expect(pretty).toContain("  /** Ends * / early */")
    expect(pretty).not.toContain("Ends */")
  })

  test("multiline descriptions become *-prefixed blocks with blank edges trimmed", () => {
    const pretty = jsonSchemaToTypeScript(
      {
        type: "object",
        properties: { query: { type: "string", description: "\nFirst line\n\nSecond line\n" } },
      },
      true,
    )
    expect(pretty).toBe(
      ["{", "  /**", "   * First line", "   *", "   * Second line", "   */", "  query?: string,", "}"].join("\n"),
    )
  })

  test("preserves inclusive and exclusive numeric bounds together", () => {
    expect(
      jsonSchemaToTypeScript(
        {
          properties: {
            value: {
              type: "integer",
              minimum: -10,
              maximum: 10,
              exclusiveMinimum: -5,
              exclusiveMaximum: 5,
              multipleOf: 2,
            },
          },
        },
        true,
      ),
    ).toContain(
      "  /** @integer @minimum -10 @maximum 10 @exclusiveMinimum -5 @exclusiveMaximum 5 @multipleOf 2 */\n  value?: number,",
    )
  })

  test.each([
    ["Maximum attempts", "Maximum attempts."],
    ["Maximum attempts.", "Maximum attempts."],
    ["Maximum attempts!", "Maximum attempts!."],
  ])("combines a short description (%s) with its summary", (description, expected) => {
    expect(
      jsonSchemaToTypeScript(
        { properties: { attempts: { description, type: "integer", minimum: 1, default: 3 } } },
        true,
      ),
    ).toContain(`  /** ${expected} @default 3 @integer @minimum 1 */\n`)
  })

  test("keeps multiline descriptions intact and appends a compact summary", () => {
    expect(
      jsonSchemaToTypeScript(
        {
          properties: {
            attempts: {
              description: "\nMaximum attempts\n\nIncludes the initial request.\n",
              type: "integer",
              minimum: 1,
            },
          },
        },
        true,
      ),
    ).toBe(
      [
        "{",
        "  /**",
        "   * Maximum attempts",
        "   *",
        "   * Includes the initial request.",
        "   * @integer @minimum 1",
        "   */",
        "  attempts?: number,",
        "}",
      ].join("\n"),
    )
  })

  test("uses a block for long descriptions without truncating or rewriting them", () => {
    const description = "A detailed description. ".repeat(8).trim()
    expect(jsonSchemaToTypeScript({ properties: { name: { type: "string", description, minLength: 1 } } }, true)).toBe(
      ["{", "  /**", `   * ${description}`, "   * @minLength 1", "   */", "  name?: string,", "}"].join("\n"),
    )
  })

  test("preserves pattern backslashes and prefixes every line of multiline summary values", () => {
    expect(
      jsonSchemaToTypeScript(
        { properties: { value: { type: "string", pattern: "^\\d+\n*/$", default: "a\nb" } } },
        true,
      ),
    ).toBe(
      ["{", "  /**", '   * @default "a\\nb" @pattern ^\\d+', "   * * /$", "   */", "  value?: string,", "}"].join("\n"),
    )
  })

  test("stays total on cyclic $refs and pathological nesting in both modes", () => {
    const cyclic = {
      $ref: "#/$defs/Node",
      $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" }, name: { type: "string" } } } },
    } as const
    expect(jsonSchemaToTypeScript(cyclic)).toBe("{ child?: unknown; name?: string }")
    expect(jsonSchemaToTypeScript(cyclic, true)).toContain("child?: unknown")

    let deep: Record<string, unknown> = { type: "string" }
    for (let level = 0; level < 12; level += 1) deep = { type: "object", properties: { next: deep } }
    for (const pretty of [false, true]) {
      const rendered = jsonSchemaToTypeScript(deep, pretty)
      expect(rendered).toContain("unknown")
      expect(rendered).toContain("next?:")
    }
  })

  test("intersects ref and union siblings instead of discarding them", () => {
    expect(
      jsonSchemaToTypeScript({
        $ref: "#/$defs/User",
        properties: { active: { type: "boolean" } },
        required: ["active"],
        $defs: {
          User: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      }),
    ).toBe("{ id: string } & { active: boolean }")
    expect(
      jsonSchemaToTypeScript({
        type: "object",
        properties: { common: { type: "boolean" } },
        required: ["common"],
        anyOf: [
          { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
        ],
      }),
    ).toBe("({ name: string } | { count: number }) & { common: boolean }")
    expect(jsonSchemaToTypeScript({ $ref: "https://example.com/schema.json" })).toBe("unknown")
    expect(
      jsonSchemaToTypeScript({
        $ref: "#/$defs/User/properties/id",
        $defs: { User: { type: "object" }, id: { type: "string" } },
      }),
    ).toBe("unknown")
    expect(
      jsonSchemaToTypeScript({
        type: ["object", "null"],
        properties: { name: { type: "string" } },
      }),
    ).toBe("{ name?: string } | null")
  })
})

describe("JSON Schema definition scope", () => {
  test.each(["definitions", "$defs"])("resolves root %s and lets $defs take precedence", (key) => {
    const schema = { $ref: `#/${key}/Value`, [key]: { Value: { type: "string" } } }
    expect(jsonSchemaToTypeScript(schema)).toBe("string")
    expect(jsonSchemaToTypeScript(schema, true)).toBe("string")

    const overridden = { ...schema, $defs: { Value: { type: "number" } } }
    expect(jsonSchemaToTypeScript(overridden)).toBe("number")
    expect(jsonSchemaToTypeScript(overridden, true)).toBe("number")
  })

  test.each(["definitions", "$defs"])("nested %s shadow inherited definitions without affecting siblings", (key) => {
    const schema = {
      type: "object",
      definitions: { Inherited: { type: "string" } },
      $defs: { Value: { type: "number" } },
      properties: {
        nested: { $ref: `#/${key}/Value`, [key]: { Value: { type: "boolean" } } },
        inherited: { $ref: "#/definitions/Inherited" },
        sibling: { $ref: "#/$defs/Value" },
      },
    }
    expect(jsonSchemaToTypeScript(schema)).toBe("{ nested?: boolean; inherited?: string; sibling?: number }")
    expect(jsonSchemaToTypeScript(schema, true)).toBe(
      ["{", "  nested?: boolean,", "  inherited?: string,", "  sibling?: number,", "}"].join("\n"),
    )
  })
})

describe("non-identifier property names render as quoted keys", () => {
  // MCP-style schemas routinely carry property names that are not bare TS identifiers
  // (`foo-bar`, `@type`, dotted names); the rendered signature must quote them so the
  // model sees a valid TypeScript object type. Bare identifiers stay unquoted.
  const rawSchema = {
    type: "object",
    properties: {
      "foo-bar": { type: "string" },
      "@type": { type: "string" },
      "x.y": { type: "number", description: "Dotted name" },
      "123": { type: "number" },
      plain: { type: "boolean" },
    },
    required: ["@type"],
  } as const

  test("compact rendering quotes non-identifier keys and leaves identifiers bare", () => {
    expect(jsonSchemaToTypeScript(rawSchema)).toBe(
      '{ "123"?: number; "foo-bar"?: string; "@type": string; "x.y"?: number; plain?: boolean }',
    )
  })

  test("pretty rendering quotes non-identifier keys and keeps their JSDoc", () => {
    expect(jsonSchemaToTypeScript(rawSchema, true)).toBe(
      [
        "{",
        '  "123"?: number,',
        '  "foo-bar"?: string,',
        '  "@type": string,',
        "  /** Dotted name */",
        '  "x.y"?: number,',
        "  plain?: boolean,",
        "}",
      ].join("\n"),
    )
  })

  test("JSON Schema input and output signatures of a tool both quote", () => {
    const tool = Tool.make({
      description: "Adapter tool with awkward field names",
      input: rawSchema,
      output: {
        type: "object",
        properties: { "content-type": { type: "string" } },
        required: ["content-type"],
      } as const,
      execute: () => Effect.succeed({ "content-type": "text/plain" }),
    })
    expect(inputTypeScript(tool)).toContain('"foo-bar"?: string')
    expect(outputTypeScript(tool)).toBe('{ "content-type": string }')
    expect(outputTypeScript(tool, true)).toBe(["{", '  "content-type": string,', "}"].join("\n"))
  })

  test("Effect Schema structs with non-identifier field names quote too", () => {
    const tool = Tool.make({
      description: "Schema tool with awkward field names",
      input: Schema.Struct({ "foo-bar": Schema.String, plain: Schema.optionalKey(Schema.Number) }),
      execute: () => Effect.succeed(null),
    })
    expect(inputTypeScript(tool)).toBe('{ "foo-bar": string; plain?: number | "Infinity" | "-Infinity" | "NaN" }')
    expect(inputTypeScript(tool, true)).toBe(
      ["{", '  "foo-bar": string,', '  plain?: number | "Infinity" | "-Infinity" | "NaN",', "}"].join("\n"),
    )
  })
})

describe("union schemas render every alternative", () => {
  test("anyOf with a number branch keeps sibling alternatives", () => {
    const schema = {
      anyOf: [{ type: "string" }, { type: "number" }],
    } as const
    expect(jsonSchemaToTypeScript(schema)).toBe("string | number")
    expect(jsonSchemaToTypeScript(schema, true)).toBe("string | number")
  })

  test("nullable numeric unions keep null", () => {
    const schema = {
      oneOf: [{ type: "number" }, { type: "null" }],
    } as const
    expect(jsonSchemaToTypeScript(schema)).toBe("number | null")
    expect(jsonSchemaToTypeScript(schema, true)).toBe("number | null")
  })

  test("tool input and output signatures preserve numeric unions", () => {
    const tool = Tool.make({
      description: "Tool with numeric unions",
      input: {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
      } as const,
      output: { anyOf: [{ type: "number" }, { type: "boolean" }] } as const,
      execute: () => Effect.succeed(1),
    })
    expect(inputTypeScript(tool)).toBe("{ value?: string | number }")
    expect(outputTypeScript(tool)).toBe("number | boolean")
  })

  test("allOf keeps siblings and parenthesized union members in order", () => {
    const schema = {
      properties: { common: { type: "boolean" } },
      allOf: [{ type: "object", properties: { id: { type: "string" } } }, { type: ["string", "null"] }],
    } as const
    expect(jsonSchemaToTypeScript(schema)).toBe("{ common?: boolean } & { id?: string } & (string | null)")
    expect(jsonSchemaToTypeScript(schema, true)).toBe(
      ["{", "    common?: boolean,", "  } & {", "    id?: string,", "  } & (string | null)"].join("\n"),
    )
  })

  test.each([false, true])("allOf does not discard an unresolved constraint (pretty=%s)", (pretty) => {
    for (const $ref of ["#/$defs/Missing", "#/definitions/Missing", "https://example.com/external.json"]) {
      expect(jsonSchemaToTypeScript({ allOf: [{ type: "string" }, { $ref }] }, pretty)).toBe("unknown")
      expect(jsonSchemaToTypeScript({ allOf: [{ type: "string" }, { allOf: [{ $ref }] }] }, pretty)).toBe("unknown")
      expect(
        jsonSchemaToTypeScript({ allOf: [{ properties: { nested: { $ref } } }, { type: "string" }] }, pretty),
      ).toBe("unknown")
    }
    expect(
      jsonSchemaToTypeScript(
        {
          type: "string",
          allOf: [{ $ref: "#/$defs/Constraint" }],
          $defs: { Constraint: { description: "TypeScript-neutral constraint" } },
        },
        pretty,
      ),
    ).toBe("string")
  })
})

describe("JSDoc signatures in catalogs and search results", () => {
  test.each([
    {
      source: "JSON Schema",
      schema: {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 0, maximum: 10 },
          name: { type: "string", minLength: 1, maxLength: 20, pattern: "^[a-z]+$" },
          labels: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 5 },
          scores: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
        },
        required: ["count", "name", "labels", "scores"],
      },
    },
    {
      source: "Effect",
      schema: Schema.Struct({
        count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10)),
        name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20), Schema.isPattern(/^[a-z]+$/)),
        labels: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(5),
        ),
        scores: Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      }),
    },
  ])("$source constraints survive input/output catalog and search signatures", async ({ schema }) => {
    const runtime = CodeMode.make({
      tools: {
        constrained: Tool.make({
          description: "Constrained tool",
          input: schema,
          output: schema,
          execute: () => Effect.succeed({ count: 1, name: "test", labels: ["test"], scores: { test: 1 } }),
        }),
      },
    })
    const type = [
      "{",
      "  /** @integer @minimum 0 @maximum 10 */",
      "  count: number,",
      "  /** @minLength 1 @maxLength 20 @pattern ^[a-z]+$ */",
      "  name: string,",
      "  /**",
      "   * @minItems 1 @maxItems 5",
      "   * Each item: @minLength 1",
      "   */",
      "  labels: Array<string>,",
      "  /** Each value: @integer @minimum 0 */",
      "  scores: {",
      "    [key: string]: number,",
      "  },",
      "}",
    ].join("\n")
    const signature = `tools.constrained(input: ${type}): Promise<${type}>`
    expect(runtime.catalog[0]?.signature).toBe(signature)
    const result = await Effect.runPromise(runtime.execute('return search({ query: "tools.constrained" })'))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("search failed")
    expect(result.value).toMatchObject({ items: [{ signature }] })
  })

  const runtime = CodeMode.make({ tools: { github: { list_issues: listIssues }, orders: { lookup: lookupOrder } } })

  const search = async (query: string) => {
    const result = await Effect.runPromise(runtime.execute(`return search({ query: ${JSON.stringify(query)} })`))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("search failed")
    return result.value as { items: Array<{ path: string; signature: string }>; remaining: number }
  }

  test("a raw JSON Schema (MCP-style) tool's result signature carries field JSDoc and summaries", async () => {
    const { items } = await search("list issues repository")
    const item = items.find(({ path }) => path === "tools.github.list_issues")!
    expect(item.signature).toBe(
      [
        "tools.github.list_issues(input: {",
        "  /** Repository owner */",
        "  owner: string,",
        "  /** Cursor from the previous response's pageInfo */",
        "  after?: string,",
        "  /** Results per page. @default 30 */",
        "  perPage?: number,",
        "  /** Filter by labels. @minItems 1 @maxItems 10 */",
        "  labels?: Array<string>,",
        '  state?: "open" | "closed",',
        "}): Promise<unknown>",
      ].join("\n"),
    )
  })

  test("an annotated Effect Schema tool's result signature carries field JSDoc (exact-path lookup too)", async () => {
    for (const query of ["look up order", "tools.orders.lookup"]) {
      const { items } = await search(query)
      const item = items.find(({ path }) => path === "tools.orders.lookup")!
      expect(item.signature).toBe(
        [
          "tools.orders.lookup(input: {",
          "  /** Order identifier */",
          "  id: string,",
          "  verbose?: boolean,",
          "}): Promise<{",
          "  /** Current order status */",
          "  status: string,",
          "}>",
        ].join("\n"),
      )
    }
  })

  test("the catalog uses the same JSDoc signatures as search", async () => {
    const catalog = runtime.catalog
    const github = (await search("list issues repository")).items.find(
      ({ path }) => path === "tools.github.list_issues",
    )!
    const orders = (await search("look up order")).items.find(({ path }) => path === "tools.orders.lookup")!
    expect(catalog.map(({ signature }) => signature)).toContain(github.signature)
    expect(catalog.map(({ signature }) => signature)).toContain(orders.signature)
    expect(github.signature).toContain("/** Repository owner */")
  })
})

describe("non-identifier tool paths", () => {
  const resolveLibrary = Tool.make({
    description: "Resolve a Context7 library ID",
    input: {
      type: "object",
      properties: {
        query: { type: "string" },
        libraryName: { type: "string" },
      },
      required: ["query", "libraryName"],
    } as const,
    output: {},
    execute: () => Effect.succeed("/reactjs/react.dev"),
  })
  const runtime = CodeMode.make({ tools: { context7: { "resolve-library-id": resolveLibrary } } })

  test("catalog signatures use bracket notation for dashed tool names", () => {
    expect(runtime.catalog[0]?.signature).toBe(
      'tools.context7["resolve-library-id"](input: {\n  query: string,\n  libraryName: string,\n}): Promise<unknown>',
    )
  })

  test("search results return callable bracket-notation paths and signatures", async () => {
    const result = await Effect.runPromise(runtime.execute(`return search({ query: "resolve library" })`))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("search failed")

    const value = result.value as { items: Array<{ path: string; signature: string }> }
    expect(value.items[0]?.path).toBe('tools.context7["resolve-library-id"]')
    expect(value.items[0]?.signature).toContain('tools.context7["resolve-library-id"](input: {')
  })
})
