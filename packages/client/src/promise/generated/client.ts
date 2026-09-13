import type {
  HealthGetOutput,
  ServerGetOutput,
  LocationGetInput,
  LocationGetOutput,
  AgentListInput,
  AgentListOutput,
  AgentGetInput,
  AgentGetOutput,
  PluginListInput,
  PluginListOutput,
  PluginAwaitActivationInput,
  PluginAwaitActivationOutput,
  PluginCheckInput,
  PluginCheckOutput,
  PluginUpdateInput,
  PluginUpdateOutput,
  SessionListInput,
  SessionListOutput,
  SessionStatsInput,
  SessionStatsOutput,
  SessionCreateInput,
  SessionCreateOutput,
  SessionImportInput,
  SessionImportOutput,
  SessionExportInput,
  SessionExportOutput,
  SessionActiveOutput,
  SessionGetInput,
  SessionGetOutput,
  SessionRemoveInput,
  SessionRemoveOutput,
  SessionForkInput,
  SessionForkOutput,
  SessionSwitchAgentInput,
  SessionSwitchAgentOutput,
  SessionSwitchModelInput,
  SessionSwitchModelOutput,
  SessionRenameInput,
  SessionRenameOutput,
  SessionMoveInput,
  SessionMoveOutput,
  SessionPromptInput,
  SessionPromptOutput,
  SessionCommandInput,
  SessionCommandOutput,
  SessionSkillInput,
  SessionSkillOutput,
  SessionSyntheticInput,
  SessionSyntheticOutput,
  SessionShellInput,
  SessionShellOutput,
  SessionCompactInput,
  SessionCompactOutput,
  SessionWaitInput,
  SessionWaitOutput,
  SessionRevertStageInput,
  SessionRevertStageOutput,
  SessionRevertClearInput,
  SessionRevertClearOutput,
  SessionRevertCommitInput,
  SessionRevertCommitOutput,
  SessionContextInput,
  SessionContextOutput,
  SessionDiffInput,
  SessionDiffOutput,
  SessionInboxListInput,
  SessionInboxListOutput,
  SessionInboxCancelInput,
  SessionInboxCancelOutput,
  SessionInboxSteerInput,
  SessionInboxSteerOutput,
  SessionInboxQueueInput,
  SessionInboxQueueOutput,
  SessionInstructionsEntryListInput,
  SessionInstructionsEntryListOutput,
  SessionInstructionsEntryPutInput,
  SessionInstructionsEntryPutOutput,
  SessionInstructionsEntryRemoveInput,
  SessionInstructionsEntryRemoveOutput,
  SessionGenerateInput,
  SessionGenerateOutput,
  SessionLogInput,
  SessionLogOutput,
  SessionInterruptInput,
  SessionInterruptOutput,
  SessionBackgroundInput,
  SessionBackgroundOutput,
  SessionMessageInput,
  SessionMessageOutput,
  SessionEnvironmentInput,
  SessionEnvironmentOutput,
  SessionViewInput,
  SessionViewOutput,
  MessageListInput,
  MessageListOutput,
  ModelListInput,
  ModelListOutput,
  ModelDefaultInput,
  ModelDefaultOutput,
  GenerateTextInput,
  GenerateTextOutput,
  ProviderListInput,
  ProviderListOutput,
  ProviderGetInput,
  ProviderGetOutput,
  IntegrationListInput,
  IntegrationListOutput,
  IntegrationGetInput,
  IntegrationGetOutput,
  IntegrationWellknownAddInput,
  IntegrationWellknownAddOutput,
  IntegrationConnectKeyInput,
  IntegrationConnectKeyOutput,
  IntegrationOauthConnectInput,
  IntegrationOauthConnectOutput,
  IntegrationOauthStatusInput,
  IntegrationOauthStatusOutput,
  IntegrationOauthCompleteInput,
  IntegrationOauthCompleteOutput,
  IntegrationOauthCancelInput,
  IntegrationOauthCancelOutput,
  IntegrationCommandConnectInput,
  IntegrationCommandConnectOutput,
  IntegrationCommandStatusInput,
  IntegrationCommandStatusOutput,
  IntegrationCommandCancelInput,
  IntegrationCommandCancelOutput,
  McpListInput,
  McpListOutput,
  McpAddInput,
  McpAddOutput,
  McpRemoveInput,
  McpRemoveOutput,
  McpConnectInput,
  McpConnectOutput,
  McpDisconnectInput,
  McpDisconnectOutput,
  McpResourceCatalogInput,
  McpResourceCatalogOutput,
  CredentialUpdateInput,
  CredentialUpdateOutput,
  CredentialActivateInput,
  CredentialActivateOutput,
  CredentialRemoveInput,
  CredentialRemoveOutput,
  ProjectListOutput,
  ProjectUpdateInput,
  ProjectUpdateOutput,
  ProjectCurrentInput,
  ProjectCurrentOutput,
  FormRequestListInput,
  FormRequestListOutput,
  FormListInput,
  FormListOutput,
  FormCreateInput,
  FormCreateOutput,
  FormGetInput,
  FormGetOutput,
  FormStateInput,
  FormStateOutput,
  FormReplyInput,
  FormReplyOutput,
  FormCancelInput,
  FormCancelOutput,
  PermissionRequestListInput,
  PermissionRequestListOutput,
  PermissionSavedListInput,
  PermissionSavedListOutput,
  PermissionSavedRemoveInput,
  PermissionSavedRemoveOutput,
  PermissionCreateInput,
  PermissionCreateOutput,
  PermissionListInput,
  PermissionListOutput,
  PermissionGetInput,
  PermissionGetOutput,
  PermissionReplyInput,
  PermissionReplyOutput,
  PermissionRulesInput,
  PermissionRulesOutput,
  FileReadInput,
  FileReadOutput,
  FileListInput,
  FileListOutput,
  FileFindInput,
  FileFindOutput,
  CommandListInput,
  CommandListOutput,
  SkillListInput,
  SkillListOutput,
  RpcCallInput,
  RpcCallOutput,
  EventSubscribeOutput,
  PtyListInput,
  PtyListOutput,
  PtyCreateInput,
  PtyCreateOutput,
  PtyGetInput,
  PtyGetOutput,
  PtyUpdateInput,
  PtyUpdateOutput,
  PtyRemoveInput,
  PtyRemoveOutput,
  PtyConnectTokenInput,
  PtyConnectTokenOutput,
  ExperimentalPersistentPtyReadInput,
  ExperimentalPersistentPtyReadOutput,
  ExperimentalPersistentPtyListInput,
  ExperimentalPersistentPtyListOutput,
  ExperimentalPersistentPtyCreateInput,
  ExperimentalPersistentPtyCreateOutput,
  ExperimentalPersistentPtyShutdownOutput,
  ExperimentalPersistentPtyHandoffOutput,
  ExperimentalPersistentPtyGetInput,
  ExperimentalPersistentPtyGetOutput,
  ExperimentalPersistentPtyUpdateInput,
  ExperimentalPersistentPtyUpdateOutput,
  ExperimentalPersistentPtySnapshotInput,
  ExperimentalPersistentPtySnapshotOutput,
  ExperimentalPersistentPtyRemoveInput,
  ExperimentalPersistentPtyRemoveOutput,
  ExperimentalPersistentPtyConnectTokenInput,
  ExperimentalPersistentPtyConnectTokenOutput,
  ShellListInput,
  ShellListOutput,
  ShellCreateInput,
  ShellCreateOutput,
  ShellGetInput,
  ShellGetOutput,
  ShellTimeoutInput,
  ShellTimeoutOutput,
  ShellOutputInput,
  ShellOutputOutput,
  ShellRemoveInput,
  ShellRemoveOutput,
  ReferenceListInput,
  ReferenceListOutput,
  WorktreeListInput,
  WorktreeListOutput,
  WorktreeCreateInput,
  WorktreeCreateOutput,
  WorktreeRemoveInput,
  WorktreeRemoveOutput,
  WorktreeRefreshInput,
  WorktreeRefreshOutput,
  WorktreeInventoryOutput,
  WorkspaceCreateInput,
  WorkspaceCreateOutput,
  WorkspaceDestroyInput,
  WorkspaceDestroyOutput,
  VcsGetInput,
  VcsGetOutput,
  VcsBaseInput,
  VcsBaseOutput,
  VcsStatusInput,
  VcsStatusOutput,
  VcsBranchesInput,
  VcsBranchesOutput,
  VcsDiffInput,
  VcsDiffOutput,
  DebugLocationListOutput,
  DebugLocationEvictInput,
  DebugLocationEvictOutput,
  MigrationV1StatusOutput,
  WebsearchProvidersInput,
  WebsearchProvidersOutput,
  WebsearchQueryInput,
  WebsearchQueryOutput,
  ConfigGetInput,
  ConfigGetOutput,
  ConfigPreferencesOutput,
  ConfigUpdatePreferencesInput,
  ConfigUpdatePreferencesOutput,
  ConfigShellsOutput,
} from "./types.js"
import { ClientError } from "./client-error.js"

