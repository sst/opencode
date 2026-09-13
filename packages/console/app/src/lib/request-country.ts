const MUSE_SPARK_BLOCKED_COUNTRIES = new Set([
  "AF",
  "BY",
  "CN",
  "CU",
  "EH",
  "ER",
  "ET",
  "HK",
  "HT",
  "IQ",
  "IR",
  "KH",
  "KP",
  "LY",
  "MM",
  "MO",
  "NI",
  "PK",
  "RU",
  "SO",
  "SY",
  "VE",
])

export function countryFromRequest(request: Request | undefined) {
  if (!request) return undefined
  const cloudflareRequest = request as Request & { cf?: { country?: string } }
  return cloudflareRequest.cf?.country ?? request.headers.get("cf-ipcountry") ?? undefined
}

export function isModelCountryRestricted(model: string, country: string | undefined) {
  return (
    [
      "muse-spark-1.3-contributor",
      "muse-spark-1.3-contributor-free",
      "muse-spark-1.2-contributor",
      "muse-spark-1.2-contributor-free",
    ].includes(model) &&
    country !== undefined &&
    MUSE_SPARK_BLOCKED_COUNTRIES.has(country.toUpperCase())
  )
}
