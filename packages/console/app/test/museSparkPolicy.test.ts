import { describe, expect, test } from "bun:test"
import { isModelCountryRestricted } from "../src/lib/request-country"
import { requiresGoTrainingConsent } from "../src/routes/zen/util/trainingConsent"

describe("Muse Spark model policies", () => {
  test.each([
    "muse-spark-1.3-contributor",
    "muse-spark-1.3-contributor-free",
    "muse-spark-1.2-contributor",
    "muse-spark-1.2-contributor-free",
  ])("restricts %s in blocked countries", (model) => {
    expect(isModelCountryRestricted(model, "CN")).toBe(true)
    expect(isModelCountryRestricted(model, "US")).toBe(false)
  })

  test("does not apply the country restriction to similar model IDs", () => {
    expect(isModelCountryRestricted("muse-spark-1.3-contributor-preview", "CN")).toBe(false)
  })

  test.each(["muse-spark-1.3-contributor", "muse-spark-1.2-contributor"])(
    "requires Go training consent for %s",
    (model) => {
      expect(requiresGoTrainingConsent(model)).toBe(true)
    },
  )

  test("does not require Go training consent for the free or similar model IDs", () => {
    expect(requiresGoTrainingConsent("muse-spark-1.3-contributor-free")).toBe(false)
    expect(requiresGoTrainingConsent("muse-spark-1.3-contributor-preview")).toBe(false)
  })
})
