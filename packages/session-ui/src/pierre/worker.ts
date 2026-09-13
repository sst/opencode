import type { LineDiffTypes } from "@pierre/diffs"
import { WorkerPoolManager } from "@pierre/diffs/worker"
import ShikiWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url"
import { registerOpenCodeTheme } from "@opencode-ai/ui/context/marked-theme-register"

registerOpenCodeTheme()

export function workerFactory(): Worker {
  return new Worker(ShikiWorkerUrl, { type: "module" })
}

function createPool(lineDiffType: LineDiffTypes) {
  const pool = new WorkerPoolManager(
    {
      workerFactory,
      // poolSize defaults to 8. More workers = more parallelism but
      // also more memory. Too many can actually slow things down.
      // NOTE: 2 is probably better for OpenCode, as I think 8 might be
      // a bit overkill, especially because Safari has a significantly slower
      // boot up time for workers
      poolSize: 2,
    },
    {
      theme: "OpenCode",
      lineDiffType,
      preferredHighlighter: "shiki-wasm",
    },
  )

  void pool.initialize()
  return pool
}

const pools = new Map<LineDiffTypes, WorkerPoolManager>()

export function getWorkerPool(lineDiffType: LineDiffTypes | undefined): WorkerPoolManager | undefined {
  if (typeof window === "undefined") return

  const type = lineDiffType ?? "none"
  const existing = pools.get(type)
  if (existing) return existing

  const pool = createPool(type)
  pools.set(type, pool)
  return pool
}

export function getWorkerPools() {
  return {
    unified: getWorkerPool("none"),
    split: getWorkerPool("word-alt"),
  }
}
