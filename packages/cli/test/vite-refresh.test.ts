import { expect, test } from "bun:test"
import { createComponent, createContext, createRoot, useContext } from "solid-js"
import { $$context, $$registry } from "solid-refresh/dist/solid-refresh.mjs"
import { $$refresh } from "../dev/refresh"

test("re-evaluated dependencies retain their mounted context before any HMR accept callback", () => {
  const previous = $$registry()
  const mounted = $$context(previous, "Context", createContext("old default"))
  const next = $$registry()
  const updated = $$context(next, "Context", createContext("new default"))
  const unrelated = $$context($$registry(), "Context", createContext("unrelated"))
  let accepted = false
  $$refresh(
    "vite",
    {
      data: { "solid-refresh": previous, "solid-refresh-prev": previous },
      accept() {
        accepted = true
      },
      invalidate() {
        throw new Error("Unexpected invalidation")
      },
      decline() {
        throw new Error("Unexpected decline")
      },
    },
    next,
  )

  // Only register acceptance: Vite re-evaluates cyclic dependencies without
  // necessarily sending those modules their own accepted update.
  expect(accepted).toBe(true)
  createRoot((dispose) => {
    createComponent(mounted.Provider, {
      value: "mounted provider",
      get children() {
        expect(useContext(updated)).toBe("mounted provider")
        expect(useContext(unrelated)).toBe("unrelated")
        return undefined
      },
    })
    expect(useContext(mounted)).toBe("new default")
    dispose()
  })
})
