export const DESKTOP_NATIVE_LOCALES = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "uk",
  "bs",
  "ar",
  "he",
  "no",
  "br",
  "th",
  "tr",
  "hi",
  "nl",
  "id",
  "vi",
  "it",
  "ur",
  "pa",
  "az",
  "fi",
  "sv",
  "am",
  "bg",
  "bn",
  "ca",
  "cs",
  "dv",
  "dz",
  "el",
  "et",
  "fa",
  "fo",
  "hr",
  "hu",
  "hy",
  "is",
  "ka",
  "km",
  "lo",
  "lt",
  "lv",
  "mk",
  "mn",
  "ms",
  "my",
  "ne",
  "ro",
  "si",
  "sk",
  "sl",
  "sq",
  "sr",
  "tg",
  "tk",
  "uz",
] as const

export type DesktopNativeLocale = (typeof DESKTOP_NATIVE_LOCALES)[number]

export const DESKTOP_NATIVE_LABELS: Record<DesktopNativeLocale, string> = {
  en: "English",
  zh: "简体中文",
  zht: "繁體中文",
  ko: "한국어",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  da: "Dansk",
  ja: "日本語",
  pl: "Polski",
  ru: "Русский",
  uk: "Українська",
  bs: "Bosanski",
  ar: "العربية",
  he: "עברית",
  no: "Norsk",
  br: "Português (Brasil)",
  th: "ไทย",
  tr: "Türkçe",
  hi: "हिन्दी",
  nl: "Nederlands",
  id: "Bahasa Indonesia",
  vi: "Tiếng Việt",
  it: "Italiano",
  ur: "اردو",
  pa: "پنجابی",
  az: "Azərbaycanca",
  fi: "Suomi",
  sv: "Svenska",
  am: "አማርኛ",
  bg: "Български",
  bn: "বাংলা",
  ca: "Català",
  cs: "Čeština",
  dv: "ދިވެހި",
  dz: "རྫོང་ཁ",
  el: "Ελληνικά",
  et: "Eesti",
  fa: "فارسی",
  fo: "Føroyskt",
  hr: "Hrvatski",
  hu: "Magyar",
  hy: "Հայերեն",
  is: "Íslenska",
  ka: "ქართული",
  km: "ខ្មែរ",
  lo: "ລາວ",
  lt: "Lietuvių",
  lv: "Latviešu",
  mk: "Македонски",
  mn: "Монгол",
  ms: "Bahasa Melayu",
  my: "မြန်မာ",
  ne: "नेपाली",
  ro: "Română",
  si: "සිංහල",
  sk: "Slovenčina",
  sl: "Slovenščina",
  sq: "Shqip",
  sr: "Српски",
  tg: "Тоҷикӣ",
  tk: "Türkmençe",
  uz: "Oʻzbekcha",
}

export const DESKTOP_NATIVE_LOCALE_TAGS: Record<DesktopNativeLocale, string> = {
  en: "en",
  zh: "zh-Hans",
  zht: "zh-Hant",
  ko: "ko",
  de: "de",
  es: "es",
  fr: "fr",
  da: "da",
  ja: "ja",
  pl: "pl",
  ru: "ru",
  uk: "uk",
  bs: "bs",
  ar: "ar",
  he: "he-IL",
  no: "nb-NO",
  br: "pt-BR",
  th: "th",
  tr: "tr",
  hi: "hi-IN",
  nl: "nl-NL",
  id: "id-ID",
  vi: "vi-VN",
  it: "it-IT",
  ur: "ur-PK",
  pa: "pa-Arab-PK",
  az: "az-Latn-AZ",
  fi: "fi-FI",
  sv: "sv-SE",
  am: "am-ET",
  bg: "bg-BG",
  bn: "bn-BD",
  ca: "ca-AD",
  cs: "cs-CZ",
  dv: "dv-MV",
  dz: "dz-BT",
  el: "el-GR",
  et: "et-EE",
  fa: "fa-IR",
  fo: "fo-FO",
  hr: "hr-HR",
  hu: "hu-HU",
  hy: "hy-AM",
  is: "is-IS",
  ka: "ka-GE",
  km: "km-KH",
  lo: "lo-LA",
  lt: "lt-LT",
  lv: "lv-LV",
  mk: "mk-MK",
  mn: "mn-MN",
  ms: "ms-MY",
  my: "my-MM",
  ne: "ne-NP",
  ro: "ro-RO",
  si: "si-LK",
  sk: "sk-SK",
  sl: "sl-SI",
  sq: "sq-AL",
  sr: "sr-Cyrl-RS",
  tg: "tg-Cyrl-TJ",
  tk: "tk-Latn-TM",
  uz: "uz-Latn-UZ",
}

