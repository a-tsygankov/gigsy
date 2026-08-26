/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarSection } from "./CalendarSection.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// See money/Payments.test.tsx for why this is required rather than nice.
notifyManager.setScheduler((cb) => cb());

const SETTINGS = {
  calendarTargetId: "primary",
  calendarTitlePrefix: false,
  calendarUseDefaultReminder: true,
  calendarReminderMinutes: 60,
};

const scopeError = () => new Error("reconnect-required");

const api = {
  getSettings: vi.fn(async () => SETTINGS),
  updateSettings: vi.fn(async () => SETTINGS),
  getCalendarStatus: vi.fn(async () => ({ connected: true })),
  createDedicatedCalendar: vi.fn(async () => ({ calendarId: "c", removed: 2, failed: 0 })),
  connectCalendar: vi.fn(async () => ({ connected: true })),
  calendarResync: vi.fn(async () => ({ queued: true as const })),
};

const authApi = { getConfig: vi.fn(async () => ({ googleClientId: "client-123" })) };

vi.mock("../../lib/app-context.tsx", () => ({
  useData: () => api,
  useServices: () => ({ authApi }),
}));

const requestCalendarCode = vi.fn(async () => "auth-code");
vi.mock("../../lib/google-signin.ts", () => ({
  CALENDAR_EVENTS_SCOPE: "https://www.googleapis.com/auth/calendar.events",
  CALENDAR_APP_CREATED_SCOPE: "https://www.googleapis.com/auth/calendar.app.created",
  requestCalendarCode: (...args: unknown[]) => requestCalendarCode(...(args as [])),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CalendarSection />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

async function clickCreate(el: HTMLElement) {
  const button = el.querySelector<HTMLButtonElement>('[data-testid="create-dedicated"]');
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
}

const notice = (el: HTMLElement) =>
  el.querySelector('[data-testid="calendar-notice"]')?.textContent ?? "";

beforeEach(() => {
  api.createDedicatedCalendar.mockResolvedValue({ calendarId: "c", removed: 2, failed: 0 });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe("CalendarSection — the dedicated calendar", () => {
  it("creates it without asking for consent when the grant already allows it", async () => {
    const el = await render();
    await clickCreate(el);

    expect(requestCalendarCode).not.toHaveBeenCalled();
    expect(notice(el)).toContain("Created.");
  });

  /**
   * The bug this replaces. `POST /calendars` is permitted by none of
   * the scopes connecting asks for, so the first attempt 409s. The old
   * handler told the user to disconnect and reconnect — which re-asks
   * for `calendar.events` and fails identically.
   */
  it("asks for calendar.app.created and retries, rather than telling the user to reconnect", async () => {
    api.createDedicatedCalendar
      .mockRejectedValueOnce(scopeError())
      .mockResolvedValueOnce({ calendarId: "c", removed: 1, failed: 0 });

    const el = await render();
    await clickCreate(el);

    expect(requestCalendarCode).toHaveBeenCalledTimes(1);
    const [, scopes] = requestCalendarCode.mock.calls[0] as unknown as [string, string[]];
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.app.created");
    // Still needed: app.created cannot write to `primary`.
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.events");

    expect(api.connectCalendar).toHaveBeenCalledWith("auth-code");
    expect(api.createDedicatedCalendar).toHaveBeenCalledTimes(2);
    expect(notice(el)).toContain("Created.");
    expect(notice(el)).not.toContain("reconnect");
  });

  it("stops after one retry when consent is dismissed, instead of looping", async () => {
    api.createDedicatedCalendar
      .mockRejectedValueOnce(scopeError())
      .mockRejectedValueOnce(scopeError());

    const el = await render();
    await clickCreate(el);

    expect(api.createDedicatedCalendar).toHaveBeenCalledTimes(2);
    expect(requestCalendarCode).toHaveBeenCalledTimes(1);
    expect(notice(el)).toContain("wasn't granted");
  });

  it("changes nothing when the deployment has no Google client id", async () => {
    api.createDedicatedCalendar.mockRejectedValueOnce(scopeError());
    authApi.getConfig.mockResolvedValueOnce({ googleClientId: "" });

    const el = await render();
    await clickCreate(el);

    expect(requestCalendarCode).not.toHaveBeenCalled();
    expect(api.createDedicatedCalendar).toHaveBeenCalledTimes(1);
    expect(notice(el)).toContain("Couldn't reach Google");
  });

  it("reports a genuine failure as a failure, not as a scope problem", async () => {
    api.createDedicatedCalendar.mockRejectedValueOnce(new Error("boom"));

    const el = await render();
    await clickCreate(el);

    expect(requestCalendarCode).not.toHaveBeenCalled();
    expect(notice(el)).toContain("Couldn't create the calendar.");
  });
});
