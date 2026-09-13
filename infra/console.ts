import { deployAws, domain } from "./stage"
import { EMAILOCTOPUS_API_KEY } from "./app"
import { SECRET } from "./secret"

const lake = deployAws ? await import("./lake") : undefined

////////////////
// DATABASE
////////////////

const cluster = planetscale.getDatabaseOutput({
  name: "opencode",
  organization: "anomalyco",
})

const branch =
  $app.stage === "production"
    ? planetscale.getBranchOutput({
        name: "production",
        organization: cluster.organization,
        database: cluster.name,
      })
    : new planetscale.Branch("DatabaseBranch", {
        database: cluster.name,
        organization: cluster.organization,
        name: $app.stage,
        parentBranch: "production",
      })
const password = new planetscale.Password("DatabasePassword", {
  name: $app.stage,
  database: cluster.name,
  organization: cluster.organization,
  branch: branch.name,
})

export const database = new sst.Linkable("Database", {
  properties: {
    host: password.accessHostUrl,
    database: cluster.name,
    username: password.username,
    password: password.plaintext,
    port: 3306,
  },
})

new sst.x.DevCommand("Studio", {
  link: [database],
  dev: {
    command: "bun db studio",
    directory: "packages/console/core",
    autostart: true,
  },
})

////////////////
// AUTH
////////////////

const GITHUB_CLIENT_ID_CONSOLE = new sst.Secret("GITHUB_CLIENT_ID_CONSOLE")
const GITHUB_CLIENT_SECRET_CONSOLE = new sst.Secret("GITHUB_CLIENT_SECRET_CONSOLE")
const GOOGLE_CLIENT_ID = new sst.Secret("GOOGLE_CLIENT_ID")
const authStorage = new sst.cloudflare.Kv("AuthStorage")
export const auth = new sst.cloudflare.Worker("AuthApi", {
  domain: `auth.${domain}`,
  handler: "packages/console/function/src/auth.ts",
  url: true,
  link: [database, authStorage, GITHUB_CLIENT_ID_CONSOLE, GITHUB_CLIENT_SECRET_CONSOLE, GOOGLE_CLIENT_ID],
})

////////////////
// GATEWAY
////////////////

export const stripeWebhook = new stripe.WebhookEndpoint("StripeWebhookEndpoint", {
  url: $interpolate`https://${domain}/stripe/webhook`,
  enabledEvents: [
    "checkout.session.async_payment_failed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.completed",
    "checkout.session.expired",
    "charge.refunded",
    "invoice.payment_succeeded",
    "invoice.payment_failed",
    "invoice.payment_action_required",
    "customer.created",
    "customer.deleted",
    "customer.updated",
    "customer.discount.created",
    "customer.discount.deleted",
    "customer.discount.updated",
    "customer.source.created",
    "customer.source.deleted",
    "customer.source.expiring",
    "customer.source.updated",
    "customer.subscription.created",
    "customer.subscription.deleted",
    "customer.subscription.paused",
    "customer.subscription.pending_update_applied",
    "customer.subscription.pending_update_expired",
    "customer.subscription.resumed",
    "customer.subscription.trial_will_end",
    "customer.subscription.updated",
  ],
})

