import { createMiddleware } from "@solidjs/start/middleware"
import { LOCALE_HEADER, cookie, fromPathname, strip } from "~/lib/language"
import { normalizeReferralCode, referralCookie } from "~/lib/referral-invite"
import { sanitizeServerActionRequest } from "~/lib/server-action"

export default createMiddleware({
  async onRequest(event) {
    event.request = sanitizeServerActionRequest(event.request)

    const url = new URL(event.request.url)
    const locale = fromPathname(url.pathname)
    if (locale) {
      url.pathname = strip(url.pathname)
      const request = new Request(url, event.request)
      request.headers.set(LOCALE_HEADER, locale)
      event.request = request
      event.response.headers.append("set-cookie", cookie(locale))
    }

    const referralCode = normalizeReferralCode(url.searchParams.get("ref"))
    if (referralCode) event.response.headers.append("set-cookie", referralCookie(referralCode))
  },
})
