import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"

export function useOpenProject(options: {
  projectDirectory?: (directory: string) => string
  open: (directory: string) => void
  touch?: (directory: string) => void
}) {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()

  async function ensureProject(directory: string) {
    const projectDirectory = options.projectDirectory?.(directory) ?? directory
    const known = serverSync().data.project.some((project) => project.worktree === projectDirectory)
    if (!known) {
      await serverSDK()
        .api.project.current({ location: { directory: projectDirectory } })
        .catch(() => undefined)
    }
    options.open(directory)
    options.touch?.(directory)
  }

  return { ensureProject }
}
