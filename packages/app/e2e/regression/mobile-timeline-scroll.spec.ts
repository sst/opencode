import { devices, expect, test, type Page } from "@playwright/test"
import {
  assistantMessage,
  partDelta,
  partUpdated,
  renderedPartID,
  session,
  sessionID,
  setupTimeline,
  shell,
  textPart,
  userMessage,
} from "../performance/timeline-stability/fixture"
import { reportVisualStability, startVisualProbe, stopVisualProbe, visualPlan } from "../utils/visual-stability"

// Compositor prediction can add 20–25px to discrete CDP moves even in a plain
// scrollport. Disable it so the visual assertion measures the supplied gesture.
test.use({ colorScheme: "light", launchOptions: { args: ["--disable-features=ResamplingScrollEvents"] } })

for (const device of ["Pixel 7", "iPhone 13"]) {
  test.describe(device, () => {
    // Chromium drives native touch input, including the virtualizer's iOS user-agent path.
    test.use({
      isMobile: true,
      hasTouch: true,
      userAgent: devices[device].userAgent,
      viewport: { width: 390, height: 844 },
    })

    for (const direction of ["ltr", "rtl"]) {
      test(`session text follows each 50px finger movement (${direction})`, async ({ page }, testInfo) => {
        const messages = Array.from({ length: 40 }, (_, index) => {
          const id = `msg_${String(index).padStart(4, "0")}_mobile`
          return [
            userMessage(undefined, { id: `${id}_user`, created: 1690000000000 + index * 10_000 }),
            assistantMessage(
              [
                textPart(
                  `prt_mobile_${index}`,
                  `Answer ${index}. ${"Mobile history content. ".repeat(10 + (index % 4) * 20)}`,
                ),
              ],
              { id: `${id}_assistant`, parentID: `${id}_user`, created: 1690000001000 + index * 10_000 },
            ),
          ]
        }).flat()
        await setupTimeline(page, { messages, viewport: { width: 390, height: 844 } })
        await page.evaluate((direction) => (document.documentElement.dir = direction), direction)
        const timeline = page.locator('[data-slot="session-timeline-scroll"]')
        const scroller = timeline.getByRole("region", { name: "scrollable content", exact: true })
        await page.evaluate(() => document.fonts.ready)
        await expect(timeline.locator("[data-timeline-virtual-content]")).toBeVisible()
        await expect(page.getByText("Answer 39.", { exact: false })).toBeInViewport()
        await expect(timeline.locator('[data-component="markdown"]:not([data-markdown-ready])')).toHaveCount(0)
        const devtools = await page.context().newCDPSession(page)

        for (const [index, sign] of [1, 1, 1, -1, -1, -1].entries()) {
          const bounds = await scroller.boundingBox()
          expect(bounds).not.toBeNull()
          if (!bounds) return
          const partID = await scroller.evaluate((root, sign) => {
            const view = root.getBoundingClientRect()
            const line = sign > 0 ? view.top + 40 : view.bottom - 40
            return [...root.querySelectorAll<HTMLElement>("[data-timeline-part-id]")]
              .filter((part) => part.querySelector("p"))
              .map((part) => ({ part, rect: part.getBoundingClientRect() }))
              .filter(({ rect }) => rect.bottom > view.top && rect.top < view.bottom)
              .sort((a, b) => Math.abs(a.rect.top - line) - Math.abs(b.rect.top - line))[0]?.part.dataset.timelinePartId
          }, sign)
          expect(partID).toBeTruthy()
          const selector = `[data-timeline-part-id="${partID}"] p`
          const anchor = scroller.locator(selector)
          await expect(anchor).toHaveCount(1)
          const regions = { text: { selector } }
          await startVisualProbe(page, regions)
          const x = bounds.x + bounds.width / 3
          const y = bounds.y + (sign > 0 ? 60 : bounds.height - 60)
          await devtools.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
          // Cross the browser's touch slop before measuring one-to-one dragging.
          await devtools.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: y + sign * 30 }],
          })
          await expect(timeline.locator('[data-orientation="vertical"][data-visible="true"]')).toHaveCount(1)
          await page.screenshot()
          const origin = await anchor.boundingBox()
          expect(origin).not.toBeNull()
          if (!origin) return
          for (let step = 1; step <= 8; step++) {
            await devtools.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x, y: y + sign * (30 + step * 50) }],
            })
            await expect.poll(async () => (await anchor.boundingBox())?.y).toBeCloseTo(origin.y + sign * step * 50, 0)
          }
          await devtools.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
          // Include release corrections through the scroll indicator's idle state.
          await expect(timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
          await testInfo.attach(`swipe-${index}.png`, { body: await page.screenshot(), contentType: "image/png" })
          // Native momentum may continue after release, including past this row's
          // virtual window. It must not move the text against the gesture.
          const finalTop = await anchor.evaluateAll((elements) => elements[0]?.getBoundingClientRect().top)
          if (finalTop !== undefined) expect((finalTop - origin.y) * sign).toBeGreaterThanOrEqual(399.5)
          const trace = await stopVisualProbe(page)
          await reportVisualStability(
            testInfo,
            `swipe-${index}`,
            trace,
            visualPlan(regions, [{ type: "motion", regions: "all", maxPositionReversals: 0 }]),
          )
        }
      })
    }

    test("reversing a touch drag stops following streamed output", async ({ page }, testInfo) => {
      const partID = "prt_mobile_stream"
      const content = Array.from({ length: 60 }, (_, index) => `Reading earlier output ${index}.\n\n`).join("")
      const timeline = await setupTimeline(page, {
        messages: [userMessage(), assistantMessage([textPart(partID, content)], { completed: false })],
        viewport: { width: 390, height: 844 },
      })
      const scroller = page
        .locator('[data-slot="session-timeline-scroll"]')
        .getByRole("region", { name: "scrollable content", exact: true })
      const part = page.locator(`[data-timeline-part-id="${renderedPartID(partID)}"]`)
      const anchor = part.getByText("Reading earlier output 59.", { exact: true })
      await page.evaluate(() => document.fonts.ready)
      await expect(scroller.locator("[data-timeline-virtual-content]")).toBeVisible()
      await expect(anchor).toBeInViewport()
      const bounds = await scroller.boundingBox()
      expect(bounds).not.toBeNull()
      if (!bounds) return
      const devtools = await page.context().newCDPSession(page)
      const x = bounds.x + bounds.width / 3
      const y = bounds.y + bounds.height * 0.75
      await devtools.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
      for (let step = 1; step <= 12; step++)
        await devtools.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 10 }] })
      for (let step = 1; step <= 8; step++)
        await devtools.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y - 120 + step * 10 }],
        })
      const before = await anchor.boundingBox()
      expect(before).not.toBeNull()
      if (!before) return
      await timeline.send(
        partUpdated(textPart(partID, `${content}New streamed output.\n\n${"More output.\n\n".repeat(10)}`)),
      )
      await expect(part).toContainText("New streamed output.")
      await expect(part.locator('[data-component="markdown"]:not([data-markdown-ready])')).toHaveCount(0)
      await devtools.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      await testInfo.attach("held-touch.png", { body: await page.screenshot(), contentType: "image/png" })
      expect((await anchor.boundingBox())?.y).toBeCloseTo(before.y, 0)
    })

    for (const imageCount of [1, 2]) {
      test(`keeps the reading anchor when ${imageCount} earlier images load during a drag`, async ({
        page,
      }, testInfo) => {
        const image = Promise.withResolvers<void>()
        const url = new URL("/mobile-scroll-images.svg", testInfo.project.use.baseURL).href
        await page.route(url, async (route) => {
          await image.promise
          await route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="340" height="600"><rect width="340" height="600" fill="steelblue"/></svg>',
          })
        })
        await setupTimeline(page, {
          messages: [
            userMessage(),
            assistantMessage(
              Array.from({ length: 6 }, (_, index) =>
                textPart(
                  `prt_images_${index}`,
                  index < imageCount
                    ? `Image ${index}.\n\n![Image ${index}](${url})`
                    : index < 2
                      ? "Earlier context."
                      : Array.from({ length: 12 }, (_, line) => `Part ${index} line ${line}.`).join("\n\n"),
                ),
              ),
              { completed: false },
            ),
          ],
          viewport: { width: 390, height: 844 },
        })
        const reading = await readFrom(page, "Part 2 line 0.")
        const images = Array.from({ length: imageCount }, (_, index) =>
          page.getByAltText(`Image ${index}`, { exact: true }),
        )
        const rows = images.map((image) => reading.scroller.locator("[data-timeline-key]", { has: image }))
        const heights = await Promise.all(
          rows.map((row) => row.evaluate((element) => element.getBoundingClientRect().height)),
        )
        const before = await reading.anchor.evaluate((element) => element.getBoundingClientRect().top)
        const bounds = (await reading.scroller.boundingBox())!
        const devtools = await page.context().newCDPSession(page)
        await devtools.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: bounds.x + 120, y: bounds.y + 5 }],
        })
        image.resolve()
        for (const [index, row] of rows.entries()) {
          await expect(images[index]).toHaveJSProperty("naturalHeight", 600)
          await expect
            .poll(() => row.evaluate((element) => element.getBoundingClientRect().height))
            .toBe(heights[index] + 600)
        }
        await testInfo.attach("images-held.png", { body: await page.screenshot(), contentType: "image/png" })
        expect(await reading.anchor.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before, 0)
        for (let step = 1; step <= 21; step++) {
          await devtools.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: bounds.x + 120, y: bounds.y + 5 + step * 30 }],
          })
          await expect
            .poll(() => reading.anchor.evaluate((element) => element.getBoundingClientRect().top))
            .toBeCloseTo(before + step * 30 - 15, 0)
        }
        await devtools.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
        await expect(reading.timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
        expect(await reading.anchor.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
          before + 615,
          0,
        )
      })
    }

    test("reaches the start without a gap or release jump after earlier output shrinks", async ({ page }, testInfo) => {
      const timeline = await setupTimeline(page, {
        messages: [
          userMessage(),
          assistantMessage(
            Array.from({ length: 6 }, (_, index) =>
              index < 2
                ? shell(
                    `prt_shrink_${index}`,
                    "running",
                    Array.from({ length: 4 }, (_, line) => `Output ${line}.`).join("\n\n"),
                  )
                : textPart(
                    `prt_shrink_text_${index}`,
                    Array.from({ length: 12 }, (_, line) => `Part ${index} line ${line}.`).join("\n\n"),
                  ),
            ),
            { completed: false },
          ),
        ],
        settings: { shellToolPartsExpanded: true },
        viewport: { width: 390, height: 844 },
      })
      const reading = await readFrom(page, "Part 2 line 0.")
      const bounds = (await reading.scroller.boundingBox())!
      const devtools = await page.context().newCDPSession(page)
      const part = page.locator(`[data-timeline-part-id="${renderedPartID("prt_shrink_0")}"]`)
      const row = reading.scroller.locator("[data-timeline-key]", { has: part })
      const height = await row.evaluate((element) => element.getBoundingClientRect().height)
      await devtools.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: bounds.x + 120, y: bounds.y + 5 }],
      })
      await timeline.send(partUpdated(shell("prt_shrink_0", "running", "Updated shorter output.")))
      await expect(part).toContainText("Updated shorter output.")
      await expect.poll(() => row.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(height)
      const capture = await capturePromptMotion(page, bounds)
      for (let step = 1; step <= 21; step++)
        await devtools.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: bounds.x + 120, y: bounds.y + 5 + step * 30 }],
        })
      const first = reading.scroller.locator('[data-timeline-row="UserMessage"]')
      await expect(first).toBeInViewport()
      await testInfo.attach("start-held.png", { body: await page.screenshot(), contentType: "image/png" })
      expect(await first.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(reading.start, 0)
      const before = await reading.anchor.evaluate((element) => element.getBoundingClientRect().top)
      await devtools.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      await expect(reading.timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
      await testInfo.attach("start-released.png", { body: await page.screenshot(), contentType: "image/png" })
      expect(await first.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(reading.start, 0)
      expect(await reading.anchor.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before, 0)
      const painted = await capture()
      await testInfo.attach("painted-prompt-motion", {
        body: JSON.stringify(painted.positions),
        contentType: "application/json",
      })
      expect(painted.positions.length).toBeGreaterThan(1)
      const issues = promptMotionIssues(painted.positions)
      if (issues.length) {
        for (const index of [Math.max(0, issues[0].frame - 1), issues[0].frame])
          await testInfo.attach(`painted-motion-${index}`, {
            body: Buffer.from(painted.frames[index], "base64"),
            contentType: "image/jpeg",
          })
      }
      expect(issues, "The painted prompt must not reverse or disappear during a one-direction drag").toEqual([])
    })

    for (const nestedStart of [500, 0]) {
      test(`nested output owns the gesture or chains at its boundary (${nestedStart})`, async ({ page }, testInfo) => {
        const timeline = await setupTimeline(page, {
          messages: [
            userMessage(),
            assistantMessage(
              [
                shell(
                  "prt_nested",
                  "completed",
                  Array.from({ length: 120 }, (_, index) => `Output line ${index}`).join("\n"),
                ),
                textPart("prt_nested_tail", "Latest output."),
              ],
              { completed: false },
            ),
          ],
          settings: { shellToolPartsExpanded: true },
          seedHistory: true,
          viewport: { width: 390, height: 844 },
        })
        const root = page.locator('[data-slot="session-timeline-scroll"]')
        const nested = page.locator(`[data-timeline-part-id="${renderedPartID("prt_nested")}"] [data-scrollable]`)
        const tail = page.getByText("Latest output.", { exact: true })
        await expect(root.locator("[data-timeline-virtual-content]")).toBeVisible()
        await expect(tail).toBeInViewport()
        if (nestedStart) {
          await page.evaluate(() => document.fonts.ready)
          const position = await tail.evaluate((element) => element.getBoundingClientRect().top)
          await nested.evaluate((element) => (element.scrollTop = 500))
          await nested.press("Control+End")
          await expect
            .poll(() => nested.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
            .toBeLessThan(1)
          await nested.press("Control+Home")
          await expect(nested).toHaveJSProperty("scrollTop", 0)
          expect(await tail.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(position, 0)
        }
        await nested.evaluate((element, top) => (element.scrollTop = top), nestedStart)
        await expect(nested).toHaveJSProperty("scrollTop", nestedStart)
        const before = await tail.evaluate((element) => element.getBoundingClientRect().top)
        const bounds = (await nested.boundingBox())!
        const x = bounds.x + 100
        const y = bounds.y + bounds.height * (nestedStart ? 0.75 : 0.25)
        const devtools = await page.context().newCDPSession(page)
        await devtools.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
        if (nestedStart) {
          for (let step = 1; step <= 12; step++)
            await devtools.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x, y: y - step * 10 }],
            })
          await expect.poll(() => nested.evaluate((element) => element.scrollTop)).toBeGreaterThan(550)
          const far = await nested.evaluate((element) => element.scrollTop)
          for (let step = 1; step <= 6; step++)
            await devtools.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x, y: y - 120 + step * 10 }],
            })
          await expect.poll(() => nested.evaluate((element) => element.scrollTop)).toBeLessThan(far)
          expect(await tail.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before, 0)
        }
        if (!nestedStart) {
          for (let step = 1; step <= 12; step++)
            await devtools.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x, y: y + step * 10 }],
            })
          await expect
            .poll(() => tail.evaluate((element) => element.getBoundingClientRect().top))
            .toBeGreaterThan(before + 50)
        }
        await devtools.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
        await expect(root.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
        const released = await tail.evaluate((element) => element.getBoundingClientRect().top)
        await timeline.send(
          partUpdated(
            textPart(
              "prt_nested_tail",
              `Latest output.\n\nNew stream.\n\n${"Additional line.\n\n".repeat(30)}Latest stream end.`,
            ),
          ),
        )
        const latest = page
          .locator(`[data-timeline-part-id="${renderedPartID("prt_nested_tail")}"]`)
          .getByText("New stream.", { exact: true })
        await expect(latest).toBeAttached()
        await expect(root.locator('[data-component="markdown"]:not([data-markdown-ready])')).toHaveCount(0)
        await testInfo.attach("nested-after-stream.png", { body: await page.screenshot(), contentType: "image/png" })
        if (nestedStart) {
          await expect(page.getByText("Latest stream end.", { exact: true })).toBeInViewport()
        }
        if (!nestedStart)
          expect(await tail.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(released, 0)
      })
    }

    for (const width of [390, 1000]) {
      for (const release of ["touchEnd", "touchCancel"] as const) {
        test(`detached session gestures do not unpin the selected session (${width}px, ${release})`, async ({
          page,
        }, testInfo) => {
          const server = testInfo.project.use.baseURL!
          const second = "ses_gesture_destination"
          await page.addInitScript(
            ({ server, first, second }) => {
              localStorage.setItem(
                "opencode.window.browser.dat:tabs",
                JSON.stringify([
                  { type: "session", sessionId: first, server },
                  { type: "session", sessionId: second, server },
                ]),
              )
            },
            { server, first: sessionID, second },
          )
          const content = Array.from({ length: 60 }, (_, index) => `Read output ${index}.`).join("\n\n")
          const fixture = await setupTimeline(page, {
            sessions: [session(), session({ id: second, title: "Second gesture session" })],
            messages: [
              userMessage(),
              assistantMessage([textPart("prt_session_gesture", content)], { completed: false }),
            ],
            viewport: { width, height: 900 },
          })
          const timeline = page.locator('[data-slot="session-timeline-scroll"]')
          const scroller = timeline.getByRole("region", { name: "scrollable content", exact: true })
          const tail = page.getByText("Read output 59.", { exact: true })
          await expect(timeline.locator("[data-timeline-virtual-content]")).toBeVisible()
          await expect(tail).toBeInViewport()
          await expect(timeline.locator('[data-component="markdown"]:not([data-markdown-ready])')).toHaveCount(0)
          await expect(timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
          const before = await tail.evaluate((element) => element.getBoundingClientRect().top)
          const bounds = (await scroller.boundingBox())!
          const point = { x: bounds.x + 150, y: bounds.y + 200 }
          const oldTarget = await page.evaluateHandle((point) => document.elementFromPoint(point.x, point.y), point)
          const oldRoot = (await scroller.elementHandle())!
          const devtools = await page.context().newCDPSession(page)
          await devtools.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
          await devtools.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: point.x, y: point.y + 40 }],
          })
          await expect
            .poll(() => tail.evaluate((element) => element.getBoundingClientRect().top))
            .toBeGreaterThan(before)
          if (width < 768) {
            await page.locator('[data-slot="mobile-tabs-trigger"]').click()
            await page
              .locator('[data-slot="mobile-tabs-drawer"]')
              .locator(`[data-titlebar-tab-link][href$="/session/${second}"]`)
              .click()
            await expect(page.locator('[data-slot="mobile-tabs-trigger"]')).toContainText("Second gesture session")
          }
          if (width >= 768) {
            await page.locator(`[data-titlebar-tab-link][href$="/session/${second}"]`).click()
            await expect(page.getByRole("heading", { name: "Second gesture session", exact: true })).toBeVisible()
          }
          await expect(page).toHaveURL(new RegExp(`/session/${second}$`))
          await expect(timeline.locator("[data-timeline-virtual-content]")).toBeVisible()
          await expect(tail).toBeInViewport()
          await expect.poll(() => oldTarget.evaluate((element) => element?.isConnected)).toBe(false)
          expect(await oldRoot.evaluate((element) => element.isConnected)).toBe(false)
          const selected = await tail.evaluate((element) => element.getBoundingClientRect().top)
          await devtools.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: point.x, y: point.y + 70 }],
          })
          await devtools.send("Input.dispatchTouchEvent", { type: release, touchPoints: [] })
          expect(await tail.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(selected, 0)
          await oldTarget.dispose()
          await oldRoot.dispose()
          const delta = partDelta(
            "prt_session_gesture",
            `\n\n${Array.from({ length: 30 }, (_, index) => `Newly streamed ${index}.`).join("\n\n")}`,
          )
          if (delta.type !== "session.text.delta") throw new Error("Expected a text delta")
          await fixture.send({ ...delta, data: { ...delta.data, sessionID: second } })
          await expect(page.getByText("Newly streamed 29.", { exact: true })).toBeInViewport()
          await testInfo.attach("selected-session-follows.png", {
            body: await page.screenshot(),
            contentType: "image/png",
          })
        })
      }
    }

    for (const handoff of [
      { key: "Home", held: false },
      { key: "Home", held: true },
      { key: "End", held: false },
      { key: "Control+Home", held: false },
      { key: "Control+Home", held: true },
      { key: "Control+End", held: false },
      { key: "latest", held: false },
      { key: "scrollbar", held: false },
      { key: "scrollbar", held: true },
      { key: "scrollbar-large", held: true },
    ] as const) {
      test(`${handoff.key} owns pending touch adjustments (${handoff.held ? "held" : "released"})`, async ({
        page,
      }, testInfo) => {
        const growsDuringDrag = handoff.key === "scrollbar" && handoff.held
        const growsBeforeDrag = handoff.key === "scrollbar-large"
        const usesScrollbar = handoff.key.startsWith("scrollbar")
        const image = Promise.withResolvers<void>()
        const imageURL = new URL("/scrollbar-drag-image.svg", testInfo.project.use.baseURL).href
        if (growsDuringDrag || growsBeforeDrag)
          await page.route(imageURL, async (route) => {
            await image.promise
            await route.fulfill({
              contentType: "image/svg+xml",
              body: `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="${growsBeforeDrag ? 4000 : 300}"><rect width="300" height="${growsBeforeDrag ? 4000 : 300}" fill="steelblue"/></svg>`,
            })
          })
        const fixture = await setupTimeline(page, {
          messages: [
            userMessage(),
            assistantMessage(
              [
                textPart(
                  "prt_handoff_prefix",
                  Array.from({ length: 40 }, (_, index) => `Prefix ${index}.`).join("\n\n") +
                    (growsDuringDrag || growsBeforeDrag ? `\n\n![Earlier diagram](${imageURL})` : ""),
                ),
                shell("prt_handoff_shell", "running", "A short."),
                textPart(
                  "prt_handoff_reading",
                  Array.from({ length: 60 }, (_, index) => `Reading ${index}.`).join("\n\n"),
                ),
              ],
              { completed: false },
            ),
          ],
          settings: { shellToolPartsExpanded: true },
          viewport: { width: 390, height: 844 },
        })
        const timeline = page.locator('[data-slot="session-timeline-scroll"]')
        const scroller = timeline.getByRole("region", { name: "scrollable content", exact: true })
        await expect(timeline.locator("[data-timeline-virtual-content]")).toBeVisible()
        await expect(page.getByText("Reading 59.", { exact: true })).toBeInViewport()
        await page.evaluate(() => document.fonts.ready)
        await scroller.evaluate((element) => {
          element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
          element.scrollTop = 0
        })
        const first = scroller.locator('[data-timeline-row="UserMessage"]')
        await expect(first).toBeInViewport()
        const start = await first.evaluate((element) => element.getBoundingClientRect().top)
        await expect(page.getByText("Prefix 39.", { exact: true })).toBeAttached()
        await expect(timeline.locator('[data-component="markdown"]:not([data-markdown-ready])')).toHaveCount(0)
        await scroller.evaluate(
          (element, distance) => (element.scrollTop = element.scrollHeight - element.clientHeight - distance),
          growsBeforeDrag ? 1200 : handoff.key === "latest" ? 800 : 80,
        )
        await expect(timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
        const latest = page.getByRole("button", { name: "Jump to latest", exact: true })
        if (handoff.key === "latest") await expect(latest.locator("..")).toHaveCSS("opacity", "1")
        const row = scroller.locator("[data-timeline-key]", {
          has: page.locator(`[data-timeline-part-id="${renderedPartID("prt_handoff_shell")}"]`),
        })
        const height = await row.evaluate((element) => element.getBoundingClientRect().height)
        const extent = await scroller.evaluate((element) => element.scrollHeight)
        const bounds = (await scroller.boundingBox())!
        const devtools = await page.context().newCDPSession(page)
        if (handoff.key.startsWith("Control+"))
          await scroller.evaluate((element) => {
            document.addEventListener("keydown", function observe(event) {
              if (!event.ctrlKey || !["Home", "End"].includes(event.key)) return
              element.dataset.nativeScrollPrevented = String(event.defaultPrevented)
              document.removeEventListener("keydown", observe)
            })
          })
        await devtools.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: bounds.x + 100, y: bounds.y + 200 }],
        })
        await devtools.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: bounds.x + 100, y: bounds.y + 230 }],
        })
        await fixture.send(
          partUpdated(
            shell(
              "prt_handoff_shell",
              "running",
              Array.from({ length: 10 }, (_, index) => `Shell A line ${index}.`).join("\n\n"),
            ),
          ),
        )
        await expect
          .poll(() => row.evaluate((element) => element.getBoundingClientRect().height))
          .toBeGreaterThan(height)
        // The row grew, but its native scroll extent is still translated: the
        // new navigation must take ownership before the idle reconciliation.
        await expect.poll(() => scroller.evaluate((element) => element.scrollHeight)).toBe(extent)
        if (growsBeforeDrag) {
          image.resolve()
          const diagram = page.getByAltText("Earlier diagram", { exact: true })
          await expect(diagram).toHaveJSProperty("naturalHeight", 4000)
          await expect
            .poll(() =>
              scroller
                .locator("[data-timeline-key]", { has: diagram })
                .evaluate((element) => element.getBoundingClientRect().height),
            )
            .toBeGreaterThan(4000)
          await expect.poll(() => scroller.evaluate((element) => element.scrollHeight)).toBe(extent)
        }
        const thumb = usesScrollbar ? timeline.locator('.scroll-view__thumb[data-orientation="vertical"]') : undefined
        await thumb?.hover()
        const grip = await thumb?.boundingBox()
        const touchTop = thumb
          ? await page
              .getByText("Reading 50.", { exact: true })
              .evaluate((element) => element.getBoundingClientRect().top)
          : undefined
        await devtools.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: bounds.x + 100, y: bounds.y + 260 }],
        })
        if (touchTop !== undefined)
          await expect
            .poll(() =>
              page.getByText("Reading 50.", { exact: true }).evaluate((element) => element.getBoundingClientRect().top),
            )
            .toBeCloseTo(touchTop + 30, 0)
        if (!handoff.held) await devtools.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
        if (handoff.key === "latest") await latest.click()
        if (handoff.key !== "latest" && !usesScrollbar) await scroller.press(handoff.key)
        if (handoff.key.startsWith("Control+"))
          await expect(scroller).toHaveAttribute("data-native-scroll-prevented", "false")
        if (usesScrollbar) {
          expect(grip).toBeTruthy()
          if (!grip) return
          const anchor = page.getByText("Reading 50.", { exact: true })
          const before = await anchor.evaluate((element) => element.getBoundingClientRect().top)
          await page.mouse.down()
          expect(await anchor.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before, 0)
          await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 4)
          await expect
            .poll(() => anchor.evaluate((element) => element.getBoundingClientRect().top))
            .toBeGreaterThan(before)
          expect((await anchor.evaluate((element) => element.getBoundingClientRect().top)) - before).toBeLessThan(60)
          if (growsDuringDrag) {
            const prefix = scroller.locator("[data-timeline-key]", {
              has: page.locator(`[data-timeline-part-id="${renderedPartID("prt_handoff_prefix")}"]`),
            })
            const prefixHeight = await prefix.evaluate((element) => element.getBoundingClientRect().height)
            const extent = await scroller.evaluate((element) => element.scrollHeight)
            // More content can arrive after the thumb has already captured the pointer.
            image.resolve()
            await expect(page.getByAltText("Earlier diagram", { exact: true })).toHaveJSProperty("naturalHeight", 300)
            await expect
              .poll(() => prefix.evaluate((element) => element.getBoundingClientRect().height))
              .toBeGreaterThan(prefixHeight)
            await expect.poll(() => scroller.evaluate((element) => element.scrollHeight)).toBe(extent)
          }
          await page.mouse.move(grip.x + grip.width / 2, bounds.y + 5)
          await page.mouse.up()
          await page.mouse.move(0, 0)
        }
        const toStart = handoff.key.endsWith("Home") || usesScrollbar
        if (toStart) await expect(first).toBeInViewport()
        if (!toStart) await expect(page.getByText("Reading 59.", { exact: true })).toBeInViewport()
        await expect(timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
        if (handoff.held) await devtools.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
        if (toStart)
          expect(await first.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(start, 0)
        await testInfo.attach("touch-navigation-handoff.png", {
          body: await page.screenshot(),
          contentType: "image/png",
        })
      })
    }

    for (const release of ["touchEnd", "touchCancel"] as const) {
      test(`returns Home after scrolling the touch target out of view (${release})`, async ({ page }, testInfo) => {
        const image = Promise.withResolvers<void>()
        const url = new URL("/lifecycle-image.svg", testInfo.project.use.baseURL).href
        await page.route(url, async (route) => {
          await image.promise
          await route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="steelblue"/></svg>',
          })
        })
        await setupTimeline(page, {
          messages: [
            userMessage(),
            assistantMessage(
              Array.from({ length: 80 }, (_, index) =>
                textPart(
                  `prt_lifecycle_${index}`,
                  `Part ${index}.${index === 46 ? `\n\n![Delayed image](${url})` : ""}`,
                ),
              ),
              { completed: false },
            ),
          ],
          viewport: { width: 390, height: 844 },
        })
        const timeline = page.locator('[data-slot="session-timeline-scroll"]')
        const scroller = timeline.getByRole("region", { name: "scrollable content", exact: true })
        await expect(timeline.locator("[data-timeline-virtual-content]")).toBeVisible()
        await expect(page.getByText("Part 79.", { exact: true })).toBeInViewport()
        await page.evaluate(() => document.fonts.ready)
        await expect(timeline.locator('[data-component="markdown"]:not([data-markdown-ready])')).toHaveCount(0)
        await scroller.evaluate((element) => {
          element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
          element.scrollTop = 0
        })
        const first = scroller.locator('[data-timeline-row="UserMessage"]')
        await expect(first).toBeInViewport()
        const start = await first.evaluate((element) => element.getBoundingClientRect().top)
        // Measure the history before exercising a gesture across the virtual window.
        for (let index = 0; index < 10; index++) {
          await scroller.evaluate((element) => (element.scrollTop += 300))
          await page.screenshot()
          await expect(timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
        }
        await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight))
        await expect(page.getByText("Part 79.", { exact: true })).toBeInViewport()
        await expect(timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
        const bounds = (await scroller.boundingBox())!
        const touched = page.getByText("Part 66.", { exact: true })
        await expect(touched).toBeInViewport()
        const devtools = await page.context().newCDPSession(page)
        await devtools.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: bounds.x + 100, y: bounds.y + 70 }],
        })
        for (let step = 1; step <= 23; step++)
          await devtools.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: bounds.x + 100, y: bounds.y + 70 + step * 30 }],
          })
        await expect(touched).not.toBeInViewport()
        await devtools.send("Input.dispatchTouchEvent", { type: release, touchPoints: [] })
        await expect(timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
        await expect(touched).toHaveCount(0)
        const anchor = page.getByText("Part 47.", { exact: true })
        await expect(anchor).toBeInViewport()
        const before = await anchor.evaluate((element) => element.getBoundingClientRect().top)
        image.resolve()
        const loaded = page.getByAltText("Delayed image", { exact: true })
        await expect(loaded).toHaveJSProperty("naturalHeight", 300)
        await expect
          .poll(() =>
            scroller
              .locator("[data-timeline-key]", { has: loaded })
              .evaluate((element) => element.getBoundingClientRect().height),
          )
          .toBeGreaterThan(300)
        await page.screenshot()
        expect(await anchor.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before, 0)
        await scroller.press("Home")
        await expect(first).toBeInViewport()
        await expect(timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
        expect(await first.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(start, 0)
        await testInfo.attach("home-after-touch.png", { body: await page.screenshot(), contentType: "image/png" })
      })

      test(`returns Home after streaming replaces the touch target (${release})`, async ({ page }, testInfo) => {
        const image = Promise.withResolvers<void>()
        const url = new URL("/stream-target-image.svg", testInfo.project.use.baseURL).href
        await page.route(url, async (route) => {
          await image.promise
          await route.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="steelblue"/></svg>',
          })
        })
        const fixture = await setupTimeline(page, {
          messages: [
            userMessage(),
            assistantMessage(
              [
                textPart(
                  "prt_target_prefix",
                  Array.from({ length: 60 }, (_, index) => `Prefix ${index}.`).join("\n\n"),
                ),
                textPart("prt_target_image", `Earlier image.\n\n![Delayed image](${url})`),
                textPart(
                  "prt_target_reading",
                  Array.from({ length: 25 }, (_, index) => `Reading ${index}.`).join("\n\n"),
                ),
                textPart("prt_target_heading", "Heading text"),
              ],
              { completed: false },
            ),
          ],
          viewport: { width: 390, height: 844 },
        })
        const timeline = page.locator('[data-slot="session-timeline-scroll"]')
        const scroller = timeline.getByRole("region", { name: "scrollable content", exact: true })
        const heading = page.locator(`[data-timeline-part-id="${renderedPartID("prt_target_heading")}"]`)
        await expect(timeline.locator("[data-timeline-virtual-content]")).toBeVisible()
        await expect(heading).toBeInViewport()
        await page.evaluate(() => document.fonts.ready)
        await expect(timeline.locator('[data-component="markdown"]:not([data-markdown-ready])')).toHaveCount(0)
        await scroller.evaluate((element) => {
          element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
          element.scrollTop = 0
        })
        const first = scroller.locator('[data-timeline-row="UserMessage"]')
        await expect(first).toBeInViewport()
        const start = await first.evaluate((element) => element.getBoundingClientRect().top)
        await expect(timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
        await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight))
        await expect(heading).toBeInViewport()
        await expect(timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
        const bounds = (await heading.getByText("Heading text", { exact: true }).boundingBox())!
        const point = { x: bounds.x + 25, y: bounds.y + bounds.height / 2 }
        const target = await page.evaluateHandle((point) => document.elementFromPoint(point.x, point.y), point)
        const devtools = await page.context().newCDPSession(page)
        await devtools.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
        await devtools.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: point.x, y: point.y + 60 }],
        })
        await expect(timeline.locator('[data-orientation="vertical"][data-visible="true"]')).toHaveCount(1)
        await fixture.send(partDelta("prt_target_heading", "\n\nMore content."))
        await expect(heading).toContainText("More content.")
        await expect(heading.locator("p")).toHaveCount(2)
        await expect.poll(() => target.evaluate((element) => element?.isConnected)).toBe(false)
        await devtools.send("Input.dispatchTouchEvent", { type: release, touchPoints: [] })
        await target.dispose()
        await expect(timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
        const anchor = page.getByText("Reading 20.", { exact: true })
        await expect(anchor).toBeInViewport()
        const before = await anchor.evaluate((element) => element.getBoundingClientRect().top)
        image.resolve()
        const loaded = page.getByAltText("Delayed image", { exact: true })
        await expect(loaded).toHaveJSProperty("naturalHeight", 300)
        await expect
          .poll(() =>
            scroller
              .locator("[data-timeline-key]", { has: loaded })
              .evaluate((element) => element.getBoundingClientRect().height),
          )
          .toBeGreaterThan(300)
        await page.screenshot()
        expect(await anchor.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before, 0)
        await scroller.press("Home")
        await expect(first).toBeInViewport()
        await expect(timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
        expect(await first.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(start, 0)
        await testInfo.attach("home-after-stream.png", { body: await page.screenshot(), contentType: "image/png" })
      })
    }

    test("keeps the visible row anchored through reflow and touch cancellation", async ({ page }, testInfo) => {
      await setupTimeline(page, {
        messages: [
          userMessage(),
          assistantMessage(
            Array.from({ length: 40 }, (_, index) =>
              textPart(`prt_reflow_${index}`, `Section ${index}. ${"Adjacent part content. ".repeat(16)}`),
            ),
          ),
        ],
        viewport: { width: 700, height: 844 },
      })
      const timeline = page.locator('[data-slot="session-timeline-scroll"]')
      const scroller = timeline.getByRole("region", { name: "scrollable content", exact: true })
      await expect(timeline.locator("[data-timeline-virtual-content]")).toBeVisible()
      const tail = page.getByText("Section 39.", { exact: false })
      await expect(tail).toBeInViewport()
      await page.evaluate(() => document.fonts.ready)
      await expect(timeline.locator('[data-component="markdown"]:not([data-markdown-ready])')).toHaveCount(0)
      const bounds = (await scroller.boundingBox())!
      const before = await tail.evaluate((element) => element.getBoundingClientRect().top)
      const devtools = await page.context().newCDPSession(page)
      await devtools.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: bounds.x + 130, y: bounds.y + 100 }],
      })
      await devtools.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: bounds.x + 130, y: bounds.y + 200 }],
      })
      await expect
        .poll(() => tail.evaluate((element) => element.getBoundingClientRect().top))
        .toBeGreaterThan(before + 50)
      await expect(timeline.locator('[data-orientation="vertical"][data-visible="false"]')).toHaveCount(1)
      const chosen = await scroller.evaluate((root) => {
        const view = root.getBoundingClientRect()
        const rows = [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")]
        const above = rows.filter((row) => row.getBoundingClientRect().bottom <= view.top).slice(-2)
        const first = rows.find((row) => row.getBoundingClientRect().bottom > view.top)!
        return {
          above: above.map((row) => ({ key: row.dataset.timelineKey, height: row.getBoundingClientRect().height })),
          key: first.dataset.timelineKey,
          top: first.getBoundingClientRect().top,
        }
      })
      expect(chosen.above).toHaveLength(2)
      await page.setViewportSize({ width: 390, height: 844 })
      for (const row of chosen.above)
        await expect
          .poll(async () => (await scroller.locator(`[data-timeline-key="${row.key}"]`).boundingBox())?.height)
          .toBeGreaterThan(row.height)
      const anchor = scroller.locator(`[data-timeline-key="${chosen.key}"]`)
      await testInfo.attach("reflow-held.png", { body: await page.screenshot(), contentType: "image/png" })
      expect((await anchor.boundingBox())?.y).toBeCloseTo(chosen.top, 0)
      await devtools.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })
      await testInfo.attach("reflow-cancelled.png", { body: await page.screenshot(), contentType: "image/png" })
      expect((await anchor.boundingBox())?.y).toBeCloseTo(chosen.top, 0)
    })
  })
}

