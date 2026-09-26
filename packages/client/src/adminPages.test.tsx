import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminOrganizations } from "./AdminOrganizations";
import { AdminUsers } from "./AdminUsers";

describe("root admin pages", () => {
  it("keeps the user listing on the Users page", () => {
    const markup = renderToStaticMarkup(<AdminUsers />);

    expect(markup).toContain("All users");
    expect(markup).toContain("Loading users…");
    expect(markup).not.toContain("All organizations");
    expect(markup).not.toContain("Loading organizations…");
  });

  it("keeps the organization listing on the Organizations page", () => {
    const markup = renderToStaticMarkup(<AdminOrganizations />);

    expect(markup).toContain("All organizations");
    expect(markup).toContain("Loading organizations…");
    expect(markup).not.toContain("All users");
    expect(markup).not.toContain("Loading users…");
  });
});
