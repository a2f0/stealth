import { describe, expect, it } from "bun:test";
import {
  equipmentName,
  equipmentTypeIcon,
  equipmentTypeLabel,
} from "./equipmentLabels";

describe("equipment labels", () => {
  it("names the starting types and falls back for types added later", () => {
    expect(equipmentTypeLabel("computer")).toBe("Computer");
    expect(equipmentTypeLabel("cell_phone")).toBe("Cell phone");
    expect(equipmentTypeLabel("monitor")).toBe("Monitor");
    expect(equipmentTypeLabel("docking_station")).toBe("Docking station");
    expect(equipmentTypeIcon("cell_phone")).toBe("cellPhone");
    expect(equipmentTypeIcon("docking_station")).toBe("equipment");
  });

  it("names an item by make and model", () => {
    expect(equipmentName({ make: "Apple", model: "MacBook Pro" })).toBe(
      "Apple MacBook Pro",
    );
  });
});
