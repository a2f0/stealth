import { describe, expect, it } from "bun:test";
import { dropIndex, moveEntry } from "./useReorderDrag";

describe("reordering", () => {
  it("moves one entry and keeps the rest in order", () => {
    expect(moveEntry(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveEntry(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveEntry(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(moveEntry(["a", "b"], 0, 2)).toEqual(["a", "b"]);
    expect(moveEntry(["a", "b"], -1, 0)).toEqual(["a", "b"]);
  });

  it("drops after every other entry whose middle is above the pointer", () => {
    const middles = [50, 150, 250];
    expect(dropIndex(middles, 0, 40)).toBe(0);
    expect(dropIndex(middles, 0, 160)).toBe(1);
    expect(dropIndex(middles, 0, 260)).toBe(2);
    expect(dropIndex(middles, 2, 10)).toBe(0);
    expect(dropIndex(middles, 2, 140)).toBe(1);
    expect(dropIndex(middles, 1, 400)).toBe(2);
  });
});
