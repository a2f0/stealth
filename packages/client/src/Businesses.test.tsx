import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BusinessListView } from "./Businesses";
import type { Business, BusinessListing } from "./businessesApi";
import {
  type BusinessListEvent,
  type BusinessListState,
  businessListReducer,
  initialBusinessListState,
} from "./businessState";

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

function renderState(state: BusinessListState) {
  const noop = () => {};
  return renderToStaticMarkup(
    <BusinessListView
      {...state}
      onAddingChange={noop}
      onCreated={noop}
      onDeleted={noop}
      onError={noop}
      onNavigate={noop}
      onUpdated={noop}
    />,
  );
}

function renderBusinesses(
  data: BusinessListing,
  options: { adding?: boolean; notice?: string } = {},
) {
  return renderState({
    adding: options.adding ?? false,
    data,
    error: undefined,
    loading: false,
    notice: options.notice,
  });
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

describe("adding a business", () => {
  // Drives the page's own reducer through what a user does, rendering each
  // state the way the page would.
  function step(state: BusinessListState, event: BusinessListEvent) {
    const next = businessListReducer(state, event);
    return { html: renderState(next), next };
  }

  it("walks from the first business through an on-demand add", () => {
    const beta: Business = { ...acme, id: "business-2", name: "Beta LLC" };
    let state = businessListReducer(initialBusinessListState, {
      type: "loaded",
      data: { businesses: [], canManage: true },
    });
    expect(renderState(state)).toContain(createForm);

    let view = step(state, { type: "created", business: acme });
    expect(view.html).not.toContain(createForm);
    expect(view.html).toMatch(headerAction);
    state = view.next;

    view = step(state, { type: "addOpened" });
    expect(view.html).toContain(createForm);
    expect(view.html).toContain(cancel);
    state = view.next;

    view = step(state, { type: "addCancelled" });
    expect(view.html).not.toContain(createForm);
    expect(view.html).toMatch(headerAction);
    state = view.next;

    view = step(state, { type: "addOpened" });
    view = step(view.next, { type: "failed", message: "Name taken." });
    expect(view.html).toContain(createForm);
    expect(view.html).toContain("Name taken.");
    state = view.next;

    view = step(state, { type: "created", business: beta });
    expect(view.html).not.toContain(createForm);
    expect(view.html).toMatch(headerAction);
    expect(view.html).toContain("Business added.");
    expect(view.html).not.toContain("Name taken.");
    expect(view.html).toContain("2 businesses");
  });

  it("reopens the form when the last business is deleted", () => {
    const state = businessListReducer(
      { ...initialBusinessListState, loading: false },
      { type: "loaded", data: { businesses: [acme], canManage: true } },
    );
    const view = step(state, { type: "deleted", id: acme.id });
    expect(view.html).toContain(createForm);
    expect(view.html).not.toMatch(headerAction);
  });
});
