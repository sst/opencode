import {
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type AuthMethod,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import type { AssistantMessage, Message, OpencodeClient, Session, SessionMessageResponse } from "@opencode-ai/sdk/v2"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import * as ACPError from "./error"
import { buildConfigOptions, DEFAULT_VARIANT_VALUE, parseModelSelection } from "./config-option"
import { promptContentToParts } from "./content"
import { Directory } from "./directory"
import { ACPEvent } from "./event"
import { ACPSession } from "./session"
import { UsageService } from "./usage"
import { ACPProfile } from "./profile"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import type { Command } from "@/command"

export const AuthMethodID = "opencode-login"

export type Error = ACPError.Error
type ServiceConnection = Pick<AgentSideConnection, "sessionUpdate"> &
  Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile">>

export type Interface = {
  readonly initialize: (input: InitializeRequest) => Effect.Effect<InitializeResponse, Error>
  readonly authenticate: (input: AuthenticateRequest) => Effect.Effect<AuthenticateResponse, Error>
  readonly newSession: (input: NewSessionRequest) => Effect.Effect<NewSessionResponse, Error>
  readonly loadSession: (input: LoadSessionRequest) => Effect.Effect<LoadSessionResponse, Error>
  readonly listSessions: (input: ListSessionsRequest) => Effect.Effect<ListSessionsResponse, Error>
  readonly resumeSession: (input: ResumeSessionRequest) => Effect.Effect<ResumeSessionResponse, Error>
  readonly closeSession: (input: CloseSessionRequest) => Effect.Effect<CloseSessionResponse, Error>
  readonly forkSession: (input: ForkSessionRequest) => Effect.Effect<ForkSessionResponse, Error>
  readonly setSessionConfigOption: (
    input: SetSessionConfigOptionRequest,
  ) => Effect.Effect<SetSessionConfigOptionResponse, Error>
  readonly setSessionMode: (input: SetSessionModeRequest) => Effect.Effect<SetSessionModeResponse, Error>
  readonly setSessionModel: (input: SetSessionModelRequest) => Effect.Effect<SetSessionModelResponse, Error>
  readonly prompt: (input: PromptRequest) => Effect.Effect<PromptResponse, Error>
  readonly cancel: (input: CancelNotification) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ACP/Service") {}

export function make(input: {
  sdk: OpencodeClient
  connection?: ServiceConnection
  directory?: Directory.Interface
  session?: ACPSession.Interface
  usage?: UsageService.Interface
  eventSubscription?: (subscription: ACPEvent.Subscription) => void
}): Interface {
  const session = input.session ?? makeSessionService()
  const directoryService = input.directory ?? makeDirectoryService(input.sdk)
  const registeredMcp = new Map<string, Set<string>>()
  const sessionSnapshots = new Map<string, Directory.Snapshot>()
  const events = input.connection
    ? ACPEvent.start({ sdk: input.sdk, connection: input.connection, session })
    : undefined
  if (events) input.eventSubscription?.(events)
  const runUntilIdle = <A>(sessionId: string, fn: () => Promise<A>) =>
    events ? events.runUntilIdle(sessionId, fn) : fn()

  const initialize = Effect.fn("ACP.initialize")(function* (params: InitializeRequest) {
    const started = performance.now()
    const authMethod: AuthMethod = {
      description: "Run `opencode auth login` in the terminal",
      name: "Login with opencode",
      id: AuthMethodID,
    }

    if (params.clientCapabilities?._meta?.["terminal-auth"] === true) {
      authMethod._meta = {
        "terminal-auth": {
          command: "opencode",
          args: ["auth", "login"],
          label: "OpenCode Login",
        },
      }
    }

    const response = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        promptCapabilities: {
          embeddedContext: true,
          image: true,
        },
        sessionCapabilities: {
          close: {},
          fork: {},
          list: {},
          resume: {},
        },
      },
      authMethods: [authMethod],
      agentInfo: {
        name: "OpenCode",
        version: InstallationVersion,
      },
    }
    ACPProfile.duration("acp.initialize", started)
    return response
  })

  const authenticate = Effect.fn("ACP.authenticate")(function* (params: AuthenticateRequest) {
    if (params.methodId !== AuthMethodID) {
      return yield* new ACPError.UnknownAuthMethodError({ methodId: params.methodId })
    }
    return {}
  })

  const directorySnapshot = Effect.fn("ACP.directorySnapshot")(function* (cwd: string) {
    const started = performance.now()
    const snapshot = yield* directoryService.get(cwd)
    ACPProfile.duration("acp.directory.snapshot", started)
    return snapshot
  })

  const configSnapshot = Effect.fn("ACP.configSnapshot")(function* (state: ACPSession.Info) {
    const snapshot = sessionSnapshots.get(state.id)
    if (snapshot) return snapshot
    const loaded = yield* directorySnapshot(state.cwd)
    sessionSnapshots.set(state.id, loaded)
    return loaded
  })

  const newSession = Effect.fn("ACP.newSession")(function* (params: NewSessionRequest) {
    const started = performance.now()
    const snapshot = yield* directorySnapshot(params.cwd)
    const selected = selectDefaultModel(snapshot)
    const variant = selectVariant(snapshot, selected)
    const modeId = snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined
    const created = yield* profiledRequest(
      "acp.newSession.session.create",
      () =>
        input.sdk.session.create(
          {
            directory: params.cwd,
            ...(modeId ? { agent: modeId } : {}),
            model: {
              providerID: selected.providerID,
              id: selected.modelID,
              ...(variant ? { variant } : {}),
            },
          },
          { throwOnError: true },
        ),
      "session",
    )
    const state = yield* session.create({
      id: created.id,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      model: selected,
      variant,
      modeId,
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers)
    yield* sendAvailableCommands(input.connection, state.id, snapshot)

    const response = {
      sessionId: state.id,
      configOptions: configOptions(snapshot, {
        model: state.model ?? selected,
        variant: state.variant,
        modeId: state.modeId,
      }),
    }
    ACPProfile.duration("acp.newSession", started)
    return response
  })

  const loadSession = Effect.fn("ACP.loadSession")(function* (params: LoadSessionRequest) {
    const snapshot = yield* directorySnapshot(params.cwd)
    const backing = yield* request(
      () => input.sdk.session.get({ directory: params.cwd, sessionID: params.sessionId }, { throwOnError: true }),
      "session",
    )
    const messages = yield* request(
      () => input.sdk.session.messages({ directory: params.cwd, sessionID: params.sessionId }, { throwOnError: true }),
      "session",
    )
    const restored = restoreSession(
      snapshot,
      backing,
      messages.map((item) => item.info),
    )
    const state = yield* session.load({
      id: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      model: restored.model,
      variant: restored.variant,
      modeId: restored.modeId,
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers)
    yield* sendAvailableCommands(input.connection, state.id, snapshot)
    yield* replayMessages(events, messages)

    return {
      configOptions: configOptions(snapshot, {
        model: state.model ?? restored.model,
        variant: state.variant,
        modeId: state.modeId,
      }),
    }
  })

  const listSessions = Effect.fn("ACP.listSessions")(function* (params: ListSessionsRequest) {
    const cursor = params.cursor ? Number(params.cursor) : undefined
    const limit = 100
    const sessions = yield* request(
      () =>
        input.sdk.session.list(
          {
            ...(params.cwd ? { directory: params.cwd } : {}),
            roots: true,
          },
          { throwOnError: true },
        ),
      "session",
    )
    const serverEntries = sessions.map(
      (item): SessionInfo => ({
        sessionId: item.id,
        cwd: item.directory,
        title: item.title,
        updatedAt: new Date(item.time.updated).toISOString(),
      }),
    )
    const liveEntries = (yield* session.list(params.cwd ?? undefined))
      .filter((item) => !serverEntries.some((entry) => entry.sessionId === item.id))
      .map(
        (item): SessionInfo => ({
          sessionId: item.id,
          cwd: item.cwd,
          updatedAt: item.createdAt.toISOString(),
        }),
      )
    const sorted = [...liveEntries, ...serverEntries].toSorted(
      (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
    )
    const filtered =
      cursor === undefined || !Number.isFinite(cursor)
        ? sorted
        : sorted.filter((item) => new Date(item.updatedAt ?? 0).getTime() < cursor)
    const page = filtered.slice(0, limit)
    const last = page.at(-1)
    return {
      sessions: page,
      ...(filtered.length > limit && last ? { nextCursor: String(new Date(last.updatedAt ?? 0).getTime()) } : {}),
    }
  })

  const resumeSession = Effect.fn("ACP.resumeSession")(function* (params: ResumeSessionRequest) {
    const snapshot = yield* directorySnapshot(params.cwd)
    const backing = yield* request(
      () => input.sdk.session.get({ directory: params.cwd, sessionID: params.sessionId }, { throwOnError: true }),
      "session",
    )
    const messages = yield* request(
      () =>
        input.sdk.session.messages(
          { directory: params.cwd, sessionID: params.sessionId, limit: 20 },
          { throwOnError: true },
        ),
      "session",
    )
    const restored = restoreSession(
      snapshot,
      backing,
      messages.map((item) => item.info),
    )
    const state = yield* session.load({
      id: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      model: restored.model,
      variant: restored.variant,
      modeId: restored.modeId,
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers ?? [])
    yield* sendAvailableCommands(input.connection, state.id, snapshot)

    return {
      configOptions: configOptions(snapshot, {
        model: state.model ?? restored.model,
        variant: state.variant,
        modeId: state.modeId,
      }),
    }
  })

  const abortBackingSession = Effect.fn("ACP.abortBackingSession")(function* (current: ACPSession.Info) {
    yield* request(
      () => input.sdk.session.abort({ directory: current.cwd, sessionID: current.id }, { throwOnError: true }),
      "session",
    ).pipe(
      Effect.catch((error) =>
        Effect.logError("failed to abort ACP backing session", { error: error, sessionID: current.id }),
      ),
    )
  })

  const closeSession = Effect.fn("ACP.closeSession")(function* (params: CloseSessionRequest) {
    const removed = yield* session.remove(params.sessionId)
    registeredMcp.delete(params.sessionId)
    sessionSnapshots.delete(params.sessionId)
    if (!removed) return {}

    yield* abortBackingSession(removed)
    return {}
  })

  const cancel = Effect.fn("ACP.cancel")(function* (params: CancelNotification) {
    const current = yield* session.get(params.sessionId)
    yield* abortBackingSession(current)
  })

  const forkSession = Effect.fn("ACP.forkSession")(function* (params: ForkSessionRequest) {
    const snapshot = yield* directorySnapshot(params.cwd)
    const forked = yield* request(
      () =>
        input.sdk.session.fork(
          {
            directory: params.cwd,
            sessionID: params.sessionId,
          },
          { throwOnError: true },
        ),
      "session",
    )
    const messages = yield* request(
      () =>
        input.sdk.session.messages({ directory: params.cwd, sessionID: forked.id, limit: 20 }, { throwOnError: true }),
      "session",
    )
    const restored = restoreSession(
      snapshot,
      forked,
      messages.map((item) => item.info),
    )
    const state = yield* session.load({
      id: forked.id,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      model: restored.model,
      variant: restored.variant,
      modeId: restored.modeId,
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers ?? [])
    yield* sendAvailableCommands(input.connection, state.id, snapshot)
    yield* replayMessages(events, messages)

    return {
      sessionId: state.id,
      configOptions: configOptions(snapshot, {
        model: state.model ?? restored.model,
        variant: state.variant,
        modeId: state.modeId,
      }),
    }
  })

  const setSessionConfigOption = Effect.fn("ACP.setSessionConfigOption")(function* (
    params: SetSessionConfigOptionRequest,
  ) {
    const current = yield* session.get(params.sessionId)
    const snapshot = yield* configSnapshot(current)
    if (typeof params.value !== "string") {
      return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
    }

    if (params.configId === "model") {
      const selected = yield* parseSelectedModel(snapshot, params.value)
      const variant = selectModelVariant(snapshot, current, selected)
      const state = yield* session
        .setVariant(params.sessionId, Directory.variants(snapshot, selected.model) ? variant : undefined)
        .pipe(Effect.andThen(session.setModel(params.sessionId, selected.model)))
      const options = configOptions(snapshot, {
        model: state.model ?? selected.model,
        variant: state.variant,
        modeId: state.modeId,
      })
      yield* sendConfigOptionUpdate(input.connection, params.sessionId, options)
      return {
        configOptions: options,
      }
    }

    if (params.configId === "effort") {
      const model = current.model ?? selectDefaultModel(snapshot)
      const variants = Directory.variants(snapshot, model)
      if (!variants || !hasVariant(variants, params.value)) {
        return yield* new ACPError.InvalidEffortError({ effort: params.value })
      }
      const state = yield* session.setVariant(params.sessionId, params.value)
      return {
        configOptions: configOptions(snapshot, {
          model: state.model ?? model,
          variant: state.variant,
          modeId: state.modeId,
        }),
      }
    }

    if (params.configId === "mode") {
      if (!snapshot.availableModes.some((mode) => mode.id === params.value)) {
        return yield* new ACPError.InvalidModeError({ mode: params.value })
      }
      const state = yield* session.setMode(params.sessionId, params.value)
      return {
        configOptions: configOptions(snapshot, {
          model: state.model ?? selectDefaultModel(snapshot),
          variant: state.variant,
          modeId: state.modeId,
        }),
      }
    }

    return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
  })

  const setSessionMode = Effect.fn("ACP.setSessionMode")(function* (params: SetSessionModeRequest) {
    const current = yield* session.get(params.sessionId)
    const snapshot = yield* configSnapshot(current)
    if (!snapshot.availableModes.some((mode) => mode.id === params.modeId)) {
      return yield* new ACPError.InvalidModeError({ mode: params.modeId })
    }
    yield* session.setMode(params.sessionId, params.modeId)
    return {}
  })

  const setSessionModel = Effect.fn("ACP.setSessionModel")(function* (params: SetSessionModelRequest) {
    const current = yield* session.get(params.sessionId)
    const snapshot = yield* configSnapshot(current)
    const selected = yield* parseSelectedModel(snapshot, params.modelId)
    const state = yield* session
      .setVariant(params.sessionId, selectModelVariant(snapshot, current, selected))
      .pipe(Effect.andThen(session.setModel(params.sessionId, selected.model)))
    yield* sendConfigOptionUpdate(
      input.connection,
      params.sessionId,
      configOptions(snapshot, {
        model: state.model ?? selected.model,
        variant: state.variant,
        modeId: state.modeId,
      }),
    )
    return {}
  })

  return {
    initialize,
    authenticate,
    newSession,
    loadSession,
    listSessions,
    resumeSession,
    closeSession,
    forkSession,
    setSessionConfigOption,
    setSessionMode,
    setSessionModel,
    prompt: Effect.fn("ACP.prompt")(function* (params: PromptRequest) {
      const current = yield* session.get(params.sessionId)
      const snapshot = yield* directorySnapshot(current.cwd)
      const selected = current.model ?? selectDefaultModel(snapshot)
      if (!current.model) {
        yield* session.setModel(params.sessionId, selected)
      }
      const variant = current.variant ?? selectVariant(snapshot, selected)
      const modeId = current.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined)
      const parts = promptContentToParts(params.prompt)
      const command = detectSlashCommand(parts)

      if (!command) {
        const response = yield* request(
          () =>
            runUntilIdle(current.id, () =>
              input.sdk.session.prompt(
                {
                  sessionID: current.id,
                  model: {
                    providerID: selected.providerID,
                    modelID: selected.modelID,
                  },
                  ...(variant ? { variant } : {}),
                  parts,
                  ...(modeId ? { agent: modeId } : {}),
                  directory: current.cwd,
                },
                { throwOnError: true },
              ),
            ),
          "session",
        )
        yield* sendUsageUpdate(input.usage, input.sdk, input.connection, current.id, current.cwd)
        return yield* promptResponse(response.info, params.messageId)
      }

      const known = snapshot.availableCommands.find((item) => item.name === command.name)
      if (known) {
        const response = yield* request(
          () =>
            runUntilIdle(current.id, () =>
              input.sdk.session.command(
                {
                  sessionID: current.id,
                  command: known.name,
                  arguments: command.args,
                  model: `${selected.providerID}/${selected.modelID}`,
                  ...(variant ? { variant } : {}),
                  ...(modeId ? { agent: modeId } : {}),
                  directory: current.cwd,
                },
                { throwOnError: true },
              ),
            ),
          "session",
        )
        yield* sendUsageUpdate(input.usage, input.sdk, input.connection, current.id, current.cwd)
        return yield* promptResponse(response.info, params.messageId)
      }

      if (command.name === "compact") {
        yield* request(
          () =>
            runUntilIdle(current.id, () =>
              input.sdk.session.summarize(
                {
                  sessionID: current.id,
                  directory: current.cwd,
                  providerID: selected.providerID,
                  modelID: selected.modelID,
                },
                { throwOnError: true },
              ),
            ),
          "session",
        )
      }

      yield* sendUsageUpdate(input.usage, input.sdk, input.connection, current.id, current.cwd)
      return yield* promptResponse(undefined, params.messageId)
    }),
    cancel,
  }
}

function makeSessionService() {
  return ManagedRuntime.make(AppNodeBuilder.build(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

function makeDirectoryService(sdk: OpencodeClient) {
  return ManagedRuntime.make(
    AppNodeBuilder.build(Directory.node, [
      [
        Directory.loaderNode,
        Layer.succeed(
          Directory.Loader,
          Directory.Loader.of({
            load: (directory) => request(() => loadDirectorySnapshot(sdk, directory), "directory"),
          }),
        ),
      ],
    ]),
  ).runSync(Directory.Service.use((service) => Effect.succeed(service)))
}

function makeUsageService(sdk: OpencodeClient) {
  const limits = new Map<string, Promise<number | undefined>>()
  const contextLimit: UsageService.Interface["contextLimit"] = Effect.fn("ACP.promptUsage.contextLimit")(
    function* (params) {
      const key = `${params.directory}\u0000${params.providerID}\u0000${params.modelID}`
      const current = limits.get(key)
      if (current) return yield* Effect.promise(() => current)

      const next = sdk.config
        .providers({ directory: params.directory }, { throwOnError: true })
        .then((response) => {
          const providers = Object.fromEntries(
            (response.data?.providers ?? []).map((provider) => [provider.id, provider]),
          ) as Record<ProviderV2.ID, Provider.Info>
          return UsageService.findContextLimit(providers, params.providerID, params.modelID)
        })
        .catch(() => undefined)
      limits.set(key, next)
      return yield* Effect.promise(() => next)
    },
  )

  const sendUpdate: UsageService.Interface["sendUpdate"] = Effect.fn("ACP.promptUsage.sendUpdate")(function* (params) {
    const messages = yield* request(
      () =>
        sdk.session.messages(
          {
            sessionID: params.sessionID,
            directory: params.directory,
          },
          { throwOnError: true },
        ),
      "session",
    ).pipe(
      Effect.map((messages) => messages as readonly UsageService.SessionMessage[]),
      Effect.catch((error) =>
        Effect.logError("failed to fetch messages for usage update", { error: error }).pipe(Effect.as(undefined)),
      ),
    )
    if (!messages) return

    const message = UsageService.latestAssistantMessage(messages)
    if (!message?.providerID || !message.modelID) return

    const size = yield* contextLimit({
      directory: params.directory,
      providerID: ProviderV2.ID.make(message.providerID),
      modelID: ModelV2.ID.make(message.modelID),
    })
    if (!size) return

    yield* Effect.promise(() =>
      params.connection
        .sessionUpdate({
          sessionId: params.sessionID,
          update: {
            sessionUpdate: "usage_update",
            used: UsageService.contextTokens(message),
            size,
            cost: { amount: UsageService.totalSessionCost(messages), currency: "USD" },
          },
        })
        .catch(() => {}),
    )
  })

  return UsageService.Service.of({
    buildUsage: UsageService.buildUsage,
    latestAssistantMessage: UsageService.latestAssistantMessage,
    totalSessionCost: UsageService.totalSessionCost,
    contextLimit,
    sendUpdate,
  })
}

function replayMessages(subscription: ACPEvent.Subscription | undefined, messages: SessionMessageResponse[]) {
  if (!subscription) return Effect.void
  return Effect.promise(async () => {
    for (const message of messages) {
      await subscription.replayMessage(message).catch(() => {})
    }
  })
}

type ConfigState = {
  readonly model: Directory.DefaultModel
  readonly variant?: string
  readonly modeId?: string
}

type SdkResponse<T> = {
  readonly data?: T
  readonly error?: unknown
}

type MessageInfo = {
  readonly role?: Message["role"]
  readonly model?: Extract<Message, { role: "user" }>["model"]
  readonly providerID?: Extract<Message, { role: "assistant" }>["providerID"]
  readonly modelID?: Extract<Message, { role: "assistant" }>["modelID"]
  readonly variant?: Extract<Message, { role: "assistant" }>["variant"]
  readonly mode?: Extract<Message, { role: "assistant" }>["mode"]
  readonly agent?: Message["agent"]
}

type AssistantError = NonNullable<AssistantMessage["error"]>
type AssistantInfo = (UsageService.AssistantTokenCost & Pick<AssistantMessage, "error">) | undefined

function request<T>(fn: () => Promise<T | SdkResponse<T>>, service?: string) {
  return Effect.tryPromise({
    try: async () => {
      const result = await fn()
      if (isSdkResponse<T>(result)) {
        if (result.error) throw result.error
        if (result.data !== undefined) return result.data
      }
      return result as T
    },
    catch: (error) => fromUnknownError(error, service),
  })
}

function profiledRequest<T>(name: string, fn: () => Promise<T | SdkResponse<T>>, service?: string) {
  return request(() => ACPProfile.measure(name, fn), service)
}

async function loadDirectorySnapshot(sdk: OpencodeClient, directory: string) {
  return ACPProfile.measure("acp.directory.load", async () => {
    const [providersResponse, agentsResponse, commandsResponse, skillsResponse, configResponse] = await Promise.all([
      ACPProfile.measure("acp.directory.provider.list", () =>
        sdk.config.providers({ directory }, { throwOnError: true }),
      ),
      ACPProfile.measure("acp.directory.mode.defaultAgent.load", () =>
        sdk.app.agents({ directory }, { throwOnError: true }),
      ),
      ACPProfile.measure("acp.directory.command.list", () => sdk.command.list({ directory }, { throwOnError: true })),
      ACPProfile.measure("acp.directory.skill.list", () => sdk.app.skills({ directory }, { throwOnError: true })),
      ACPProfile.measure("acp.directory.defaultModel.config", () =>
        sdk.config.get({ directory }, { throwOnError: true }).catch(() => undefined),
      ),
    ])
    const providersData = providersResponse.data!
    const agents = agentsResponse.data!
    const commandsData = commandsResponse.data!
    const skills = skillsResponse.data!
    const providers = Object.fromEntries(providersData.providers.map((provider) => [provider.id, provider])) as Record<
      ProviderV2.ID,
      Provider.Info
    >
    const defaultModelStarted = performance.now()
    const defaultModel = defaultModelFromConfig(configResponse?.data?.model, providers)
    ACPProfile.duration("acp.directory.defaultModel.resolve", defaultModelStarted, { configured: !!defaultModel })
    const modes = agents
      .filter((agent) => agent.mode !== "subagent" && agent.hidden !== true)
      .map((agent) => ({
        id: agent.name,
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
      }))
    const commands = [
      ...commandsData,
      ...skills
        .filter((skill) => !commandsData.some((command) => command.name === skill.name))
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          source: "skill" as const,
          template: skill.content,
          hints: [],
        })),
    ] as Command.Info[]

    return Directory.build({
      directory,
      providers,
      modes,
      defaultModeID: agents.find((agent) => agent.mode === "primary" && agent.hidden !== true)?.name ?? "build",
      commands: commands.toSorted((a, b) => a.name.localeCompare(b.name)),
      ...(defaultModel ? { defaultModel } : {}),
    })
  })
}

function defaultModelFromConfig(
  configuredModel: string | undefined,
  providers: Record<ProviderV2.ID, Provider.Info>,
): Directory.DefaultModel | undefined {
  const configured = configuredModel ? Provider.parseModel(configuredModel) : undefined
  if (configured && providers[configured.providerID]?.models[configured.modelID]) return configured

  // First-session ACP startup must not scan historical sessions just to infer
  // a default. Configured model, opencode provider, then sorted best model keep
  // the protocol response deterministic without extra session/message reads.
  const opencodeProvider = providers[ProviderV2.ID.make("opencode")]
  const opencodeModel = opencodeProvider ? Provider.sort(Object.values(opencodeProvider.models))[0] : undefined
  if (opencodeProvider && opencodeModel) return { providerID: opencodeProvider.id, modelID: opencodeModel.id }

  const best = Provider.sort(Object.values(providers).flatMap((provider) => Object.values(provider.models)))[0]
  if (best) return { providerID: best.providerID, modelID: best.id }
  if (configured) return configured
}

function selectDefaultModel(snapshot: Directory.Snapshot) {
  if (snapshot.defaultModel) return snapshot.defaultModel
  const model = snapshot.modelOptions[0]
  if (model) return { providerID: model.providerID, modelID: model.modelID }
  return { providerID: "unknown" as ProviderV2.ID, modelID: "unknown" as ModelV2.ID }
}

function detectSlashCommand(parts: ReturnType<typeof promptContentToParts>) {
  const text = parts
    .filter((part): part is Extract<(typeof parts)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
  if (!text.startsWith("/")) return

  const [name, ...rest] = text.slice(1).split(/\s+/)
  if (!name) return
  return { name, args: rest.join(" ").trim() }
}

const promptResponse = Effect.fn("ACP.promptResponse")(function* (
  info: AssistantInfo,
  messageId: string | null | undefined,
) {
  if (!info?.error) {
    return {
      stopReason: "end_turn" as const,
      ...(info ? { usage: UsageService.buildUsage(info) } : {}),
      ...(messageId ? { userMessageId: messageId } : {}),
      _meta: {},
    }
  }

  const base = {
    usage: UsageService.buildUsage(info),
    ...(messageId ? { userMessageId: messageId } : {}),
    _meta: {},
  }

  if (info.error.name === "MessageAbortedError") {
    return {
      stopReason: "cancelled" as const,
      ...base,
    }
  }

  if (info.error.name === "MessageOutputLengthError") {
    return {
      stopReason: "max_tokens" as const,
      ...base,
    }
  }

  if (info.error.name === "ContentFilterError") {
    return {
      stopReason: "refusal" as const,
      ...base,
    }
  }

  if (info.error.name === "ProviderAuthError") {
    return yield* new ACPError.AuthRequiredError({ providerId: info.error.data.providerID })
  }

  return yield* new ACPError.ServiceFailureError({
    service: "session",
    safeMessage: promptErrorMessage(info.error),
    errorName: info.error.name,
  })
})

function promptErrorMessage(error: AssistantError) {
  if ("message" in error.data && typeof error.data.message === "string") return error.data.message
  return "OpenCode prompt failed"
}

function sendUsageUpdate(
  usage: UsageService.Interface | undefined,
  sdk: OpencodeClient,
  connection: ServiceConnection | undefined,
  sessionID: string,
  directory: string,
) {
  if (!connection) return Effect.void
  return (usage ?? makeUsageService(sdk)).sendUpdate({
    connection,
    sessionID,
    directory,
  })
}

function selectVariant(snapshot: Directory.Snapshot, model: Directory.DefaultModel) {
  const variants = Directory.variants(snapshot, model)
  if (!variants) return
  if (variants.default) return "default"
  return Object.keys(variants)[0]
}

function selectModelVariant(
  snapshot: Directory.Snapshot,
  current: ACPSession.Info,
  selected: { model: Directory.DefaultModel; variant?: string },
) {
  const variants = Directory.variants(snapshot, selected.model)
  if (!variants) return
  if (selected.variant) return selected.variant
  if (sameModel(selected.model, current.model) && current.variant && hasVariant(variants, current.variant))
    return current.variant
  return selectVariant(snapshot, selected.model)
}

function hasVariant(variants: Directory.ModelVariants, variant: string) {
  // "default" is also the persisted sentinel for no explicit variant override.
  return variant === DEFAULT_VARIANT_VALUE || Object.hasOwn(variants, variant)
}

function configOptions(snapshot: Directory.Snapshot, session: ConfigState) {
  return buildConfigOptions({
    providers: Object.values(snapshot.providers),
    currentModel: session.model,
    currentVariant: session.variant,
    modes: snapshot.availableModes,
    currentModeId: session.modeId,
  })
}

function sendConfigOptionUpdate(
  connection: ServiceConnection | undefined,
  sessionId: string,
  options: ReturnType<typeof configOptions>,
) {
  if (!connection) return Effect.void
  return Effect.tryPromise({
    try: () =>
      connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: options,
        },
      }),
    catch: () => undefined,
  }).pipe(Effect.ignore)
}

function parseSelectedModel(snapshot: Directory.Snapshot, modelId: string) {
  const selected = parseModelSelection(modelId, Object.values(snapshot.providers))
  const provider = snapshot.providers[ProviderV2.ID.make(selected.model.providerID)]
  const model = provider?.models[ModelV2.ID.make(selected.model.modelID)]
  if (!model) {
    return Effect.fail(
      new ACPError.InvalidModelError({
        providerId: selected.model.providerID,
        modelId,
      }),
    )
  }
  if (selected.variant && !model.variants?.[selected.variant]) {
    return Effect.fail(new ACPError.InvalidEffortError({ effort: selected.variant }))
  }
  return Effect.succeed({
    model: {
      providerID: provider.id,
      modelID: model.id,
    },
    variant: selected.variant,
  })
}

function sendAvailableCommands(
  connection: Pick<AgentSideConnection, "sessionUpdate"> | undefined,
  sessionId: string,
  snapshot: Directory.Snapshot,
) {
  if (!connection) return Effect.void
  return Effect.sync(() => {
    setTimeout(() => {
      void connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: snapshot.availableCommands.map((command) => ({
            name: command.name,
            description: command.description ?? "",
          })),
        },
      })
    }, 0)
  })
}