const zenLiteProduct = new stripe.Product("ZenLite", {
  name: "OpenCode Go",
})
const zenLiteCouponFirstMonth50 = new stripe.Coupon("ZenLiteCouponFirstMonth50", {
  name: "First month 50% off",
  percentOff: 50,
  appliesToProducts: [zenLiteProduct.id],
  duration: "once",
})
const zenLiteCouponFirstMonth100 = new stripe.Coupon("ZenLiteCouponFirstMonth100", {
  name: "First month 100% off",
  percentOff: 100,
  appliesToProducts: [zenLiteProduct.id],
  duration: "once",
})
const zenLiteCouponThreeMonths100 = new stripe.Coupon("ZenLiteCoupon3Months100", {
  name: "3 months 100% off",
  percentOff: 100,
  appliesToProducts: [zenLiteProduct.id],
  duration: "repeating",
  durationInMonths: 3,
})
const zenLiteCouponSixMonths100 = new stripe.Coupon("ZenLiteCoupon6Months100", {
  name: "6 months 100% off",
  percentOff: 100,
  appliesToProducts: [zenLiteProduct.id],
  duration: "repeating",
  durationInMonths: 6,
})
const zenLiteCouponTwelveMonths100 = new stripe.Coupon("ZenLiteCoupon12Months100", {
  name: "12 months 100% off",
  percentOff: 100,
  appliesToProducts: [zenLiteProduct.id],
  duration: "repeating",
  durationInMonths: 12,
})
const zenLitePrice = new stripe.Price("ZenLitePrice", {
  product: zenLiteProduct.id,
  currency: "usd",
  recurring: {
    interval: "month",
    intervalCount: 1,
  },
  unitAmount: 1000,
})
const ZEN_LITE_PRICE = new sst.Linkable("ZEN_LITE_PRICE", {
  properties: {
    // Use existing Go resources in dev's checkout Stripe account.
    product: $app.stage === "dev" ? "prod_U1tUscpmwtV2bG" : zenLiteProduct.id,
    price: $app.stage === "dev" ? "price_1T3phhE7fOCwHSD4zS6w2NPy" : zenLitePrice.id,
    priceInr: 92900,
    firstMonth50Coupon: zenLiteCouponFirstMonth50.id,
    firstMonth100Coupon: zenLiteCouponFirstMonth100.id,
    threeMonths100Coupon: zenLiteCouponThreeMonths100.id,
    sixMonths100Coupon: zenLiteCouponSixMonths100.id,
    twelveMonths100Coupon: zenLiteCouponTwelveMonths100.id,
  },
})

const zenBlackProduct = new stripe.Product("ZenBlack", {
  name: "OpenCode Black",
})
const zenBlackPriceProps = {
  product: zenBlackProduct.id,
  currency: "usd",
  recurring: {
    interval: "month",
    intervalCount: 1,
  },
}
const zenBlackPrice200 = new stripe.Price("ZenBlackPrice", { ...zenBlackPriceProps, unitAmount: 20000 })
const zenBlackPrice100 = new stripe.Price("ZenBlack100Price", { ...zenBlackPriceProps, unitAmount: 10000 })
const zenBlackPrice20 = new stripe.Price("ZenBlack20Price", { ...zenBlackPriceProps, unitAmount: 2000 })
const ZEN_BLACK_PRICE = new sst.Linkable("ZEN_BLACK_PRICE", {
  properties: {
    product: zenBlackProduct.id,
    plan200: zenBlackPrice200.id,
    plan100: zenBlackPrice100.id,
    plan20: zenBlackPrice20.id,
  },
})

const ZEN_MODELS = [
  new sst.Secret("ZEN_MODELS1"),
  new sst.Secret("ZEN_MODELS2"),
  new sst.Secret("ZEN_MODELS3"),
  new sst.Secret("ZEN_MODELS4"),
  new sst.Secret("ZEN_MODELS5"),
  new sst.Secret("ZEN_MODELS6"),
  new sst.Secret("ZEN_MODELS7"),
  new sst.Secret("ZEN_MODELS8"),
  new sst.Secret("ZEN_MODELS9"),
  new sst.Secret("ZEN_MODELS10"),
  new sst.Secret("ZEN_MODELS11"),
  new sst.Secret("ZEN_MODELS12"),
  new sst.Secret("ZEN_MODELS13"),
  new sst.Secret("ZEN_MODELS14"),
  new sst.Secret("ZEN_MODELS15"),
  new sst.Secret("ZEN_MODELS16"),
  new sst.Secret("ZEN_MODELS17"),
  new sst.Secret("ZEN_MODELS18"),
  new sst.Secret("ZEN_MODELS19"),
  new sst.Secret("ZEN_MODELS20"),
  new sst.Secret("ZEN_MODELS21"),
  new sst.Secret("ZEN_MODELS22"),
  new sst.Secret("ZEN_MODELS23"),
  new sst.Secret("ZEN_MODELS24"),
  new sst.Secret("ZEN_MODELS25"),
  new sst.Secret("ZEN_MODELS26"),
  new sst.Secret("ZEN_MODELS27"),
  new sst.Secret("ZEN_MODELS28"),
  new sst.Secret("ZEN_MODELS29"),
  new sst.Secret("ZEN_MODELS30"),
]
const STRIPE_SECRET_KEY = new sst.Secret("STRIPE_SECRET_KEY")
const STRIPE_PUBLISHABLE_KEY = new sst.Secret("STRIPE_PUBLISHABLE_KEY")
const AUTH_API_URL = new sst.Linkable("AUTH_API_URL", {
  properties: { value: auth.url.apply((url) => url!) },
})
// Preview branches have independent databases; do not send their workspaces to shared dev.
const migrationDomain =
  $app.stage === "production" ? "opencode.ai" : $app.stage === "dev" ? "dev.opencode.ai" : undefined
