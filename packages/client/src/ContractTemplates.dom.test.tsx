import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DialogHost } from "@tearleads/ui/react";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import {
  EditorOverlay,
  FieldHelp,
  FieldToolbox,
  SelectedField,
  useContractFieldEditor,
} from "./ContractFieldEditor";
import { Contracts } from "./Contracts";
import type { DraftInput } from "./contractsApi";
import type { ContractTemplate } from "./contractTemplatesApi";
import { canNavigate, guardWorkspaceChange } from "./navigationGuard";

const dom = new Window({ url: "http://localhost:5173/contracts/templates/t1" });
const domGlobals = {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let createRoot: (container: Element) => Root;
const mounted: { container: HTMLElement; root: Root }[] = [];

beforeAll(async () => {
  for (const [key, value] of Object.entries(domGlobals)) {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  ({ createRoot } = await import("react-dom/client"));
});
afterAll(async () => {
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});
afterEach(async () => {
  for (const { container, root } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  globalThis.fetch = originalFetch;
});

function template(version = 2): ContractTemplate {
  return {
    createdAt: "2026-10-01T12:00:00.000Z",
    createdByName: "Owner",
    currentVersion: 2,
    definition: {
      fields: [
        {
          height: 0.05,
          label: null,
          page: 1,
          required: true,
          roleKey: "employee",
          type: "signature",
          width: 0.3,
          x: 0.1,
          y: 0.8,
        },
      ],
      message: "Please sign",
      reminderIntervalDays: 3,
      roles: [{ key: "employee", label: "Employee", routingOrder: 1 }],
      signingOrder: "parallel",
    },
    description: "Employment document",
    document: {
      filename: "agreement.pdf",
      pageCount: 2,
      sha256: "abc",
      size: 800,
    },
    id: "t1",
    name: version === 1 ? "Original agreement" : "Employment agreement",
    version,
  };
}

interface TemplatePost {
  dueDate?: string | null;
  recipients?: Array<{ email: string; name: string; roleKey: string }>;
  title?: string;
  version?: number;
  definition?: ContractTemplate["definition"];
  expectedCurrentVersion?: number;
  name?: string;
  sourceVersion?: number;
}

function stubApi(
  options: {
    conflict?: boolean;
    createResponse?: Promise<Response>;
    uploadResponse?: Promise<Response>;
    deleteResponse?: Promise<Response>;
  } = {},
) {
  const posts: Array<{ body: TemplatePost; url: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (init?.method === "DELETE")
      return options.deleteResponse ?? new Response(null, { status: 204 });
    if (init?.body instanceof FormData)
      return (
        options.uploadResponse ??
        Response.json({ template: template() }, { status: 201 })
      );
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as TemplatePost;
      posts.push({ body, url });
      if (url.endsWith("/versions"))
        return options.conflict
          ? Response.json(
              {
                error:
                  "This template changed. Reload the latest version before saving your changes.",
              },
              { status: 409 },
            )
          : Response.json(
              {
                template: {
                  ...template(3),
                  currentVersion: 3,
                  definition: body.definition,
                  name: body.name,
                },
              },
              { status: 201 },
            );
      return (
        options.createResponse ??
        Response.json({ contractId: "c1" }, { status: 201 })
      );
    }
    if (url.includes("/document")) return new Response(null, { status: 404 });
    if (url.endsWith("/versions"))
      return Response.json({
        versions: [2, 1].map((version) => ({
          createdAt: template().createdAt,
          createdByName: "Owner",
          name: template(version).name,
          version,
        })),
      });
    if (url.endsWith("/templates"))
      return Response.json({
        templates: [{ ...template(), updatedAt: template().createdAt }],
      });
    return Response.json({
      template: template(url.includes("version=1") ? 1 : 2),
    });
  }) as typeof fetch;
  return posts;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function mount(
  pathname = "/contracts/templates/t1",
  onNavigate: (path: string) => void = () => {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () =>
    root.render(
      <>
        <Contracts onNavigate={onNavigate} pathname={pathname} />
        <DialogHost />
      </>,
    ),
  );
  await settle();
  return container;
}

/** Answers the open dialog with the button labelled `label`. */
async function answer(label: string) {
  await settle();
  const choice = [
    ...(document.querySelector("dialog[open]")?.querySelectorAll("button") ??
      []),
  ].find((element) => element.textContent?.trim() === label);
  expect(choice).toBeTruthy();
  await act(async () => choice?.click());
  await settle();
}

/** Starts a guarded action, answers its dialog, and returns its result. */
async function decide<Result>(start: () => Promise<Result>, label: string) {
  let action: Promise<Result> | undefined;
  await act(async () => {
    action = start();
  });
  await answer(label);
  return action;
}
function button(container: HTMLElement, text: string) {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === text,
  );
  expect(found).toBeTruthy();
  return found as HTMLButtonElement;
}
function field(container: HTMLElement, label: string) {
  const element = [...container.querySelectorAll("label")].find(
    (element) =>
      element.querySelector(".fieldLabel")?.textContent?.trim() === label,
  );
  const found =
    element?.querySelector("input,select,textarea") ??
    container.querySelector(`#${element?.htmlFor}`);
  expect(found).toBeTruthy();
  return found as HTMLInputElement;
}
async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    const prototype =
      input.tagName === "SELECT"
        ? dom.HTMLSelectElement.prototype
        : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      input,
      value,
    );
    fire(
      input,
      new dom.Event(input.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
  await settle();
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

describe("contract templates, mounted", () => {
  it("routes the templates list separately from issued contracts", async () => {
    stubApi();
    const navigations: string[] = [];
    const container = await mount("/contracts/templates", (path) =>
      navigations.push(path),
    );
    expect(container.querySelector("h1")?.textContent).toBe(
      "Contract templates",
    );
    await click(
      container.querySelector(
        "a[href='/contracts/templates/t1']",
      ) as HTMLElement,
    );
    expect(navigations).toEqual(["/contracts/templates/t1"]);
  });

  it("saves boxes under unassigned roles and appends a version", async () => {
    const posts = stubApi();
    const container = await mount();
    expect(container.querySelector("input[type=email]")).toBeNull();
    await change(field(container, "Role 1"), "Worker");
    await click(button(container, "Full name"));
    await click(button(container, "Save version 3"));
    const definition = posts[0]?.body
      .definition as ContractTemplate["definition"];
    expect(definition.roles).toEqual([
      { key: "employee", label: "Worker", routingOrder: 1 },
    ]);
    expect(
      definition.fields.map(({ type, roleKey }) => ({ roleKey, type })),
    ).toEqual([
      { roleKey: "employee", type: "signature" },
      { roleKey: "employee", type: "name" },
    ]);
    expect(posts[0]?.body.expectedCurrentVersion).toBe(2);
    expect(posts[0]?.body.sourceVersion).toBe(2);
    expect(container.querySelector(".toast")?.textContent).toContain(
      "Version 3 saved",
    );
    expect(button(container, "Save version 4").disabled).toBe(true);
  });

  it("uses a selected older version and maps its role once", async () => {
    const posts = stubApi();
    const navigations: string[] = [];
    const container = await mount(undefined, (path) => navigations.push(path));
    await change(field(container, "Version"), "1");
    expect(container.querySelector("h1")?.textContent).toBe(
      "Original agreement",
    );
    await click(button(container, "Use this version"));
    await change(field(container, "Employee name"), "Sam Signer");
    await change(field(container, "Employee email"), "sam@example.com");
    await act(async () =>
      fire(
        container.querySelector("form"),
        new dom.Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    await settle();
    expect(posts[0]?.body).toEqual({
      dueDate: null,
      recipients: [
        { email: "sam@example.com", name: "Sam Signer", roleKey: "employee" },
      ],
      title: "Original agreement",
      version: 1,
    });
    expect(navigations).toEqual(["/contracts/c1"]);
  });

  it("preserves edits after a conflict and prevents discarded navigation", async () => {
    stubApi({ conflict: true });
    const container = await mount();
    await change(field(container, "Role 1"), "Worker");
    expect(await decide(canNavigate, "Keep editing")).toBe(false);
    await click(button(container, "Use this version"));
    expect(document.querySelector("dialog[open]")?.textContent).toContain(
      "Discard unsaved changes?",
    );
    await answer("Keep editing");
    expect(container.querySelector("input[type=email]")).toBeNull();
    await click(button(container, "Save version 3"));
    expect(container.textContent).toContain("This template changed");
    expect(field(container, "Role 1").value).toBe("Worker");
    expect(button(container, "Save version 3").disabled).toBe(false);
  });

  it("guards account, organization, and sign-out actions before changing the session", async () => {
    stubApi();
    const container = await mount();
    await change(field(container, "Role 1"), "Worker");
    const changes: string[] = [];
    const switchAccount = guardWorkspaceChange(async (id: string) => {
      changes.push(`account:${id}`);
    });
    const switchOrganization = guardWorkspaceChange(async (id: string) => {
      changes.push(`organization:${id}`);
    });
    const signOut = guardWorkspaceChange(async () => {
      changes.push("sign-out");
    });
    await decide(() => switchAccount("a2"), "Keep editing");
    await decide(() => switchOrganization("org2"), "Keep editing");
    await decide(signOut, "Keep editing");
    expect(changes).toEqual([]);
    expect(field(container, "Role 1").value).toBe("Worker");
    await decide(() => switchAccount("a2"), "Discard changes");
    await decide(() => switchOrganization("org2"), "Discard changes");
    await decide(signOut, "Discard changes");
    expect(changes).toEqual(["account:a2", "organization:org2", "sign-out"]);
  });

  it("blocks version changes while creating and ignores a response after leaving the page", async () => {
    let complete: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    stubApi({ createResponse: response });
    const navigations: string[] = [];
    const container = await mount(undefined, (path) => navigations.push(path));
    await click(button(container, "Use this version"));
    await change(field(container, "Employee name"), "Sam Signer");
    await change(field(container, "Employee email"), "sam@example.com");
    await act(async () => {
      fire(
        container.querySelector("form"),
        new dom.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(field(container, "Version").disabled).toBe(true);
    expect(button(container, "Delete template").disabled).toBe(true);
    const root = mounted.at(-1)?.root;
    await act(async () =>
      root?.render(
        <Contracts
          onNavigate={(path) => navigations.push(path)}
          pathname="/contracts/templates"
        />,
      ),
    );
    await act(async () => {
      complete?.(
        Response.json({ contractId: "late-contract" }, { status: 201 }),
      );
    });
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe(
      "Contract templates",
    );
    expect(navigations).toEqual([]);
  });

  it("ignores an upload completion after the templates list unmounts", async () => {
    let complete: ((response: Response) => void) | undefined;
    const uploadResponse = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    stubApi({ uploadResponse });
    const navigations: string[] = [];
    const container = await mount("/contracts/templates", (path) =>
      navigations.push(path),
    );
    const input = container.querySelector(
      "input[type=file]",
    ) as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: { 0: new File(["PDF"], "agreement.pdf"), length: 1 },
    });
    await act(async () => {
      fire(input, new dom.Event("change", { bubbles: true }));
    });
    const root = mounted.at(-1)?.root;
    await act(async () => root?.render(<p>Other workspace</p>));
    await act(async () => {
      complete?.(Response.json({ template: template() }, { status: 201 }));
    });
    await settle();
    expect(navigations).toEqual([]);
    expect(container.textContent).toBe("Other workspace");
  });

  it("ignores a deletion completion after leaving the template", async () => {
    let complete: ((response: Response) => void) | undefined;
    const deleteResponse = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    stubApi({ deleteResponse });
    const navigations: string[] = [];
    const container = await mount(undefined, (path) => navigations.push(path));
    await click(button(container, "Delete template"));
    await answer("Delete template");
    const root = mounted.at(-1)?.root;
    await act(async () => root?.render(<p>Other workspace</p>));
    await act(async () => {
      complete?.(new Response(null, { status: 204 }));
    });
    await settle();
    expect(navigations).toEqual([]);
    expect(container.textContent).toBe("Other workspace");
  });
});

function FieldHarness() {
  const [draft, setDraft] = useState<DraftInput>({
    dueDate: null,
    fields: [],
    message: "",
    recipients: [{ email: "", key: "role", name: "Employee", routingOrder: 1 }],
    reminderIntervalDays: null,
    signingOrder: "parallel",
    title: "Template",
  });
  const editor = useContractFieldEditor(draft, setDraft, 2);
  return (
    <div className="contractEditor">
      <FieldHelp />
      <FieldToolbox editor={editor} />
      <SelectedField editor={editor} />
      <EditorOverlay
        editor={editor}
        page={{ height: 792, number: 1, width: 612 }}
      />
      <output>{JSON.stringify(draft.fields)}</output>
    </div>
  );
}

it("shares keyboard placement, movement, and removal with the draft editor", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => root.render(<FieldHarness />));
  await click(button(container, "Initials"));
  const placed = container.querySelector(
    "button.contractField",
  ) as HTMLButtonElement;
  expect(document.activeElement).toBe(placed);
  const before = JSON.parse(
    container.querySelector("output")?.textContent ?? "[]",
  ) as Array<{ x: number }>;
  await act(async () => {
    fire(
      placed,
      new dom.KeyboardEvent("keydown", {
        bubbles: true,
        key: "ArrowRight",
        shiftKey: true,
      }),
    );
  });
  const after = JSON.parse(
    container.querySelector("output")?.textContent ?? "[]",
  ) as Array<{ x: number }>;
  expect(after[0]?.x).toBeCloseTo((before[0]?.x ?? 0) + 0.05);
  await act(async () => {
    fire(
      placed,
      new dom.KeyboardEvent("keydown", { bubbles: true, key: "Delete" }),
    );
  });
  expect(container.querySelector("button.contractField")).toBeNull();
  expect(container.querySelector("output")?.textContent).toBe("[]");
});

function fire(element: Element | null, event: unknown) {
  return element?.dispatchEvent(event as Event);
}
