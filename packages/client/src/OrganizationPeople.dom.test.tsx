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

const dom = new Window({ url: "http://localhost:5173/organization/people" });
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
let OrganizationPeople: typeof import("./OrganizationPeople").OrganizationPeople;
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
  ({ OrganizationPeople } = await import("./OrganizationPeople"));
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

function requirement(
  overrides: Partial<EmployeeRequirement>,
): EmployeeRequirement {
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
    id: crypto.randomUUID(),
    invitationId: null,
    invitationStatus: null,
    kind: "form",
    memberId: null,
    status: "pending",
    targetEmail: null,
    targetName: null,
    title: "W-4",
    ...overrides,
  };
}

const owner = member("owner", "Olivia Owner", "owner");

/**
 * Serves people and requirements; an invitation joins the pending list, and
 * the first `failedRequests` request posts fail.
 */
function stubApi(
  people: OrganizationPeopleData,
  requirements: EmployeeRequirement[] = [],
  failedRequests = 0,
  failedListings = 0,
) {
  const invited: string[] = [];
  const requested: unknown[] = [];
  let failures = failedRequests;
  let listingFailures = failedListings;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/employee-forms") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        invitationId?: string;
        requirements: Array<{ title: string }>;
      };
      requested.push(body);
      if (failures > 0) {
        failures -= 1;
        return Response.json(
          { error: "Requirement service unavailable." },
          { status: 503 },
        );
      }
      for (const draft of body.requirements) {
        requirements.push(
          requirement({
            invitationId: body.invitationId ?? null,
            targetEmail:
              people.invitations.find(({ id }) => id === body.invitationId)
                ?.email ?? null,
            title: draft.title,
          }),
        );
      }
      return Response.json({ ids: ["new"] });
    }
    if (url.pathname.endsWith("/organization/invite-member")) {
      const body = JSON.parse(String(init?.body)) as {
        email: string;
        role: string;
      };
      invited.push(body.email);
      people.invitations.push({
        email: body.email,
        expiresAt: "2026-10-11T09:00:00.000Z",
        id: `invitation-${invited.length}`,
        role: body.role,
        status: "pending",
      });
      return Response.json({ id: `invitation-${invited.length}`, ...body });
    }
    if (url.pathname.endsWith("/employee-forms")) {
      if (listingFailures > 0) {
        listingFailures -= 1;
        return Response.json(
          { error: "Requirement service unavailable." },
          { status: 503 },
        );
      }
      return Response.json({ requirements });
    }
    return Response.json(people);
  }) as typeof fetch;
  return { invited, requested };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(onNavigate: (pathname: string) => void = () => {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <>
        <OrganizationPeople
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

const inviteForm = () =>
  [...container.querySelectorAll("form")].find((form) =>
    form.textContent?.includes("Invite a member"),
  );
const button = (scope: Element | null | undefined, label: string) =>
  [...(scope?.querySelectorAll("button") ?? [])].find(
    (element) => element.textContent?.trim() === label,
  ) ?? null;
const inviteButton = () => button(container, "Invite member");
const emailField = () =>
  inviteForm()?.querySelector<HTMLInputElement>('input[name="invite-email"]') ??
  null;

async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => element?.click());
  await settle();
}

