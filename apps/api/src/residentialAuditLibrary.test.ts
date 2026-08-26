import { describe, expect, it } from "bun:test";
import { parseAuditDefinition } from "./auditDefinition";
import {
  residentialCoreStarter,
  residentialLibraryStats,
  validateResidentialLibrary,
} from "./residentialAuditLibrary";

describe("residential audit library", () => {
  it("keeps every control attributable and structurally valid", () => {
    expect(validateResidentialLibrary()).toEqual([]);
    expect(parseAuditDefinition(residentialCoreStarter.definition)).toEqual(
      residentialCoreStarter.definition,
    );
  });

  it("ships a substantial cross-trade residential baseline", () => {
    expect(residentialLibraryStats.sections).toBe(19);
    expect(residentialLibraryStats.controls).toBe(253);
    expect(residentialLibraryStats.criticalControls).toBeGreaterThanOrEqual(50);
    expect(residentialLibraryStats.sources).toBeGreaterThanOrEqual(25);
  });

  it("does not present the baseline as a code-compliance certification", () => {
    expect(residentialCoreStarter.description).toContain(
      "not a code-compliance certification",
    );
    expect(residentialCoreStarter.description).toContain("State Plan");
    expect(residentialCoreStarter.description).toContain("local");
  });
});
