import type { Page } from "@playwright/test"

export async function openWithDirection(page: Page, route: string, direction: "ltr" | "rtl") {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.goto(`/e2e/utils/app-direction.html?${new URLSearchParams({ server, route, direction })}`)
}
