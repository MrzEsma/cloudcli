import { describe, expect, it } from "vitest";
import { formatRecurrenceSummary, nextOccurrenceForRecurrence, validateRecurrenceDefinition } from "../../src/server/recurrence.js";

describe("recurrence", () => {
  it("computes the next daily occurrence", () => {
    const next = nextOccurrenceForRecurrence(
      {
        scheduleType: "daily",
        timezone: "Europe/Paris",
        localTime: "09:00"
      },
      "2026-04-26T07:00:00.000Z"
    );

    expect(next).toBeTruthy();
  });

  it("clamps monthly recurrences to the last day of short months", () => {
    const next = nextOccurrenceForRecurrence(
      {
        scheduleType: "monthly",
        timezone: "Europe/Paris",
        localTime: "09:00",
        dayOfMonth: 31,
        monthlyOverflowPolicy: "clamp_to_last_day"
      },
      "2026-04-28T07:00:00.000Z"
    );

    expect(next?.startsWith("2026-04-30") || next?.startsWith("2026-05-31")).toBe(true);
  });

  it("uses the last valid day for February when the monthly schedule targets the 31st", () => {
    const next = nextOccurrenceForRecurrence(
      {
        scheduleType: "monthly",
        timezone: "Europe/Paris",
        localTime: "09:00",
        dayOfMonth: 31,
        monthlyOverflowPolicy: "clamp_to_last_day"
      },
      "2026-02-01T00:00:00.000Z"
    );

    expect(next?.startsWith("2026-02-28T08:00")).toBe(true);
  });

  it("returns to the configured day when the following month supports it", () => {
    const next = nextOccurrenceForRecurrence(
      {
        scheduleType: "monthly",
        timezone: "Europe/Paris",
        localTime: "09:00",
        dayOfMonth: 31,
        monthlyOverflowPolicy: "clamp_to_last_day"
      },
      "2026-02-28T08:00:00.000Z"
    );

    expect(next?.startsWith("2026-03-31T07:00")).toBe(true);
  });

  it("renders human-readable summaries", () => {
    const summary = formatRecurrenceSummary({
      scheduleType: "weekly",
      timezone: "Europe/Paris",
      localTime: "09:00",
      dayOfWeek: "monday"
    });

    expect(summary).toContain("monday");
  });

  it("rejects invalid weekday values", () => {
    expect(() =>
      validateRecurrenceDefinition({
        scheduleType: "weekdays",
        timezone: "Europe/Paris",
        localTime: "09:00",
        weekdays: ["mon" as never]
      })
    ).toThrow("Invalid weekday: mon");
  });
});
