import { action, useParams, useAction, useSubmission, json, query, createAsync } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Modal } from "~/component/modal"
import { Billing } from "@opencode-ai/console-core/billing.js"
import { Database, eq, and, gte, isNull, sql } from "@opencode-ai/console-core/drizzle/index.js"
import { BillingTable, LiteTable, UsageTable } from "@opencode-ai/console-core/schema/billing.sql.js"
import { KeyTable } from "@opencode-ai/console-core/schema/key.sql.js"
import { WorkspaceTable } from "@opencode-ai/console-core/schema/workspace.sql.js"
import { Actor } from "@opencode-ai/console-core/actor.js"
import { Workspace } from "@opencode-ai/console-core/workspace.js"
import { Subscription } from "@opencode-ai/console-core/subscription.js"
import { LiteData } from "@opencode-ai/console-core/lite.js"
import { ZenData } from "@opencode-ai/console-core/model.js"
import { getMonthlyBounds, getWeekBounds } from "@opencode-ai/console-core/util/date.js"
import { centsToMicroCents } from "@opencode-ai/console-core/util/price.js"
import { withActor } from "~/context/auth.withActor"
import { queryBillingInfo } from "../../common"
import styles from "./lite-section.module.css"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"
import { formError } from "~/lib/form-error"
import { formatResetTime, liteResetTimeKeys } from "~/lib/format-reset-time"
import { createReferralFromCookie } from "~/lib/referral-invite"
import { getRequestEvent } from "solid-js/web"
import { countryFromRequest } from "~/lib/request-country"
import { checkCheckoutRateLimit } from "~/routes/zen/util/redis"

import { IconAlipay, IconChevron, IconUpi } from "~/component/icon"
import { buildLiteUsageBreakdown, getModelQuotaLimit, getUsagePercent } from "~/lib/lite-usage"

type LiteUsageWindow = "rolling" | "weekly" | "monthly"

export const queryLiteSubscription = query(async (workspaceID: string) => {
  "use server"
  return withActor(async () => {
    const row = await Database.use((tx) =>
      tx
        .select({
          userID: LiteTable.userID,
          rollingUsage: LiteTable.rollingUsage,
          weeklyUsage: LiteTable.weeklyUsage,
          monthlyUsage: LiteTable.monthlyUsage,
          timeRollingUpdated: LiteTable.timeRollingUpdated,
          timeWeeklyUpdated: LiteTable.timeWeeklyUpdated,
          timeMonthlyUpdated: LiteTable.timeMonthlyUpdated,
          timeCreated: LiteTable.timeCreated,
          lite: BillingTable.lite,
          region: WorkspaceTable.region,
          allowTraining: WorkspaceTable.allow_training,
        })
        .from(BillingTable)
        .innerJoin(LiteTable, eq(LiteTable.workspaceID, BillingTable.workspaceID))
        .innerJoin(WorkspaceTable, eq(WorkspaceTable.id, BillingTable.workspaceID))
        .where(and(eq(LiteTable.workspaceID, Actor.workspace()), isNull(LiteTable.timeDeleted)))
        .then((r) => r[0]),
    )
    if (!row) return null

    const limits = LiteData.getLimits()
    const mine = row.userID === Actor.userID()
    const now = new Date()
    const rollingCutoff = new Date(now.getTime() - limits.rollingWindow * 3600 * 1000)
    const week = getWeekBounds(now)
    const month = getMonthlyBounds(now, row.timeCreated)
    const rollingActive = !!row.timeRollingUpdated && row.timeRollingUpdated >= rollingCutoff
    const weeklyActive = !!row.timeWeeklyUpdated && row.timeWeeklyUpdated >= week.start
    const monthlyActive = !!row.timeMonthlyUpdated && row.timeMonthlyUpdated >= month.start
    const rollingLimit = centsToMicroCents(limits.rollingLimit * 100)
    const weeklyLimit = centsToMicroCents(limits.weeklyLimit * 100)
    const monthlyLimit = centsToMicroCents(limits.monthlyLimit * 100)
    const rollingUsage = Subscription.analyzeRollingUsage({
      limit: limits.rollingLimit,
      window: limits.rollingWindow,
      usage: row.rollingUsage ?? 0,
      timeUpdated: row.timeRollingUpdated ?? now,
    })
    const weeklyUsage = Subscription.analyzeWeeklyUsage({
      limit: limits.weeklyLimit,
      usage: row.weeklyUsage ?? 0,
      timeUpdated: row.timeWeeklyUpdated ?? now,
    })
    const monthlyUsage = Subscription.analyzeMonthlyUsage({
      limit: limits.monthlyLimit,
      usage: row.monthlyUsage ?? 0,
      timeUpdated: row.timeMonthlyUpdated ?? now,
      timeSubscribed: row.timeCreated,
    })

    return {
      mine,
      useBalance: row.lite?.useBalance ?? false,
      allowTraining: row.allowTraining ?? false,
      region:
        row.region ?? (await Workspace.setDefaultRegion({ country: countryFromRequest(getRequestEvent()?.request) })),
      rollingUsage: {
        ...rollingUsage,
        usage: rollingActive ? (row.rollingUsage ?? 0) : 0,
        limit: rollingLimit,
        usagePercent: getUsagePercent(rollingActive ? (row.rollingUsage ?? 0) : 0, rollingLimit),
      },
      weeklyUsage: {
        ...weeklyUsage,
        usage: weeklyActive ? (row.weeklyUsage ?? 0) : 0,
        limit: weeklyLimit,
        usagePercent: getUsagePercent(weeklyActive ? (row.weeklyUsage ?? 0) : 0, weeklyLimit),
      },
      monthlyUsage: {
        ...monthlyUsage,
        usage: monthlyActive ? (row.monthlyUsage ?? 0) : 0,
        limit: monthlyLimit,
        usagePercent: getUsagePercent(monthlyActive ? (row.monthlyUsage ?? 0) : 0, monthlyLimit),
      },
    }
  }, workspaceID)
}, "lite.subscription.get")

