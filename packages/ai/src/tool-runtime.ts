import { Effect } from "effect"
import {
  LLMEvent,
  type ToolCallPart,
  ToolFailure,
  ToolOutput,
  ToolResultValue,
  type ToolOutput as ToolOutputType,
  type ToolResultValue as ToolResultValueType,
} from "./schema/index.js"
import { type AnyTool, type Tools } from "./tool.js"

export interface ToolSettlement {
  readonly result: ToolResultValueType
  readonly output?: ToolOutputType
}

export interface DispatchResult extends ToolSettlement {
  readonly events: ReadonlyArray<LLMEvent>
}

/** Execute one canonical tool call without owning provider IO or continuation. */
export const dispatch = (tools: Tools, call: ToolCallPart): Effect.Effect<DispatchResult> => {
  const name = call.namespace === undefined ? call.name : `${call.namespace}.${call.name}`
  const tool = tools[name]
  if (!tool)
    return Effect.succeed(
      result(call, {
        type: "error",
        value: `No tool named "${name}" is currently available. Please use a tool from the available tool list.`,
      }),
    )
  if (!tool.execute)
    return Effect.succeed(result(call, { type: "error", value: `Tool has no execute handler: ${name}` }))

  return decodeAndExecute(tool, call).pipe(
    Effect.map((value) => result(call, value)),
    Effect.catchTag("Tool.Error", (failure) =>
      Effect.succeed(result(call, { type: "error", value: failure.message }, failure.error)),
    ),
  )
}

const decodeAndExecute = (tool: AnyTool, call: ToolCallPart): Effect.Effect<ToolSettlement, ToolFailure> =>
  tool._decode(call.input).pipe(
    Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
    Effect.flatMap((decoded) =>
      tool.execute!(decoded, {
        id: call.id,
        name: call.name,
        namespace: call.namespace,
      }).pipe(
        Effect.flatMap((value) =>
          tool._encode(value).pipe(
            Effect.mapError(
              (error) =>
                new ToolFailure({
                  message: `Tool returned an invalid value for its success schema: ${error.message}`,
                }),
            ),
          ),
        ),
        Effect.map((encoded) => {
          if (tool._legacyResult && ToolResultValue.is(encoded))
            return { result: encoded, output: ToolOutput.fromResultValue(encoded) }
          const output = tool._project(decoded, call.id, encoded)
          const result = ToolOutput.toResultValue(output)
          return result.type === "error" ? { result } : { result, output }
        }),
      ),
    ),
  )

const result = (call: ToolCallPart, value: ToolResultValueType | ToolSettlement, error?: unknown): DispatchResult => {
  const settlement = ToolResultValue.is(value) ? { result: value } : value
  return {
    result: settlement.result,
    output: settlement.output,
    events:
      settlement.result.type === "error"
        ? [
            LLMEvent.toolError({
              id: call.id,
              name: call.name,
              namespace: call.namespace,
              message: String(settlement.result.value),
              error,
              providerMetadata: call.providerMetadata,
            }),
            LLMEvent.toolResult({
              id: call.id,
              name: call.name,
              namespace: call.namespace,
              result: settlement.result,
              providerMetadata: call.providerMetadata,
            }),
          ]
        : [
            LLMEvent.toolResult({
              id: call.id,
              name: call.name,
              namespace: call.namespace,
              result: settlement.result,
              output: settlement.output,
              providerMetadata: call.providerMetadata,
            }),
          ],
  }
}

export const ToolRuntime = { dispatch } as const
