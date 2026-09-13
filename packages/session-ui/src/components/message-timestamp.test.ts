import { describe, expect, test } from "bun:test"
import { formatMessageTimestamp } from "./message-timestamp"

const local = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month - 1, day, hour, minute).getTime()

describe("formatMessageTimestamp", () => {
  const now = local(2026, 8, 22, 18, 0)

  test("labels messages from today with the time", () => {
    expect(formatMessageTimestamp(local(2026, 8, 22, 14, 32), "en-US", now)).toEqual({
      label: "Today 2:32 PM",
      title: "Aug 22, 2026 at 2:32 PM",
    })
  })

  test("labels messages from yesterday with the time", () => {
    expect(formatMessageTimestamp(local(2026, 8, 21, 9, 10), "en-US", now)).toEqual({
      label: "Yesterday 9:10 AM",
      title: "Aug 21, 2026 at 9:10 AM",
    })
  })

  test("uses a short date for older messages", () => {
    expect(formatMessageTimestamp(local(2026, 8, 12, 9, 10), "en-US", now)).toEqual({
      label: "Aug 12",
      title: "Aug 12, 2026 at 9:10 AM",
    })
  })

  test("includes the year when it differs from the current year", () => {
    expect(formatMessageTimestamp(local(2025, 8, 12, 9, 10), "en-US", now)).toEqual({
      label: "Aug 12, 2025",
      title: "Aug 12, 2025 at 9:10 AM",
    })
  })

  test("uses locale-aware relative labels and dates", () => {
    expect(formatMessageTimestamp(local(2026, 8, 22, 14, 32), "de-DE", now)).toEqual({
      label: "Heute 14:32",
      title: "22.08.2026, 14:32",
    })
  })
})
