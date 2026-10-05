import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  confirmDialog,
  DialogHost,
  dismissDialogs,
  promptDialog,
} from "@tearleads/ui/react";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import {
  addNavigationGuard,
  useDismissDialogsOnChange,
  useWorkspaceNavigation,
} from "./navigationGuard";
import { confirmDiscardChanges } from "./unsavedChanges";

const dom = new Window({ url: "http://localhost:5173" });
const saved = new Map<string, PropertyDescriptor | undefined>();
let createRoot: (container: Element) => Root;
let root: Root | undefined;
let container: HTMLElement;

beforeAll(async () => {
  for (const [key, value] of Object.entries({
    document: dom.document,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: dom.Node,
    window: dom,
  })) {
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
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

/** Mounts the host beside a button that stands in for whatever opened it. */
async function mount(page?: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <>
        <button type="button">Opener</button>
        {page}
        <DialogHost />
      </>,
    ),
  );
  const opener = container.querySelector("button") as HTMLButtonElement;
  opener.focus();
  return opener;
}

/**
 * Requests a dialog inside act, so the host renders it first. The answer comes
 * back wrapped: an async function would otherwise wait for it.
 */
async function open<Answer>(request: () => Promise<Answer>) {
  let answer: Promise<Answer> | undefined;
  await act(async () => {
    answer = request();
  });
  return { answer: answer as Promise<Answer> };
}

const openDialog = () => document.querySelector("dialog[open]");
const choice = (label: string) =>
  [...(openDialog()?.querySelectorAll("button") ?? [])].find(
    (element) => element.textContent?.trim() === label,
  ) ?? null;

async function click(element: HTMLElement | null) {
  expect(element).toBeTruthy();
  await act(async () => element?.click());
}

async function type(value: string) {
  const field =
    openDialog()?.querySelector<HTMLInputElement>("input, textarea");
  expect(field).toBeTruthy();
  const prototype =
    field?.tagName === "TEXTAREA"
      ? dom.HTMLTextAreaElement.prototype
      : dom.HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setValue?.call(field, value);
    field?.dispatchEvent(new dom.Event("input", { bubbles: true }) as never);
  });
}

const deletion = {
  confirmLabel: "Delete business",
  message: "This can't be undone.",
  title: "Delete Acme, Inc.?",
  tone: "danger" as const,
};

