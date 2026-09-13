export const LOCALES = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "it",
  "da",
  "ja",
  "pl",
  "ru",
  "uk",
  "ar",
  "no",
  "br",
  "th",
  "tr",
] as const

export type Locale = (typeof LOCALES)[number]

export const LOCALE_COOKIE = "oc_locale" as const
export const LOCALE_HEADER = "x-opencode-locale" as const

function fix(pathname: string) {
  if (pathname.startsWith("/")) return pathname
  return `/${pathname}`
}

const LABEL = {
  en: "English",
  zh: "简体中文",
  zht: "繁體中文",
  ko: "한국어",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  it: "Italiano",
  da: "Dansk",
  ja: "日本語",
  pl: "Polski",
  ru: "Русский",
  uk: "Українська",
  ar: "العربية",
  no: "Norsk",
  br: "Português (Brasil)",
  th: "ไทย",
  tr: "Türkçe",
} satisfies Record<Locale, string>

const TAG = {
  en: "en",
  zh: "zh-Hans",
  zht: "zh-Hant",
  ko: "ko",
  de: "de",
  es: "es",
  fr: "fr",
  it: "it",
  da: "da",
  ja: "ja",
  pl: "pl",
  ru: "ru",
  uk: "uk",
  ar: "ar",
  no: "no",
  br: "pt-BR",
  th: "th",
  tr: "tr",
} satisfies Record<Locale, string>

const DOCS = {
  en: "root",
  zh: "zh-cn",
  zht: "zh-tw",
  ko: "ko",
  de: "de",
  es: "es",
  fr: "fr",
  it: "it",
  da: "da",
  ja: "ja",
  pl: "pl",
  ru: "ru",
  uk: "uk",
  ar: "ar",
  no: "nb",
  br: "pt-br",
  th: "th",
  tr: "tr",
} satisfies Record<Locale, string>

const DOCS_SEGMENT = new Set([
  "ar",
  "bs",
  "da",
  "de",
  "es",
  "fr",
  "it",
  "ja",
  "ko",
  "nb",
  "pl",
  "pt-br",
  "ru",
  "th",
  "tr",
  "uk",
  "zh-cn",
  "zh-tw",
])

const DOCS_LOCALE = {
  ar: "ar",
  da: "da",
  de: "de",
  en: "en",
  es: "es",
  fr: "fr",
  it: "it",
  ja: "ja",
  ko: "ko",
  nb: "no",
  "pt-br": "br",
  root: "en",
  ru: "ru",
  th: "th",
  tr: "tr",
  uk: "uk",
  "zh-cn": "zh",
  "zh-tw": "zht",
} as const satisfies Record<string, Locale>

// Heading IDs from the localized Go documentation.
const GO_USAGE_LIMITS = {
  en: "usage-limits",
  zh: "使用限制",
  zht: "使用限制",
  ko: "사용-한도",
  de: "nutzungslimits",
  es: "límites-de-uso",
  fr: "limites-dutilisation",
  it: "limiti-di-utilizzo",
  da: "forbrugsgrænser",
  ja: "利用制限",
  pl: "limity-użycia",
  ru: "лимиты-использования",
  uk: "usage-limits",
  ar: "حدود-الاستخدام",
  no: "bruksgrenser",
  br: "limites-de-uso",
  th: "usage-limits",
  tr: "kullanım-limitleri",
} satisfies Record<Locale, string>

export function goUsageLimits(locale: Locale) {
  // No Ukrainian Go docs yet; the explicit English path overrides the locale cookie.
  if (locale === "uk") return "/docs/en/go/#usage-limits"
  return docs(locale, `/docs/go/#${GO_USAGE_LIMITS[locale]}`)
}

