import { describe, expect, it } from "bun:test";
import {
  inboxEmailPath,
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
  });

  it("opens a message in the inbox", () => {
    expect(inboxEmailPath("email 1")).toBe("/inbox?email=email+1");
  });
});
