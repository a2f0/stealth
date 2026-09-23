import { describe, expect, it } from "bun:test";
import {
  clampBox,
  contractStatus,
  describeContractEvent,
  initialsFor,
  isOverdue,
  matchesFilter,
  nudgeBox,
  placeNewField,
  recipientTone,
} from "./contractFields";

const letter = { height: 792, width: 612 };

describe("placeNewField", () => {
  it("centres a field's default size on the click", () => {
    const box = placeNewField("signature", 2, { x: 0.5, y: 0.5 }, letter);
    expect(box.page).toBe(2);
    expect(box.width).toBeCloseTo(180 / 612);
    expect(box.height).toBeCloseTo(44 / 792);
    expect(box.x).toBeCloseTo(0.5 - 90 / 612, 3);
    expect(box.y).toBeCloseTo(0.5 - 22 / 792, 3);
  });

  it("keeps fields on the page near its edges", () => {
    const corner = placeNewField("signature", 1, { x: 0.99, y: 0.99 }, letter);
    expect(corner.x + corner.width).toBeLessThanOrEqual(1);
    expect(corner.y + corner.height).toBeLessThanOrEqual(1);
    expect(
      clampBox({ height: 0.1, page: 1, width: 0.2, x: -0.3, y: 1.5 }),
    ).toEqual({
      height: 0.1,
      page: 1,
      width: 0.2,
      x: 0,
      y: 0.9,
    });
  });
});

describe("nudgeBox", () => {
  it("moves a field by page fractions without leaving the page", () => {
    const box = { height: 0.1, page: 2, width: 0.2, x: 0.5, y: 0.5 };
    expect(nudgeBox(box, 0.01, -0.05)).toEqual({ ...box, x: 0.51, y: 0.45 });
    expect(nudgeBox(box, 0.5, 0.5)).toEqual({ ...box, x: 0.8, y: 0.9 });
    expect(nudgeBox({ ...box, x: 0.005 }, -0.01, 0).x).toBe(0);
  });
});

describe("contract status", () => {
  it("labels statuses and flags contracts past their due date", () => {
    expect(contractStatus({ dueDate: null, status: "draft" }).label).toBe(
      "Draft",
    );
    expect(
      contractStatus({ dueDate: "2026-10-01", status: "sent" }, "2026-09-30"),
    ).toEqual({
      label: "Waiting for signatures",
      tone: "info",
    });
    expect(
      contractStatus({ dueDate: "2026-10-01", status: "sent" }, "2026-10-02"),
    ).toEqual({
      label: "Overdue",
      tone: "warning",
    });
    expect(
      isOverdue({ dueDate: "2026-10-01", status: "completed" }, "2026-12-01"),
    ).toBe(false);
    expect(
      isOverdue({ dueDate: "2026-10-01", status: "sent" }, "2026-10-01"),
    ).toBe(false);
  });

  it("filters contracts into list tabs", () => {
    expect(matchesFilter("sent", "waiting")).toBe(true);
    expect(matchesFilter("voided", "closed")).toBe(true);
    expect(matchesFilter("declined", "closed")).toBe(true);
    expect(matchesFilter("draft", "completed")).toBe(false);
    expect(matchesFilter("completed", "all")).toBe(true);
  });
});

describe("contract labels", () => {
  it("derives initials and cycles signer colours", () => {
    expect(initialsFor("Sam  Signer")).toBe("SS");
    expect(initialsFor("mary ann de la cruz")).toBe("MAD");
    expect(recipientTone(0)).toBe("recipientTone0");
    expect(recipientTone(7)).toBe("recipientTone1");
  });

  it("describes activity with signer names", () => {
    const names = new Map([["r1", "Sam Signer"]]);
    const event = {
      actorName: "Olivia",
      createdAt: "",
      detail: null,
      id: "e",
      ip: null,
      recipientId: "r1",
    };
    expect(describeContractEvent({ ...event, type: "signed" }, names)).toBe(
      "Sam Signer signed",
    );
    expect(
      describeContractEvent(
        { ...event, detail: "Wrong rate", type: "declined" },
        names,
      ),
    ).toBe("Sam Signer declined: “Wrong rate”");
    expect(describeContractEvent({ ...event, type: "sent" }, names)).toBe(
      "Olivia sent it for signature",
    );
  });
});
