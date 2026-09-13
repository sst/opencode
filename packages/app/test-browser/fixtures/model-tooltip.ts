import { expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import { dict } from "@/runtime/i18n/en"

const require = createRequire(import.meta.url)
const solid = createRequire(require.resolve("vite-plugin-solid"))
const { transformSync } = solid("@babel/core")
Bun.plugin({
  name: "model-tooltip-solid",
  setup(build) {
    build.onLoad({ filter: /[\\/]models[\\/]tooltip\.tsx$/ }, async (args) => ({
      contents: transformSync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [solid.resolve("babel-preset-solid"), solid.resolve("@babel/preset-typescript")],
      }).code,
      loader: "js",
    }))
  },
})
mock.module("@/runtime/i18n/language", () => ({
  useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key], intl: () => "en-US" }),
}))
const { ModelTooltip } = await import("@/providers/models/tooltip")

const model = {
  id: "route_1",
  name: "Claude coding",
  provider: { id: "opencode-routes-org_first", name: "First / Routes" },
  capabilities: { reasoning: false, input: { text: true, image: true, audio: false, video: false, pdf: false } },
  limit: { context: 200_000 },
}

test.each([false, true])("route tooltip keeps its organization identity and variable price (v2=%p)", (v2) => {
  const element = document.createElement("div")
  const dispose = render(() => createComponent(ModelTooltip, { model, free: true, v2 }), element)
  expect(element.textContent).toContain("First / Routes")
  expect(element.textContent).toContain("Claude coding (Variable)")
  expect(element.textContent).not.toContain("Anthropic")
  expect(element.textContent).not.toContain("Free")
  expect(element.textContent).not.toContain("200,000")
  expect(element.textContent).not.toContain(dict["model.tooltip.reasoning.none"])
  dispose()
})

test("ordinary model tooltips retain free pricing and capability details", () => {
  const element = document.createElement("div")
  const dispose = render(
    () =>
      createComponent(ModelTooltip, {
        model: { ...model, provider: { id: "opencode", name: "OpenCode Zen" } },
        free: true,
        v2: true,
      }),
    element,
  )
  expect(element.textContent).toContain("Claude coding (Free)")
  expect(element.textContent).toContain("OpenCode Zen")
  expect(element.textContent).toContain("200,000")
  expect(element.textContent).toContain(dict["model.tooltip.reasoning.none"])
  expect(element.textContent).not.toContain("Variable")
  dispose()
})
