import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { isFileNotFoundError } from "@opencode/client/promise"
import { createSimpleContext } from "@opencode/ui/context"
import { showToast } from "@/shell/notifications/toast"
import { useParams } from "@solidjs/router"
import { base64Encode } from "@opencode/util/encode"
import { getFilename } from "@opencode/util/path"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useLanguage } from "@/runtime/i18n/language"
import { useLayout } from "@/shell/state/layout"
import { createPathHelpers } from "./path"
import {
  approxBytes,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./content-cache"
import { createFileViewCache } from "./view-cache"
import { useServerSDK } from "@/runtime/server/client"
import { formatServerError } from "@/runtime/server/errors"
import { SessionRouteKey, SessionStateKey } from "@/runtime/server/scope"
import { createFileTreeStore } from "./tree-store"
import { invalidateFromWatcher } from "./watcher"
import {
  selectionFromLines,
  type FileState,
  type FileSelection,
  type FileViewState,
  type SelectedLineRange,
} from "./types"

export type { FileSelection, SelectedLineRange, FileViewState, FileState }
export { selectionFromLines }
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

export const { use: useFile, provider: FileProvider } = createSimpleContext({
  name: "File",
  gate: false,
  init: () => {
    const sdk = useWorkspaceLocation()
    const params = useParams()
    const serverSDK = useServerSDK()
    const language = useLanguage()
    const layout = useLayout()

    const scope = createMemo(() => sdk().directory)
    const path = createPathHelpers(scope)
    const tabs = layout.tabs(() =>
      SessionStateKey.from(serverSDK.scope, SessionRouteKey.fromRoute(base64Encode(sdk().directory), params.id)),
    )

    const inflight = new Map<string, Promise<void>>()
    const [store, setStore] = createStore<{
      file: Record<string, FileState>
    }>({
      file: {},
    })

    const tree = createFileTreeStore({
      scope,
      normalizeDir: path.normalizeDir,
      list: (dir) =>
        serverSDK.api.file.list({ path: dir, location: { directory: scope() } }).then((x) =>
          x.data.map((entry) => ({
            ...entry,
            name: entry.path.split("/").at(-1) ?? entry.path,
            absolute: `${scope()}/${entry.path}`,
            ignored: false,
          })),
        ),
      onError: (message) => {
        showToast({
          variant: "error",
          title: language.t("toast.file.listFailed.title"),
          description: message,
        })
      },
    })

    const evictContent = (keep?: Set<string>) => {
      evictContentLru(keep, (target) => {
        if (!store.file[target]) return
        setStore(
          "file",
          target,
          produce((draft) => {
            draft.content = undefined
            draft.loaded = false
          }),
        )
      })
    }

    createEffect(() => {
      scope()
      inflight.clear()
      resetFileContentLru()
      batch(() => {
        setStore("file", reconcile({}))
        tree.reset()
      })
    })

    const viewCache = createFileViewCache(serverSDK.scope)
    const view = createMemo(() => viewCache.load(scope(), params.id))

    const ensure = (file: string) => {
      if (!file) return
      if (store.file[file]) return
      setStore("file", file, { path: file, name: getFilename(file) })
    }

    const setLoading = (file: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = true
          draft.error = undefined
        }),
      )
    }

    const setLoaded = (file: string, content: FileState["content"]) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loaded = true
          draft.loading = false
          draft.notFound = false
          draft.content = content
        }),
      )
    }

    const setLoadError = (file: string, message: string, notFound = false) => {
      if (notFound) removeFileContentBytes(file)
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = false
          draft.notFound = notFound
          draft.error = message
          if (!notFound) return
          draft.loaded = false
          draft.content = undefined
        }),
      )
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: message,
      })
    }

    const load = (input: string, options?: { force?: boolean }) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve()

      const directory = scope()
      const key = `${directory}\n${file}`
      ensure(file)

      const current = store.file[file]
      if (!options?.force && current?.loaded) return Promise.resolve()

      const pending = inflight.get(key)
      if (pending) return pending

      setLoading(file)

      const promise = serverSDK.api.file
        .read({ path: file, location: { directory } })
        .then((data) => {
          if (scope() !== directory) return
          const content = { type: "text" as const, content: new TextDecoder().decode(data) }
          setLoaded(file, content)

          if (!content) return
          touchFileContent(file, approxBytes(content))
          evictContent(new Set([file]))
        })
        .catch((e) => {
          if (scope() !== directory) return
          setLoadError(
            file,
            formatServerError(e, language.t, language.t("error.chain.unknown")),
            isFileNotFoundError(e),
          )
        })
        .finally(() => {
          inflight.delete(key)
        })

      inflight.set(key, promise)
      return promise
    }

    const search = (query: string, dirs: "true" | "false", options?: { limit?: number; signal?: AbortSignal }) =>
      serverSDK.api.file
        .find(
          {
            location: { directory: sdk().directory },
            query,
            type: dirs === "true" ? undefined : "file",
            limit: options?.limit,
          },
          { signal: options?.signal },
        )
        .then(
          (x) => x.data.map((entry) => path.normalize(entry.path)),
          (error) => {
            if (options?.signal?.aborted) throw error
            return []
          },
        )

    createEffect(() => {
      const stop = sdk().event.on("filesystem.changed", (event) => {
        invalidateFromWatcher(event, {
          normalize: path.normalize,
          hasFile: (file) => Boolean(store.file[file]),
          isOpen: (file) => tabs.all().some((tab) => path.pathFromTab(tab) === file),
          loadFile: (file) => {
            void load(file, { force: true })
          },
          node: tree.node,
          isDirLoaded: tree.isLoaded,
          refreshDir: (dir) => {
            void tree.listDir(dir, { force: true })
          },
        })
      })
      onCleanup(stop)
    })

    const get = (input: string) => {
      const file = path.normalize(input)
      const state = store.file[file]
      const content = state?.content
      if (!content) return state
      if (hasFileContent(file)) {
        touchFileContent(file)
        return state
      }
      touchFileContent(file, approxBytes(content))
      return state
    }

    function withPath(input: string, action: (file: string) => unknown) {
      return action(path.normalize(input))
    }
    const scrollTop = (input: string) => withPath(input, (file) => view().scrollTop(file))
    const scrollLeft = (input: string) => withPath(input, (file) => view().scrollLeft(file))
    const selectedLines = (input: string) => withPath(input, (file) => view().selectedLines(file))
    const setScrollTop = (input: string, top: number) => withPath(input, (file) => view().setScrollTop(file, top))
    const setScrollLeft = (input: string, left: number) => withPath(input, (file) => view().setScrollLeft(file, left))
    const setSelectedLines = (input: string, range: SelectedLineRange | null) =>
      withPath(input, (file) => view().setSelectedLines(file, range))

    onCleanup(() => {
      viewCache.clear()
    })

    return {
      ready: () => view().ready(),
      normalize: path.normalize,
      tab: path.tab,
      pathFromTab: path.pathFromTab,
      tree: {
        list: tree.listDir,
        refresh: (input: string) => tree.listDir(input, { force: true }),
        state: tree.dirState,
        children: tree.children,
        expand: tree.expandDir,
        collapse: tree.collapseDir,
      },
      get,
      notFound: (input: string) => store.file[path.normalize(input)]?.notFound ?? false,
      load,
      scrollTop,
      scrollLeft,
      setScrollTop,
      setScrollLeft,
      selectedLines,
      setSelectedLines,
      searchFiles: (query: string, options?: { limit?: number; signal?: AbortSignal }) =>
        search(query, "false", options),
      searchFilesAndDirectories: (query: string) => search(query, "true"),
    }
  },
})
