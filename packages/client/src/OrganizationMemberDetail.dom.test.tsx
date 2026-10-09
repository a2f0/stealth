import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@tearleads/ui/react";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { EmployeeRequirement } from "./employeeFormsApi";
import type {
  OrganizationMember,
  OrganizationPeopleData,
} from "./organizationSettingsApi";

const dom = new Window({ url: "http://localhost:5173/organization/people/m" });
const domGlobals = {
  document: dom.document,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let createRoot: (container: Element) => Root;
let OrganizationMemberDetail: typeof import("./OrganizationMemberDetail").OrganizationMemberDetail;
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
  ({ OrganizationMemberDetail } = await import("./OrganizationMemberDetail"));
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

function member(id: string, name: string, role = "member"): OrganizationMember {
  return {
    id,
    joinedAt: "2026-10-01T09:00:00.000Z",
    role,
    twoFactorEnabled: false,
    twoFactorRequired: false,
    user: { email: `${id}@example.com`, id: `user-${id}`, name },
  };
}

function requirement(memberId: string, title: string): EmployeeRequirement {
  return {
    checkrAvailable: false,
    checkrInvitationStatus: null,
    checkrPendingStart: false,
    checkrResult: null,
    checkrStarted: false,
    completedAt: null,
    documentFilename: null,
    documentRevision: 0,
    documentSize: null,
    dueDate: "2026-11-15",
    hasDocument: false,
    id: `${memberId}-${title}`,
    invitationId: null,
    invitationStatus: null,
    kind: "form",
    memberId,
    status: "pending",
    targetEmail: null,
    targetName: null,
    title,
  };
}

const members = [
  member("owner", "Olivia Owner", "owner"),
  member("mark", "Mark Member"),
];

/** Serves people and requirements, and records every other request. */
function stubApi(viewer: { currentMemberId: string; memberRole: string }) {
  const requests: Array<{ body: unknown; path: string }> = [];
  const people: OrganizationPeopleData = {
    ...viewer,
    invitations: [],
    members: [...members],
  };
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname.endsWith("/employee-forms")) {
      requests.push({ body: undefined, path: url.pathname });
      return Response.json({
        requirements: [
          requirement("mark", "W-9"),
          requirement("owner", "Owner form"),
        ],
      });
    }
    if (method === "GET") return Response.json(people);
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ body, path: url.pathname });
    if (url.pathname.endsWith("/organization/remove-member")) {
      people.members = people.members.filter(({ id }) => id !== "mark");
      return Response.json({ member: members[1] });
    }
    return Response.json({ ids: ["new"] });
  }) as typeof fetch;
  return requests;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(
  memberId: string,
  onNavigate: (pathname: string) => void = () => {},
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <>
        <OrganizationMemberDetail
          memberId={memberId}
          onAccessChanged={async () => {}}
          onNavigate={onNavigate}
          organization={{ id: "org-1", name: "Acme" }}
        />
        <DialogHost />
      </>,
    ),
  );
  await settle();
}

const button = (scope: ParentNode | null | undefined, label: string) =>
  [...(scope?.querySelectorAll("button") ?? [])].find(
    (element) => element.textContent?.trim() === label,
  ) ?? null;

async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => element?.click());
  await settle();
}

describe("a member's page", () => {
  it("shows a manager the member's profile and only their requests", async () => {
    const requests = stubApi({ currentMemberId: "owner", memberRole: "owner" });
    await render("mark");

    const text = container.textContent ?? "";
    expect(text).toContain("Mark Member");
    expect(text).toContain("mark@example.com");
    expect(text).toContain(
      `Joined${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date("2026-10-01T09:00:00.000Z"))}`,
    );
    expect(text).toContain("Require 2FA");
    expect(
      container.querySelector('select[aria-label="Role for Mark Member"]'),
    ).toBeTruthy();
    expect(text).toContain("W-9");
    expect(text).not.toContain("Owner form");
    expect(button(container, "Send requests")).toBeTruthy();
    expect(requests).toHaveLength(1);
  });

  it("returns to the list after removing the member", async () => {
    const paths: string[] = [];
    const requests = stubApi({ currentMemberId: "owner", memberRole: "owner" });
    await render("mark", (path) => paths.push(path));

    await click(button(container, "Remove from organization"));
    await click(
      button(document.querySelector("dialog[open]"), "Remove member"),
    );
    expect(requests.at(-1)).toEqual({
      body: { memberIdOrEmail: "mark", organizationId: "org-1" },
      path: "/api/auth/organization/remove-member",
    });
    expect(paths).toEqual(["/organization/people"]);
  });

  it("shows a member their own requests without manager controls", async () => {
    stubApi({ currentMemberId: "mark", memberRole: "member" });
    await render("mark");

    const text = container.textContent ?? "";
    expect(text).toContain("You");
    expect(text).toContain("W-9");
    expect(text).toContain("requested from you");
    expect(button(container, "Send requests")).toBeNull();
    expect(button(container, "Remove from organization")).toBeNull();
    expect(text).not.toContain("Require 2FA");
  });

  it("keeps another member's requests private", async () => {
    const requests = stubApi({ currentMemberId: "mark", memberRole: "member" });
    await render("owner");

    expect(container.textContent).toContain("Olivia Owner");
    expect(container.textContent).not.toContain("Forms and checks");
    expect(requests).toEqual([]);
  });

  it("explains when the member is no longer in the organization", async () => {
    stubApi({ currentMemberId: "owner", memberRole: "owner" });
    await render("gone");
    expect(container.textContent).toContain("This member isn’t here");
    const back = [...container.querySelectorAll("a")].find(
      (link) => link.textContent === "All people",
    );
    expect(back?.getAttribute("href")).toBe("/organization/people");
  });
});