function registerMcpServers(
  sdk: OpencodeClient,
  registered: Map<string, Set<string>>,
  directory: string,
  sessionId: string,
  servers: readonly McpServer[],
) {
  const started = performance.now()
  const current = registered.get(sessionId) ?? new Set<string>()
  registered.set(sessionId, current)
  const pending = new Set<string>()

  return Effect.all(
    servers
      .map((server) => ({ server, config: mcpConfig(server) }))
      .filter((entry) => {
        const key = mcpRegistrationKey(entry.server.name, entry.config)
        if (current.has(key) || pending.has(key)) return false
        pending.add(key)
        return true
      })
      .map((entry) =>
        request(
          () =>
            sdk.mcp.add(
              {
                directory,
                name: entry.server.name,
                config: entry.config,
              },
              { throwOnError: true },
            ),
          "mcp",
        ).pipe(
          Effect.tap(() => Effect.sync(() => current.add(mcpRegistrationKey(entry.server.name, entry.config)))),
          Effect.ignore,
        ),
      ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        ACPProfile.duration("acp.mcp.register", started, {
          count: pending.size,
        }),
      ),
    ),
    Effect.asVoid,
  )
}

function mcpRegistrationKey(name: string, config: ReturnType<typeof mcpConfig>) {
  return `${name}:${stableStringify(config)}`
}

