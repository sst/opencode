import type { APIEvent } from "@solidjs/start/server"
import { Quota } from "@opencode-ai/console-core/quota.js"
import { safeEqual } from "@opencode-ai/console-core/util/crypto.js"
import { Resource } from "@opencode-ai/console-resource"
import z from "zod"

const Body = z.object({
  workspaceID: z.string().startsWith("wrk_"),
  plan: z.enum(["lite", "subscription"]),
})

export async function POST(event: APIEvent) {
  if (!safeEqual(event.request.headers.get("authorization") ?? "", `Bearer ${Resource.SUPPORT_API_KEY.value}`)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = Body.safeParse(await event.request.json().catch(() => undefined))
  if (!body.success) {
    return Response.json({ error: "Invalid request", issues: body.error.issues }, { status: 400 })
  }
  return Quota.reset(body.data)
    .then((result) => Response.json({ success: true, message: "Usage counters reset to zero", result }))
    .catch((error) => Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }))
}