for (const hidden of ["translateY(-500px)", "scale(0)"]) {
  test(`painted motion rejects a disappearing prompt (${hidden})`, async ({ page }) => {
    await setupTimeline(page, {
      messages: [userMessage(), assistantMessage([textPart("prt_pixel_control", "Content.")])],
      viewport: { width: 390, height: 844 },
    })
    const timeline = page.locator('[data-slot="session-timeline-scroll"]')
    await expect(timeline.locator("[data-timeline-virtual-content]")).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    const prompt = timeline.locator('[data-timeline-row="UserMessage"]')
    await expect(prompt).toBeInViewport()
    const view = (await timeline.getByRole("region", { name: "scrollable content", exact: true }).boundingBox())!
    const frames = [(await page.screenshot({ type: "jpeg" })).toString("base64")]
    // Negative control: a captured disappearance must fail even if the layout recovers.
    await prompt.evaluate((element, transform) => (element.style.transform = transform), hidden)
    frames.push((await page.screenshot({ type: "jpeg" })).toString("base64"))
    await prompt.evaluate((element) => element.style.removeProperty("transform"))
    frames.push((await page.screenshot({ type: "jpeg" })).toString("base64"))
    const positions = await readPromptPositions(page, frames, view)
    expect(positions.map((position) => position.top !== null)).toEqual([true, false, true])
    expect(promptMotionIssues(positions)).toEqual([{ frame: 1, reason: "missing" }])
  })
}