describe("confirmDialog", () => {
  it("asks in a labelled alert dialog and resolves true on confirm", async () => {
    const opener = await mount();
    const { answer } = await open(() => confirmDialog(deletion));
    const dialog = openDialog();
    expect(dialog?.getAttribute("role")).toBe("alertdialog");
    const titleId = dialog?.getAttribute("aria-labelledby") ?? "";
    const messageId = dialog?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(titleId)?.textContent).toBe(
      "Delete Acme, Inc.?",
    );
    expect(document.getElementById(messageId)?.textContent).toBe(
      "This can't be undone.",
    );
    expect(choice("Delete business")?.className).toContain("buttonDanger");

    await click(choice("Delete business"));
    expect(await answer).toBe(true);
    expect(openDialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("focuses Cancel for a destructive question and resolves false", async () => {
    const opener = await mount();
    const { answer } = await open(() => confirmDialog(deletion));
    expect(document.activeElement).toBe(choice("Cancel"));
    await click(choice("Cancel"));
    expect(await answer).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("focuses the confirm button for a safe question", async () => {
    await mount();
    const { answer } = await open(() =>
      confirmDialog({ confirmLabel: "Restore", title: "Restore Acme?" }),
    );
    expect(document.activeElement).toBe(choice("Restore"));
    expect(choice("Restore")?.className).toContain("buttonPrimary");
    await click(choice("Restore"));
    expect(await answer).toBe(true);
  });

  it("treats Escape as no", async () => {
    await mount();
    const { answer } = await open(() => confirmDialog(deletion));
    const cancel = new dom.Event("cancel", { cancelable: true });
    await act(async () => openDialog()?.dispatchEvent(cancel as never));
    expect(cancel.defaultPrevented).toBe(true);
    expect(await answer).toBe(false);
    expect(openDialog()).toBeNull();
  });

  it("enables a type-to-confirm button only once the text matches", async () => {
    await mount();
    const { answer } = await open(() =>
      confirmDialog({
        confirmLabel: "Delete organization",
        title: "Delete Acme?",
        tone: "danger",
        typeToConfirm: "Acme",
      }),
    );
    expect(openDialog()?.querySelector(".fieldLabel")?.textContent).toBe(
      "Type Acme to confirm",
    );
    expect(document.activeElement?.tagName).toBe("INPUT");
    expect(choice("Delete organization")?.disabled).toBe(true);
    await type("Acm");
    expect(choice("Delete organization")?.disabled).toBe(true);
    await type(" Acme ");
    expect(choice("Delete organization")?.disabled).toBe(false);
    await click(choice("Delete organization"));
    expect(await answer).toBe(true);
  });

  it("shows queued questions one at a time, in order", async () => {
    await mount();
    const { answer: first } = await open(() => confirmDialog(deletion));
    const { answer: second } = await open(() =>
      confirmDialog({ confirmLabel: "Restore", title: "Restore Acme?" }),
    );
    expect(document.querySelectorAll("dialog")).toHaveLength(1);
    expect(openDialog()?.textContent).toContain("Delete Acme, Inc.?");
    await click(choice("Cancel"));
    expect(await first).toBe(false);
    expect(openDialog()?.textContent).toContain("Restore Acme?");
    await click(choice("Restore"));
    expect(await second).toBe(true);
  });

  it("refuses to ask when no host is mounted", async () => {
    await expect(confirmDialog(deletion)).rejects.toThrow(
      "DialogHost is not mounted.",
    );
  });
});

describe("promptDialog", () => {
  it("returns the typed answer, or null when cancelled", async () => {
    await mount();
    let { answer } = await open(() =>
      promptDialog({
        confirmLabel: "Void contract",
        label: "Reason (optional)",
        maxLength: 500,
        multiline: true,
        title: "Void “Lease”?",
        tone: "danger",
      }),
    );
    const field = openDialog()?.querySelector("textarea");
    expect(field?.maxLength).toBe(500);
    expect(document.activeElement).toBe(field ?? null);
    await type("Sent to the wrong tenant");
    await click(choice("Void contract"));
    expect(await answer).toBe("Sent to the wrong tenant");

    ({ answer } = await open(() =>
      promptDialog({
        confirmLabel: "Void contract",
        label: "Reason (optional)",
        title: "Void “Lease”?",
      }),
    ));
    await click(choice("Cancel"));
    expect(await answer).toBeNull();
  });

  it("requires text when asked to", async () => {
    await mount();
    const { answer } = await open(() =>
      promptDialog({
        confirmLabel: "Create organization",
        label: "Organization name",
        required: true,
        title: "Create an organization",
      }),
    );
    expect(choice("Create organization")?.disabled).toBe(true);
    await type("   ");
    expect(choice("Create organization")?.disabled).toBe(true);
    await type("Northwind");
    await click(choice("Create organization"));
    expect(await answer).toBe("Northwind");
  });
});

describe("DialogHost", () => {
  it("answers no when it unmounts, so a later host shows nothing stale", async () => {
    await mount();
    const { answer } = await open(() => confirmDialog(deletion));
    await act(async () => root?.unmount());
    root = undefined;
    expect(await answer).toBe(false);

    await mount();
    expect(openDialog()).toBeNull();
  });
});

describe("dismissDialogs", () => {
  it("answers the open and queued questions with no", async () => {
    await mount();
    const { answer: confirmed } = await open(() => confirmDialog(deletion));
    const { answer: prompted } = await open(() =>
      promptDialog({
        confirmLabel: "Create organization",
        label: "Organization name",
        title: "Create an organization",
      }),
    );
    await act(async () => dismissDialogs());
    expect(await confirmed).toBe(false);
    expect(await prompted).toBeNull();
    expect(openDialog()).toBeNull();
  });

  it("is how a page change answers the question its old page asked", async () => {
    const pages: string[] = [];
    function Workspace() {
      useWorkspaceNavigation(onNavigated);
      return null;
    }
    const onNavigated = (pathname: string) => {
      pages.push(pathname);
    };
    await mount(<Workspace />);
    const { answer } = await open(() =>
      confirmDialog({
        confirmLabel: "Generate new codes",
        message: "Every existing recovery code will stop working.",
        title: "Generate new recovery codes?",
        tone: "danger",
      }),
    );
    // Browser Back lands on another workspace page while the question is open.
    const back = new dom.PopStateEvent("popstate", {
      state: { workspacePosition: -1 },
    });
    await act(async () => dom.dispatchEvent(back as never));
    expect(pages).toEqual(["/"]);
    expect(await answer).toBe(false);
    expect(openDialog()).toBeNull();
  });
});

describe("guarded Back with a question open", () => {
  it("answers the open question no, then asks about unsaved changes", async () => {
    function Workspace() {
      useWorkspaceNavigation(() => {});
      return null;
    }
    await mount(<Workspace />);
    const removeGuard = addNavigationGuard(confirmDiscardChanges);
    try {
      const { answer } = await open(() => confirmDialog(deletion));
      const back = new dom.PopStateEvent("popstate", {
        state: { workspacePosition: -1 },
      });
      await act(async () => dom.dispatchEvent(back as never));
      expect(await answer).toBe(false);
      expect(openDialog()?.textContent).toContain("Discard unsaved changes?");
      await click(choice("Keep editing"));
    } finally {
      removeGuard();
    }
  });
});

describe("useDismissDialogsOnChange", () => {
  function Workspace({ identity }: { identity: string }) {
    useDismissDialogsOnChange(identity);
    return null;
  }
  const render = (identity: string) =>
    act(async () =>
      root?.render(
        <>
          <button type="button">Opener</button>
          <Workspace identity={identity} />
          <DialogHost />
        </>,
      ),
    );

  it("answers no when the account or organization changes underneath", async () => {
    await mount(<Workspace identity="user-1:org-1" />);
    const { answer } = await open(() =>
      confirmDialog({
        confirmLabel: "Delete organization",
        title: "Delete Northwind?",
        tone: "danger",
        typeToConfirm: "Northwind",
      }),
    );
    await render("user-1:org-1");
    expect(openDialog()).toBeTruthy();

    // Another tab switched the active organization.
    await render("user-1:org-2");
    expect(await answer).toBe(false);
    expect(openDialog()).toBeNull();
  });
});
