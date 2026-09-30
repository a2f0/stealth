import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BusinessListView } from "./Businesses";
import type { Business, BusinessListing } from "./businessesApi";

const acme: Business = {
  city: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  ein: null,
  id: "business-1",
  incorporationDate: null,
  name: "Acme, Inc.",
  state: null,
  streetAddress: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
  zip: null,
};

function renderBusinesses(
  data: BusinessListing,
  options: { adding?: boolean; notice?: string } = {},
) {
  const noop = () => {};
  return renderToStaticMarkup(
    <BusinessListView
      adding={options.adding ?? false}
      data={data}
      error={undefined}
      loading={false}
      notice={options.notice}
      onAddingChange={noop}
      onCreated={noop}
      onDeleted={noop}
      onError={noop}
      onNavigate={noop}
      onUpdated={noop}
    />,
  );
}

const headerAction = /<div class="pageActions">[\s\S]*?Add business<\/button>/;
const createForm = "Add a business";
const cancel = ">Cancel</button>";

describe("business list page", () => {
  it("opens the add form while the organization has no businesses", () => {
    const html = renderBusinesses({ businesses: [], canManage: true });
    expect(html).toContain(createForm);
    expect(html).not.toMatch(headerAction);
    expect(html).not.toContain(cancel);
  });

  it("folds the add form behind a header action once a business exists", () => {
    const html = renderBusinesses(
      { businesses: [acme], canManage: true },
      { notice: "Business added." },
    );
    expect(html).toMatch(headerAction);
    expect(html).not.toContain(createForm);
    expect(html).toContain("Business added.");
    expect(html).toContain("Acme, Inc.");
  });

  it("shows the add form with a cancel when opened on demand", () => {
    const html = renderBusinesses(
      { businesses: [acme], canManage: true },
      { adding: true },
    );
    expect(html).toContain(createForm);
    expect(html).toContain(cancel);
    expect(html).not.toMatch(headerAction);
  });

  it("offers no way to add a business to read-only members", () => {
    for (const businesses of [[], [acme]]) {
      const html = renderBusinesses({ businesses, canManage: false });
      expect(html).not.toContain(createForm);
      expect(html).not.toMatch(headerAction);
      expect(html).toContain("Only organization owners and admins");
    }
  });
});
