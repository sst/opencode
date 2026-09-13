import { Model } from "@opencode-ai/console-core/model.js"
import { query, action, useParams, createAsync, json } from "@solidjs/router"
import { createMemo, For, Show } from "solid-js"
import { withActor } from "~/context/auth.withActor"
import { ZenData } from "@opencode-ai/console-core/model.js"
import styles from "./model-section.module.css"
import { querySessionInfo } from "../common"
import {
  IconAlibaba,
  IconAnthropic,
  IconArcee,
  IconGemini,
  IconDeepSeek,
  IconMiniMax,
  IconMoonshotAI,
  IconNvidia,
  IconOpenAI,
  IconStealth,
  IconXai,
  IconXiaomi,
  IconZai,
} from "~/component/icon"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"
import { formError } from "~/lib/form-error"

const getModelLab = (modelId: string) => {
  if (modelId.startsWith("claude")) return "Anthropic"
  if (modelId.startsWith("gpt")) return "OpenAI"
  if (modelId.startsWith("gemini")) return "Google"
  if (modelId.startsWith("deepseek")) return "DeepSeek"
  if (modelId.startsWith("kimi")) return "Moonshot AI"
  if (modelId.startsWith("glm")) return "Z.ai"
  if (modelId.startsWith("qwen")) return "Alibaba"
  if (modelId.startsWith("minimax")) return "MiniMax"
  if (modelId.startsWith("grok")) return "xAI"
  if (modelId.startsWith("mimo")) return "Xiaomi"
  if (modelId.startsWith("nemotron")) return "NVIDIA"
  if (modelId.startsWith("trinity")) return "Arcee"
  return "Stealth"
}

const getModelsInfo = query(async (workspaceID: string) => {
  "use server"
  return withActor(async () => {
    return {
      all: Object.entries(ZenData.list("full").models)
        .filter(([id, _model]) => !["claude-3-5-haiku"].includes(id))
        .filter(([id, _model]) => !id.startsWith("alpha-"))
        .filter(([id, _model]) => !id.endsWith(":global"))
        .sort(([idA, modelA], [idB, modelB]) => {
          const priority = [
            "big-pickle",
            "claude",
            "gpt",
            "gemini",
            "deepseek",
            "glm",
            "kimi",
            "qwen",
            "grok",
            "minimax",
            "mimo",
          ]
          const getPriority = (id: string) => {
            const index = priority.findIndex((p) => id.startsWith(p))
            return index === -1 ? Infinity : index
          }
          const pA = getPriority(idA)
          const pB = getPriority(idB)
          if (pA !== pB) return pA - pB

          const modelAName = Array.isArray(modelA) ? modelA[0].name : modelA.name
          const modelBName = Array.isArray(modelB) ? modelB[0].name : modelB.name
          return modelAName.localeCompare(modelBName)
        })
        .map(([id, model]) => ({ id, name: Array.isArray(model) ? model[0].name : model.name })),
      disabled: await Model.listDisabled(),
    }
  }, workspaceID)
}, "model.info")

const updateModel = action(async (form: FormData) => {
  "use server"
  const model = form.get("model") as string | null
  if (!model) return { error: formError.modelRequired }
  const workspaceID = form.get("workspaceID") as string | null
  if (!workspaceID) return { error: formError.workspaceRequired }
  const enabled = (form.get("enabled") as string | null) === "true"
  return json(
    await withActor(async () => {
      if (enabled) {
        await Model.disable({ model })
      } else {
        await Model.enable({ model })
      }
    }, workspaceID),
    { revalidate: getModelsInfo.key },
  )
}, "model.toggle")

export function ModelSection() {
  const params = useParams()
  const i18n = useI18n()
  const language = useLanguage()
  const modelsInfo = createAsync(() => getModelsInfo(params.id!))
  const userInfo = createAsync(() => querySessionInfo(params.id!))

  const modelsWithLab = createMemo(() => {
    const info = modelsInfo()
    if (!info) return []
    return info.all.map((model) => ({
      ...model,
      lab: getModelLab(model.id),
    }))
  })
  return (
    <section class={styles.root}>
      <div data-slot="section-title">
        <h2>{i18n.t("workspace.models.title")}</h2>
        <p>
          {i18n.t("workspace.models.subtitle.beforeLink")}{" "}
          <a href={language.route("/docs/zen#pricing")}>{i18n.t("common.learnMore")}</a>.
        </p>
      </div>
      <div data-slot="models-list">
        <Show when={modelsInfo()}>
          <div data-slot="models-table">
            <table data-slot="models-table-element">
              <thead>
                <tr>
                  <th>{i18n.t("workspace.models.table.model")}</th>
                  <th></th>
                  <th>{i18n.t("workspace.models.table.enabled")}</th>
                </tr>
              </thead>
              <tbody>
                <For each={modelsWithLab()}>
                  {({ id, name, lab }) => {
                    const isEnabled = createMemo(() => !modelsInfo()!.disabled.includes(id))
                    return (
                      <tr data-slot="model-row" data-disabled={!isEnabled()}>
                        <td data-slot="model-name">
                          <div>
                            {(() => {
                              switch (lab) {
                                case "OpenAI":
                                  return <IconOpenAI width={16} height={16} />
                                case "Anthropic":
                                  return <IconAnthropic width={16} height={16} />
                                case "Google":
                                  return <IconGemini width={16} height={16} />
                                case "DeepSeek":
                                  return <IconDeepSeek width={16} height={16} />
                                case "Moonshot AI":
                                  return <IconMoonshotAI width={16} height={16} />
                                case "Z.ai":
                                  return <IconZai width={16} height={16} />
                                case "Alibaba":
                                  return <IconAlibaba width={16} height={16} />
                                case "xAI":
                                  return <IconXai width={16} height={16} />
                                case "MiniMax":
                                  return <IconMiniMax width={16} height={16} />
                                case "Xiaomi":
                                  return <IconXiaomi width={16} height={16} />
                                case "NVIDIA":
                                  return <IconNvidia width={16} height={16} />
                                case "Arcee":
                                  return <IconArcee width={16} height={16} />
                                default:
                                  return <IconStealth width={16} height={16} />
                              }
                            })()}
                            <span>{name}</span>
                          </div>
                        </td>
                        <td data-slot="model-lab">{lab}</td>
                        <td data-slot="model-toggle">
                          <form action={updateModel} method="post">
                            <input type="hidden" name="model" value={id} />
                            <input type="hidden" name="workspaceID" value={params.id} />
                            <input type="hidden" name="enabled" value={String(isEnabled())} />
                            <label data-slot="model-toggle-label">
                              <input
                                type="checkbox"
                                checked={isEnabled()}
                                disabled={!userInfo()?.isAdmin}
                                onChange={(e) => {
                                  const form = e.currentTarget.closest("form")
                                  if (form) form.requestSubmit()
                                }}
                              />
                              <span></span>
                            </label>
                          </form>
                        </td>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </div>
    </section>
  )
}