const consoleMigration = new sst.Linkable("ConsoleMigration", {
  properties: {
    consoleUrl: migrationDomain ? `https://${migrationDomain}/console` : "",
    inferenceUrl: migrationDomain ? `https://${migrationDomain}/inference` : "",
  },
})
const STRIPE_WEBHOOK_SECRET = new sst.Linkable("STRIPE_WEBHOOK_SECRET", {
  properties: { value: stripeWebhook.secret },
})

////////////////
// CONSOLE
////////////////

const bucket = new sst.cloudflare.Bucket("ZenData")
const bucketNew = new sst.cloudflare.Bucket("ZenDataNew")

const DISCORD_INCIDENT_WEBHOOK_URL = new sst.Secret("DISCORD_INCIDENT_WEBHOOK_URL")
const AWS_SES_ACCESS_KEY_ID = new sst.Secret("AWS_SES_ACCESS_KEY_ID")
const AWS_SES_SECRET_ACCESS_KEY = new sst.Secret("AWS_SES_SECRET_ACCESS_KEY")
const ENTERPRISE_SALES_INBOX_EMAIL = new sst.Secret("ENTERPRISE_SALES_INBOX_EMAIL")

const SALESFORCE_CLIENT_ID = new sst.Secret("SALESFORCE_CLIENT_ID")
const SALESFORCE_CLIENT_SECRET = new sst.Secret("SALESFORCE_CLIENT_SECRET")
const SALESFORCE_INSTANCE_URL = new sst.Secret("SALESFORCE_INSTANCE_URL")

const logProcessor = new sst.cloudflare.Worker("LogProcessor", {
  handler: "packages/console/function/src/log-processor.ts",
  link: [SECRET.HoneycombApiKey, ...(lake?.lakeIngest ? [lake.lakeIngest] : [])],
})

new sst.cloudflare.x.SolidStart("Console", {
  domain,
  path: "packages/console/app",
  link: [
    bucket,
    bucketNew,
    database,
    SECRET.UpstashRedisRestUrl,
    SECRET.UpstashRedisRestToken,
    AUTH_API_URL,
    consoleMigration,
    STRIPE_WEBHOOK_SECRET,
    SECRET.SupportApiKey,
    DISCORD_INCIDENT_WEBHOOK_URL,
    SECRET.HoneycombWebhookSecret,
    STRIPE_SECRET_KEY,
    EMAILOCTOPUS_API_KEY,
    AWS_SES_ACCESS_KEY_ID,
    AWS_SES_SECRET_ACCESS_KEY,
    ENTERPRISE_SALES_INBOX_EMAIL,
    SALESFORCE_CLIENT_ID,
    SALESFORCE_CLIENT_SECRET,
    SALESFORCE_INSTANCE_URL,
    ZEN_BLACK_PRICE,
    ZEN_LITE_PRICE,
    new sst.Secret("ZEN_LIMITS"),
    new sst.Secret("ZEN_SESSION_SECRET"),
    ...ZEN_MODELS,
    ...($dev
      ? [
          new sst.Secret("CLOUDFLARE_DEFAULT_ACCOUNT_ID", process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID!),
          new sst.Secret("CLOUDFLARE_API_TOKEN", process.env.CLOUDFLARE_API_TOKEN!),
        ]
      : []),
  ],
  environment: {
    //VITE_DOCS_URL: web.url.apply((url) => url!),
    //VITE_API_URL: gateway.url.apply((url) => url!),
    VITE_AUTH_URL: auth.url.apply((url) => url!),
    VITE_STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY.value,
  },
  transform: {
    server: {
      placement: { region: "aws:us-east-2" },
      transform: {
        worker: (args) => {
          args.compatibilityFlags = $resolve(args.compatibilityFlags).apply((flags) => [
            ...(flags ?? []),
            "global_fetch_strictly_public",
          ])
          args.tailConsumers = [{ service: logProcessor.nodes.worker.scriptName }]
        },
      },
    },
  },
})

////////////////
// HELPERS
////////////////

export const stat = new sst.cloudflare.Worker("Stat", {
  handler: "packages/console/function/src/stat.ts",
  link: [database],
  url: true,
})
