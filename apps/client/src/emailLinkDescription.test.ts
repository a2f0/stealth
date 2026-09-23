import { describe, expect, it } from "bun:test";
import { describeEmailLink } from "./emailLinkDescription";

describe("describeEmailLink", () => {
  it("describes folder links", () => {
    expect(
      describeEmailLink({
        folder: { name: "Receipts" },
        id: "link-1",
        targetId: "folder/1",
        targetType: "library_folder",
      }),
    ).toEqual({
      icon: "folder",
      label: "Receipts",
      path: "/library/folder%2F1",
    });
  });

  it("describes equipment links with and without a serial number", () => {
    const equipment = {
      make: "Apple",
      model: "MacBook Pro",
      serialNumber: "C02XYZ" as string | null,
      type: "computer",
    };
    expect(
      describeEmailLink({
        equipment,
        id: "link-2",
        targetId: "item-1",
        targetType: "equipment",
      }),
    ).toEqual({
      icon: "computer",
      label: "Apple MacBook Pro · C02XYZ",
      path: "/equipment/item-1",
    });
    expect(
      describeEmailLink({
        equipment: { ...equipment, serialNumber: null, type: "tablet" },
        id: "link-3",
        targetId: "item-2",
        targetType: "equipment",
      }),
    ).toMatchObject({ icon: "equipment", label: "Apple MacBook Pro" });
  });

  it("describes transaction links by merchant, outflow, and date", () => {
    const description = describeEmailLink({
      id: "link-4",
      targetId: "txn-1",
      targetType: "finance_transaction",
      transaction: {
        amount: 42.75,
        currencyCode: "USD",
        date: "2026-09-18",
        merchantName: "Test Cafe",
        name: "TEST CAFE 042",
      },
    });
    expect(description.icon).toBe("finance");
    expect(description.path).toBe("/finance");
    expect(description.label).toStartWith("Test Cafe · ");
    expect(description.label).toContain("42.75");
    expect(description.label).toContain("2026");
  });
});