function suffix(pathname: string) {
  const index = pathname.search(/[?#]/)
  if (index === -1) {
    return {
      path: fix(pathname),
      suffix: "",
    }
  }

  return {
    path: fix(pathname.slice(0, index)),
    suffix: pathname.slice(index),
  }
}

export function docs(locale: Locale, pathname: string) {
  const value = DOCS[locale]
  const next = suffix(pathname)
  if (next.path !== "/docs" && next.path !== "/docs/" && !next.path.startsWith("/docs/")) {
    return `${next.path}${next.suffix}`
  }

  if (value === "root") {
    if (next.path === "/docs/en") return `/docs${next.suffix}`
    if (next.path === "/docs/en/") return `/docs/${next.suffix}`
    if (next.path.startsWith("/docs/en/")) return `/docs/${next.path.slice("/docs/en/".length)}${next.suffix}`
    return `${next.path}${next.suffix}`
  }

  if (next.path === "/docs") return `/docs/${value}${next.suffix}`
  if (next.path === "/docs/") return `/docs/${value}/${next.suffix}`

  const head = next.path.slice("/docs/".length).split("/")[0] ?? ""
  if (!head) return `/docs/${value}/${next.suffix}`
  if (DOCS_SEGMENT.has(head)) return `${next.path}${next.suffix}`
  if (head.startsWith("_")) return `${next.path}${next.suffix}`
  if (head.includes(".")) return `${next.path}${next.suffix}`

  return `/docs/${value}${next.path.slice("/docs".length)}${next.suffix}`
}

export function parseLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null
  if ((LOCALES as readonly string[]).includes(value)) return value as Locale
  return null
}

export function fromPathname(pathname: string) {
  return parseLocale(fix(pathname).split("/")[1])
}

export function fromDocsPathname(pathname: string) {
  const next = fix(pathname)
  const value = next.split("/")[2]?.toLowerCase()
  if (!value) return null
  if (!next.startsWith("/docs/")) return null
  if (!(value in DOCS_LOCALE)) return null
  return DOCS_LOCALE[value as keyof typeof DOCS_LOCALE]
}

export function strip(pathname: string) {
  const locale = fromPathname(pathname)
  if (!locale) return fix(pathname)

  const next = fix(pathname).slice(locale.length + 1)
  if (!next) return "/"
  if (next.startsWith("/")) return next
  return `/${next}`
}

export function route(locale: Locale, pathname: string) {
  const next = strip(pathname)
  if (next.startsWith("/docs")) return docs(locale, next)
  if (next.startsWith("/auth")) return next
  if (next.startsWith("/workspace")) return next
  if (locale === "en") return next
  if (next === "/") return `/${locale}`
  return `/${locale}${next}`
}

export function label(locale: Locale) {
  return LABEL[locale]
}

export function tag(locale: Locale) {
  return TAG[locale]
}

export function dir(locale: Locale) {
  if (locale === "ar") return "rtl"
  return "ltr"
}

function match(input: string): Locale | null {
  const value = input.trim().toLowerCase()
  if (!value) return null

  if (value.startsWith("zh")) {
    if (value.includes("hant") || value.includes("-tw") || value.includes("-hk") || value.includes("-mo")) return "zht"
    return "zh"
  }

  if (value.startsWith("ko")) return "ko"
  if (value.startsWith("de")) return "de"
  if (value.startsWith("es")) return "es"
  if (value.startsWith("fr")) return "fr"
  if (value.startsWith("it")) return "it"
  if (value.startsWith("da")) return "da"
  if (value.startsWith("ja")) return "ja"
  if (value.startsWith("pl")) return "pl"
  if (value.startsWith("ru")) return "ru"
  if (value.startsWith("uk")) return "uk"
  if (value.startsWith("ar")) return "ar"
  if (value.startsWith("tr")) return "tr"
  if (value.startsWith("th")) return "th"
  if (value.startsWith("pt")) return "br"
  if (value.startsWith("no") || value.startsWith("nb") || value.startsWith("nn")) return "no"
  if (value.startsWith("en")) return "en"
  return null
}

export function detectFromLanguages(languages: readonly string[]) {
  for (const language of languages) {
    const locale = match(language)
    if (locale) return locale
  }
  return "en" satisfies Locale
}

export function detectFromAcceptLanguage(header: string | null) {
  if (!header) return "en" satisfies Locale

  const items = header
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const parts = raw.split(";").map((x) => x.trim())
      const lang = parts[0] ?? ""
      const q = parts
        .slice(1)
        .find((x) => x.startsWith("q="))
        ?.slice(2)
      return {
        lang,
        q: q ? Number.parseFloat(q) : 1,
      }
    })
    .sort((a, b) => b.q - a.q)

  for (const item of items) {
    if (!item.lang || item.lang === "*") continue
    const locale = match(item.lang)
    if (locale) return locale
  }

  return "en" satisfies Locale
}

export function localeFromCookieHeader(header: string | null) {
  if (!header) return null

  const raw = header
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${LOCALE_COOKIE}=`))
    ?.slice(`${LOCALE_COOKIE}=`.length)

  if (!raw) return null
  return parseLocale(decodeURIComponent(raw))
}

export function localeFromRequest(request: Request) {
  const fromHeader = parseLocale(request.headers.get(LOCALE_HEADER))
  if (fromHeader) return fromHeader

  const fromPath = fromPathname(new URL(request.url).pathname)
  if (fromPath) return fromPath

  const fromDocsPath = fromDocsPathname(new URL(request.url).pathname)
  if (fromDocsPath) return fromDocsPath

  return (
    localeFromCookieHeader(request.headers.get("cookie")) ??
    detectFromAcceptLanguage(request.headers.get("accept-language"))
  )
}

export function cookie(locale: Locale) {
  return `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
}

export function clearCookie() {
  return `${LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}
