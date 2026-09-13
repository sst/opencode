import { describe, expect, test } from "bun:test"
import {
  AuthenticationError,
  ContentPolicyError,
  InvalidProviderOutputError,
  InvalidRequestError,
  UnsupportedOperationError,
  AIError,
  NoRouteError,
  ModelID,
  ProviderID,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
  TransportError,
  UnknownProviderError,
  ToolFailure,
  HttpContext,
} from "@opencode/ai"
import { Permission } from "@opencode/core/permission"
import { ID } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Provider } from "@opencode/core/provider"
import { Tool } from "@opencode/schema/tool"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"

const llm = (reason: AIError["reason"]) => new AIError({ reason })

describe("toSessionError", () => {
  test("maps every AI error reason to the open wire type", () => {
    expect(toSessionError(llm(new RateLimitError({ message: "rate", retryAfterMs: 123 })))).toEqual({
      type: "provider.rate-limit",
      message: "rate",
    })
    expect(toSessionError(llm(new AuthenticationError({ message: "auth" }))).type).toBe("provider.auth")
    expect(toSessionError(llm(new QuotaExceededError({ message: "quota" }))).type).toBe("provider.quota")
    expect(toSessionError(llm(new ContentPolicyError({ message: "blocked" }))).type).toBe("provider.content-filter")
    expect(
      toSessionError(llm(new TransportError({ message: "transport", transport: "http", operation: "request" }))).type,
    ).toBe("provider.transport")
    expect(toSessionError(llm(new ProviderInternalError({ message: "internal" }))).type).toBe("provider.internal")
    expect(toSessionError(llm(new InvalidProviderOutputError({ message: "output" }))).type).toBe(
      "provider.invalid-output",
    )
    expect(toSessionError(llm(new InvalidRequestError({ message: "request" }))).type).toBe("provider.invalid-request")
    expect(
      toSessionError(
        llm(
          new UnsupportedOperationError({
            message: "no compact endpoint",
            operation: "compact",
            provider: ProviderID.make("provider"),
            route: "route",
          }),
        ),
      ),
    ).toEqual({ type: "provider.unsupported-operation", message: "no compact endpoint" })
    expect(
      toSessionError(
        llm(
          new NoRouteError({
            message: "failed",
            route: "route",
            provider: ProviderID.make("provider"),
            model: ModelID.make("model"),
          }),
        ),
      ).type,
    ).toBe("provider.no-route")
    expect(toSessionError(llm(new UnknownProviderError({ message: "unknown" }))).type).toBe("provider.unknown")
  })

  test("preserves the permission rejection type without exposing internal fields", () => {
    const blocked = new Permission.BlockedError({ rules: [], permission: "external_directory", resources: [] })
    expect(toSessionError(blocked)).toEqual({
      type: "permission.rejected",
      message: "Permission denied: external_directory",
    })
    expect(toSessionError(new ToolFailure({ message: blocked.message, error: blocked }))).toEqual({
      type: "permission.rejected",
      message: "Permission denied: external_directory",
    })
    expect(toSessionError(new Tool.Error({ message: "failed" }))).toEqual({
      type: "tool.execution",
      message: "failed",
    })
  })

  test("preserves provider HTTP status without exposing runtime diagnostics", () => {
    const http = new HttpContext({
      url: "https://example.com",
      status: 413,
      headers: { "x-request-id": "request-1" },
    })
    expect(
      toSessionError(
        llm(
          new InvalidRequestError({
            message: "too large",
            classification: "context-overflow",
            parameter: "messages",
            body: '{"error":"context limit"}',
            http,
            cause: new Error("request failed"),
          }),
        ),
      ),
    ).toEqual({
      type: "provider.invalid-request",
      message: "too large",
      status: 413,
    })
    expect(
      toSessionError(
        llm(
          new ProviderInternalError({
            message: "bad gateway",
            http: new HttpContext({ url: "https://example.com", status: 502, headers: {} }),
          }),
        ),
      ),
    ).toEqual({
      type: "provider.internal",
      message: "bad gateway",
      status: 502,
    })
  })

  test("preserves unresolved provider endpoint errors", () => {
    const error = new ModelResolver.UnresolvedProviderVariablesError({
      providerID: Provider.ID.make("cloudflare-workers-ai"),
      modelID: ID.make("model"),
      variables: ["CLOUDFLARE_ACCOUNT_ID"],
    })
    expect(toSessionError(error)).toEqual({
      type: "provider.no-route",
      message:
        "Cannot initialize cloudflare-workers-ai/model: CLOUDFLARE_ACCOUNT_ID is required to resolve the provider endpoint",
    })
  })

  test("preserves provider configuration and initialization errors", () => {
    const configuration = new ModelResolver.ModelConfigurationError({
      providerID: Provider.ID.make("azure"),
      modelID: ID.make("gpt-5.4-nano"),
      package: "aisdk:@ai-sdk/azure",
      detail: "Azure requires resourceName or baseURL",
    })
    expect(toSessionError(configuration)).toEqual({
      type: "provider.no-route",
      message: "Cannot initialize azure/gpt-5.4-nano: Azure requires resourceName or baseURL",
    })
    const initialization = new ModelResolver.ModelInitializationError({
      providerID: Provider.ID.make("custom"),
      modelID: ID.make("model"),
      package: "@opencode/ai/providers/custom",
      phase: "load",
      detail: "Provider package @opencode/ai/providers/custom is broken",
    })
    expect(toSessionError(initialization)).toEqual({
      type: "provider.no-route",
      message: "Cannot initialize custom/model: Provider package @opencode/ai/providers/custom is broken",
    })
  })

  test("retries rate limits, provider-internal, transport, and unrecognized failures", () => {
    const eligible = [
      llm(new RateLimitError({ message: "rate" })),
      llm(new ProviderInternalError({ message: "internal" })),
      llm(new TransportError({ message: "transport", transport: "http", operation: "request" })),
      llm(new UnknownProviderError({ message: "unknown" })),
    ]
    const ineligible = [
      llm(new AuthenticationError({ message: "auth" })),
      llm(new QuotaExceededError({ message: "quota" })),
      llm(new ContentPolicyError({ message: "blocked" })),
      llm(new InvalidProviderOutputError({ message: "output" })),
      llm(new InvalidRequestError({ message: "request" })),
      llm(new UnsupportedOperationError({ message: "unsupported", operation: "compact" })),
      llm(
        new NoRouteError({
          message: "failed",
          route: "route",
          provider: ProviderID.make("provider"),
          model: ModelID.make("model"),
        }),
      ),
    ]

    expect(eligible.map(SessionRunnerRetry.isRetryable)).toEqual([true, true, true, true])
    expect(ineligible.map(SessionRunnerRetry.isRetryable)).toEqual([false, false, false, false, false, false, false])
  })

  test("retries transport failures unless the provider accepted or rejected the request", () => {
    const retryable = [
      llm(new TransportError({ message: "http transport", transport: "http", operation: "request" })),
      llm(
        new TransportError({
          message: "connect failed",
          transport: "websocket",
          operation: "request",
          delivery: "not-sent",
          phase: "connect",
        }),
      ),
      llm(
        new TransportError({
          message: "send uncertain",
          transport: "websocket",
          operation: "write",
          delivery: "ambiguous",
          phase: "send",
        }),
      ),
    ]
    const ineligible = [
      llm(
        new TransportError({
          message: "response interrupted",
          transport: "websocket",
          operation: "read",
          delivery: "accepted",
          phase: "receive",
        }),
      ),
      llm(
        new TransportError({
          message: "continuation rejected",
          transport: "websocket",
          operation: "read",
          delivery: "rejected",
          recovery: "retry-full",
          phase: "receive",
        }),
      ),
    ]

    expect(retryable.map(SessionRunnerRetry.isRetryable)).toEqual([true, true, true])
    expect(ineligible.map(SessionRunnerRetry.isRetryable)).toEqual([false, false])
  })

  test("honors provider retry header overrides", () => {
    const http = (headers: Record<string, string>) =>
      new HttpContext({
        url: "https://example.com",
        status: 500,
        headers,
      })

    expect(
      SessionRunnerRetry.isRetryable(
        llm(
          new ProviderInternalError({
            message: "do not retry",
            http: http({ "x-should-retry": "false" }),
          }),
        ),
      ),
    ).toBeFalse()
    expect(
      SessionRunnerRetry.isRetryable(
        llm(new InvalidRequestError({ message: "retry", http: http({ "x-should-retry": "true" }) })),
      ),
    ).toBeTrue()
  })
})