async function type(field: HTMLInputElement | null, value: string) {
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

describe("inviting people", () => {
  it("keeps the form open while the owner is alone, then folds it after the first invitation", async () => {
    const { invited } = stubApi({
      currentMemberId: "owner",
      invitations: [],
      memberRole: "owner",
      members: [owner],
    });
    await render();
    expect(inviteForm()).toBeTruthy();
    expect(inviteButton()).toBeNull();
    expect(button(inviteForm(), "Cancel")).toBeNull();

    await type(emailField(), "new@example.com");
    await click(button(inviteForm(), "Send invitation"));

    expect(invited).toEqual(["new@example.com"]);
    expect(inviteForm()).toBeUndefined();
    expect(container.textContent).toContain(
      "Invitation sent to new@example.com with the member role.",
    );
    expect(container.textContent).toContain("Pending invitations");
    expect(document.activeElement).toBe(inviteButton());
  });

  it("keeps the form and its requests when only the requests fail, then retries them", async () => {
    const { invited, requested } = stubApi(
      {
        currentMemberId: "owner",
        invitations: [],
        memberRole: "owner",
        members: [owner],
      },
      [],
      1,
    );
    await render();
    await type(emailField(), "new@example.com");
    await type(
      inviteForm()?.querySelector<HTMLInputElement>("input[type=date]") ?? null,
      "2026-11-15",
    );
    await click(button(inviteForm(), "Add"));
    await click(button(inviteForm(), "Send invitation"));

    expect(invited).toEqual(["new@example.com"]);
    expect(inviteForm()?.textContent).toContain(
      "Invitation sent, but requirements could not be assigned",
    );
    expect(
      inviteForm()?.querySelector(".requirementDrafts")?.textContent,
    ).toContain("W-4");

    await click(button(inviteForm(), "Retry requests"));
    expect(requested).toHaveLength(2);
    expect(requested[1]).toMatchObject({
      invitationId: "invitation-1",
      requirements: [expect.objectContaining({ title: "W-4" })],
    });
    expect(inviteForm()).toBeUndefined();
    expect(container.textContent).toContain(
      "Invitation sent to new@example.com, with its requested forms.",
    );
    // The retried request has no member page, so it shows with the others.
    expect(container.textContent).toContain("W-4 · new@example.com (invited)");
  });

  it("reports requests that could not load, and shows them after a retry", async () => {
    stubApi(
      {
        currentMemberId: "owner",
        invitations: [],
        memberRole: "owner",
        members: [owner],
      },
      [
        requirement({
          targetEmail: "former@example.com",
          title: "Credit check",
        }),
      ],
      0,
      1,
    );
    await render();
    expect(container.textContent).toContain(
      "Requested forms and checks could not be loaded.",
    );
    expect(container.textContent).not.toContain("Invitees and former members");

    await click(button(container, "Try again"));
    expect(container.textContent).not.toContain("could not be loaded");
    expect(container.textContent).toContain(
      "Credit check · former@example.com",
    );
  });

  it("opens on demand with focus on the address, and returns focus on cancel", async () => {
    stubApi({
      currentMemberId: "owner",
      invitations: [],
      memberRole: "owner",
      members: [owner, member("mark", "Mark Member")],
    });
    await render();
    expect(inviteForm()).toBeUndefined();

    await click(inviteButton());
    expect(document.activeElement).toBe(emailField());
    await click(button(inviteForm(), "Cancel"));
    expect(inviteForm()).toBeUndefined();
    expect(document.activeElement).toBe(inviteButton());
  });
});

describe("the member list", () => {
  it("links each member to their page and counts their open requests", async () => {
    const paths: string[] = [];
    stubApi(
      {
        currentMemberId: "owner",
        invitations: [
          {
            email: "invitee@example.com",
            expiresAt: "2026-10-11T09:00:00.000Z",
            id: "invite-1",
            role: "member",
            status: "pending",
          },
        ],
        memberRole: "owner",
        members: [owner, member("mark", "Mark Member")],
      },
      [
        requirement({ memberId: "mark" }),
        requirement({ memberId: "mark", title: "W-9" }),
        requirement({ memberId: "mark", status: "complete", title: "I-9" }),
        requirement({
          invitationId: "invite-1",
          targetEmail: "invitee@example.com",
          title: "Background check",
        }),
        requirement({
          kind: "credit_check",
          targetEmail: "former@example.com",
          title: "Credit check",
        }),
      ],
    );
    await render((path) => paths.push(path));

    const mark = [...container.querySelectorAll("a")].find((link) =>
      link.textContent?.includes("Mark Member"),
    );
    expect(mark?.getAttribute("href")).toBe("/organization/people/mark");
    expect(mark?.textContent).toContain("2 open requests");
    const unattached = [...container.querySelectorAll(".card")].find((card) =>
      card.textContent?.includes("Invitees and former members"),
    );
    expect(unattached?.textContent).toContain(
      "Background check · invitee@example.com (invited)",
    );
    expect(unattached?.textContent).toContain(
      "Credit check · former@example.com",
    );
    expect(unattached?.textContent).not.toContain("W-9");
    // Managers keep every control for requests without a member page.
    expect(
      [...(unattached?.querySelectorAll("button") ?? [])].filter(
        (element) => element.textContent?.trim() === "Remove",
      ),
    ).toHaveLength(2);
    expect(container.textContent).not.toContain("Send requests");
    await click(mark);
    expect(paths).toEqual(["/organization/people/mark"]);
  });

  it("points a member to the forms requested from them", async () => {
    const paths: string[] = [];
    stubApi(
      {
        currentMemberId: "mark",
        invitations: [],
        memberRole: "member",
        members: [owner, member("mark", "Mark Member")],
      },
      [requirement({ memberId: "mark" })],
    );
    await render((path) => paths.push(path));

    expect(inviteForm()).toBeUndefined();
    expect(inviteButton()).toBeNull();
    expect(container.textContent).toContain(
      "Your organization has requested a form or check from you.",
    );
    const link = [...container.querySelectorAll("a")].find(
      (element) => element.textContent === "View your forms",
    );
    await click(link);
    expect(paths).toEqual(["/organization/people/mark"]);
  });
});
