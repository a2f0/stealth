import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AdminOrganizations } from "./AdminOrganizations";
import type { AdminOrganizationDetail } from "./api";

const dom = new Window({ url: "http://localhost:5173/root/organizations" });
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
let root: Root | undefined;
let container: HTMLElement;

beforeAll(async () => {
  for (const [key, value] of Object.entries(domGlobals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  ({ createRoot } = await import("react-dom/client"));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

function detail(id = "other/org"): AdminOrganizationDetail {
  return {
    organization: {
      createdAt: "2026-10-07T11:00:00.000Z",
      deletedAt: null,
      deletedByEmail: null,
      deletedByName: null,
      deletedByUserId: null,
      id,
      memberCount: 1,
      name: `Organization ${id}`,
      ownerEmail: "pat@example.com",
      ownerName: "Pat Person",
      slug: "other-organization",
    },
    members: [
      {
        id: "member-1",
        joinedAt: "2026-10-07T11:00:00.000Z",
        role: "owner",
        twoFactorEnabled: true,
        user: { id: "user-1", email: "pat@example.com", name: "Pat Person" },
      },
    ],
    requirements: [
      {
        checkrInvitationStatus: "completed",
        checkrReportUrl:
          "https://dashboard.checkrhq-staging.net/reports/report-1",
        checkrResult: "consider",
        completedAt: "2026-10-07T11:09:18.000Z",
        dueDate: "2026-10-31",
        id: "check-1",
        kind: "background_check",
        status: "complete",
        targetEmail: "pat@example.com",
        targetName: "Pat Person",
        title: "Background check",
      },
    ],
  };
}

async function render(
  pathname = "/root/organizations",
  onNavigate?: (path: string) => void,
) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  const navigate = onNavigate ?? (() => {});
  await act(async () =>
    root?.render(
      <AdminOrganizations onNavigate={navigate} pathname={pathname} />,
    ),
  );
}

function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(text),
  );
  if (!found) throw new Error(`No button labeled ${text}`);
  return found;
}

describe("root organization details", () => {
  it("opens the clicked organization and returns to the list using only reads", async () => {
    const fixture = detail();
    const requests: Array<{
      url: string;
      method: string;
      credentials: string | undefined;
    }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        credentials: init?.credentials,
      });
      return Response.json(
        url.endsWith("/other%2Forg")
          ? fixture
          : { organizations: [fixture.organization] },
      );
    }) as typeof fetch;
    const paths: string[] = [];
    const navigate = (path: string) => {
      paths.push(path);
      root?.render(
        <AdminOrganizations onNavigate={navigate} pathname={path} />,
      );
    };
    await render(undefined, navigate);
    const link = container.querySelector<HTMLAnchorElement>(
      ".adminOrganizationLink",
    );
    expect(link?.getAttribute("href")).toBe("/root/organizations/other%2Forg");
    await act(async () => link?.click());
    expect(paths).toEqual(["/root/organizations/other%2Forg"]);
    expect(container.querySelector("h1")?.textContent).toBe(
      "Organization other/org",
    );
    expect(container.textContent).toContain("pat@example.com");
    expect(container.textContent).toContain("Background check");
    expect(container.textContent).toContain("Consider");
    expect(container.textContent).toContain("Review the report in Checkr.");
    const report =
      container.querySelector<HTMLAnchorElement>('a[target="_blank"]');
    expect(report?.href).toBe(
      fixture.requirements[0]?.checkrReportUrl ?? undefined,
    );
    expect(report?.rel).toBe("noopener noreferrer");
    await act(async () => button("Organizations").click());
    expect(paths.at(-1)).toBe("/root/organizations");
    expect(container.querySelector("h1")?.textContent).toBe("Organizations");
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
    ]);
    expect(
      requests.every((request) => request.credentials === "include"),
    ).toBeTrue();
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/admin/organizations",
      "/api/admin/organizations/other%2Forg",
      "/api/admin/organizations",
    ]);
  });

  it("keeps modified clicks available for opening a new tab", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        organizations: [detail().organization],
      })) as unknown as typeof fetch;
    const paths: string[] = [];
    await render(undefined, (path) => paths.push(path));
    const link = container.querySelector<HTMLAnchorElement>(
      ".adminOrganizationLink",
    );
    const event = new dom.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    link?.dispatchEvent(event as unknown as Event);
    expect(event.defaultPrevented).toBeFalse();
    expect(paths).toEqual([]);
  });

  it("shows errors and allows retrying an empty organization", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return attempts === 1
        ? Response.json({ error: "Organization not found." }, { status: 404 })
        : Response.json({ ...detail(), members: [], requirements: [] });
    }) as unknown as typeof fetch;
    await render("/root/organizations/other%2Forg");
    expect(container.textContent).toContain("Organization not found.");
    await act(async () => button("Refresh").click());
    expect(container.textContent).not.toContain("Organization not found.");
    expect(container.textContent).toContain("No members found.");
    expect(container.textContent).toContain("No requirements assigned yet.");
  });

  it("ignores a previous organization's response after navigation", async () => {
    let finishFirst: ((response: Response) => void) | undefined;
    globalThis.fetch = ((input) =>
      String(input).endsWith("/first")
        ? new Promise<Response>((resolve) => {
            finishFirst = resolve;
          })
        : Promise.resolve(Response.json(detail("second")))) as typeof fetch;
    await render("/root/organizations/first");
    expect(container.textContent).toContain("Loading organization details…");
    await render("/root/organizations/second");
    await act(async () => finishFirst?.(Response.json(detail("first"))));
    expect(container.querySelector("h1")?.textContent).toBe(
      "Organization second",
    );
    expect(container.textContent).not.toContain("Organization first");
  });
});
