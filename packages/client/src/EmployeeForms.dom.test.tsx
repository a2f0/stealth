import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { EmployeeForms } from "./EmployeeForms";
import type { EmployeeRequirement } from "./employeeFormsApi";

const dom = new Window({ url: "http://localhost:5173/organization/people" });
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

function screening(
  overrides: Partial<EmployeeRequirement>,
): EmployeeRequirement {
  return {
    checkrAvailable: true,
    checkrPendingStart: false,
    checkrStarted: true,
    checkrInvitationStatus: "completed",
    checkrResult: null,
    completedAt: null,
    documentFilename: null,
    documentRevision: 0,
    documentSize: null,
    dueDate: "2026-10-31",
    hasDocument: false,
    id: "screening",
    invitationId: null,
    invitationStatus: null,
    kind: "background_check",
    memberId: "member",
    status: "in_progress",
    targetEmail: "person@example.com",
    targetName: "Pat Person",
    title: "Background check",
    ...overrides,
  };
}

async function render(requirements: EmployeeRequirement[], canManage = true) {
  globalThis.fetch = (async () =>
    Response.json({ requirements })) as unknown as typeof fetch;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <EmployeeForms canManage={canManage} invitations={[]} members={[]} />,
    ),
  );
}

function item(title: string) {
  const match = [...container.querySelectorAll(".requirementItem")].find(
    (element) => element.querySelector("strong")?.textContent === title,
  );
  if (!match) throw new Error(`No requirement titled ${title}`);
  return match;
}

describe("Checkr screening results", () => {
  it("shows the result, completion date, and review guidance", async () => {
    await render([
      screening({
        checkrResult: "clear",
        completedAt: "2026-10-07T11:09:40.000Z",
        id: "clear",
        status: "complete",
        title: "Clear check",
      }),
      screening({
        checkrResult: "consider",
        completedAt: "2026-10-07T11:09:40.000Z",
        id: "consider",
        status: "complete",
        title: "Consider check",
      }),
      screening({
        checkrInvitationStatus: "pending",
        id: "pending",
        title: "Pending check",
      }),
    ]);

    const clear = item("Clear check");
    const clearBadge = clear.querySelector(".checkrResult .badge");
    expect(clearBadge?.textContent).toBe("Checkr result: Clear");
    expect(clearBadge?.className).toContain("badgeSuccess");
    const completedOn = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
    }).format(new Date("2026-10-07T11:09:40.000Z"));
    expect(clear.textContent).toContain(`Completed ${completedOn}`);
    expect(clear.textContent).not.toContain("Review it in Checkr");
    expect(clear.textContent).not.toContain("Checkr: completed");
    expect(clear.textContent).toContain("Refresh check");

    const consider = item("Consider check");
    const considerBadge = consider.querySelector(".checkrResult .badge");
    expect(considerBadge?.textContent).toBe("Checkr result: Consider");
    expect(considerBadge?.className).toContain("badgeWarning");
    expect(consider.textContent).toContain(
      "The report found records to review. Review it in Checkr before making a decision.",
    );

    const pending = item("Pending check");
    expect(pending.querySelector(".checkrResult")).toBeNull();
    expect(pending.textContent).toContain("Checkr: pending");
  });

  it("keeps the invitation status beside a result from a canceled report", async () => {
    await render([
      screening({
        checkrInvitationStatus: "partially_canceled",
        checkrResult: "consider",
        status: "pending",
        title: "Partial check",
      }),
    ]);

    const partial = item("Partial check");
    expect(partial.textContent).toContain("Checkr result: Consider");
    expect(partial.textContent).toContain("Checkr: partially canceled");
  });

  it("hides the result from the screened person", async () => {
    await render(
      [
        screening({
          checkrResult: "clear",
          completedAt: "2026-10-07T11:09:40.000Z",
          status: "complete",
          title: "Own check",
        }),
      ],
      false,
    );

    const own = item("Own check");
    expect(own.querySelector(".checkrResult")).toBeNull();
    expect(own.textContent).toContain("Complete");
  });
});
