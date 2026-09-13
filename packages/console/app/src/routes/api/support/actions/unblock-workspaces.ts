import type { APIEvent } from "@solidjs/start/server"
import { Workspace } from "@opencode-ai/console-core/workspace.js"
import { safeEqual } from "@opencode-ai/console-core/util/crypto.js"
import { Resource } from "@opencode-ai/console-resource"
import z from "zod"

const Body = z.object({ workspaceIDs: z.array(z.string().startsWith("wrk_")).min(1) })

export async function POST(event: APIEvent) {
  if (!safeEqual(event.request.headers.get("authorization") ?? "", `Bearer ${Resource.SUPPORT_API_KEY.value}`)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = Body.safeParse(await event.request.json().catch(() => undefined))
  if (!body.success) {
    return Response.json({ error: "Invalid request", issues: body.error.issues }, { status: 400 })
  }
  // Missing IDs do not fail the batch; they are reported per item in the result.
  return Workspace.unblockBatch(body.data)
    .then((result) => Response.json({ success: true, message: "Workspaces unblocked", result }))
    .catch((error) => Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }))
}
