import { expect, test } from "bun:test"
import { type Virtualizer } from "@tanstack/solid-virtual"
import { Node, Window } from "happy-dom"
import { mutationNodesContainElement, observeElementOffsetReconnectAware } from "./observe-element-offset"

test("matches only the scroll element or an ancestor containing it", () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  const child = document.createElement("div")
  const sibling = document.createElement("div")
  route.append(viewport)
  viewport.append(child)

  expect(mutationNodesContainElement([viewport], viewport)).toBe(true)
  expect(mutationNodesContainElement([route], viewport)).toBe(true)
  expect(mutationNodesContainElement([child, sibling], viewport)).toBe(false)
})

test("restores a view observed before its first attachment", async () => {
  const targetWindow = new Window()
  const mutations = controlledMutations(targetWindow)
  const viewport = targetWindow.document.createElement("div")
  const instance = {
    scrollElement: viewport,
    targetWindow,
    scrollOffset: 240,
    options: { horizontal: false, isRtl: false, isScrollingResetDelay: 0, useScrollendEvent: false },
  } as unknown as Virtualizer<HTMLDivElement, HTMLDivElement>
  const connections: boolean[] = []
  const cleanup = observeElementOffsetReconnectAware(
    instance,
    (offset) => {
      instance.scrollOffset = offset
    },
    () => connections.push(viewport.isConnected),
  )
  try {
    mutations.append(targetWindow.document.body, viewport)
    await frames(2, targetWindow)
    expect(connections).toEqual([true])
    expect(instance.scrollOffset).toBe(0)
  } finally {
    cleanup()
    await targetWindow.happyDOM.close()
  }
})

test("reports a divergent native offset once and ignores equal offsets and unrelated mutations", async () => {
  const targetWindow = new Window()
  const mutations = controlledMutations(targetWindow)
  const route = targetWindow.document.createElement("section")
  const viewport = targetWindow.document.createElement("div")
  const unrelated = targetWindow.document.createElement("div")
  route.append(viewport)
  targetWindow.document.body.append(route)
  const instance = {
    scrollElement: viewport,
    targetWindow,
    scrollOffset: 79_400,
    options: {
      horizontal: false,
      isRtl: false,
      isScrollingResetDelay: 0,
      useScrollendEvent: false,
    },
  } as unknown as Virtualizer<HTMLDivElement, HTMLDivElement>
  const calls: [number, boolean][] = []
  const cleanup = observeElementOffsetReconnectAware(instance, (offset, isScrolling) => {
    calls.push([offset, isScrolling])
    instance.scrollOffset = offset
  })

  try {
    mutations.append(targetWindow.document.body, unrelated)
    mutations.remove(unrelated)
    expect(calls).toEqual([])

    mutations.remove(route)
    mutations.append(targetWindow.document.body, route)
    await frames(2, targetWindow)
    expect(calls).toEqual([[0, false]])

    mutations.remove(route)
    mutations.append(targetWindow.document.body, route)
    await frames(2, targetWindow)
    expect(calls).toEqual([[0, false]])
  } finally {
    cleanup?.()
    await targetWindow.happyDOM.close()
  }
})

test("keeps checking until stale reset-delay callbacks can no longer win", async () => {
  const targetWindow = new Window()
  const mutations = controlledMutations(targetWindow)
  const animation = controlledAnimationFrames(targetWindow)
  const route = targetWindow.document.createElement("section")
  const viewport = targetWindow.document.createElement("div")
  route.append(viewport)
  targetWindow.document.body.append(route)
  const instance = {
    scrollElement: viewport,
    targetWindow,
    scrollOffset: 79_400,
    options: {
      horizontal: false,
      isRtl: false,
      isScrollingResetDelay: 20,
      useScrollendEvent: false,
    },
  } as unknown as Virtualizer<HTMLDivElement, HTMLDivElement>
  const calls: number[] = []
  const cleanup = observeElementOffsetReconnectAware(instance, (offset) => {
    calls.push(offset)
    instance.scrollOffset = offset
  })

  try {
    mutations.remove(route)
    mutations.append(targetWindow.document.body, route)
    animation.run(16)
    expect(instance.scrollOffset).toBe(0)

    instance.scrollOffset = 79_400
    animation.run(32)
    animation.run(48)

    expect(instance.scrollOffset).toBe(0)
    expect(calls).toEqual([0, 0])
    expect(animation.pending()).toBe(0)
  } finally {
    cleanup?.()
    await targetWindow.happyDOM.close()
  }
})

