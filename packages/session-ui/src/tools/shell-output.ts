import { isShellNotFoundError, type ShellOutputInput, type ShellOutputOutput } from "@opencode/client/promise"

// Same page size as the TUI shell output viewer; only this much recent output is retained and rendered.
export const SHELL_OUTPUT_TAIL_BYTES = 64 * 1024
const PROGRESS_LIMIT = 32

type Progress = { cursor: number; output: string; state: "partial" | "complete" | "missing" }

// Virtualized timelines remount shell tools frequently. Progress is remembered per shell so a
// remount resumes from its cursor instead of re-reading from zero, and so a shell the server no
// longer knows is never requested again.
const progress = new Map<string, Progress>()

function remember(id: string, entry: Progress) {
  progress.delete(id)
  progress.set(id, entry)
  if (progress.size <= PROGRESS_LIMIT) return
  const oldest = progress.keys().next().value
  if (oldest !== undefined) progress.delete(oldest)
}

export function followShellOutput(input: {
  id: string
  directory: string
  running: boolean
  load: (input: ShellOutputInput) => Promise<ShellOutputOutput>
  onOutput: (output: string) => void
}) {
  const cached = progress.get(input.id)
  if (cached) {
    remember(input.id, cached)
    input.onOutput(cached.output)
  }
  // A missing shell never comes back. A complete one is only re-read while the shell is believed to be
  // running, because the running-shell inventory can arrive after history has already rendered.
  if (cached?.state === "missing" || (cached?.state === "complete" && !input.running)) return () => {}
  let cursor = cached?.cursor ?? 0
  let text = cached?.output ?? ""
  let loading = false
  let disposed = false
  const read = async () => {
    if (loading) return
    loading = true
    while (true) {
      const page = await input.load({ id: input.id, location: { directory: input.directory }, cursor }).then(
        (response) => response.data,
        (cause: unknown) => (isShellNotFoundError(cause) ? "missing" : undefined),
      )
      if (disposed) break
      if (page === "missing") {
        // The server drops exited shells past its retention limit; stop asking for this one.
        remember(input.id, { cursor, output: text, state: "missing" })
        clearInterval(interval)
        break
      }
      if (!page) break
      const advanced = page.cursor > cursor
      cursor = Math.max(cursor, page.cursor)
      text = (text + page.output).slice(-SHELL_OUTPUT_TAIL_BYTES)
      const complete = !input.running && cursor >= page.size
      remember(input.id, { cursor, output: text, state: complete ? "complete" : "partial" })
      input.onOutput(text)
      if (input.running || complete || !advanced) break
    }
    loading = false
  }
  void read()
  // Refresh the final snapshot on exit, but poll only while the shell is live.
  const interval = input.running ? setInterval(() => void read(), 1_000) : undefined
  return () => {
    disposed = true
    clearInterval(interval)
  }
}
