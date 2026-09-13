import type { FormAnswer, IntegrationMethod, IntegrationOauthConnectOutput } from "@opencode/client/promise"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import { createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"

export type ProviderConnectMethod = Extract<IntegrationMethod, { type: "key" | "oauth" }>
type Authorization = IntegrationOauthConnectOutput["data"]

export function createProviderConnectionController(options: {
  provider: () => string
  directory: () => string | undefined
  onComplete: () => void
  initialMethod?: string
  pollInterval?: number
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const data = useData()
  // An authorization belongs to the server and Location where it began.
  const directory = options.directory()
  const integrationID = options.provider()
  const desktopConsole = platform.platform === "desktop" && integrationID === "opencode"
  const location = () => (directory ? { directory } : undefined)
  const [integration] = createResource(
    () => ({ provider: integrationID, directory }),
    (input) =>
      serverSDK.api.integration
        .get({ integrationID: input.provider, location: location() })
        .then((result) => result.data),
  )
  const methods = createMemo<ProviderConnectMethod[]>(() => {
    const values = integration.latest?.methods.filter(
      (method): method is ProviderConnectMethod => method.type === "key" || method.type === "oauth",
    )
    if (values?.length) return [...values]
    return [{ type: "key", label: language.t("provider.connect.method.apiKey") }]
  })
  const [store, setStore] = createStore({
    methodIndex: undefined as number | undefined,
    authorization: undefined as Authorization | undefined,
    formAnswer: undefined as FormAnswer | undefined,
    state: "pending" as "pending" | "waiting" | "refreshing" | "ready" | "error" | "form" | undefined,
    error: undefined as string | undefined,
    connected: false,
    browserFailed: false,
    statusFailed: false,
    selectingIndex: undefined as number | undefined,
  })
  const polling = {
    generation: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    disposed: false,
  }
  const currentMethod = createMemo(() =>
    store.methodIndex === undefined ? undefined : methods().at(store.methodIndex),
  )

  type Action =
    | { type: "method.select"; index: number }
    | { type: "method.reset" }
    | { type: "auth.form" }
    | { type: "auth.answer"; answer: FormAnswer | undefined }
    | { type: "auth.pending" }
    | { type: "auth.authorized"; index: number; authorization: Authorization }
    | { type: "auth.error"; error: string }

  const dispatch = (action: Action) => {
    setStore(
      produce((draft) => {
        if (action.type === "method.select") {
          draft.methodIndex = action.index
          draft.authorization = undefined
          draft.formAnswer = undefined
          draft.state = undefined
          draft.error = undefined
          draft.connected = false
          draft.browserFailed = false
          draft.statusFailed = false
          draft.selectingIndex = undefined
          return
        }
        if (action.type === "method.reset") {
          draft.methodIndex = undefined
          draft.authorization = undefined
          draft.formAnswer = undefined
          draft.state = undefined
          draft.error = undefined
          draft.connected = false
          draft.browserFailed = false
          draft.statusFailed = false
          draft.selectingIndex = undefined
          return
        }
        if (action.type === "auth.form") {
          draft.state = "form"
          draft.error = undefined
          return
        }
        if (action.type === "auth.answer") {
          draft.formAnswer = action.answer
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "auth.pending") {
          draft.state = "pending"
          draft.error = undefined
          draft.selectingIndex = undefined
          return
        }
        if (action.type === "auth.authorized") {
          draft.methodIndex = action.index
          draft.state = "waiting"
          draft.authorization = action.authorization
          draft.error = undefined
          draft.selectingIndex = undefined
          return
        }
        draft.state = "error"
        draft.error = action.error
      }),
    )
  }

  const cancelPolling = () => {
    polling.generation++
    if (polling.timer === undefined) return
    clearTimeout(polling.timer)
    polling.timer = undefined
  }
  const cancelAttempt = (authorization = store.authorization) => {
    if (!desktopConsole) return
    if (!authorization || (authorization.attemptID === store.authorization?.attemptID && store.connected)) return
    void serverSDK.api.integration.oauth
      .cancel({
        integrationID,
        attemptID: authorization.attemptID,
        location: location(),
      })
      .catch(() => undefined)
  }
  const openBrowser = async () => {
    const authorization = store.authorization
    if (!authorization) return
    const generation = polling.generation
    const opened = await Promise.resolve()
      .then(async () => {
        if (platform.openBrowser) return platform.openBrowser(authorization.url)
        platform.openExternal(authorization.url)
        return true
      })
      .then((result) => result !== false)
      .catch(() => false)
    if (polling.disposed || generation !== polling.generation) return
    setStore("browserFailed", !opened)
  }
  const finish = async () => {
    cancelPolling()
    const generation = polling.generation
    setStore({ connected: true, state: "refreshing", error: undefined })
    const ref = location()
    data.location.integration.invalidate(ref)
    data.location.provider.invalidate(ref)
    data.location.model.invalidate(ref)
    const refreshed = await Promise.all([
      data.location.integration.sync(ref),
      data.location.provider.sync(ref),
      data.location.model.sync(ref),
    ])
      .then(() => true)
      .catch(() => false)
    if (polling.disposed || generation !== polling.generation) return
    if (!refreshed && desktopConsole) {
      dispatch({ type: "auth.error", error: language.t("provider.connect.console.refreshFailed") })
      return
    }
    setStore("state", "ready")
    options.onComplete()
  }
  const poll = async (authorization: Authorization, generation: number) => {
    const result = await serverSDK.api.integration.oauth
      .status({
        integrationID,
        attemptID: authorization.attemptID,
        location: location(),
      })
      .then((response) => ({ ok: true as const, status: response.data }))
      .catch((error) => ({ ok: false as const, error }))
    if (polling.disposed || generation !== polling.generation) return
    if (!result.ok) {
      setStore("statusFailed", true)
      dispatch({
        type: "auth.error",
        error: desktopConsole
          ? language.t("provider.connect.console.statusFailed")
          : result.error instanceof Error
            ? result.error.message
            : String(result.error),
      })
      return
    }
    if (result.status.status === "complete") {
      await finish()
      return
    }
    if (result.status.status === "failed") {
      const message = result.status.message
      dispatch({
        type: "auth.error",
        error:
          desktopConsole && message.includes("expired_token")
            ? language.t("provider.connect.console.expired")
            : desktopConsole && message.includes("access_denied")
              ? language.t("provider.connect.console.denied")
              : message,
      })
      return
    }
    if (result.status.status === "expired") {
      dispatch({
        type: "auth.error",
        error: language.t(desktopConsole ? "provider.connect.console.expired" : "common.requestFailed"),
      })
      return
    }
    polling.timer = setTimeout(
      () => void poll(authorization, generation),
      options.pollInterval ?? (desktopConsole ? 500 : 1_000),
    )
  }
  const select = async (index: number, answer?: FormAnswer) => {
    cancelPolling()
    cancelAttempt()
    const generation = polling.generation
    const selected = methods()[index]
    const awaitAuthorization = desktopConsole && selected.type === "oauth" && selected.id === "device"
    if (!awaitAuthorization) dispatch({ type: "method.select", index })
    if (selected.form?.length && !answer) {
      dispatch({ type: "auth.form" })
      return
    }
    if (selected.type === "key") {
      dispatch({ type: "auth.answer", answer })
      return
    }
    if (selected.type !== "oauth") return
    if (selected.form?.some((field) => field.type !== "string")) {
      dispatch({ type: "auth.error", error: language.t("provider.connect.form.unsupported") })
      return
    }
    if (awaitAuthorization) {
      setStore({
        selectingIndex: index,
        authorization: undefined,
        state: undefined,
        error: undefined,
        browserFailed: false,
        statusFailed: false,
      })
    } else {
      dispatch({ type: "auth.pending" })
    }
    const result = await serverSDK.api.integration.oauth
      .connect({
        integrationID,
        methodID: selected.id,
        ...(answer ? { answer } : {}),
        location: location(),
      })
      .then((response) => {
        if (integrationID === "opencode" && platform.platform === "desktop") {
          const url = new URL(response.data.url)
          url.searchParams.set("client_id", "opencode-desktop")
          url.searchParams.set("return_window", platform.windowID)
          response.data.url = url.href
        }
        return { ok: true as const, authorization: response.data }
      })
      .catch((error) => ({ ok: false as const, error }))
    if (polling.disposed || generation !== polling.generation) {
      if (result.ok) cancelAttempt(result.authorization)
      return
    }
    if (!result.ok) {
      if (awaitAuthorization) dispatch({ type: "method.select", index })
      dispatch({
        type: "auth.error",
        error: desktopConsole ? language.t("provider.connect.console.startFailed") : String(result.error),
      })
      return
    }
    dispatch({ type: "auth.authorized", index, authorization: result.authorization })
    if (desktopConsole && selected.id === "device") void openBrowser()
    if (result.authorization.mode === "auto") void poll(result.authorization, generation)
  }
  const reset = () => {
    cancelPolling()
    cancelAttempt()
    dispatch({ type: "method.reset" })
  }
  const connectKey = async (key: string) => {
    await serverSDK.api.integration.connect.key({
      integrationID,
      location: location(),
      key,
      ...(store.formAnswer ? { answer: store.formAnswer } : {}),
    })
    await finish()
  }
  const completeCode = async (code: string) => {
    const authorization = store.authorization
    if (!authorization) return language.t("provider.connect.oauth.code.invalid")
    const result = await serverSDK.api.integration.oauth
      .complete({
        integrationID,
        attemptID: authorization.attemptID,
        location: location(),
        code,
      })
      .then(() => ({ ok: true as const }))
      .catch((error) => ({ ok: false as const, error }))
    if (!result.ok) {
      const message = result.error instanceof Error ? result.error.message : String(result.error)
      return message || language.t("provider.connect.oauth.code.invalid")
    }
    await finish()
    return undefined
  }

  let auto = false
  createEffect(() => {
    if (auto || integration.loading) return
    const index = options.initialMethod
      ? methods().findIndex((method) => method.type === "oauth" && method.id === options.initialMethod)
      : methods().length === 1
        ? 0
        : -1
    if (index < 0) return
    auto = true
    void select(index)
  })
  onCleanup(() => {
    polling.disposed = true
    cancelPolling()
    cancelAttempt()
  })

  return {
    loading: () => integration.loading,
    integration: () => integration.latest,
    methods,
    currentMethod,
    methodIndex: () => store.methodIndex,
    authorization: () => store.authorization,
    browserFailed: () => store.browserFailed,
    selecting: (index: number) => store.selectingIndex === index,
    openBrowser,
    auth: {
      state: () => store.state,
      error: () => store.error,
      select,
      reset,
      connectKey,
      completeCode,
      refresh: finish,
      retry: () => {
        if (store.connected) return finish()
        if (store.statusFailed && store.authorization) {
          setStore({ state: "waiting", error: undefined, statusFailed: false })
          return poll(store.authorization, polling.generation)
        }
        return store.methodIndex === undefined ? Promise.resolve() : select(store.methodIndex, store.formAnswer)
      },
    },
  }
}

export type ProviderConnectionController = ReturnType<typeof createProviderConnectionController>
