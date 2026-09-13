import { json, action, useParams, createAsync, useSubmission } from "@solidjs/router"
import { createEffect, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { withActor } from "~/context/auth.withActor"
import { Billing } from "@opencode-ai/console-core/billing.js"
import { Database, eq } from "@opencode-ai/console-core/drizzle/index.js"
import { BillingTable } from "@opencode-ai/console-core/schema/billing.sql.js"
import styles from "./reload-section.module.css"
import { queryBillingInfo } from "../../common"
import { useI18n } from "~/context/i18n"
import { formError, formErrorReloadAmountMin, formErrorReloadTriggerMin, localizeError } from "~/lib/form-error"

const reload = action(async (form: FormData) => {
  "use server"
  const workspaceID = form.get("workspaceID") as string | null
  if (!workspaceID) return { error: formError.workspaceRequired }
  return json(await withActor(() => Billing.reload(), workspaceID), {
    revalidate: queryBillingInfo.key,
  })
}, "billing.reload")

const setReload = action(async (form: FormData) => {
  "use server"
  const workspaceID = form.get("workspaceID") as string | null
  if (!workspaceID) return { error: formError.workspaceRequired }
  const reloadValue = (form.get("reload") as string | null) === "true"
  const amountStr = form.get("reloadAmount") as string | null
  const triggerStr = form.get("reloadTrigger") as string | null

  const reloadAmount = amountStr && amountStr.trim() !== "" ? parseInt(amountStr) : null
  const reloadTrigger = triggerStr && triggerStr.trim() !== "" ? parseInt(triggerStr) : null

  if (reloadValue) {
    if (reloadAmount === null || reloadAmount < Billing.RELOAD_AMOUNT_MIN)
      return { error: formErrorReloadAmountMin(Billing.RELOAD_AMOUNT_MIN) }
    if (reloadTrigger === null || reloadTrigger < Billing.RELOAD_TRIGGER_MIN)
      return { error: formErrorReloadTriggerMin(Billing.RELOAD_TRIGGER_MIN) }
  }

  return json(
    await withActor(
      () =>
        Database.use((tx) =>
          tx
            .update(BillingTable)
            .set({
              reload: reloadValue,
              ...(reloadAmount !== null ? { reloadAmount } : {}),
              ...(reloadTrigger !== null ? { reloadTrigger } : {}),
              ...(reloadValue
                ? {
                    reloadError: null,
                    timeReloadError: null,
                  }
                : {}),
            })
            .where(eq(BillingTable.workspaceID, workspaceID)),
        ),
      workspaceID,
    ),
    { revalidate: queryBillingInfo.key },
  )
}, "billing.setReload")

export function ReloadSection() {
  const params = useParams()
  const i18n = useI18n()
  const billingInfo = createAsync(() => queryBillingInfo(params.id!))
  const setReloadSubmission = useSubmission(setReload)
  const reloadSubmission = useSubmission(reload)
  const [store, setStore] = createStore({
    show: false,
    reload: false,
    reloadAmount: "",
    reloadTrigger: "",
  })

  const processingFee = createMemo(() => {
    const reloadAmount = billingInfo()?.reloadAmount
    if (!reloadAmount) return "0.00"
    return (((reloadAmount + 0.3) / 0.956) * 0.044 + 0.3).toFixed(2)
  })

  createEffect(() => {
    if (!setReloadSubmission.pending && setReloadSubmission.result && !(setReloadSubmission.result as any).error) {
      setStore("show", false)
    }
  })

  function show() {
    while (true) {
      setReloadSubmission.clear()
      if (!setReloadSubmission.result) break
    }
    const info = billingInfo()!
    setStore("show", true)
    setStore("reload", true)
    setStore("reloadAmount", String(info.reloadAmount))
    setStore("reloadTrigger", String(info.reloadTrigger))
  }

  function hide() {
    setStore("show", false)
  }

  return (
    <section class={styles.root}>
      <div data-slot="section-title">
        <h2>{i18n.t("workspace.reload.title")}</h2>
        <div data-slot="title-row">
          <Show
            when={billingInfo()?.reload}
            fallback={
              <p>
                {i18n.t("workspace.reload.disabled.before")} <b>{i18n.t("workspace.reload.disabled.state")}</b>.{" "}
                {i18n.t("workspace.reload.disabled.after")}
              </p>
            }
          >
            <p>
              {i18n.t("workspace.reload.enabled.before")} <b>{i18n.t("workspace.reload.enabled.state")}</b>.{" "}
              {i18n.t("workspace.reload.enabled.middle")} <b>${billingInfo()?.reloadAmount}</b> (+${processingFee()}{" "}
              {i18n.t("workspace.reload.processingFee")}) {i18n.t("workspace.reload.enabled.after")}{" "}
              <b>${billingInfo()?.reloadTrigger}</b>.
            </p>
          </Show>
          <button data-color="primary" type="button" onClick={() => show()}>
            {billingInfo()?.reload ? i18n.t("workspace.reload.edit") : i18n.t("workspace.reload.enable")}
          </button>
        </div>
      </div>
      <Show when={store.show}>
        <form action={setReload} method="post" data-slot="create-form">
          <div data-slot="form-field">
            <label>
              <span data-slot="field-label">{i18n.t("workspace.reload.enableAutoReload")}</span>
              <div data-slot="toggle-container">
                <label data-slot="model-toggle-label">
                  <input
                    type="checkbox"
                    name="reload"
                    value="true"
                    checked={store.reload}
                    onChange={(e) => setStore("reload", e.currentTarget.checked)}
                  />
                  <span></span>
                </label>
              </div>
            </label>
          </div>

          <div data-slot="input-row">
            <div data-slot="input-field">
              <p>{i18n.t("workspace.reload.reloadAmount")}</p>
              <input
                data-component="input"
                name="reloadAmount"
                type="number"
                min={String(billingInfo()?.reloadAmountMin ?? "")}
                step="1"
                value={store.reloadAmount}
                onInput={(e) => setStore("reloadAmount", e.currentTarget.value)}
                placeholder={String(billingInfo()?.reloadAmount ?? "")}
                disabled={!store.reload}
              />
            </div>
            <div data-slot="input-field">
              <p>{i18n.t("workspace.reload.whenBalanceReaches")}</p>
              <input
                data-component="input"
                name="reloadTrigger"
                type="number"
                min={String(billingInfo()?.reloadTriggerMin ?? "")}
                step="1"
                value={store.reloadTrigger}
                onInput={(e) => setStore("reloadTrigger", e.currentTarget.value)}
                placeholder={String(billingInfo()?.reloadTrigger ?? "")}
                disabled={!store.reload}
              />
            </div>
          </div>

          <Show when={setReloadSubmission.result && (setReloadSubmission.result as any).error}>
            {(err: any) => <div data-slot="form-error">{localizeError(i18n.t, err())}</div>}
          </Show>
          <input type="hidden" name="workspaceID" value={params.id} />
          <div data-slot="form-actions">
            <button type="button" data-color="ghost" onClick={() => hide()}>
              {i18n.t("common.cancel")}
            </button>
            <button type="submit" data-color="primary" disabled={setReloadSubmission.pending}>
              {setReloadSubmission.pending ? i18n.t("workspace.reload.saving") : i18n.t("workspace.reload.save")}
            </button>
          </div>
        </form>
      </Show>
      <Show when={billingInfo()?.reloadError}>
        <div data-slot="section-content">
          <div data-slot="reload-error">
            <p>
              {i18n.t("workspace.reload.failedAt")}{" "}
              {billingInfo()?.timeReloadError!.toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
              })}
              . {i18n.t("workspace.reload.reason")}{" "}
              {localizeError(i18n.t, billingInfo()?.reloadError ?? undefined).replace(/\.$/, "")}.{" "}
              {i18n.t("workspace.reload.updatePaymentMethod")}
            </p>
            <form action={reload} method="post" data-slot="create-form">
              <input type="hidden" name="workspaceID" value={params.id} />
              <button data-color="ghost" type="submit" disabled={reloadSubmission.pending}>
                {reloadSubmission.pending ? i18n.t("workspace.reload.retrying") : i18n.t("workspace.reload.retry")}
              </button>
            </form>
          </div>
        </div>
      </Show>
    </section>
  )
}