function mcpConfig(server: McpServer) {
  if ("type" in server) {
    return {
      type: "remote" as const,
      url: server.url,
      headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
    }
  }
  return {
    type: "local" as const,
    command: [server.command, ...server.args],
    environment: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (!value || typeof value !== "object") return JSON.stringify(value)
  return `{${Object.entries(value)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`
}

function restoreSession(
  snapshot: Directory.Snapshot,
  backing: Pick<Session, "agent" | "model">,
  messages: MessageInfo[],
) {
  const history = restoreFromMessages(messages)
  const durable = restoreDurableModel(backing.model)
  const model = restoreModel(snapshot, durable.model, history.model)
  return {
    model,
    variant: restoreVariant(snapshot, model, durable, history),
    modeId: restoreMode(snapshot, backing.agent, history.modeId),
  }
}

function restoreDurableModel(model: Session["model"] | undefined) {
  if (!model) return {}
  return {
    model: {
      providerID: ProviderV2.ID.make(model.providerID),
      modelID: ModelV2.ID.make(model.id),
    },
    variant: model.variant,
  }
}

function restoreModel(
  snapshot: Directory.Snapshot,
  durable: Directory.DefaultModel | undefined,
  history: Directory.DefaultModel | undefined,
) {
  if (durable && hasModel(snapshot, durable)) return durable
  if (history && hasModel(snapshot, history)) return history
  return selectDefaultModel(snapshot)
}

function restoreVariant(
  snapshot: Directory.Snapshot,
  model: Directory.DefaultModel,
  durable: { model?: Directory.DefaultModel; variant?: string },
  history: { model?: Directory.DefaultModel; variant?: string },
) {
  const variants = Directory.variants(snapshot, model)
  if (!variants) return
  if (sameModel(model, durable.model) && durable.variant && hasVariant(variants, durable.variant))
    return durable.variant
  if (sameModel(model, history.model) && history.variant && hasVariant(variants, history.variant))
    return history.variant
  return selectVariant(snapshot, model)
}

function restoreMode(snapshot: Directory.Snapshot, durable: string | undefined, history: string | undefined) {
  if (hasMode(snapshot, durable)) return durable
  if (hasMode(snapshot, history)) return history
  if (snapshot.availableModes.length > 0) return snapshot.defaultModeID
}

function hasModel(snapshot: Directory.Snapshot, model: Directory.DefaultModel) {
  return Boolean(snapshot.providers[model.providerID]?.models[model.modelID])
}

function hasMode(snapshot: Directory.Snapshot, modeId: string | undefined) {
  return Boolean(modeId && snapshot.availableModes.some((mode) => mode.id === modeId))
}

function sameModel(left: Directory.DefaultModel, right: Directory.DefaultModel | undefined) {
  return left.providerID === right?.providerID && left.modelID === right.modelID
}

function restoreFromMessages(messages: readonly MessageInfo[]) {
  const user = messages.findLast(
    (message) => message.role === "user" && message.model?.providerID && message.model.modelID,
  )
  if (user?.model?.providerID && user.model.modelID) {
    return {
      model: { providerID: user.model.providerID as ProviderV2.ID, modelID: user.model.modelID as ModelV2.ID },
      variant: user.model.variant,
      modeId: user.agent,
    }
  }

  const assistant = messages.findLast((message) => message.providerID && message.modelID)
  if (assistant?.providerID && assistant.modelID) {
    return {
      model: { providerID: assistant.providerID as ProviderV2.ID, modelID: assistant.modelID as ModelV2.ID },
      variant: assistant.variant,
      modeId: assistant.mode ?? assistant.agent,
    }
  }

  return {}
}

function isSdkResponse<T>(value: T | SdkResponse<T>): value is SdkResponse<T> {
  return typeof value === "object" && value !== null && ("data" in value || "error" in value)
}

function fromUnknownError(error: unknown, service?: string): Error {
  if (isACPError(error)) return error
  if (isAuthRequired(error)) {
    return new ACPError.AuthRequiredError({ providerId: findProviderID(error) })
  }
  return new ACPError.ServiceFailureError({ safeMessage: "OpenCode service failure", service })
}

function isACPError(error: unknown): error is Error {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    error._tag.startsWith("ACP")
  )
}

function isAuthRequired(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  if (value instanceof Error && (value.name === "ProviderAuthError" || value.name === "LoadAPIKeyError")) return true
  if (
    value instanceof Error &&
    (value.message.includes("ProviderAuthError") || value.message.includes("LoadAPIKeyError"))
  ) {
    return true
  }
  if ("name" in value && (value.name === "ProviderAuthError" || value.name === "LoadAPIKeyError")) return true
  if ("_tag" in value && (value._tag === "ProviderAuthError" || value._tag === "LoadAPIKeyError")) return true
  if ("error" in value && isAuthRequired(value.error)) return true
  if ("data" in value && isAuthRequired(value.data)) return true
  return false
}

function findProviderID(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return
  if ("providerID" in value && typeof value.providerID === "string") return value.providerID
  if ("providerId" in value && typeof value.providerId === "string") return value.providerId
  if ("data" in value) return findProviderID(value.data)
  if ("error" in value) return findProviderID(value.error)
}
