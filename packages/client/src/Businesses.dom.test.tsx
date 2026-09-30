import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { Businesses } from "./Businesses";
import type { Business } from "./businessesApi";

// Mounts the real page in happy-dom so effects run: the add form folds away
// and focus moves the way a keyboard user would experience it.
const dom = new Window({ url: "http://localhost:5173/businesses" });
const domGlobals = {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let createRoot: (container: Element) => Root;

beforeAll(async () => {
  for (const [key, value] of Object.entries(domGlobals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  // React DOM decides whether it can use the DOM when first loaded.
  ({ createRoot } = await import("react-dom/client"));
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

const mounted: { container: HTMLElement; root: Root }[] = [];

afterEach(async () => {
  for (const { container, root } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  globalThis.fetch = originalFetch;
});

function business(id: string, name: string): Business {
  return {
    city: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    ein: null,
    id,
    incorporationDate: null,
    name,
    state: null,
    streetAddress: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    zip: null,
  };
}

/** Serves the listing, and answers each create with `createResponse`. */
function stubApi(
  businesses: Business[],
  createResponse: (name: string) => Response,
) {
  const created: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    if ((init?.method ?? "GET") === "GET") {
      return Response.json({ businesses, canManage: true });
    }
    const { name } = JSON.parse(String(init?.body)) as { name: string };
    created.push(name);
    return createResponse(name);
  }) as typeof fetch;
  return created;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountPage() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () =>
    root.render(<Businesses onNavigate={() => {}} pathname="/businesses" />),
  );
  await settle();
  return page(container);
}

function page(container: HTMLElement) {
  const form = () =>
    [...container.querySelectorAll("form")].find((element) =>
      element.textContent?.includes("Add a business"),
    );
  // Null, not undefined, when absent: `document.activeElement` compares to it.
  const button = (scope: Element | null | undefined, label: string) =>
    [...(scope?.querySelectorAll("button") ?? [])].find(
      (element) => element.textContent?.trim() === label,
    ) ?? null;
  return {
    addButton: () =>
      button(container.querySelector(".pageActions"), "Add business"),
    cancelButton: () => button(form(), "Cancel"),
    form,
    nameField: () =>
      form()?.querySelector<HTMLInputElement>(
        'input[placeholder="Acme, Inc."]',
      ) ?? null,
    rows: () => container.querySelectorAll(".rowList > li").length,
    submitButton: () =>
      form()?.querySelector<HTMLButtonElement>('button[type="submit"]'),
    text: () => container.textContent ?? "",
  };
}

async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => element?.click());
  await settle();
}

async function typeName(
  field: HTMLInputElement | null | undefined,
  value: string,
) {
  expect(field).toBeTruthy();
  const setValue = Object.getOwnPropertyDescriptor(
    dom.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setValue?.call(field, value);
    field?.dispatchEvent(new dom.Event("input", { bubbles: true }) as never);
  });
}

describe("adding a business, mounted", () => {
  it("opens the form on arrival for the first business without moving focus", async () => {
    stubApi([], (name) => Response.json({ business: business("b1", name) }));
    const view = await mountPage();
    expect(view.form()).toBeTruthy();
    expect(view.addButton()).toBeNull();
    expect(view.cancelButton()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("folds the form away after the first business and focuses Add", async () => {
    const created = stubApi([], (name) =>
      Response.json({ business: business("b1", name) }),
    );
    const view = await mountPage();
    await typeName(view.nameField(), "Acme, Inc.");
    await click(view.submitButton());

    expect(created).toEqual(["Acme, Inc."]);
    expect(view.form()).toBeUndefined();
    expect(view.rows()).toBe(1);
    expect(view.text()).toContain("Business added.");
    expect(document.activeElement).toBe(view.addButton());
  });

  it("opens on demand into the name field, and cancel returns focus", async () => {
    stubApi([business("b1", "Acme, Inc.")], (name) =>
      Response.json({ business: business("b2", name) }),
    );
    const view = await mountPage();
    expect(view.form()).toBeUndefined();

    await click(view.addButton());
    expect(view.form()).toBeTruthy();
    expect(document.activeElement).toBe(view.nameField());

    await click(view.cancelButton());
    expect(view.form()).toBeUndefined();
    expect(document.activeElement).toBe(view.addButton());
  });

  it("adds on demand, then folds away and focuses Add", async () => {
    const created = stubApi([business("b1", "Acme, Inc.")], (name) =>
      Response.json({ business: business("b2", name) }),
    );
    const view = await mountPage();
    await click(view.addButton());
    await typeName(view.nameField(), "Beta LLC");
    await click(view.submitButton());

    expect(created).toEqual(["Beta LLC"]);
    expect(view.form()).toBeUndefined();
    expect(view.rows()).toBe(2);
    expect(document.activeElement).toBe(view.addButton());
  });

  it("keeps the form and its values open when an add fails", async () => {
    stubApi([business("b1", "Acme, Inc.")], () =>
      Response.json({ error: "Name taken." }, { status: 409 }),
    );
    const view = await mountPage();
    await click(view.addButton());
    await typeName(view.nameField(), "Beta LLC");
    await click(view.submitButton());

    expect(view.form()).toBeTruthy();
    expect(view.nameField()?.value).toBe("Beta LLC");
    expect(view.text()).toContain("Name taken.");
    expect(view.rows()).toBe(1);
  });
});