test.each([
  { name: "LTR", isRtl: false, expected: 240 },
  { name: "RTL", isRtl: true, expected: -240 },
])("reports the TanStack horizontal $name offset after reconnect", async ({ isRtl, expected }) => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  route.append(viewport)
  document.body.append(route)
  viewport.scrollLeft = 240
  const instance = {
    scrollElement: viewport,
    targetWindow: window,
    scrollOffset: 0,
    options: {
      horizontal: true,
      isRtl,
      isScrollingResetDelay: 0,
      useScrollendEvent: false,
    },
  } as unknown as Virtualizer<HTMLDivElement, HTMLDivElement>
  const calls: [number, boolean][] = []
  const cleanup = observeElementOffsetReconnectAware(instance, (offset, isScrolling) => {
    calls.push([offset, isScrolling])
    instance.scrollOffset = offset
  })

  route.remove()
  document.body.append(route)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await frames(3)

  expect(calls).toEqual([[expected, false]])
  cleanup?.()
  route.remove()
})

test("cleanup suppresses an already queued delegated offset callback", async () => {
  const viewport = document.createElement("div")
  document.body.append(viewport)
  viewport.scrollTop = 100
  const instance = {
    scrollElement: viewport,
    targetWindow: window,
    scrollOffset: 0,
    options: {
      horizontal: false,
      isRtl: false,
      isScrollingResetDelay: 10,
      useScrollendEvent: false,
    },
  } as unknown as Virtualizer<HTMLDivElement, HTMLDivElement>
  const calls: [number, boolean][] = []
  const cleanup = observeElementOffsetReconnectAware(instance, (offset, isScrolling) =>
    calls.push([offset, isScrolling]),
  )

  viewport.dispatchEvent(new Event("scroll"))
  cleanup?.()
  await new Promise((resolve) => setTimeout(resolve, 25))

  expect(calls).toEqual([[100, true]])
  viewport.remove()
})

test("cleanup cancels reconnect checks and delegated offset observation", async () => {
  const route = document.createElement("section")
  const viewport = document.createElement("div")
  route.append(viewport)
  document.body.append(route)
  const instance = {
    scrollElement: viewport,
    targetWindow: window,
    scrollOffset: 0,
    options: {
      horizontal: false,
      isRtl: false,
      isScrollingResetDelay: 50,
      useScrollendEvent: false,
    },
  } as unknown as Virtualizer<HTMLDivElement, HTMLDivElement>
  const calls: number[] = []
  const cleanup = observeElementOffsetReconnectAware(instance, (offset) => calls.push(offset))

  route.remove()
  document.body.append(route)
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanup?.()
  instance.scrollOffset = 100
  viewport.dispatchEvent(new Event("scroll"))
  await frames(4)

  expect(calls).toEqual([])
  route.remove()
})

type FrameWindow = {
  requestAnimationFrame(callback: () => void): unknown
  performance: { now(): number }
}

async function frames(count: number, targetWindow: FrameWindow = window) {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => targetWindow.requestAnimationFrame(() => resolve()))
  }
}

function controlledMutations(targetWindow: Window) {
  let emit: (record: MutationRecord) => void = () => {
    throw new Error("Mutation observer is not active")
  }
  class ControlledMutationObserver {
    constructor(callback: MutationCallback) {
      emit = (record) => callback([record], this as unknown as MutationObserver)
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  Object.defineProperty(targetWindow, "MutationObserver", { value: ControlledMutationObserver })
  const record = (target: Node, addedNodes: Node[], removedNodes: Node[]) =>
    ({ type: "childList", target, addedNodes, removedNodes }) as unknown as MutationRecord
  return {
    append(parent: Node, node: Node) {
      parent.appendChild(node)
      emit(record(parent, [node], []))
    },
    remove(node: Node) {
      const parent = node.parentNode
      if (!parent) throw new Error("Mutation target has no parent")
      parent.removeChild(node)
      emit(record(parent, [], [node]))
    },
  }
}

function controlledAnimationFrames(targetWindow: Window) {
  let time = 0
  let id = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  Object.defineProperty(targetWindow.performance, "now", { value: () => time })
  Object.defineProperty(targetWindow, "requestAnimationFrame", {
    value: (callback: FrameRequestCallback) => {
      id += 1
      callbacks.set(id, callback)
      return id
    },
  })
  Object.defineProperty(targetWindow, "cancelAnimationFrame", {
    value: (frame: number) => callbacks.delete(frame),
  })
  return {
    run(at: number) {
      time = at
      const pending = [...callbacks.values()]
      callbacks.clear()
      pending.forEach((callback) => callback(at))
    },
    pending: () => callbacks.size,
  }
}
