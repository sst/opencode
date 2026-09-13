import { getRequestEvent } from "solid-js/web"
import { and, Database, eq, inArray, isNull, sql } from "@opencode-ai/console-core/drizzle/index.js"
import { UserTable } from "@opencode-ai/console-core/schema/user.sql.js"
import { WorkspaceTable } from "@opencode-ai/console-core/schema/workspace.sql.js"
import { redirect } from "@solidjs/router"
import { Actor } from "@opencode-ai/console-core/actor.js"

import { createClient } from "@openauthjs/openauth/client"

export const AuthClient = createClient({
  clientID: "app",
  issuer: import.meta.env.VITE_AUTH_URL,
})

import { useSession } from "@solidjs/start/http"
import { Resource } from "@opencode-ai/console-resource"

export interface AuthSession {
  account?: Record<
    string,
    {
      id: string
      email: string
    }
  >
  current?: string
}

export function useAuthSession() {
  return useSession<AuthSession>({
    password: Resource.ZEN_SESSION_SECRET.value,
    name: "auth",
    maxAge: 60 * 60 * 24 * 365,
    cookie: {
      secure: false,
      httpOnly: true,
    },
  })
}

export const getActor = async (workspace?: string): Promise<Actor.Info> => {
  "use server"
  const evt = getRequestEvent()
  if (!evt) throw new Error("No request event")
  if (evt.locals.actor) return evt.locals.actor
  evt.locals.actor = (async () => {
    const auth = await useAuthSession()
    if (!workspace) {
      const account = auth.data.account ?? {}
      const current = account[auth.data.current ?? ""]
      if (current) {
        return {
          type: "account",
          properties: {
            email: current.email,
            accountID: current.id,
          },
        }
      }
      if (Object.keys(account).length > 0) {
        const current = Object.values(account)[0]
        await auth.update((val) => ({
          ...val,
          current: current.id,
        }))
        return {
          type: "account",
          properties: {
            email: current.email,
            accountID: current.id,
          },
        }
      }
      return {
        type: "public",
        properties: {},
      }
    }
    const accounts = Object.keys(auth.data.account ?? {})
    if (accounts.length) {
      const user = await Database.use((tx) =>
        tx
          .select({
            id: UserTable.id,
            workspaceID: UserTable.workspaceID,
            accountID: UserTable.accountID,
            role: UserTable.role,
            migratedAt: WorkspaceTable.migrated_at,
          })
          .from(UserTable)
          .innerJoin(WorkspaceTable, eq(WorkspaceTable.id, UserTable.workspaceID))
          .where(
            and(
              eq(UserTable.workspaceID, workspace),
              isNull(UserTable.timeDeleted),
              inArray(UserTable.accountID, accounts),
            ),
          )
          .limit(1)
          .execute()
          .then((x) => x[0]),
      )
      if (user) {
        if (user.migratedAt) {
          const destination = Resource.ConsoleMigration.consoleUrl
          if (!destination) throw new Error("New Console URL is not configured")
          evt.response.headers.set("Cache-Control", "no-store")
          throw redirect(`${destination}/login`, {
            status: evt.request.method === "GET" || evt.request.method === "HEAD" ? 302 : 303,
            headers: { "Cache-Control": "no-store" },
          })
        }
        await Database.use((tx) =>
          tx
            .update(UserTable)
            .set({ timeSeen: sql`now()` })
            .where(and(eq(UserTable.workspaceID, workspace), eq(UserTable.id, user.id))),
        )
        return {
          type: "user",
          properties: {
            userID: user.id,
            workspaceID: user.workspaceID,
            accountID: user.accountID,
            role: user.role,
          },
        }
      }
    }
    throw redirect("/auth/authorize")
  })()
  return evt.locals.actor
}
