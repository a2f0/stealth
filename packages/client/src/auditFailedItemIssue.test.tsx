import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FailedItemIssue } from "./AuditRunPage";
import type { AuditTemplateItem } from "./auditApi";

const item: AuditTemplateItem = {
  id: "panel-labels",
  prompt: "Panel directory is legible",
  required: true,
  responseType: "check",
};

function render(openIssueCount = 0) {
  return renderToStaticMarkup(
    <FailedItemIssue
      auditId="audit-1"
      item={item}
      members={[{ email: "sam@example.com", id: "user-1", name: "Sam" }]}
      onCreated={async () => {}}
      openIssueCount={openIssueCount}
    />,
  );
}

describe("failed item issue", () => {
  it("offers an issue titled after the failed prompt", () => {
    const markup = render();

    expect(markup).toContain('value="Panel directory is legible"');
    expect(markup).toContain("Create issue");
    expect(markup).toContain("Sam · sam@example.com");
    expect(markup).not.toContain("already has");
  });

  it("lets the auditor fail the item without creating an issue", () => {
    const markup = render();

    expect(markup).toMatch(
      /<input type="checkbox"\/>Fail without creating issue/,
    );
  });

  it("warns when the item already has an open issue", () => {
    expect(render(1)).toContain("This item already has 1 open issue.");
    expect(render(2)).toContain("This item already has 2 open issues.");
  });
});
