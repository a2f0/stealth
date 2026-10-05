import { describe, expect, it } from "bun:test";
import type { Business } from "./businessesApi";
import {
  type BusinessListEvent,
  type BusinessListState,
  businessListReducer,
  formatBusinessAddress,
  formatBusinessDate,
  formatDuns,
  formatEin,
  initialBusinessListState,
} from "./businessState";

function business(id: string, name: string): Business {
  return {
    city: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    duns: null,
    ein: null,
    id,
    incorporationDate: null,
    name,
    state: null,
    streetAddress: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    zip: null,
  };
}

function run(events: BusinessListEvent[], state = initialBusinessListState) {
  return events.reduce<BusinessListState>(businessListReducer, state);
}

const acme = business("business-1", "Acme, Inc.");
const loaded = run([
  { type: "loaded", data: { businesses: [acme], canManage: true } },
]);

describe("formatEin", () => {
  it("formats a normalized EIN for display", () => {
    expect(formatEin("123456789")).toBe("12-3456789");
    expect(formatEin("012345678")).toBe("01-2345678");
  });

  it("leaves unexpected values visible", () => {
    expect(formatEin("1234")).toBe("1234");
  });
});

describe("formatDuns", () => {
  it("groups a normalized DUNS number for display", () => {
    expect(formatDuns("123456789")).toBe("12-345-6789");
    expect(formatDuns("012345678")).toBe("01-234-5678");
  });

  it("leaves unexpected values visible", () => {
    expect(formatDuns("1234")).toBe("1234");
  });
});

describe("formatBusinessDate", () => {
  it("formats an ISO date without shifting time zones", () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(new Date("2026-08-22T00:00:00.000Z"));
    expect(formatBusinessDate("2026-08-22")).toBe(expected);
  });

  it("leaves unexpected values visible", () => {
    expect(formatBusinessDate("unknown")).toBe("unknown");
  });
});

describe("formatBusinessAddress", () => {
  const empty = { city: null, state: null, streetAddress: null, zip: null };

  it("joins street, city, state, and ZIP on one line", () => {
    expect(
      formatBusinessAddress({
        city: "Portland",
        state: "OR",
        streetAddress: "410 SW Alder St",
        zip: "97205",
      }),
    ).toBe("410 SW Alder St, Portland, OR 97205");
  });

  it("skips missing parts", () => {
    expect(
      formatBusinessAddress({ ...empty, streetAddress: "1 Main St" }),
    ).toBe("1 Main St");
    expect(
      formatBusinessAddress({ ...empty, city: "Austin", state: "TX" }),
    ).toBe("Austin, TX");
    expect(formatBusinessAddress({ ...empty, zip: "10001" })).toBe("10001");
    expect(formatBusinessAddress(empty)).toBe("");
  });
});

describe("businessListReducer", () => {
  it("loads, and reports a failed load", () => {
    expect(loaded).toMatchObject({ loading: false, error: undefined });
    expect(run([{ type: "loadFailed", message: "Offline." }])).toMatchObject({
      error: "Offline.",
      loading: false,
    });
    expect(
      run([{ type: "loadStarted" }], { ...loaded, error: "Offline." }),
    ).toMatchObject({ error: undefined, loading: true });
  });

  it("opens and cancels the on-demand add form", () => {
    const opened = run([{ type: "addOpened" }], loaded);
    expect(opened.adding).toBe(true);
    expect(run([{ type: "addCancelled" }], opened).adding).toBe(false);
  });

  it("folds the form away after a successful add", () => {
    const beta = business("business-2", "Beta LLC");
    const state = run(
      [
        { type: "addOpened" },
        { type: "failed", message: "Try again." },
        { type: "created", business: beta },
      ],
      loaded,
    );
    expect(state).toMatchObject({
      adding: false,
      error: undefined,
      notice: "Business added.",
    });
    expect(state.data?.businesses).toEqual([beta, acme]);
  });

  it("keeps the form open when an add fails", () => {
    const state = run(
      [{ type: "addOpened" }, { type: "failed", message: "Name taken." }],
      { ...loaded, notice: "Business updated." },
    );
    expect(state).toMatchObject({
      adding: true,
      error: "Name taken.",
      notice: undefined,
    });
    expect(state.data?.businesses).toEqual([acme]);
  });

  it("updates and deletes businesses in place", () => {
    const renamed = { ...acme, name: "Acme Holdings" };
    const updated = run([{ type: "updated", business: renamed }], loaded);
    expect(updated.data?.businesses).toEqual([renamed]);
    expect(updated.notice).toBe("Business updated.");

    const deleted = run([{ type: "deleted", id: acme.id }], updated);
    expect(deleted.data?.businesses).toEqual([]);
    expect(deleted.notice).toBe("Business deleted.");
  });

  it("names the copied identifier and clears a stale error", () => {
    const failed = run([{ type: "failed", message: "Offline." }], loaded);
    expect(
      run([{ type: "copied", identifier: "DUNS number" }], failed),
    ).toMatchObject({ error: undefined, notice: "DUNS number copied." });
    expect(run([{ type: "copied", identifier: "EIN" }], failed).notice).toBe(
      "EIN copied.",
    );
  });
});