export const queryLiteUsageDetails = query(async (workspaceID: string, window: LiteUsageWindow) => {
  "use server"
  return withActor(async () => {
    if (window !== "rolling" && window !== "weekly" && window !== "monthly") return null
    const row = await Database.use((tx) =>
      tx
        .select({
          userID: LiteTable.userID,
          rollingUsage: LiteTable.rollingUsage,
          weeklyUsage: LiteTable.weeklyUsage,
          monthlyUsage: LiteTable.monthlyUsage,
          timeRollingUpdated: LiteTable.timeRollingUpdated,
          timeWeeklyUpdated: LiteTable.timeWeeklyUpdated,
          timeMonthlyUpdated: LiteTable.timeMonthlyUpdated,
          timeCreated: LiteTable.timeCreated,
        })
        .from(LiteTable)
        .where(and(eq(LiteTable.workspaceID, Actor.workspace()), isNull(LiteTable.timeDeleted)))
        .then((result) => result[0]),
    )
    if (!row || row.userID !== Actor.userID()) return null

    const limits = LiteData.getLimits()
    const now = new Date()
    const detail = (() => {
      if (window === "rolling") {
        const active =
          !!row.timeRollingUpdated &&
          row.timeRollingUpdated >= new Date(now.getTime() - limits.rollingWindow * 3600 * 1000)
        return {
          start: active ? row.timeRollingUpdated! : now,
          usage: active ? (row.rollingUsage ?? 0) : 0,
          limit: centsToMicroCents(limits.rollingLimit * 100),
        }
      }
      if (window === "weekly") {
        const start = getWeekBounds(now).start
        return {
          start,
          usage: row.timeWeeklyUpdated && row.timeWeeklyUpdated >= start ? (row.weeklyUsage ?? 0) : 0,
          limit: centsToMicroCents(limits.weeklyLimit * 100),
        }
      }
      const start = getMonthlyBounds(now, row.timeCreated).start
      return {
        start,
        usage: row.timeMonthlyUpdated && row.timeMonthlyUpdated >= start ? (row.monthlyUsage ?? 0) : 0,
        limit: centsToMicroCents(limits.monthlyLimit * 100),
      }
    })()
    const modelData = Object.fromEntries(
      Object.entries(ZenData.list("lite").models).map(([id, value]) => {
        const models = Array.isArray(value) ? value : [value]
        const multipliers = new Set(models.map((model) => model.costMultiplier))
        return [id, { name: models[0].name, multiplier: multipliers.size === 1 ? models[0].costMultiplier : undefined }]
      }),
    )
    const usageRows = await Database.use((tx) =>
      tx
        .select({
          model: UsageTable.model,
          multiplier: sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(${UsageTable.enrichment}, '$.costMultiplier'))`,
          cost: sql<string>`SUM(${UsageTable.cost})`,
          quotaCost: sql<string>`SUM(CASE WHEN JSON_EXTRACT(${UsageTable.enrichment}, '$.costMultiplier') IS NOT NULL THEN ROUND(${UsageTable.cost} * CAST(JSON_UNQUOTE(JSON_EXTRACT(${UsageTable.enrichment}, '$.costMultiplier')) AS DECIMAL(20, 8))) ELSE 0 END)`,
        })
        .from(UsageTable)
        .innerJoin(KeyTable, and(eq(KeyTable.id, UsageTable.keyID), eq(KeyTable.workspaceID, UsageTable.workspaceID)))
        .where(
          and(
            eq(UsageTable.workspaceID, Actor.workspace()),
            eq(KeyTable.userID, row.userID),
            gte(UsageTable.timeCreated, detail.start),
            sql`JSON_UNQUOTE(JSON_EXTRACT(${UsageTable.enrichment}, '$.plan')) = 'lite'`,
          ),
        )
        .groupBy(UsageTable.model, sql`JSON_UNQUOTE(JSON_EXTRACT(${UsageTable.enrichment}, '$.costMultiplier'))`),
    )

    return buildLiteUsageBreakdown({
      usage: detail.usage,
      limit: detail.limit,
      sources: usageRows.map((usage) => {
        const cost = Number(usage.cost)
        const info = modelData[usage.model]
        const multiplier = usage.multiplier === null ? info?.multiplier : Number(usage.multiplier)
        return {
          model: usage.model,
          name: info?.name ?? usage.model,
          cost,
          quotaCost: usage.multiplier === null ? Math.round(cost * (multiplier ?? 1)) : Number(usage.quotaCost),
          multiplier,
          estimated: usage.multiplier === null,
        }
      }),
    })
  }, workspaceID)
}, "lite.subscription.usage")

type LiteSubscription = Awaited<ReturnType<typeof queryLiteSubscription>>

const createLiteCheckoutUrl = action(
  async (workspaceID: string, successUrl: string, cancelUrl: string, method?: "alipay" | "upi") => {
    "use server"
    return json(
      await withActor(async () => {
        await checkCheckoutRateLimit(Actor.account())
        const data = await Billing.generateLiteCheckoutUrl({ successUrl, cancelUrl, method })
        await createReferralFromCookie()
        return { error: undefined, data }
      }, workspaceID).catch((e) => ({
        error: e.message as string,
        data: undefined,
      })),
      { revalidate: [queryBillingInfo.key, queryLiteSubscription.key] },
    )
  },
  "liteCheckoutUrl",
)

const createSessionUrl = action(async (workspaceID: string, returnUrl: string) => {
  "use server"
  return json(
    await withActor(
      () =>
        Billing.generateSessionUrl({ returnUrl })
          .then((data) => ({ error: undefined, data }))
          .catch((e) => ({
            error: e.message as string,
            data: undefined,
          })),
      workspaceID,
    ),
    { revalidate: [queryBillingInfo.key, queryLiteSubscription.key] },
  )
}, "liteSessionUrl")

const setLiteUseBalance = action(async (form: FormData) => {
  "use server"
  const workspaceID = form.get("workspaceID") as string | null
  if (!workspaceID) return { error: formError.workspaceRequired }
  const useBalance = (form.get("useBalance") as string | null) === "true"

  return json(
    await withActor(async () => {
      await Database.use((tx) =>
        tx
          .update(BillingTable)
          .set({
            lite: useBalance ? { useBalance: true } : {},
          })
          .where(eq(BillingTable.workspaceID, workspaceID)),
      )
      return { error: undefined }
    }, workspaceID).catch((e) => ({ error: e.message as string })),
    { revalidate: [queryBillingInfo.key, queryLiteSubscription.key] },
  )
}, "setLiteUseBalance")

const setGoProviderRouting = action(async (form: FormData) => {
  "use server"
  const workspaceID = form.get("workspaceID") as string | null
  if (!workspaceID) return { error: formError.workspaceRequired }
  const useChinaProviders = (form.get("useChinaProviders") as string | null) === "true"

  return json(
    await withActor(
      () =>
        Workspace.update({ region: useChinaProviders ? ["us", "eu", "sg"] : ["us", "eu", "sg", "cn"] })
          .then(() => ({ error: undefined }))
          .catch((e) => ({ error: e.message as string })),
      workspaceID,
    ),
    { revalidate: queryLiteSubscription.key },
  )
}, "go.providerRouting.set")

const setGoAllowTraining = action(async (form: FormData) => {
  "use server"
  const workspaceID = form.get("workspaceID") as string | null
  if (!workspaceID) return { error: formError.workspaceRequired }
  const allowTraining = (form.get("allowTraining") as string | null) === "true"

  return json(
    await withActor(
      () =>
        Workspace.update({ allow_training: allowTraining })
          .then(() => ({ error: undefined }))
          .catch((e) => ({ error: e.message as string })),
      workspaceID,
    ),
    { revalidate: queryLiteSubscription.key },
  )
}, "go.allowTraining.set")

type LiteUsage = NonNullable<LiteSubscription>["rollingUsage"]
type LiteUsageDetailsData = NonNullable<Awaited<ReturnType<typeof queryLiteUsageDetails>>>

function LiteUsageItem(props: {
  id: LiteUsageWindow
  label: string
  usage: LiteUsage
  open: boolean
  onToggle: () => void
}) {
  const i18n = useI18n()

  return (
    <div data-slot="usage-item">
      <div data-slot="usage-header">
        <span data-slot="usage-label">{props.label}</span>
        <span data-slot="usage-value">{props.usage.usagePercent}%</span>
      </div>
      <div
        data-slot="progress"
        role="progressbar"
        aria-label={props.label}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.min(100, props.usage.usagePercent)}
      >
        <div data-slot="progress-bar" style={{ width: `${Math.min(100, props.usage.usagePercent)}%` }} />
      </div>
      <span data-slot="reset-time">
        {i18n.t("workspace.lite.subscription.resetsIn")}{" "}
        {formatResetTime(props.usage.resetInSec, i18n, liteResetTimeKeys)}
      </span>
      <Show when={props.usage.usage > 0}>
        <div data-slot="usage-details">
          <button
            type="button"
            data-slot="usage-details-trigger"
            aria-expanded={props.open}
            aria-controls={`usage-details-${props.id}`}
            onClick={props.onToggle}
          >
            <span data-slot="show-details">{i18n.t("workspace.lite.subscription.showDetails")}</span>
            <span data-slot="hide-details">{i18n.t("workspace.lite.subscription.hideDetails")}</span>
            <IconChevron />
          </button>
        </div>
      </Show>
    </div>
  )
}

function LiteUsageDetails(props: {
  id: LiteUsageWindow
  label: string
  quotaLabel: string
  usage: LiteUsageDetailsData
}) {
  const i18n = useI18n()
  const language = useLanguage()
  const money = (amount: number) =>
    new Intl.NumberFormat(language.tag(language.locale()), {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(amount / 100_000_000)
  const totalPercentage = () =>
    Number(props.usage.rows.reduce((total, row) => total + row.contributionPercent, 0).toFixed(1))

  return (
    <div id={`usage-details-${props.id}`} data-slot="usage-details-content" role="region" aria-label={props.label}>
      <div data-slot="usage-details-table">
        <table>
          <thead>
            <tr>
              <th>{i18n.t("workspace.lite.subscription.model")}</th>
              <th>{props.label}</th>
              <th>{props.quotaLabel}</th>
              <th>{i18n.t("workspace.lite.subscription.contribution")}</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.usage.rows}>
              {(row) => {
                const quota = getModelQuotaLimit(props.usage.limit, row.multiplier)
                return (
                  <tr>
                    <td>
                      <bdi dir="auto">{row.name}</bdi>
                    </td>
                    <td>{row.cost === undefined ? "-" : money(row.cost)}</td>
                    <td>{quota === undefined ? "-" : money(quota)}</td>
                    <td>{row.contributionPercent}%</td>
                  </tr>
                )
              }}
            </For>
            <tr data-slot="usage-total">
              <td colSpan={3}>{i18n.t("workspace.lite.subscription.total")}</td>
              <td>{totalPercentage()}%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

function LiteUsageGroup(props: { lite: NonNullable<LiteSubscription> }) {
  const params = useParams()
  const i18n = useI18n()
  const [open, setOpen] = createSignal<LiteUsageWindow>()
  const [store, setStore] = createStore({
    details: {} as Partial<Record<LiteUsageWindow, LiteUsageDetailsData | null>>,
    loading: undefined as LiteUsageWindow | undefined,
  })
  const items = () =>
    [
      {
        id: "rolling",
        label: i18n.t("workspace.lite.subscription.rollingUsage"),
        quotaLabel: i18n.t("workspace.lite.subscription.rollingQuota"),
        usage: props.lite.rollingUsage,
      },
      {
        id: "weekly",
        label: i18n.t("workspace.lite.subscription.weeklyUsage"),
        quotaLabel: i18n.t("workspace.lite.subscription.weeklyQuota"),
        usage: props.lite.weeklyUsage,
      },
      {
        id: "monthly",
        label: i18n.t("workspace.lite.subscription.monthlyUsage"),
        quotaLabel: i18n.t("workspace.lite.subscription.monthlyQuota"),
        usage: props.lite.monthlyUsage,
      },
    ] as const
  const selected = createMemo(() => items().find((item) => item.id === open()))

  async function toggle(id: LiteUsageWindow) {
    if (open() === id) {
      setOpen()
      return
    }
    setOpen(id)
    if (store.details[id] !== undefined) return
    setStore("loading", id)
    const details = await queryLiteUsageDetails(params.id!, id).catch(() => null)
    setStore("details", id, details)
    setStore("loading", (current) => (current === id ? undefined : current))
  }

  return (
    <>
      <div data-slot="usage">
        <For each={items()}>
          {(item) => (
            <LiteUsageItem
              id={item.id}
              label={item.label}
              usage={item.usage}
              open={open() === item.id}
              onToggle={() => toggle(item.id)}
            />
          )}
        </For>
      </div>
      <Show when={selected()}>
        {(item) => {
          const details = () => store.details[item().id]
          return (
            <Show
              when={details()}
              fallback={
                <Show when={store.loading === item().id}>
                  <div data-slot="usage-details-loading">{i18n.t("workspace.lite.loading")}</div>
                </Show>
              }
            >
              {(usage) => (
                <LiteUsageDetails id={item().id} label={item().label} quotaLabel={item().quotaLabel} usage={usage()} />
              )}
            </Show>
          )
        }}
      </Show>
    </>
  )
}

export function LiteSection(props: { lite: LiteSubscription | undefined }) {
  const params = useParams()
  const i18n = useI18n()
  const language = useLanguage()
  const billingInfo = createAsync(() => queryBillingInfo(params.id!))
  const isBlack = createMemo(() => billingInfo()?.subscriptionID || billingInfo()?.timeSubscriptionBooked)
  const sessionAction = useAction(createSessionUrl)
  const sessionSubmission = useSubmission(createSessionUrl)
  const checkoutAction = useAction(createLiteCheckoutUrl)
  const checkoutSubmission = useSubmission(createLiteCheckoutUrl)
  const useBalanceSubmission = useSubmission(setLiteUseBalance)
  const providerRoutingSubmission = useSubmission(setGoProviderRouting)
  const allowTrainingSubmission = useSubmission(setGoAllowTraining)
  const [store, setStore] = createStore({
    loading: undefined as undefined | "session" | "checkout" | "alipay" | "upi",
    showModal: false,
  })

  const busy = createMemo(() => !!store.loading)

  async function onClickSession() {
    setStore("loading", "session")
    const result = await sessionAction(params.id!, window.location.href)
    if (result.data) {
      window.location.href = result.data
      return
    }
    setStore("loading", undefined)
  }

  async function onClickSubscribe(method?: "alipay" | "upi") {
    setStore("loading", method ?? "checkout")
    const result = await checkoutAction(params.id!, window.location.href, window.location.href, method)
    if (result.data) {
      window.location.href = result.data
      return
    }
    setStore("loading", undefined)
  }

  return (
    <>
      <Show when={isBlack()}>
        <section class={styles.root}>
          <p data-slot="other-message">{i18n.t("workspace.lite.black.message")}</p>
        </section>
      </Show>
      <Show when={!isBlack() && props.lite && props.lite.mine && props.lite}>
        {(sub) => (
          <section class={styles.root}>
            <div data-slot="section-title">
              <div data-slot="title-row">
                <p>{i18n.t("workspace.lite.subscription.message")}</p>
                <button data-color="primary" disabled={sessionSubmission.pending || busy()} onClick={onClickSession}>
                  {store.loading === "session"
                    ? i18n.t("workspace.lite.loading")
                    : i18n.t("workspace.lite.subscription.manage")}
                </button>
              </div>
            </div>
            <div data-slot="beta-notice">
              {i18n.t("workspace.lite.subscription.selectProvider")}{" "}
              <a href={language.route("/docs/providers/#opencode-go")} target="_blank" rel="noopener noreferrer">
                {i18n.t("common.learnMore")}
              </a>
              .
            </div>
            <LiteUsageGroup lite={sub()} />
            <form action={setLiteUseBalance} method="post" data-slot="setting-row">
              <p>{i18n.t("workspace.lite.subscription.useBalance")}</p>
              <input type="hidden" name="workspaceID" value={params.id} />
              <input type="hidden" name="useBalance" value={sub().useBalance ? "false" : "true"} />
              <label data-slot="toggle-label">
                <input
                  type="checkbox"
                  checked={sub().useBalance}
                  disabled={useBalanceSubmission.pending}
                  onChange={(e) => e.currentTarget.form?.requestSubmit()}
                />
                <span></span>
              </label>
            </form>
            <div data-slot="providers-section">
              <div data-slot="providers-header">
                <h3>{i18n.t("workspace.lite.providers.title")}</h3>
                <p>{i18n.t("workspace.lite.providers.description")}</p>
              </div>
              <form action={setGoAllowTraining} method="post" data-slot="setting-row">
                <p>{i18n.t("workspace.lite.providers.allowTraining")}</p>
                <input type="hidden" name="workspaceID" value={params.id} />
                <input type="hidden" name="allowTraining" value={sub().allowTraining ? "false" : "true"} />
                <label data-slot="toggle-label">
                  <input
                    type="checkbox"
                    checked={sub().allowTraining}
                    disabled={allowTrainingSubmission.pending}
                    onChange={(e) => e.currentTarget.form?.requestSubmit()}
                  />
                  <span></span>
                </label>
              </form>
              <form action={setGoProviderRouting} method="post" data-slot="setting-row">
                <p>{i18n.t("workspace.lite.providers.useChina")}</p>
                <input type="hidden" name="workspaceID" value={params.id} />
                <input type="hidden" name="useChinaProviders" value={sub().region.includes("cn") ? "true" : "false"} />
                <label data-slot="toggle-label">
                  <input
                    type="checkbox"
                    checked={sub().region.includes("cn")}
                    disabled={providerRoutingSubmission.pending}
                    onChange={(e) => e.currentTarget.form?.requestSubmit()}
                  />
                  <span></span>
                </label>
              </form>
            </div>
          </section>
        )}
      </Show>
      <Show when={!isBlack() && props.lite && !props.lite.mine}>
        <section class={styles.root}>
          <p data-slot="other-message">{i18n.t("workspace.lite.other.message")}</p>
        </section>
      </Show>
      <Show when={!isBlack() && props.lite === null}>
        <section class={styles.root}>
          <p data-slot="promo-description">
            <For
              each={i18n
                .t("workspace.lite.promo.description")
                .split(/(\{\{price\}\})/g)
                .filter(Boolean)}
            >
              {(part) => {
                if (part === "{{price}}") return <strong>{i18n.t("workspace.lite.promo.price")}</strong>
                return part
              }}
            </For>
          </p>
          <h3 data-slot="promo-models-title">{i18n.t("workspace.lite.promo.modelsTitle")}</h3>
          <ul data-slot="promo-models">
            <li>Grok 4.6</li>
            <li>GPT 5.6 Luna</li>
            <li>GLM-5.3-Flash</li>
            <li>GLM-5.3</li>
            <li>GLM-5.2</li>
            <li>GLM-5.1</li>
            <li>Kimi K3</li>
            <li>Kimi K2.7 Code</li>
            <li>Kimi K2.6</li>
            <li>LongCat-2.0</li>
            <li>MiniMax M3</li>
            <li>MiniMax M2.7</li>
            <li>Muse Spark 1.3 Contributor</li>
            <li>Muse Spark 1.2 Contributor</li>
            <li>Qwen3.8 Max</li>
            <li>Qwen3.8 Flash</li>
            <li>Qwen3.7 Max</li>
            <li>Qwen3.7 Plus</li>
            <li>Qwen3.6 Plus</li>
            <li>DeepSeek V4.1 Flash — {i18n.t("go.graph.bonus", { count: 4 })}</li>
            <li>DeepSeek V4 Pro</li>
            <li>DeepSeek V4 Flash</li>
            <li>DeepSeek V4 Flash Vision Exp</li>
            <li>MiMo-V2.5</li>
            <li>MiMo-V2.5-Pro</li>
            <li>Hy4 preview</li>
            <li>Hy3</li>
          </ul>
          <p data-slot="promo-description">{i18n.t("go.promo.deepseek")}</p>
          <p data-slot="promo-description">{i18n.t("workspace.lite.promo.footer")}</p>
          <div data-slot="subscribe-actions">
            <button
              data-slot="subscribe-button"
              data-color="primary"
              disabled={checkoutSubmission.pending || busy()}
              onClick={() => onClickSubscribe()}
            >
              {store.loading === "checkout"
                ? i18n.t("workspace.lite.promo.subscribing")
                : i18n.t("workspace.lite.promo.subscribe")}
            </button>
            <button
              type="button"
              data-slot="other-methods"
              data-color="ghost"
              onClick={() => setStore("showModal", true)}
            >
              <span>{i18n.t("workspace.lite.promo.otherMethods")}</span>
              <span data-slot="other-methods-icons">
                <span> </span>
                <IconAlipay style={{ width: "16px", height: "16px" }} />
                <span> </span>
                <IconUpi style={{ width: "auto", height: "10px" }} />
              </span>
            </button>
          </div>
          <Modal
            open={store.showModal}
            onClose={() => setStore("showModal", false)}
            title={i18n.t("workspace.lite.promo.selectMethod")}
          >
            <div class={styles.paymentMethodModal}>
              <div data-slot="modal-actions">
                <button
                  type="button"
                  data-slot="method-button"
                  data-color="ghost"
                  disabled={checkoutSubmission.pending || busy()}
                  onClick={() => onClickSubscribe("alipay")}
                >
                  <Show when={store.loading !== "alipay"}>
                    <IconAlipay style={{ width: "24px", height: "24px" }} />
                  </Show>
                  {store.loading === "alipay" ? i18n.t("workspace.lite.promo.subscribing") : "Alipay"}
                </button>
                <button
                  type="button"
                  data-slot="method-button"
                  data-color="ghost"
                  disabled={checkoutSubmission.pending || busy()}
                  onClick={() => onClickSubscribe("upi")}
                >
                  <Show when={store.loading !== "upi"}>
                    <IconUpi style={{ width: "auto", height: "16px" }} />
                  </Show>
                  {store.loading === "upi" ? i18n.t("workspace.lite.promo.subscribing") : "UPI"}
                </button>
              </div>
            </div>
          </Modal>
        </section>
      </Show>
    </>
  )
}
