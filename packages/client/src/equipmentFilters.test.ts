import { describe, expect, it } from "bun:test";
import { filterEquipment } from "./equipmentFilters";

const items = [
  { assignee: { id: "ana" }, id: "laptop", type: "computer" },
  { assignee: null, id: "monitor", type: "monitor" },
  { assignee: { id: "ben" }, id: "phone", type: "cell_phone" },
  { assignee: null, id: "spare-laptop", type: "computer" },
];
const ids = (type: string, assignee: string) =>
  filterEquipment(items, type, assignee).map(({ id }) => id);

describe("filterEquipment", () => {
  it("shows everything without filters", () => {
    expect(ids("all", "everyone")).toEqual([
      "laptop",
      "monitor",
      "phone",
      "spare-laptop",
    ]);
  });

  it("filters by type and by assignee, alone and together", () => {
    expect(ids("computer", "everyone")).toEqual(["laptop", "spare-laptop"]);
    expect(ids("all", "unassigned")).toEqual(["monitor", "spare-laptop"]);
    expect(ids("all", "ben")).toEqual(["phone"]);
    expect(ids("computer", "unassigned")).toEqual(["spare-laptop"]);
    expect(ids("computer", "ana")).toEqual(["laptop"]);
    expect(ids("monitor", "ana")).toEqual([]);
  });
});
