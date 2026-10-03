import { describe, expect, it } from "bun:test";
import {
  businessIdForPath,
  businessPath,
  contractIdForPath,
  contractPath,
  contractTemplateIdForPath,
  contractTemplatePath,
  equipmentIdForPath,
  equipmentPath,
  inboxEmailPath,
  isBusinessesPath,
  isContractsPath,
  isEquipmentPath,
  libraryFolderIdForPath,
  libraryPath,
  signingTokenForPath,
} from "./workspacePaths";

describe("workspace paths", () => {
  it("round-trips business paths", () => {
    expect(businessPath()).toBe("/businesses");
    expect(businessPath("business/1")).toBe("/businesses/business%2F1");
    expect(businessIdForPath(businessPath("business/1"))).toBe("business/1");
    expect(businessIdForPath("/businesses")).toBeUndefined();
    expect(isBusinessesPath("/businesses/abc")).toBe(true);
    expect(isBusinessesPath("/businessesx")).toBe(false);
  });

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

  it("round-trips contract paths", () => {
    expect(contractPath()).toBe("/contracts");
    expect(contractPath("contract/1")).toBe("/contracts/contract%2F1");
    expect(contractIdForPath(contractPath("contract/1"))).toBe("contract/1");
    expect(contractIdForPath("/contracts")).toBeUndefined();
    expect(contractIdForPath("/contracts/a/b")).toBeUndefined();
    expect(isContractsPath("/contracts/abc")).toBe(true);
    expect(isContractsPath("/contractsx")).toBe(false);
  });

  it("round-trips contract template paths", () => {
    expect(contractTemplatePath()).toBe("/contracts/templates");
    expect(contractTemplateIdForPath(contractTemplatePath("template/1"))).toBe(
      "template/1",
    );
    expect(contractTemplateIdForPath("/contracts/templates")).toBeUndefined();
    expect(contractTemplateIdForPath("/contracts/templates/%E0%A4")).toBe(
      "%E0%A4",
    );
    expect(isContractsPath(contractTemplatePath("t1"))).toBe(true);
  });

  it("recognises public signing links", () => {
    const token = `${"A".repeat(40)}_-9`;
    expect(signingTokenForPath(`/sign/${token}`)).toBe(token);
    expect(signingTokenForPath(`/sign/${token}/`)).toBe(token);
    expect(signingTokenForPath(`/sign/${token}x`)).toBeUndefined();
    expect(signingTokenForPath("/sign/short")).toBeUndefined();
    expect(signingTokenForPath(`/sign/${token}/document`)).toBeUndefined();
  });

  it("opens a message in the inbox", () => {
    expect(inboxEmailPath("email 1")).toBe("/inbox?email=email+1");
  });
});
