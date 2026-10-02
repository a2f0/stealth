import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AnswerAttribution,
  createIssueWithImages,
  FailedItemIssue,
  type FailIssueState,
  failIssueReducer,
  runStateReducer,
} from "./AuditRunPage";
import type { AuditDetail, AuditTemplateItem } from "./auditApi";

const item: AuditTemplateItem = {
  id: "panel-labels",
  prompt: "Panel directory is legible",
  required: true,
  responseType: "check",
};

const closed: FailIssueState = { offer: 0, step: "closed" };

function answer(state: FailIssueState, previous: string, next: string) {
  return failIssueReducer(state, { next, previous, type: "answered" });
}

function skip(state: FailIssueState, skipIssue: boolean) {
  return failIssueReducer(state, { skip: skipIssue, type: "skipToggled" });
}

function create(state: FailIssueState, offer: number, warning?: string) {
  return failIssueReducer(state, { offer, type: "created", warning });
}

function render(
  state: Exclude<FailIssueState, { step: "closed" }>,
  openIssueCount = 0,
) {
  return renderToStaticMarkup(
    <FailedItemIssue
      auditId="audit-1"
      item={item}
      members={[{ email: "sam@example.com", id: "user-1", name: "Sam" }]}
      onCreated={async () => {}}
      onSkipChange={() => {}}
      openIssueCount={openIssueCount}
      state={state}
    />,
  );
}

function detailWith(responses: Record<string, string>): AuditDetail {
  return {
    audit: {
      answerActivity: {},
      completedAt: null,
      createdAt: "2026-09-29T00:00:00.000Z",
      createdBy: { email: "sam@example.com", id: "user-1", name: "Sam" },
      definition: { sections: [], version: 1 },
      id: "audit-1",
      responses,
      revision: 0,
      status: "in_progress",
      templateId: null,
      templateName: "Electrical walk",
      templateVersion: 1,
      updatedAt: "2026-09-29T00:00:00.000Z",
    },
    issues: [],
    members: [],
  };
}

describe("failed item issue flow", () => {
  it("offers an issue only when Fail is freshly chosen", () => {
    expect(answer(closed, "", "fail")).toEqual({ offer: 1, step: "offered" });
    expect(answer(closed, "pass", "fail")).toEqual({
      offer: 1,
      step: "offered",
    });
    expect(answer(closed, "", "pass")).toEqual(closed);
  });

  it("keeps the current step when Fail is clicked again", () => {
    const skipped = skip(answer(closed, "", "fail"), true);
    expect(answer(skipped, "fail", "fail")).toBe(skipped);
  });

  it("closes the offer when the answer moves away from Fail", () => {
    const offered = answer(closed, "", "fail");
    expect(answer(offered, "fail", "pass")).toEqual({
      offer: 1,
      step: "closed",
    });
    expect(answer(skip(offered, true), "fail", "na")).toEqual({
      offer: 1,
      step: "closed",
    });
    expect(answer(create(offered, 1), "fail", "pass")).toEqual({
      offer: 1,
      step: "closed",
    });
  });

  it("toggles failing without an issue", () => {
    const skipped = skip(answer(closed, "", "fail"), true);
    expect(skipped).toEqual({ offer: 1, step: "skipped" });
    expect(skip(skipped, false)).toEqual({ offer: 1, step: "offered" });
  });

  it("ignores the skip checkbox once the issue exists", () => {
    const created = create(answer(closed, "", "fail"), 1);
    expect(skip(created, true)).toBe(created);
  });

  it("records the created issue and offers a new one after re-failing", () => {
    const created = create(
      answer(closed, "", "fail"),
      1,
      "1 image could not be attached.",
    );
    expect(created).toEqual({
      offer: 1,
      step: "created",
      warning: "1 image could not be attached.",
    });
    expect(answer(answer(created, "fail", "pass"), "pass", "fail")).toEqual({
      offer: 2,
      step: "offered",
    });
  });

  it("keeps a newer form when an earlier submission finishes late", () => {
    const first = answer(closed, "", "fail");
    const refailed = answer(answer(first, "fail", "pass"), "pass", "fail");

    expect(create(refailed, first.offer)).toBe(refailed);
    expect(create(refailed, refailed.offer)).toEqual({
      offer: 2,
      step: "created",
      warning: undefined,
    });
  });

  it("stays closed when a submission finishes after Pass", () => {
    const passed = answer(answer(closed, "", "fail"), "fail", "pass");
    expect(create(passed, passed.offer)).toBe(passed);
  });
});

