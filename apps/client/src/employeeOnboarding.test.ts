import { describe, expect, it } from "bun:test";
import {
  canCompleteRequirement,
  inviteWithRequirements,
  reviewRevisionForStatus,
} from "./employeeOnboarding";

describe("employee onboarding", () => {
  it("requires approval of the downloaded form version", () => {
    const downloadedRevision = 1;
    expect(canCompleteRequirement("form", 1, downloadedRevision)).toBe(true);
    expect(
      reviewRevisionForStatus("form", 1, downloadedRevision, "complete"),
    ).toBe(1);

    // A replacement and list reload may change the current revision, but the
    // downloaded revision stays tied to the file the manager actually saw.
    expect(canCompleteRequirement("form", 2, downloadedRevision)).toBe(false);
    expect(
      reviewRevisionForStatus("form", 2, downloadedRevision, "complete"),
    ).toBe(1);
    expect(canCompleteRequirement("form", 2, 2)).toBe(true);
  });

  it("keeps the invitation visible if requirement assignment fails", async () => {
    const calls: string[] = [];
    const requirements = [
      {
        id: "draft-1",
        kind: "form" as const,
        title: "W-4",
        dueDate: "2026-10-01",
      },
    ];
    await expect(
      inviteWithRequirements({
        assign: async (invitationId, assigned) => {
          expect(invitationId).toBe("invite-1");
          expect(assigned).toEqual(requirements);
          calls.push("assign");
          throw new Error("Requirement service unavailable.");
        },
        invite: async () => {
          calls.push("invite");
          return { data: { id: "invite-1", role: "member" } };
        },
        onInvited: () => calls.push("invited"),
        onSent: async () => {
          calls.push("reload");
        },
        requirements,
        role: "member",
      }),
    ).rejects.toThrow(
      "Invitation sent, but requirements could not be assigned: Requirement service unavailable.",
    );
    expect(calls).toEqual(["invite", "invited", "assign", "reload"]);
  });
});
