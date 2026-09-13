import { expect, test } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import { OpenCode } from "@opencode/client/promise"
import { createData } from "@opencode/client/solid"

test("publishes an initial message page, its index, and its cursor together", async () => {
  const observed: { ids: string[]; more: boolean; text: string | undefined }[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async () =>
      Response.json({
        data: [{ id: "msg_page", type: "user", text: "History", time: { created: 1 } }],
        cursor: { next: "older" },
      }),
  })
  const setup = createRoot((dispose) => {
    const data = createData({
      api: () => api,
      directory: "/project",
      event: { on: () => () => {}, listen: () => () => {} },
    })
    createComputed(() => {
      const message = data.session.message.get("ses_page", "msg_page")
      observed.push({
        ids: data.session.message.list("ses_page").map((message) => message.id),
        more: data.session.message.more("ses_page"),
        text: message?.type === "user" ? message.text : undefined,
      })
    })
    return { data, dispose }
  })
  try {
    await setup.data.session.message.sync("ses_page")
    expect(observed).toEqual([
      { ids: [], more: false, text: undefined },
      { ids: ["msg_page"], more: true, text: "History" },
    ])
  } finally {
    setup.dispose()
  }
})