describe("failed item issue panel", () => {
  it("offers an issue titled after the failed prompt", () => {
    const markup = render({ offer: 1, step: "offered" });

    expect(markup).toMatch(
      /<input type="checkbox"\/>Fail without creating issue/,
    );
    expect(markup).toContain('value="Panel directory is legible"');
    expect(markup).toContain("Create issue");
    expect(markup).toContain("Sam · sam@example.com");
    expect(markup).not.toContain("already has");
  });

  it("tucks the form away when failing without an issue", () => {
    const markup = render({ offer: 1, step: "skipped" });

    expect(markup).toMatch(
      /<input type="checkbox" checked=""\/>Fail without creating issue/,
    );
    expect(markup).not.toContain("Create issue");
    expect(markup).not.toContain('value="Panel directory is legible"');
  });

  it("confirms the created issue with any image warning", () => {
    expect(render({ offer: 1, step: "created", warning: undefined })).toContain(
      "Issue created.</span>",
    );
    const markup = render({
      offer: 1,
      step: "created",
      warning: "1 image could not be attached. The issue was created.",
    });

    expect(markup).toContain("Issue created. 1 image could not be attached.");
    expect(markup).not.toContain("Fail without creating issue");
  });

  it("warns when the item already has an open issue", () => {
    expect(render({ offer: 1, step: "offered" }, 1)).toContain(
      "This item already has 1 open issue.",
    );
    expect(render({ offer: 1, step: "offered" }, 2)).toContain(
      "This item already has 2 open issues.",
    );
  });
});

describe("creating an issue with images", () => {
  const issue = {
    assignedTo: "user-1",
    description: "Directory is faded.",
    itemId: item.id,
    priority: "high",
    title: item.prompt,
  };

  it("creates the issue for the item, then attaches each image to it", async () => {
    const created: unknown[] = [];
    const uploaded: string[] = [];
    const warning = await createIssueWithImages(
      "audit-1",
      issue,
      [new File(["a"], "a.png"), new File(["b"], "b.png")],
      async (auditId, input) => {
        created.push([auditId, input]);
        return { issueId: "issue-1" };
      },
      async (issueId, file) => {
        uploaded.push(`${issueId}/${file.name}`);
      },
    );

    expect(created).toEqual([["audit-1", issue]]);
    expect(uploaded).toEqual(["issue-1/a.png", "issue-1/b.png"]);
    expect(warning).toBeUndefined();
  });

  it("warns when images could not be attached", async () => {
    const warning = await createIssueWithImages(
      "audit-1",
      issue,
      [new File(["a"], "a.png"), new File(["b"], "b.png")],
      async () => ({ issueId: "issue-1" }),
      async (_issueId, file) => {
        if (file.name === "b.png") throw new Error("Upload failed.");
      },
    );

    expect(warning).toBe(
      "1 image could not be attached. The issue was created.",
    );
  });

  it("uploads nothing when the issue cannot be created", async () => {
    const uploaded: string[] = [];
    const attempt = createIssueWithImages(
      "audit-1",
      issue,
      [new File(["a"], "a.png")],
      async () => {
        throw new Error("Invalid issue details.");
      },
      async (_issueId, file) => {
        uploaded.push(file.name);
      },
    );

    await expect(attempt).rejects.toThrow("Invalid issue details.");
    expect(uploaded).toEqual([]);
  });
});

describe("audit run state", () => {
  it("keeps unsaved answers when issues refresh", () => {
    const loaded = runStateReducer(
      { detail: undefined, responses: {} },
      { detail: detailWith({ a: "pass" }), type: "loaded" },
    );
    const answered = runStateReducer(loaded, {
      itemId: item.id,
      response: "fail",
      type: "answered",
    });
    const refreshedDetail = detailWith({ a: "na" });
    refreshedDetail.audit.revision = 2;
    const refreshed = runStateReducer(answered, {
      detail: refreshedDetail,
      type: "issuesRefreshed",
    });

    expect(refreshed.detail?.issues).toBe(refreshedDetail.issues);
    expect(refreshed.detail?.audit).toBe(loaded.detail?.audit);
    expect(refreshed.detail?.audit.revision).toBe(0);
    expect(refreshed.responses).toEqual({ a: "pass", [item.id]: "fail" });
  });

  it("replaces answers with the saved ones on load", () => {
    const state = runStateReducer(
      { detail: undefined, responses: { stale: "fail" } },
      { detail: detailWith({ a: "na" }), type: "loaded" },
    );

    expect(state.responses).toEqual({ a: "na" });
  });
});

describe("answer attribution", () => {
  it("shows the last saved actor and labels older answers without inventing an actor", () => {
    const audit = detailWith({ [item.id]: "pass" }).audit;
    const older = renderToStaticMarkup(
      <AnswerAttribution audit={audit} itemId={item.id} response="pass" />,
    );
    expect(older).toContain("Answer saved before activity tracking");
    const inheritedId = renderToStaticMarkup(
      <AnswerAttribution
        audit={detailWith({ constructor: "pass" }).audit}
        itemId="constructor"
        response="pass"
      />,
    );
    expect(inheritedId).toContain("Answer saved before activity tracking");
    audit.answerActivity[item.id] = {
      actor: { email: "sam@example.com", id: "user-1", name: "Sam" },
      occurredAt: "2026-10-02T12:00:00.000Z",
    };
    const tracked = renderToStaticMarkup(
      <AnswerAttribution audit={audit} itemId={item.id} response="pass" />,
    );
    expect(tracked).toContain("Updated by");
    expect(tracked).toContain("Sam");
    expect(tracked).toContain("sam@example.com");
    const pending = renderToStaticMarkup(
      <AnswerAttribution audit={audit} itemId={item.id} response="fail" />,
    );
    expect(pending).toContain("Unsaved answer");
    expect(pending).not.toContain("Updated by");
  });
});
