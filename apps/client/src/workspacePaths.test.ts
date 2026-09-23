import { describe, expect, it } from "bun:test";
import {
  equipmentIdForPath,
  equipmentPath,
  inboxEmailPath,
  isEquipmentPath,
  libraryFolderIdForPath,
  libraryPath,
} from "./workspacePaths";

describe("workspace paths", () => {
  it("round-trips library folder paths", () => {
    expect(libraryPath()).toBe("/");
    expect(libraryPath("folder/1")).toBe("/library/folder%2F1");
    expect(libraryFolderIdForPath(libraryPath("folder/1"))).toBe("folder/1");
    expect(libraryFolderIdForPath("/library/abc/")).toBe("abc");
    expect(libraryFolderIdForPath("/")).toBeUndefined();
    expect(libraryFolderIdForPath("/library")).toBeUndefined();
    expect(libraryFolderIdForPath("/library/a/b")).toBeUndefined();
    expect(libraryFolderIdForPath("/library/%E0%A4")).toBe("%E0%A4");
  });

  it("round-trips equipment paths", () => {
    expect(equipmentPath()).toBe("/equipment");
    expect(equipmentPath("item/1")).toBe("/equipment/item%2F1");
    expect(equipmentIdForPath(equipmentPath("item/1"))).toBe("item/1");
    expect(equipmentIdForPath("/equipment")).toBeUndefined();
    expect(equipmentIdForPath("/equipment/%E0%A4")).toBe("%E0%A4");
    expect(isEquipmentPath("/equipment")).toBe(true);
    expect(isEquipmentPath("/equipment/abc")).toBe(true);
    expect(isEquipmentPath("/equipments")).toBe(false);
  });

  it("opens a message in the inbox", () => {
    expect(inboxEmailPath("email 1")).toBe("/inbox?email=email+1");
  });
});