export interface ClientOptions {
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: RequestInit["headers"]
}

export interface RequestOptions {
  readonly signal?: AbortSignal
  readonly headers?: RequestInit["headers"]
  /** Reports every chunk a streaming response receives, including keepalive comments that yield no event. */
  readonly onActivity?: () => void
}

interface RequestDescriptor {
  readonly method: string
  readonly path: string
  readonly query?: Record<string, unknown>
  readonly headers?: Record<string, unknown>
  readonly body?: unknown
  readonly successStatus: number
  readonly declaredStatuses: ReadonlyArray<number>
  readonly empty: boolean
  readonly binary?: true
}

const maxSseEventBytes = 16 * 1024 * 1024

export function make(options: ClientOptions) {
  const fetch = options.fetch ?? globalThis.fetch

  const prepare = (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    const url = new URL(descriptor.path, options.baseUrl)
    for (const [key, value] of Object.entries(descriptor.query ?? {})) appendQuery(url.searchParams, key, value)
    const headers = new Headers(options.headers)
    for (const [key, value] of Object.entries(descriptor.headers ?? {})) {
      if (value !== undefined && value !== null) headers.set(key, String(value))
    }
    for (const [key, value] of new Headers(requestOptions?.headers)) headers.set(key, value)
    if (descriptor.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
    return {
      url,
      init: {
        method: descriptor.method,
        signal: requestOptions?.signal,
        headers,
        body: descriptor.body === undefined ? undefined : JSON.stringify(descriptor.body),
      } satisfies RequestInit,
    }
  }

  const execute = async (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    try {
      const prepared = prepare(descriptor, requestOptions)
      return await fetch(prepared.url, prepared.init)
    } catch (cause) {
      throw new ClientError("Transport", { cause })
    }
  }

  const responseError = async (response: Response, descriptor: RequestDescriptor): Promise<never> => {
    if (descriptor.declaredStatuses.includes(response.status)) throw await json(response)
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
  }

  const request = async <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): Promise<A> => {
    const response = await execute(descriptor, requestOptions)
    if (response.status !== descriptor.successStatus) return responseError(response, descriptor)
    if (descriptor.binary) return new Uint8Array(await response.arrayBuffer()) as A
    if (descriptor.empty) {
      try {
        await response.body?.cancel()
      } catch {}
      return undefined as A
    }
    return (await json(response)) as A
  }

  const sse = <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): AsyncIterable<A> => ({
    async *[Symbol.asyncIterator]() {
      const response = await execute(descriptor, requestOptions)
      if (response.status !== descriptor.successStatus) await responseError(response, descriptor)
      if (!isContentType(response, "text/event-stream")) {
        try {
          await response.body?.cancel()
        } catch {}
        throw new ClientError("UnsupportedContentType")
      }
      if (response.body === null) throw new ClientError("MalformedResponse")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          let next
          try {
            next = await reader.read()
          } catch (cause) {
            throw new ClientError("Transport", { cause })
          }
          if (!next.done) requestOptions?.onActivity?.()
          buffer += decoder.decode(next.value, { stream: !next.done })
          if (buffer.length > maxSseEventBytes) throw new ClientError("SseEventTooLarge")
          const trailingCarriageReturn = !next.done && buffer.endsWith("\r")
          if (trailingCarriageReturn) buffer = buffer.slice(0, -1)
          buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
          if (trailingCarriageReturn) buffer += "\r"
          if (next.done && buffer !== "") buffer += "\n\n"
          let boundary = buffer.indexOf("\n\n")
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = block
              .split("\n")
              .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
              .join("\n")
            if (data !== "") {
              try {
                yield JSON.parse(data) as A
              } catch (cause) {
                throw new ClientError("MalformedResponse", { cause })
              }
            }
            boundary = buffer.indexOf("\n\n")
          }
          if (next.done) return
        }
      } finally {
        try {
          await reader.cancel()
        } catch {}
        reader.releaseLock()
      }
    },
  })

  return {
    health: {
      get: (requestOptions?: RequestOptions) =>
        request<HealthGetOutput>(
          { method: "GET", path: `/api/health`, successStatus: 200, declaredStatuses: [400, 401], empty: false },
          requestOptions,
        ),
    },
    server: {
      get: (requestOptions?: RequestOptions) =>
        request<ServerGetOutput>(
          { method: "GET", path: `/api/server`, successStatus: 200, declaredStatuses: [400, 401], empty: false },
          requestOptions,
        ),
    },
    location: {
      get: (input?: LocationGetInput, requestOptions?: RequestOptions) =>
        request<LocationGetOutput>(
          {
            method: "GET",
            path: `/api/location`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    agent: {
      list: (input?: AgentListInput, requestOptions?: RequestOptions) =>
        request<AgentListOutput>(
          {
            method: "GET",
            path: `/api/agent`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: AgentGetInput, requestOptions?: RequestOptions) =>
        request<AgentGetOutput>(
          {
            method: "GET",
            path: `/api/agent/${encodeURIComponent(input.agentID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ),
    },
    plugin: {
      list: (input?: PluginListInput, requestOptions?: RequestOptions) =>
        request<PluginListOutput>(
          {
            method: "GET",
            path: `/api/plugin`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      awaitActivation: (input?: PluginAwaitActivationInput, requestOptions?: RequestOptions) =>
        request<PluginAwaitActivationOutput>(
          {
            method: "POST",
            path: `/api/plugin/await-activation`,
            query: { location: input?.["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
      check: (input?: PluginCheckInput, requestOptions?: RequestOptions) =>
        request<PluginCheckOutput>(
          {
            method: "POST",
            path: `/api/plugin/check`,
            query: { location: input?.["location"] },
            body: { target: input?.["target"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: PluginUpdateInput, requestOptions?: RequestOptions) =>
        request<PluginUpdateOutput>(
          {
            method: "POST",
            path: `/api/plugin/update`,
            query: { location: input["location"] },
            body: { targets: input["targets"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 503],
            empty: true,
          },
          requestOptions,
        ),
    },
    session: {
      list: (input?: SessionListInput, requestOptions?: RequestOptions) =>
        request<SessionListOutput>(
          {
            method: "GET",
            path: `/api/session`,
            query: {
              workspace: input?.["workspace"],
              limit: input?.["limit"],
              order: input?.["order"],
              search: input?.["search"],
              parentID: input?.["parentID"],
              directory: input?.["directory"],
              project: input?.["project"],
              subpath: input?.["subpath"],
              cursor: input?.["cursor"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      stats: (input?: SessionStatsInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionStatsOutput }>(
          {
            method: "GET",
            path: `/api/session/stats`,
            query: {
              from: input?.["from"],
              to: input?.["to"],
              project: input?.["project"],
              timezone: input?.["timezone"],
              tools: input?.["tools"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      create: (input?: SessionCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionCreateOutput }>(
          {
            method: "POST",
            path: `/api/session`,
            body: {
              id: input?.["id"],
              title: input?.["title"],
              agent: input?.["agent"],
              model: input?.["model"],
              location: input?.["location"],
              metadata: input?.["metadata"],
              permissions: input?.["permissions"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      import: (input: SessionImportInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionImportOutput }>(
          {
            method: "POST",
            path: `/api/session/import`,
            body: { info: input["info"], messages: input["messages"], location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404, 409],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      export: (input: SessionExportInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionExportOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/export`,
            query: { sanitize: input["sanitize"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404, 500],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      active: (requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionActiveOutput }>(
          {
            method: "GET",
            path: `/api/session/active`,
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: SessionGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}`,
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      remove: (input: SessionRemoveInput, requestOptions?: RequestOptions) =>
        request<SessionRemoveOutput>(
          {
            method: "DELETE",
            path: `/api/session/${encodeURIComponent(input.sessionID)}`,
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      fork: (input: SessionForkInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionForkOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/fork`,
            body: { boundary: input["boundary"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      switchAgent: (input: SessionSwitchAgentInput, requestOptions?: RequestOptions) =>
        request<SessionSwitchAgentOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/agent`,
            body: { agent: input["agent"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      switchModel: (input: SessionSwitchModelInput, requestOptions?: RequestOptions) =>
        request<SessionSwitchModelOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/model`,
            body: { model: input["model"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      rename: (input: SessionRenameInput, requestOptions?: RequestOptions) =>
        request<SessionRenameOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/rename`,
            body: { title: input["title"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      move: (input: SessionMoveInput, requestOptions?: RequestOptions) =>
        request<SessionMoveOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/move`,
            body: { directory: input["directory"], workspaceID: input["workspaceID"], delivery: input["delivery"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      prompt: (input: SessionPromptInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionPromptOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/prompt`,
            body: {
              id: input["id"],
              text: input["text"],
              files: input["files"],
              agents: input["agents"],
              skills: input["skills"],
              metadata: input["metadata"],
              delivery: input["delivery"],
              resume: input["resume"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401, 404, 409],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      command: (input: SessionCommandInput, requestOptions?: RequestOptions) =>
        request<SessionCommandOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/command`,
            body: {
              command: input["command"],
              text: input["text"],
              files: input["files"],
              agents: input["agents"],
              skills: input["skills"],
              delivery: input["delivery"],
            },
            successStatus: 204,
            declaredStatuses: [400, 401, 404, 500],
            empty: true,
          },
          requestOptions,
        ),
      skill: (input: SessionSkillInput, requestOptions?: RequestOptions) =>
        request<SessionSkillOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/skill`,
            body: { id: input["id"], skill: input["skill"], resume: input["resume"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      synthetic: (input: SessionSyntheticInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionSyntheticOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/synthetic`,
            body: {
              id: input["id"],
              text: input["text"],
              description: input["description"],
              metadata: input["metadata"],
              delivery: input["delivery"],
              resume: input["resume"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401, 404, 409],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      shell: (input: SessionShellInput, requestOptions?: RequestOptions) =>
        request<SessionShellOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/shell`,
            body: { id: input["id"], command: input["command"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      compact: (input: SessionCompactInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionCompactOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/compact`,
            body: { id: input["id"], delivery: input["delivery"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404, 409],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      wait: (input: SessionWaitInput, requestOptions?: RequestOptions) =>
        request<SessionWaitOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/wait`,
            successStatus: 204,
            declaredStatuses: [400, 401, 404, 503],
            empty: true,
          },
          requestOptions,
        ),
      revert: {
        stage: (input: SessionRevertStageInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: SessionRevertStageOutput }>(
            {
              method: "POST",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/stage`,
              body: { messageID: input["messageID"], files: input["files"] },
              successStatus: 200,
              declaredStatuses: [400, 401, 404, 409, 500],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        clear: (input: SessionRevertClearInput, requestOptions?: RequestOptions) =>
          request<SessionRevertClearOutput>(
            {
              method: "POST",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/clear`,
              successStatus: 204,
              declaredStatuses: [400, 401, 404, 409, 500],
              empty: true,
            },
            requestOptions,
          ),
        commit: (input: SessionRevertCommitInput, requestOptions?: RequestOptions) =>
          request<SessionRevertCommitOutput>(
            {
              method: "POST",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/commit`,
              successStatus: 204,
              declaredStatuses: [400, 401, 404, 409],
              empty: true,
            },
            requestOptions,
          ),
      },
      context: (input: SessionContextInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionContextOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/context`,
            successStatus: 200,
            declaredStatuses: [400, 401, 404, 500],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      diff: (input: SessionDiffInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionDiffOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/diff`,
            query: { from: input["from"], to: input["to"], context: input["context"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404, 500],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      inbox: {
        list: (input: SessionInboxListInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: SessionInboxListOutput }>(
            {
              method: "GET",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/inbox`,
              successStatus: 200,
              declaredStatuses: [400, 401, 404],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        cancel: (input: SessionInboxCancelInput, requestOptions?: RequestOptions) =>
          request<SessionInboxCancelOutput>(
            {
              method: "DELETE",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/inbox/${encodeURIComponent(input.inboxID)}`,
              successStatus: 204,
              declaredStatuses: [400, 401, 404, 409],
              empty: true,
            },
            requestOptions,
          ),
        steer: (input: SessionInboxSteerInput, requestOptions?: RequestOptions) =>
          request<SessionInboxSteerOutput>(
            {
              method: "POST",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/inbox/${encodeURIComponent(input.inboxID)}/steer`,
              successStatus: 204,
              declaredStatuses: [400, 401, 404, 409],
              empty: true,
            },
            requestOptions,
          ),
        queue: (input: SessionInboxQueueInput, requestOptions?: RequestOptions) =>
          request<SessionInboxQueueOutput>(
            {
              method: "POST",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/inbox/${encodeURIComponent(input.inboxID)}/queue`,
              successStatus: 204,
              declaredStatuses: [400, 401, 404, 409],
              empty: true,
            },
            requestOptions,
          ),
      },
      instructions: {
        entry: {
          list: (input: SessionInstructionsEntryListInput, requestOptions?: RequestOptions) =>
            request<{ readonly data: SessionInstructionsEntryListOutput }>(
              {
                method: "GET",
                path: `/api/session/${encodeURIComponent(input.sessionID)}/instructions/entries`,
                successStatus: 200,
                declaredStatuses: [400, 401, 404],
                empty: false,
              },
              requestOptions,
            ).then((value) => value.data),
          put: (input: SessionInstructionsEntryPutInput, requestOptions?: RequestOptions) =>
            request<SessionInstructionsEntryPutOutput>(
              {
                method: "PUT",
                path: `/api/session/${encodeURIComponent(input.sessionID)}/instructions/entries/${encodeURIComponent(input.key)}`,
                body: { value: input["value"] },
                successStatus: 204,
                declaredStatuses: [400, 401, 404, 413],
                empty: true,
              },
              requestOptions,
            ),
          remove: (input: SessionInstructionsEntryRemoveInput, requestOptions?: RequestOptions) =>
            request<SessionInstructionsEntryRemoveOutput>(
              {
                method: "DELETE",
                path: `/api/session/${encodeURIComponent(input.sessionID)}/instructions/entries/${encodeURIComponent(input.key)}`,
                successStatus: 204,
                declaredStatuses: [400, 401, 404],
                empty: true,
              },
              requestOptions,
            ),
        },
      },
      generate: (input: SessionGenerateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionGenerateOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/generate`,
            body: { prompt: input["prompt"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404, 503],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      log: (input: SessionLogInput, requestOptions?: RequestOptions): AsyncIterable<SessionLogOutput> =>
        sse<SessionLogOutput>(
          {
            method: "GET",
            path: `/api/experimental/session/${encodeURIComponent(input.sessionID)}/log`,
            query: { after: input["after"], follow: input["follow"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ),
      interrupt: (input: SessionInterruptInput, requestOptions?: RequestOptions) =>
        request<SessionInterruptOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/interrupt`,
            query: { continue: input["continue"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ),
      background: (input: SessionBackgroundInput, requestOptions?: RequestOptions) =>
        request<SessionBackgroundOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/background`,
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      message: (input: SessionMessageInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionMessageOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      environment: (input: SessionEnvironmentInput, requestOptions?: RequestOptions) =>
        request<SessionEnvironmentOutput>(
          {
            method: "PUT",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/environment`,
            body: { variables: input["variables"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      view: (input: SessionViewInput, requestOptions?: RequestOptions) =>
        request<SessionViewOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/view`,
            body: { idle: input["idle"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
    },
    message: {
      list: (input: MessageListInput, requestOptions?: RequestOptions) =>
        request<MessageListOutput>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/message`,
            query: { limit: input["limit"], order: input["order"], cursor: input["cursor"], type: input["type"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404, 500],
            empty: false,
          },
          requestOptions,
        ),
    },
    model: {
      list: (input?: ModelListInput, requestOptions?: RequestOptions) =>
        request<ModelListOutput>(
          {
            method: "GET",
            path: `/api/model`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 503],
            empty: false,
          },
          requestOptions,
        ),
      default: (input?: ModelDefaultInput, requestOptions?: RequestOptions) =>
        request<ModelDefaultOutput>(
          {
            method: "GET",
            path: `/api/model/default`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 503],
            empty: false,
          },
          requestOptions,
        ),
    },
    generate: {
      text: (input: GenerateTextInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: GenerateTextOutput }>(
          {
            method: "POST",
            path: `/api/generate`,
            body: { prompt: input["prompt"], model: input["model"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 503],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    provider: {
      list: (input?: ProviderListInput, requestOptions?: RequestOptions) =>
        request<ProviderListOutput>(
          {
            method: "GET",
            path: `/api/provider`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 503],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: ProviderGetInput, requestOptions?: RequestOptions) =>
        request<ProviderGetOutput>(
          {
            method: "GET",
            path: `/api/provider/${encodeURIComponent(input.providerID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404, 503],
            empty: false,
          },
          requestOptions,
        ),
    },
    integration: {
      list: (input?: IntegrationListInput, requestOptions?: RequestOptions) =>
        request<IntegrationListOutput>(
          {
            method: "GET",
            path: `/api/integration`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: IntegrationGetInput, requestOptions?: RequestOptions) =>
        request<IntegrationGetOutput>(
          {
            method: "GET",
            path: `/api/integration/${encodeURIComponent(input.integrationID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      wellknown: {
        add: (input: IntegrationWellknownAddInput, requestOptions?: RequestOptions) =>
          request<IntegrationWellknownAddOutput>(
            {
              method: "POST",
              path: `/api/experimental/integration/wellknown`,
              query: { location: input["location"] },
              body: { url: input["url"] },
              successStatus: 204,
              declaredStatuses: [400, 401],
              empty: true,
            },
            requestOptions,
          ),
      },
      connect: {
        key: (input: IntegrationConnectKeyInput, requestOptions?: RequestOptions) =>
          request<IntegrationConnectKeyOutput>(
            {
              method: "POST",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/key`,
              query: { location: input["location"] },
              body: { key: input["key"], answer: input["answer"], label: input["label"] },
              successStatus: 204,
              declaredStatuses: [400, 401],
              empty: true,
            },
            requestOptions,
          ),
      },
      oauth: {
        connect: (input: IntegrationOauthConnectInput, requestOptions?: RequestOptions) =>
          request<IntegrationOauthConnectOutput>(
            {
              method: "POST",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/oauth`,
              query: { location: input["location"] },
              body: { methodID: input["methodID"], answer: input["answer"], label: input["label"] },
              successStatus: 200,
              declaredStatuses: [400, 401],
              empty: false,
            },
            requestOptions,
          ),
        status: (input: IntegrationOauthStatusInput, requestOptions?: RequestOptions) =>
          request<IntegrationOauthStatusOutput>(
            {
              method: "GET",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/oauth/${encodeURIComponent(input.attemptID)}`,
              query: { location: input["location"] },
              successStatus: 200,
              declaredStatuses: [400, 401],
              empty: false,
            },
            requestOptions,
          ),
        complete: (input: IntegrationOauthCompleteInput, requestOptions?: RequestOptions) =>
          request<IntegrationOauthCompleteOutput>(
            {
              method: "POST",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/oauth/${encodeURIComponent(input.attemptID)}/complete`,
              query: { location: input["location"] },
              body: { code: input["code"] },
              successStatus: 204,
              declaredStatuses: [400, 401],
              empty: true,
            },
            requestOptions,
          ),
        cancel: (input: IntegrationOauthCancelInput, requestOptions?: RequestOptions) =>
          request<IntegrationOauthCancelOutput>(
            {
              method: "DELETE",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/oauth/${encodeURIComponent(input.attemptID)}`,
              query: { location: input["location"] },
              successStatus: 204,
              declaredStatuses: [400, 401],
              empty: true,
            },
            requestOptions,
          ),
      },
      command: {
        connect: (input: IntegrationCommandConnectInput, requestOptions?: RequestOptions) =>
          request<IntegrationCommandConnectOutput>(
            {
              method: "POST",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/command`,
              query: { location: input["location"] },
              body: { methodID: input["methodID"], label: input["label"] },
              successStatus: 200,
              declaredStatuses: [400, 401],
              empty: false,
            },
            requestOptions,
          ),
        status: (input: IntegrationCommandStatusInput, requestOptions?: RequestOptions) =>
          request<IntegrationCommandStatusOutput>(
            {
              method: "GET",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/command/${encodeURIComponent(input.attemptID)}`,
              query: { location: input["location"] },
              successStatus: 200,
              declaredStatuses: [400, 401],
              empty: false,
            },
            requestOptions,
          ),
        cancel: (input: IntegrationCommandCancelInput, requestOptions?: RequestOptions) =>
          request<IntegrationCommandCancelOutput>(
            {
              method: "DELETE",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/command/${encodeURIComponent(input.attemptID)}`,
              query: { location: input["location"] },
              successStatus: 204,
              declaredStatuses: [400, 401],
              empty: true,
            },
            requestOptions,
          ),
      },
    },
    mcp: {
      list: (input?: McpListInput, requestOptions?: RequestOptions) =>
        request<McpListOutput>(
          {
            method: "GET",
            path: `/api/mcp`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      add: (input: McpAddInput, requestOptions?: RequestOptions) =>
        request<McpAddOutput>(
          {
            method: "PUT",
            path: `/api/mcp/${encodeURIComponent(input.server)}`,
            query: { location: input["location"] },
            body: { config: input["config"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
      remove: (input: McpRemoveInput, requestOptions?: RequestOptions) =>
        request<McpRemoveOutput>(
          {
            method: "DELETE",
            path: `/api/mcp/${encodeURIComponent(input.server)}`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      connect: (input: McpConnectInput, requestOptions?: RequestOptions) =>
        request<McpConnectOutput>(
          {
            method: "POST",
            path: `/api/mcp/${encodeURIComponent(input.server)}/connect`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      disconnect: (input: McpDisconnectInput, requestOptions?: RequestOptions) =>
        request<McpDisconnectOutput>(
          {
            method: "POST",
            path: `/api/mcp/${encodeURIComponent(input.server)}/disconnect`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      resource: {
        catalog: (input?: McpResourceCatalogInput, requestOptions?: RequestOptions) =>
          request<McpResourceCatalogOutput>(
            {
              method: "GET",
              path: `/api/mcp/resource`,
              query: { location: input?.["location"] },
              successStatus: 200,
              declaredStatuses: [400, 401],
              empty: false,
            },
            requestOptions,
          ),
      },
    },
    credential: {
      update: (input: CredentialUpdateInput, requestOptions?: RequestOptions) =>
        request<CredentialUpdateOutput>(
          {
            method: "PATCH",
            path: `/api/credential/${encodeURIComponent(input.credentialID)}`,
            query: { location: input["location"] },
            body: { label: input["label"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
      activate: (input: CredentialActivateInput, requestOptions?: RequestOptions) =>
        request<CredentialActivateOutput>(
          {
            method: "POST",
            path: `/api/credential/${encodeURIComponent(input.credentialID)}/activate`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
      remove: (input: CredentialRemoveInput, requestOptions?: RequestOptions) =>
        request<CredentialRemoveOutput>(
          {
            method: "DELETE",
            path: `/api/credential/${encodeURIComponent(input.credentialID)}`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
    },
    project: {
      list: (requestOptions?: RequestOptions) =>
        request<ProjectListOutput>(
          { method: "GET", path: `/api/project`, successStatus: 200, declaredStatuses: [400, 401], empty: false },
          requestOptions,
        ),
      update: (input: ProjectUpdateInput, requestOptions?: RequestOptions) =>
        request<ProjectUpdateOutput>(
          {
            method: "PATCH",
            path: `/api/project/${encodeURIComponent(input.projectID)}`,
            body: {
              canonical: input["canonical"],
              name: input["name"],
              icon: input["icon"],
              commands: input["commands"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ),
      current: (input?: ProjectCurrentInput, requestOptions?: RequestOptions) =>
        request<ProjectCurrentOutput>(
          {
            method: "GET",
            path: `/api/project/current`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    form: {
      request: {
        list: (input?: FormRequestListInput, requestOptions?: RequestOptions) =>
          request<FormRequestListOutput>(
            {
              method: "GET",
              path: `/api/form/request`,
              query: { location: input?.["location"] },
              successStatus: 200,
              declaredStatuses: [400, 401],
              empty: false,
            },
            requestOptions,
          ),
      },
      list: (input: FormListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: FormListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/form`,
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      create: (input: FormCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: FormCreateOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/form`,
            body: { id: input["id"], title: input["title"], metadata: input["metadata"], fields: input["fields"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404, 409],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: FormGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: FormGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}`,
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      state: (input: FormStateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: FormStateOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}/state`,
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      reply: (input: FormReplyInput, requestOptions?: RequestOptions) =>
        request<FormReplyOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}/reply`,
            body: { answer: input["answer"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404, 409],
            empty: true,
          },
          requestOptions,
        ),
      cancel: (input: FormCancelInput, requestOptions?: RequestOptions) =>
        request<FormCancelOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}/cancel`,
            successStatus: 204,
            declaredStatuses: [400, 401, 404, 409],
            empty: true,
          },
          requestOptions,
        ),
    },
    permission: {
      request: {
        list: (input?: PermissionRequestListInput, requestOptions?: RequestOptions) =>
          request<PermissionRequestListOutput>(
            {
              method: "GET",
              path: `/api/permission/request`,
              query: { location: input?.["location"] },
              successStatus: 200,
              declaredStatuses: [400, 401],
              empty: false,
            },
            requestOptions,
          ),
      },
      saved: {
        list: (input?: PermissionSavedListInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: PermissionSavedListOutput }>(
            {
              method: "GET",
              path: `/api/permission/saved`,
              query: { projectID: input?.["projectID"] },
              successStatus: 200,
              declaredStatuses: [400, 401],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        remove: (input: PermissionSavedRemoveInput, requestOptions?: RequestOptions) =>
          request<PermissionSavedRemoveOutput>(
            {
              method: "DELETE",
              path: `/api/permission/saved/${encodeURIComponent(input.id)}`,
              successStatus: 204,
              declaredStatuses: [400, 401],
              empty: true,
            },
            requestOptions,
          ),
      },
      create: (input: PermissionCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionCreateOutput }>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission`,
            body: {
              id: input["id"],
              action: input["action"],
              resources: input["resources"],
              save: input["save"],
              metadata: input["metadata"],
              source: input["source"],
              agent: input["agent"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      list: (input: PermissionListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionListOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission`,
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: PermissionGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionGetOutput }>(
          {
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}`,
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      reply: (input: PermissionReplyInput, requestOptions?: RequestOptions) =>
        request<PermissionReplyOutput>(
          {
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}/reply`,
            body: { reply: input["reply"], message: input["message"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      rules: (input: PermissionRulesInput, requestOptions?: RequestOptions) =>
        request<PermissionRulesOutput>(
          {
            method: "PUT",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission/rules`,
            body: { permissions: input["permissions"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
    },
    file: {
      read: (input: FileReadInput, requestOptions?: RequestOptions) =>
        request<FileReadOutput>(
          {
            method: "GET",
            path: `/api/fs/read/${encodePath(input.path)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
            binary: true,
          },
          requestOptions,
        ),
      list: (input?: FileListInput, requestOptions?: RequestOptions) =>
        request<FileListOutput>(
          {
            method: "GET",
            path: `/api/fs/list`,
            query: { location: input?.["location"], path: input?.["path"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      find: (input: FileFindInput, requestOptions?: RequestOptions) =>
        request<FileFindOutput>(
          {
            method: "GET",
            path: `/api/fs/find`,
            query: { location: input["location"], query: input["query"], type: input["type"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    command: {
      list: (input?: CommandListInput, requestOptions?: RequestOptions) =>
        request<CommandListOutput>(
          {
            method: "GET",
            path: `/api/command`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    skill: {
      list: (input?: SkillListInput, requestOptions?: RequestOptions) =>
        request<SkillListOutput>(
          {
            method: "GET",
            path: `/api/skill`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    rpc: {
      call: (input: RpcCallInput, requestOptions?: RequestOptions) =>
        request<RpcCallOutput>(
          {
            method: "POST",
            path: `/api/rpc/${encodeURIComponent(input.rpcID)}/${encodeURIComponent(input.method)}`,
            query: { location: input["location"] },
            body: { input: input["input"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 500],
            empty: false,
          },
          requestOptions,
        ),
    },
    event: {
      subscribe: (requestOptions?: RequestOptions): AsyncIterable<EventSubscribeOutput> =>
        sse<EventSubscribeOutput>(
          { method: "GET", path: `/api/event`, successStatus: 200, declaredStatuses: [400, 401], empty: false },
          requestOptions,
        ),
    },
    pty: {
      list: (input?: PtyListInput, requestOptions?: RequestOptions) =>
        request<PtyListOutput>(
          {
            method: "GET",
            path: `/api/pty`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      create: (input?: PtyCreateInput, requestOptions?: RequestOptions) =>
        request<PtyCreateOutput>(
          {
            method: "POST",
            path: `/api/pty`,
            query: { location: input?.["location"] },
            body: {
              command: input?.["command"],
              args: input?.["args"],
              cwd: input?.["cwd"],
              title: input?.["title"],
              env: input?.["env"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: PtyGetInput, requestOptions?: RequestOptions) =>
        request<PtyGetOutput>(
          {
            method: "GET",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: PtyUpdateInput, requestOptions?: RequestOptions) =>
        request<PtyUpdateOutput>(
          {
            method: "PUT",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            query: { location: input["location"] },
            body: { title: input["title"], size: input["size"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: PtyRemoveInput, requestOptions?: RequestOptions) =>
        request<PtyRemoveOutput>(
          {
            method: "DELETE",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
      connect: {
        token: (input: PtyConnectTokenInput, requestOptions?: RequestOptions) =>
          request<PtyConnectTokenOutput>(
            {
              method: "POST",
              path: `/api/pty/${encodeURIComponent(input.ptyID)}/connect-token`,
              query: { location: input["location"] },
              headers: { "x-opencode-ticket": input["x-opencode-ticket"] },
              successStatus: 200,
              declaredStatuses: [400, 401, 403, 404],
              empty: false,
            },
            requestOptions,
          ),
      },
    },
    experimental: {
      persistentPty: {
        read: (input: ExperimentalPersistentPtyReadInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: ExperimentalPersistentPtyReadOutput }>(
            {
              method: "GET",
              path: `/api/experimental/session/${encodeURIComponent(input.sessionID)}/terminal/read`,
              query: { lines: input["lines"] },
              successStatus: 200,
              declaredStatuses: [400, 401, 503],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        list: (input: ExperimentalPersistentPtyListInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: ExperimentalPersistentPtyListOutput }>(
            {
              method: "GET",
              path: `/api/experimental/session/${encodeURIComponent(input.sessionID)}/terminal`,
              successStatus: 200,
              declaredStatuses: [400, 401, 503],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        create: (input: ExperimentalPersistentPtyCreateInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: ExperimentalPersistentPtyCreateOutput }>(
            {
              method: "POST",
              path: `/api/experimental/session/${encodeURIComponent(input.sessionID)}/terminal`,
              body: {
                command: input["command"],
                args: input["args"],
                cwd: input["cwd"],
                title: input["title"],
                env: input["env"],
                size: input["size"],
              },
              successStatus: 200,
              declaredStatuses: [400, 401, 503],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        shutdown: (requestOptions?: RequestOptions) =>
          request<ExperimentalPersistentPtyShutdownOutput>(
            {
              method: "POST",
              path: `/api/experimental/persistent-pty/shutdown`,
              successStatus: 204,
              declaredStatuses: [400, 401, 503],
              empty: true,
            },
            requestOptions,
          ),
        handoff: (requestOptions?: RequestOptions) =>
          request<ExperimentalPersistentPtyHandoffOutput>(
            {
              method: "POST",
              path: `/api/experimental/persistent-pty/handoff`,
              successStatus: 200,
              declaredStatuses: [400, 401, 503],
              empty: false,
            },
            requestOptions,
          ),
        get: (input: ExperimentalPersistentPtyGetInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: ExperimentalPersistentPtyGetOutput }>(
            {
              method: "GET",
              path: `/api/experimental/persistent-pty/${encodeURIComponent(input.ptyID)}`,
              successStatus: 200,
              declaredStatuses: [400, 401, 404, 503],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        update: (input: ExperimentalPersistentPtyUpdateInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: ExperimentalPersistentPtyUpdateOutput }>(
            {
              method: "PUT",
              path: `/api/experimental/persistent-pty/${encodeURIComponent(input.ptyID)}`,
              body: { attachmentID: input["attachmentID"], size: input["size"] },
              successStatus: 200,
              declaredStatuses: [400, 401, 404, 503],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        snapshot: (input: ExperimentalPersistentPtySnapshotInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: ExperimentalPersistentPtySnapshotOutput }>(
            {
              method: "GET",
              path: `/api/experimental/persistent-pty/${encodeURIComponent(input.ptyID)}/snapshot`,
              successStatus: 200,
              declaredStatuses: [400, 401, 404, 503],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        remove: (input: ExperimentalPersistentPtyRemoveInput, requestOptions?: RequestOptions) =>
          request<ExperimentalPersistentPtyRemoveOutput>(
            {
              method: "DELETE",
              path: `/api/experimental/persistent-pty/${encodeURIComponent(input.ptyID)}`,
              successStatus: 204,
              declaredStatuses: [400, 401, 404, 503],
              empty: true,
            },
            requestOptions,
          ),
        connectToken: (input: ExperimentalPersistentPtyConnectTokenInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: ExperimentalPersistentPtyConnectTokenOutput }>(
            {
              method: "POST",
              path: `/api/experimental/persistent-pty/${encodeURIComponent(input.ptyID)}/connect-token`,
              headers: { "x-opencode-ticket": input["x-opencode-ticket"] },
              successStatus: 200,
              declaredStatuses: [400, 401, 403, 404, 503],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
      },
    },
    shell: {
      list: (input?: ShellListInput, requestOptions?: RequestOptions) =>
        request<ShellListOutput>(
          {
            method: "GET",
            path: `/api/shell`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      create: (input: ShellCreateInput, requestOptions?: RequestOptions) =>
        request<ShellCreateOutput>(
          {
            method: "POST",
            path: `/api/shell`,
            query: { location: input["location"] },
            body: {
              command: input["command"],
              cwd: input["cwd"],
              timeout: input["timeout"],
              metadata: input["metadata"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: ShellGetInput, requestOptions?: RequestOptions) =>
        request<ShellGetOutput>(
          {
            method: "GET",
            path: `/api/shell/${encodeURIComponent(input.id)}`,
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ),
      timeout: (input: ShellTimeoutInput, requestOptions?: RequestOptions) =>
        request<ShellTimeoutOutput>(
          {
            method: "PATCH",
            path: `/api/shell/${encodeURIComponent(input.id)}/timeout`,
            query: { location: input["location"] },
            body: { timeout: input["timeout"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ),
      output: (input: ShellOutputInput, requestOptions?: RequestOptions) =>
        request<ShellOutputOutput>(
          {
            method: "GET",
            path: `/api/shell/${encodeURIComponent(input.id)}/output`,
            query: { location: input["location"], cursor: input["cursor"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: ShellRemoveInput, requestOptions?: RequestOptions) =>
        request<ShellRemoveOutput>(
          {
            method: "DELETE",
            path: `/api/shell/${encodeURIComponent(input.id)}`,
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 404],
            empty: true,
          },
          requestOptions,
        ),
    },
    reference: {
      list: (input?: ReferenceListInput, requestOptions?: RequestOptions) =>
        request<ReferenceListOutput>(
          {
            method: "GET",
            path: `/api/reference`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    worktree: {
      list: (input?: WorktreeListInput, requestOptions?: RequestOptions) =>
        request<WorktreeListOutput>(
          {
            method: "GET",
            path: `/api/worktree`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      create: (input?: WorktreeCreateInput, requestOptions?: RequestOptions) =>
        request<WorktreeCreateOutput>(
          {
            method: "POST",
            path: `/api/worktree`,
            query: { location: input?.["location"] },
            body: {
              strategy: input?.["strategy"],
              from: input?.["from"],
              branch: input?.["branch"],
              directory: input?.["directory"],
              name: input?.["name"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: WorktreeRemoveInput, requestOptions?: RequestOptions) =>
        request<WorktreeRemoveOutput>(
          {
            method: "DELETE",
            path: `/api/worktree`,
            query: { location: input["location"] },
            body: { directory: input["directory"], force: input["force"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
      refresh: (input?: WorktreeRefreshInput, requestOptions?: RequestOptions) =>
        request<WorktreeRefreshOutput>(
          {
            method: "POST",
            path: `/api/worktree/refresh`,
            query: { location: input?.["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
      inventory: (requestOptions?: RequestOptions) =>
        request<WorktreeInventoryOutput>(
          {
            method: "GET",
            path: `/api/worktree/inventory`,
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    workspace: {
      create: (input: WorkspaceCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: WorkspaceCreateOutput }>(
          {
            method: "POST",
            path: `/api/workspace`,
            body: { id: input["id"], provider: input["provider"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 404, 409],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      destroy: (input: WorkspaceDestroyInput, requestOptions?: RequestOptions) =>
        request<WorkspaceDestroyOutput>(
          {
            method: "DELETE",
            path: `/api/workspace/${encodeURIComponent(input.workspaceID)}`,
            successStatus: 200,
            declaredStatuses: [400, 401, 500],
            empty: false,
          },
          requestOptions,
        ),
    },
    vcs: {
      get: (input?: VcsGetInput, requestOptions?: RequestOptions) =>
        request<VcsGetOutput>(
          {
            method: "GET",
            path: `/api/vcs`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      base: (input?: VcsBaseInput, requestOptions?: RequestOptions) =>
        request<VcsBaseOutput>(
          {
            method: "GET",
            path: `/api/vcs/base`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 503],
            empty: false,
          },
          requestOptions,
        ),
      status: (input?: VcsStatusInput, requestOptions?: RequestOptions) =>
        request<VcsStatusOutput>(
          {
            method: "GET",
            path: `/api/vcs/status`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      branches: (input?: VcsBranchesInput, requestOptions?: RequestOptions) =>
        request<VcsBranchesOutput>(
          {
            method: "GET",
            path: `/api/vcs/branches`,
            query: { location: input?.["location"], search: input?.["search"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      diff: (input: VcsDiffInput, requestOptions?: RequestOptions) =>
        request<VcsDiffOutput>(
          {
            method: "GET",
            path: `/api/vcs/diff`,
            query: { location: input["location"], mode: input["mode"], base: input["base"], context: input["context"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 503],
            empty: false,
          },
          requestOptions,
        ),
    },
    debug: {
      location: {
        list: (requestOptions?: RequestOptions) =>
          request<DebugLocationListOutput>(
            {
              method: "GET",
              path: `/api/debug/location`,
              successStatus: 200,
              declaredStatuses: [400, 401],
              empty: false,
            },
            requestOptions,
          ),
        evict: (input?: DebugLocationEvictInput, requestOptions?: RequestOptions) =>
          request<DebugLocationEvictOutput>(
            {
              method: "DELETE",
              path: `/api/debug/location`,
              query: { location: input?.["location"] },
              successStatus: 204,
              declaredStatuses: [400, 401],
              empty: true,
            },
            requestOptions,
          ),
      },
    },
    migration: {
      v1: {
        status: (requestOptions?: RequestOptions) =>
          request<MigrationV1StatusOutput>(
            {
              method: "GET",
              path: `/api/experimental/migration/v1`,
              successStatus: 200,
              declaredStatuses: [400, 401],
              empty: false,
            },
            requestOptions,
          ),
      },
    },
    websearch: {
      providers: (input?: WebsearchProvidersInput, requestOptions?: RequestOptions) =>
        request<WebsearchProvidersOutput>(
          {
            method: "GET",
            path: `/api/websearch/provider`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 503],
            empty: false,
          },
          requestOptions,
        ),
      query: (input: WebsearchQueryInput, requestOptions?: RequestOptions) =>
        request<WebsearchQueryOutput>(
          {
            method: "POST",
            path: `/api/websearch`,
            query: { location: input["location"] },
            body: { query: input["query"], providerID: input["providerID"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 503],
            empty: false,
          },
          requestOptions,
        ),
    },
    config: {
      get: (input?: ConfigGetInput, requestOptions?: RequestOptions) =>
        request<ConfigGetOutput>(
          {
            method: "GET",
            path: `/api/config`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      preferences: (requestOptions?: RequestOptions) =>
        request<ConfigPreferencesOutput>(
          {
            method: "GET",
            path: `/api/config/preferences`,
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      updatePreferences: (input?: ConfigUpdatePreferencesInput, requestOptions?: RequestOptions) =>
        request<ConfigUpdatePreferencesOutput>(
          {
            method: "PATCH",
            path: `/api/config/preferences`,
            body: { shell: input?.["shell"], websearch: input?.["websearch"] },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      shells: (requestOptions?: RequestOptions) =>
        request<ConfigShellsOutput>(
          { method: "GET", path: `/api/config/shell`, successStatus: 200, declaredStatuses: [400, 401], empty: false },
          requestOptions,
        ),
    },
  }
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/")
}

function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined) return
  if (value === null) {
    params.append(key, "null")
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, key, item)
    return
  }
  if (typeof value === "object") {
    for (const [child, item] of Object.entries(value)) appendQuery(params, `${key}[${child}]`, item)
    return
  }
  params.append(key, String(value))
}

async function json(response: Response): Promise<unknown> {
  if (!isContentType(response, "application/json") && !response.headers.get("content-type")?.includes("+json")) {
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnsupportedContentType")
  }
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    throw new ClientError("Transport", { cause })
  }
  if (text === "") throw new ClientError("MalformedResponse")
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new ClientError("MalformedResponse", { cause })
  }
}

function isContentType(response: Response, expected: string) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected
}
