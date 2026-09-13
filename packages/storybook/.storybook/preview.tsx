import "../../app/src/index.css"

import { createEffect, onCleanup, onMount } from "solid-js"
import addonA11y from "@storybook/addon-a11y"
import addonDocs from "@storybook/addon-docs"
import { MetaProvider } from "@solidjs/meta"
import { addons } from "storybook/preview-api"
import { GLOBALS_UPDATED } from "storybook/internal/core-events"
import { createJSXDecorator, definePreview } from "storybook-solidjs-vite"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { MarkedProvider } from "@opencode/ui/context/marked"
import { ThemeProvider, useTheme, type ColorScheme } from "@opencode/ui/theme"
import { Font } from "@opencode/ui/font"
import { LanguageProvider, UiI18nBridge, useLanguage } from "@/runtime/i18n/language"
import { SettingsProvider } from "@/settings/model"

function resolveScheme(value: unknown): ColorScheme {
  if (value === "light" || value === "dark" || value === "system") return value
  return "system"
}

const channel = addons.getChannel()

const Scheme = (props: { value?: unknown }) => {
  const theme = useTheme()
  const apply = (value?: unknown) => {
    theme.setColorScheme(resolveScheme(value))
  }
  createEffect(() => {
    apply(props.value)
  })
  createEffect(() => {
    const root = document.documentElement
    root.classList.remove("light", "dark")
    root.classList.add(theme.mode())
  })
  onMount(() => {
    const handler = (event: { globals?: Record<string, unknown> }) => {
      apply(event.globals?.theme)
    }
    channel.on(GLOBALS_UPDATED, handler)
    onCleanup(() => channel.off(GLOBALS_UPDATED, handler))
  })
  return null
}

const Direction = (props: { value?: unknown }) => {
  const language = useLanguage()
  createEffect(() => {
    language.setDirection(props.value === "rtl" ? "rtl" : "ltr")
  })
  return null
}

const BodyTypography = () => {
  onMount(() => {
    document.body.classList.add("font-(family-name:--font-family-text)", "text-[13px]", "font-[440]")
    document.body.classList.remove("text-12-regular")
  })
  return null
}

const frame = createJSXDecorator((Story, context) => {
  const override = context.parameters?.themes?.themeOverride
  const selected = context.globals?.theme
  const pick = override === "light" || override === "dark" ? override : selected
  const scheme = resolveScheme(pick)
  const fullscreen = context.parameters?.layout === "fullscreen"
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider>
        <LanguageProvider locale={typeof context.globals?.locale === "string" ? context.globals.locale : "en"}>
          <UiI18nBridge>
            <Scheme value={scheme} />
            <Direction value={context.globals?.direction} />
            <BodyTypography />
            <DialogProvider>
              <MarkedProvider>
                <div
                  style={{
                    "min-height": "100vh",
                    padding: fullscreen ? "0" : "24px",
                    "background-color": "var(--background-base)",
                    color: "var(--text-base)",
                  }}
                >
                  <SettingsProvider>
                    <Story />
                  </SettingsProvider>
                </div>
              </MarkedProvider>
            </DialogProvider>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
})

export default definePreview({
  addons: [addonDocs(), addonA11y()],
  decorators: [frame],
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Global theme",
      defaultValue: "light",
    },
    direction: {
      name: "Direction",
      description: "Interface direction",
      defaultValue: "ltr",
    },
    locale: {
      name: "Locale",
      description: "Interface language",
      defaultValue: "en",
    },
  },
  parameters: {
    actions: {
      argTypesRegex: "^on.*",
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      test: "todo",
    },
  },
})
