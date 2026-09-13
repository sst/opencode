export function formatMessageTimestamp(created: number, locale: string, now = Date.now()) {
  const date = new Date(created)
  const current = new Date(now)
  const day =
    (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) -
      Date.UTC(current.getFullYear(), current.getMonth(), current.getDate())) /
    86_400_000
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(date)
  const relative =
    day === 0 || day === -1
      ? new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
          .format(day, "day")
          .replace(/^./u, (value) => value.toLocaleUpperCase(locale))
      : undefined
  const label = relative
    ? `${relative} ${time}`
    : new Intl.DateTimeFormat(
        locale,
        date.getFullYear() === current.getFullYear()
          ? { month: "short", day: "numeric" }
          : { year: "numeric", month: "short", day: "numeric" },
      ).format(date)

  return {
    label,
    title: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date),
  }
}
