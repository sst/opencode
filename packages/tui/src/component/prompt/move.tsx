import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useTuiPaths } from "../../context/runtime"
import { errorMessage } from "../../util/error"
import { useDialog } from "../../ui/dialog"
import { useClient } from "../../context/client"
import { useToast } from "../../ui/toast"
import { DialogWorkspaces, type WorkspaceSelection } from "../dialog-workspaces"
import { useData } from "../../context/data"
import { useLocation } from "../../context/location"
import { useRoute } from "../../context/route"

export function usePromptMove(input: { projectID: () => string | undefined; sessionID: () => string | undefined }) {
  const dialog = useDialog()
  const client = useClient()
  const toast = useToast()
  const data = useData()
  const currentLocation = useLocation()
  const route = useRoute()
  const paths = useTuiPaths()
  const [creating, setCreating] = createSignal(false)
  const [creatingDots, setCreatingDots] = createSignal(3)
  const [progress, setProgress] = createSignal<string>()
  const [destination, setDestination] = createSignal<WorkspaceSelection>()

  function homeLocation() {
    const location = currentLocation.ref ?? data.location.default()
    return { ...location, directory: location.directory || paths.cwd }
  }

  async function create(name: string) {
    setCreating(true)
    setProgress("Creating worktree")
    try {
      const sessionID = input.sessionID()
      const session = sessionID ? await resolveSession(sessionID) : undefined
      if (sessionID && !session) throw new Error("Unable to determine current session location")
      const location = session?.location ?? homeLocation()
      if (!data.location.info(location)) await data.location.syncInfo(location)
      const project = data.location.info(location)?.project
      if (!project) throw new Error("Unable to determine current project")
      const result = await client.api.worktree.create({
        location: { directory: location.directory, workspace: location.workspaceID },
        name,
      })
      const directory = result.directory
      if (!directory) throw new Error("No worktree directory returned")

      // Seed the location store before optimistic session creation mounts the
      // destination. A raw read initializes the server location but leaves the
      // optimistic session without its project until the create request echoes.
      await data.location.syncInfo({ directory })

      setProgress("Creating session")
      return directory
    } catch (err) {
      setDestination(undefined)
      setProgress(undefined)
      setCreating(false)
      toast.show({ title: "Creating workspace failed", message: errorMessage(err), variant: "error" })
      return
    }
  }

  async function open() {
    const projectID = await resolveProjectID()
    if (!projectID) {
      toast.show({ message: "Unable to determine current project", variant: "error" })
      return
    }
    const sessionID = input.sessionID()
    const session = sessionID ? await resolveSession(sessionID) : undefined
    dialog.replace(() => (
      <DialogWorkspaces
        projectID={projectID}
        location={session?.location ?? homeLocation()}
        current={
          destination() ??
          (session
            ? {
                type: "directory",
                directory: session.location.directory,
                subdirectory: !!session.subpath,
              }
            : {
                type: "directory",
                directory: homeLocation().directory,
                subdirectory: homeLocation().directory !== data.location.info(homeLocation())?.project.directory,
              })
        }
        onCurrentChange={setDestination}
        onSelect={(selection) => {
          if (!input.sessionID() && selection.type === "new") {
            setDestination(selection)
            dialog.clear()
            return
          }
          void selectWorkspace(selection)
        }}
      />
    ))
  }

  async function selectWorkspace(selection: WorkspaceSelection) {
    dialog.clear()
    const directory = selection.type === "new" ? await create(selection.name) : selection.directory
    if (!directory) {
      setProgress(undefined)
      dialog.clear()
      return
    }
    finishSubmit()
    route.navigate({ type: "home", location: { directory } })
  }

  async function resolveProjectID() {
    const sessionID = input.sessionID()
    if (sessionID) return input.projectID() ?? (await resolveSession(sessionID))?.projectID
    const location = homeLocation()
    const current = data.location.info(location)
    if (current) return current.project.id
    return client.api.project
      .current({ location: { directory: location.directory, workspace: location.workspaceID } })
      .then((project) => project.id)
      .catch(() => undefined)
  }

  async function resolveSession(sessionID: string) {
    const session = data.session.get(sessionID)
    if (session) return session
    await data.session.sync(sessionID).catch(() => undefined)
    return data.session.get(sessionID)
  }

  const pending = createMemo(() => Boolean(destination()))
  const pendingNew = createMemo(() => destination()?.type === "new")

  async function getDirectory() {
    const value = destination()
    if (!value) return
    if (value.type === "directory") {
      return value.directory
    }
    return await create(value.name)
  }

  function startSubmit() {
    if (progress()) setProgress("Submitting prompt")
  }

  function finishSubmit() {
    setDestination(undefined)
    setProgress(undefined)
    setCreating(false)
  }

  function setDirectory(directory: string, subdirectory: boolean) {
    setDestination({ type: "directory", directory, subdirectory })
  }

  createEffect(() => {
    if (!creating()) {
      setCreatingDots(3)
      return
    }
    const timer = setInterval(() => setCreatingDots((dots) => (dots % 3) + 1), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return {
    creating,
    creatingDots,
    finishSubmit,
    getDirectory,
    open,
    pending,
    pendingNew,
    progress,
    setDirectory,
    startSubmit,
  }
}