async function readFrom(page: Page, text: string) {
  const timeline = page.locator('[data-slot="session-timeline-scroll"]')
  const scroller = timeline.getByRole("region", { name: "scrollable content", exact: true })
  await expect(timeline.locator("[data-timeline-virtual-content]")).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }))
    element.scrollTop = 0
  })
  const first = scroller.locator('[data-timeline-row="UserMessage"]')
  await expect(first).toBeInViewport()
  const start = await first.evaluate((element) => element.getBoundingClientRect().top)
  const anchor = scroller.getByText(text, { exact: true })
  await expect(anchor).toBeAttached()
  await expect(scroller.locator('[data-component="markdown"]:not([data-markdown-ready])')).toHaveCount(0)
  await anchor.evaluate((element) => {
    const root = element.closest("[data-scrollable]")!
    root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top - 8
  })
  await expect(anchor).toBeInViewport()
  return { timeline, scroller, anchor, start }
}

async function capturePromptMotion(page: Page, view: { x: number; y: number; width: number }) {
  const session = await page.context().newCDPSession(page)
  const frames: string[] = []
  const acknowledgements: Promise<unknown>[] = []
  const onFrame = (frame: { data: string; sessionId: number }) => {
    frames.push(frame.data)
    acknowledgements.push(session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }))
  }
  session.on("Page.screencastFrame", onFrame)
  const viewport = page.viewportSize()!
  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: 90,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  })
  return async () => {
    session.off("Page.screencastFrame", onFrame)
    await session.send("Page.stopScreencast")
    await Promise.all(acknowledgements)
    await session.detach()
    return { positions: await readPromptPositions(page, frames, view), frames }
  }
}