export function detectDesktopNativeLocale(languages: readonly string[]): DesktopNativeLocale {
  for (const language of languages) {
    const source = locale(language)
    if (!source) continue
    if (["no", "nb", "nn"].includes(source.language)) return "no"
    const match = DESKTOP_NATIVE_LOCALES.find((candidate) => {
      const target = locale(DESKTOP_NATIVE_LOCALE_TAGS[candidate])
      return target?.language === source.language && normalizeScript(target.script) === normalizeScript(source.script)
    })
    if (match) return match
  }
  return "en"
}

export function desktopNativePluralCategories(locale: DesktopNativeLocale) {
  return new Intl.PluralRules(DESKTOP_NATIVE_LOCALE_TAGS[locale]).resolvedOptions().pluralCategories
}

function locale(value: string) {
  try {
    return new Intl.Locale(value).maximize()
  } catch {
    return undefined
  }
}

// Bun's ICU currently reports Punjabi's Arabic script as the invalid "Aran" code.
const normalizeScript = (script?: string) => (script === "Aran" ? "Arab" : script)

export const DESKTOP_NATIVE_ENGLISH = {
  "desktop.menu.app": "OpenCode",
  "desktop.menu.file": "File",
  "desktop.menu.edit": "Edit",
  "desktop.menu.view": "View",
  "desktop.menu.go": "Go",
  "desktop.menu.window": "Window",
  "desktop.menu.help": "Help",
  "desktop.menu.checkForUpdates": "Check for Updates…",
  "desktop.menu.installCli": "Install CLI…",
  "desktop.menu.settings": "Settings",
  "desktop.menu.reloadWebview": "Reload Webview",
  "desktop.menu.restart": "Restart",
  "desktop.menu.exportLogs": "Export Logs…",
  "desktop.menu.newSession": "New Session",
  "desktop.menu.openProject": "Open Project…",
  "desktop.menu.newWindow": "New Window",
  "desktop.menu.closeWindow": "Close Window",
  "desktop.menu.undo": "Undo",
  "desktop.menu.redo": "Redo",
  "desktop.menu.cut": "Cut",
  "desktop.menu.copy": "Copy",
  "desktop.menu.paste": "Paste",
  "desktop.menu.delete": "Delete",
  "desktop.menu.selectAll": "Select All",
  "desktop.menu.toggleSidebar": "Toggle Sidebar",
  "desktop.menu.toggleTerminal": "Toggle Terminal",
  "desktop.menu.toggleFileTree": "Toggle File Tree",
  "desktop.menu.reload": "Reload",
  "desktop.menu.toggleDeveloperTools": "Toggle Developer Tools",
  "desktop.menu.actualSize": "Actual Size",
  "desktop.menu.zoomIn": "Zoom In",
  "desktop.menu.zoomOut": "Zoom Out",
  "desktop.menu.toggleFullScreen": "Toggle Full Screen",
  "desktop.menu.back": "Back",
  "desktop.menu.forward": "Forward",
  "desktop.menu.previousSession": "Previous Session",
  "desktop.menu.nextSession": "Next Session",
  "desktop.menu.previousProject": "Previous Project",
  "desktop.menu.nextProject": "Next Project",
  "desktop.menu.minimize": "Minimize",
  "desktop.menu.maximize": "Maximize",
  "desktop.menu.documentation": "OpenCode Documentation",
  "desktop.menu.supportForum": "Support Forum",
  "desktop.menu.shareFeedback": "Share Feedback",
  "desktop.menu.reportBug": "Report a Bug",
  "desktop.menu.ariaLabel": "OpenCode menu",

  "desktop.updater.dialog.checkFailed.message": "Update check failed.",
  "desktop.updater.dialog.checkFailed.title": "Update Error",
  "desktop.updater.dialog.upToDate.message": "You're up to date.",
  "desktop.updater.dialog.upToDate.title": "No Updates",
  "desktop.updater.dialog.ready.message": "Update {{version}} downloaded. Restart now?",
  "desktop.updater.dialog.ready.title": "Update Ready",
  "desktop.updater.dialog.restart": "Restart",
  "desktop.updater.dialog.later": "Later",

  "desktop.cli.installed.title": "CLI Installed",
  "desktop.cli.installed.message": "CLI installed to {{path}}\n\nRestart your terminal to use the 'opencode' command.",
  "desktop.cli.failed.title": "Installation Failed",
  "desktop.cli.failed.message": "Failed to install CLI: {{error}}",

  "desktop.recovery.action.relaunch": "Relaunch",
  "desktop.recovery.action.exportLogs": "Export Logs",
  "desktop.recovery.action.keepWaiting": "Keep Waiting",
  "desktop.recovery.action.quit": "Quit",
  "desktop.recovery.loadFailed": "OpenCode failed to load",
  "desktop.recovery.terminated": "OpenCode window terminated unexpectedly",
  "desktop.recovery.unresponsive": "OpenCode is not responding",
  "desktop.recovery.unresponsive.detail": "You can relaunch the app, open the logs, or keep waiting.",
  "desktop.recovery.loadFailed.detail": "Window: {{window}}\nURL: {{url}}\nError: {{code}} {{description}}",
  "desktop.recovery.terminated.detail": "Window: {{window}}\nReason: {{reason}}\nCode: {{code}}",
  "desktop.recovery.unknown": "<unknown>",

  "desktop.dialog.chooseFolder": "Choose a folder",
  "desktop.dialog.chooseFile": "Choose a file",
  "desktop.dialog.saveFile": "Save file",
  "desktop.dialog.files": "Files",
  "desktop.server.local": "Local Server",

  "desktop.wsl.error.windowsOnly": "WSL is only available on Windows",
  "desktop.wsl.error.unavailable": "WSL is unavailable",
  "desktop.wsl.error.listInstalled": "Failed to list installed WSL distros",
  "desktop.wsl.error.listOnline": "Failed to list online WSL distros",
  "desktop.wsl.error.executeDistro": "Cannot execute commands in distro",
  "desktop.wsl.error.installWsl": "WSL installation failed",
  "desktop.wsl.error.installDistro": "Failed to install distro: {{distro}}",
  "desktop.wsl.error.installOpencode": "OpenCode installation failed",
  "desktop.wsl.error.alreadyAdded": "{{distro}} is already added",
  "desktop.wsl.error.opencodeMissing": "opencode is not installed in this distro",
  "desktop.wsl.error.opencodeCannotRun": "opencode is installed but could not run",
  "desktop.wsl.error.opencodeNotInstalled": "OpenCode is not installed in {{distro}}",
  "desktop.wsl.error.updateVersion":
    "OpenCode update finished but {{distro}} still reports {{installed}}; expected {{expected}}",
  "desktop.wsl.error.noVersion": "no version",
  "desktop.wsl.error.serverExited": "WSL server exited after startup (code={{code}} signal={{signal}})",
  "desktop.wsl.error.serverExitedBeforeHealthy":
    "WSL server exited before becoming healthy (code={{code}} signal={{signal}}){{output}}",
  "desktop.wsl.error.healthTimeout": "Sidecar for {{distro}} health check timed out after {{timeout}}ms",
  "desktop.wsl.error.commandTimeout": "{{command}} {{args}} timed out after {{timeout}}ms",
  "desktop.wsl.error.failedPort": "Failed to get port",

  "desktop.picker.error.notSelected": "File was not selected by the picker",
  "desktop.picker.error.sizeLimit": "Selected attachments exceed the {{limit}} MB limit",
} as const

