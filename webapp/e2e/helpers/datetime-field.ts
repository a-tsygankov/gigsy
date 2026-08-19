import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Driving a `DateTimeField`.
 *
 * The control used to be two native inputs, so a spec filled a date and
 * filled a time and that was the whole interaction. It is now one
 * trigger opening a popover that holds a calendar and a time box, and
 * every spec that captures a moment has to open it. Putting that here
 * rather than in each spec keeps five tests from each inventing their
 * own idea of how the popover works.
 *
 * Everything this reaches for is an attribute the app puts there on
 * purpose — `data-day-iso`, `data-nav`, `data-value` (see
 * components/ui/calendar.tsx and components/DateTimeField.tsx). None of
 * it is react-day-picker's rendered markup, which carries no such
 * promise and whose own handles are English aria-labels.
 */
export class DateTimeFieldDriver {
  readonly trigger: Locator;
  readonly calendar: Locator;
  readonly time: Locator;

  constructor(
    private readonly page: Page,
    private readonly testId: string,
  ) {
    this.trigger = page.getByTestId(testId);
    this.calendar = page.getByTestId(`${testId}-calendar`);
    this.time = page.getByTestId(`${testId}-time`);
  }

  async open(): Promise<void> {
    await this.trigger.click();
    await expect(this.calendar).toBeVisible();
  }

  async close(): Promise<void> {
    await this.page.getByTestId(`${this.testId}-done`).click();
    await expect(this.calendar).toBeHidden();
  }

  /** Walk to the month holding `iso` ("YYYY-MM-DD"), then click the day. */
  async pickDay(iso: string): Promise<void> {
    const cell = this.calendar.locator(`[data-day-iso="${iso}"]`);
    const shown = await this.calendar
      .locator("[data-day-iso]")
      .first()
      .getAttribute("data-day-iso");
    // ISO dates sort as strings, which is the whole reason for the format.
    const direction = shown !== null && iso < shown ? "previous" : "next";
    // Bounded. An unbounded walk against a calendar that has stopped
    // navigating hangs the run instead of failing it, and two years of
    // steps is already far more than any spec here asks for.
    for (let step = 0; step < 24 && (await cell.count()) === 0; step++) {
      await this.calendar.locator(`[data-nav="${direction}"]`).click();
    }
    await cell.click();
  }

  async setTime(hhmm: string): Promise<void> {
    await this.time.fill(hhmm);
  }

  async clear(): Promise<void> {
    await this.page.getByTestId(`${this.testId}-clear`).click();
  }

  /** Open, set a whole moment, close. The common case. */
  async set(iso: string, hhmm: string): Promise<void> {
    await this.open();
    await this.pickDay(iso);
    await this.setTime(hhmm);
    await this.close();
  }

  /**
   * What the field holds, as "YYYY-MM-DDTHH:mm" or "".
   *
   * The trigger's visible text is localised — it is written for a person
   * — so the canonical copy beside it is what a spec can assert on.
   */
  expectValue(value: string): Promise<void> {
    return expect(this.trigger).toHaveAttribute("data-value", value);
  }
}

export function dateTimeField(page: Page, testId: string): DateTimeFieldDriver {
  return new DateTimeFieldDriver(page, testId);
}
