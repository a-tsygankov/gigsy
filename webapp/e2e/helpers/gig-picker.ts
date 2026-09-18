import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Driving a `GigPicker` (components/GigPicker.tsx).
 *
 * The three places a spec used to `selectOption` a gig are a trigger
 * opening a full-screen sheet now, and the sheet holds the Gigs tab's
 * own filter bar — so "pick gig X" is open, find, tap, and the same
 * three steps in every spec are one helper here, for the reason
 * datetime-field.ts gives.
 *
 * Two ways to name the gig, because specs know a gig two ways:
 *
 *   - by ID, when the spec created the gig and has its id (money.spec's
 *     `createGig`). Every row carries `<testId>-row-<id>`, and the list
 *     is not virtualised, so the row exists in the DOM however many
 *     gigs prior runs left behind — no search needed.
 *   - by TITLE, when the spec wants to prove the search itself: the
 *     text goes into the sheet's search box and the row that survives
 *     is tapped.
 *
 * The search box is `GigFilters`' own `gig-search` — the component is
 * reused unchanged inside the sheet — which is why it is located THROUGH
 * the sheet rather than by id alone: on a screen that also shows the
 * gig list there would be two.
 */
export class GigPickerDriver {
  readonly trigger: Locator;
  readonly sheet: Locator;
  readonly search: Locator;

  constructor(
    private readonly page: Page,
    private readonly testId: string,
  ) {
    this.trigger = page.getByTestId(testId);
    this.sheet = page.getByTestId(`${testId}-sheet`);
    this.search = this.sheet.getByTestId("gig-search");
  }

  async open(): Promise<void> {
    await this.trigger.click();
    await expect(this.sheet).toBeVisible();
  }

  async close(): Promise<void> {
    await this.page.getByTestId(`${this.testId}-sheet-close`).click();
    await expect(this.sheet).toBeHidden();
  }

  row(gigId: string): Locator {
    return this.page.getByTestId(`${this.testId}-row-${gigId}`);
  }

  /**
   * Open the sheet and choose a gig, by id or by title.
   *
   * An id is tried first — a row tagged with it is proof enough. Only
   * when no row carries the text as an id is it treated as a title and
   * typed into the search box, and the (one) row left is tapped. Picking
   * closes the sheet, so the wait on it being hidden is the receipt.
   */
  async pick(gigTitleOrId: string): Promise<void> {
    await this.open();
    const byId = this.row(gigTitleOrId);
    if ((await byId.count()) > 0) {
      await byId.click();
    } else {
      await this.search.fill(gigTitleOrId);
      // Scoped to the list, so the Close button and the filter chips
      // are never candidates; the "none" row is a button in the list
      // too, but it reads as the placeholder, never as a gig's title.
      const rows = this.sheet
        .getByTestId(`${this.testId}-list`)
        .getByRole("button")
        .filter({ hasText: gigTitleOrId });
      await rows.first().click();
    }
    await expect(this.sheet).toBeHidden();
  }

  /** Choose the "none" row — "Not linked", "Not part of anything". */
  async clear(): Promise<void> {
    await this.open();
    await this.page.getByTestId(`${this.testId}-none`).click();
    await expect(this.sheet).toBeHidden();
  }

  /**
   * What the picker holds: a gig id, or "" for none.
   *
   * The trigger's visible text is a title and a localised date — written
   * for a person — so the canonical copy beside it is what a spec can
   * assert on, exactly as DateTimeFieldDriver does.
   */
  expectValue(gigId: string): Promise<void> {
    return expect(this.trigger).toHaveAttribute("data-value", gigId);
  }

  /** Something is chosen, whichever gig it is. */
  expectChosen(): Promise<void> {
    return expect(this.trigger).not.toHaveAttribute("data-value", "");
  }
}

export function gigPicker(page: Page, testId: string): GigPickerDriver {
  return new GigPickerDriver(page, testId);
}