export type DesktopNativeKey = keyof typeof DESKTOP_NATIVE_ENGLISH
export type DesktopNativeMessages = Record<DesktopNativeKey, string>
export type DesktopNativeBundle = { locale: DesktopNativeLocale; messages: DesktopNativeMessages }

export const DESKTOP_NATIVE_KEYS = Object.keys(DESKTOP_NATIVE_ENGLISH) as DesktopNativeKey[]
export const DESKTOP_NATIVE_MAX_PAYLOAD_BYTES = 64 * 1024

export function createDesktopNativeBundle(
  locale: DesktopNativeLocale,
  translate: (key: DesktopNativeKey) => string,
): DesktopNativeBundle {
  return {
    locale,
    messages: Object.fromEntries(DESKTOP_NATIVE_KEYS.map((key) => [key, translate(key)])) as DesktopNativeMessages,
  }
}

export function parseDesktopNativeBundle(value: unknown): DesktopNativeBundle | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > DESKTOP_NATIVE_MAX_PAYLOAD_BYTES) return undefined
  } catch {
    return undefined
  }
  const bundle = value as { locale?: unknown; messages?: unknown }
  if (!DESKTOP_NATIVE_LOCALES.some((locale) => locale === bundle.locale)) return undefined
  if (!bundle.messages || typeof bundle.messages !== "object" || Array.isArray(bundle.messages)) return undefined
  const messages = bundle.messages as Record<string, unknown>
  const keys = Object.keys(messages)
  if (keys.length !== DESKTOP_NATIVE_KEYS.length) return undefined
  if (!DESKTOP_NATIVE_KEYS.every((key) => typeof messages[key] === "string")) return undefined
  if (!keys.every((key) => key in DESKTOP_NATIVE_ENGLISH)) return undefined
  return bundle as DesktopNativeBundle
}

export function formatDesktopNativeMessage(message: string, params?: Record<string, string | number>) {
  if (!params) return message
  return message.replace(/\{\{([^{}]+)\}\}/g, (match, key: string) => {
    const value = params[key]
    return value === undefined ? match : String(value)
  })
}