async function readPromptPositions(page: Page, frames: string[], view: { x: number; y: number; width: number }) {
  return page.evaluate(
    async ({ frames, view, viewport }) => {
      const positions: { frame: number; top: number | null }[] = []
      for (const [frame, encoded] of frames.entries()) {
        const position = { frame, top: null as number | null }
        const image = await createImageBitmap(
          new Blob([Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))], { type: "image/jpeg" }),
        )
        const canvas = new OffscreenCanvas(image.width, image.height)
        const context = canvas.getContext("2d")!
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, image.width, image.height).data
        const scale = image.height / viewport.height
        // This fixture's only blue content in the top 200px is its user prompt.
        // Track painted ink, including compositor-only scroll frames.
        for (let y = Math.ceil(view.y * scale); y < Math.min(image.height, (view.y + 200) * scale); y++) {
          let ink = 0
          for (let x = Math.ceil((view.x + 16) * scale); x < (view.x + view.width - 16) * scale; x++) {
            const offset = (y * image.width + x) * 4
            if (pixels[offset + 2] > pixels[offset] + 50 && pixels[offset + 2] > pixels[offset + 1] + 30) ink++
          }
          if (ink < 3) continue
          position.top = y / scale
          break
        }
        positions.push(position)
        image.close()
      }
      return positions
    },
    { frames, view, viewport: page.viewportSize()! },
  )
}

function promptMotionIssues(positions: { frame: number; top: number | null }[]) {
  const first = positions.findIndex((position) => position.top !== null)
  if (first < 0) return [{ frame: 0, reason: "never-painted" }]
  return positions.slice(first).flatMap((position, index, all) => {
    if (position.top === null) return [{ frame: position.frame, reason: "missing" }]
    const previous = all[index - 1]?.top
    if (previous === undefined || previous === null || position.top >= previous - 2) return []
    return [{ frame: position.frame, reason: "reversed" }]
  })
}
