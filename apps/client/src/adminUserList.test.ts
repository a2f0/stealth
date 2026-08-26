import { describe, expect, it } from "bun:test";
import { adminUserListQuery } from "./adminUserList";

describe("admin user listing", () => {
  it("excludes system actors from rows and totals", () => {
    expect(adminUserListQuery(2)).toEqual({
      filterField: "id",
      filterOperator: "ne",
      filterValue: "system:audit-library",
      limit: 25,
      offset: 50,
      sortBy: "createdAt",
      sortDirection: "desc",
    });
  });
});
