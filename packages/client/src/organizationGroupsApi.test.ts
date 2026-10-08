import { describe, expect, it } from "bun:test";
import {
  OrganizationApiError,
  seatRequirementFrom,
  twoFactorRequirementFrom,
} from "./organizationGroupsApi";

describe("organization API errors", () => {
  it("identifies two-factor setup and verification requirements", () => {
    expect(
      twoFactorRequirementFrom(
        new OrganizationApiError("setup", "TWO_FACTOR_SETUP_REQUIRED"),
      ),
    ).toBe("setup");
    expect(
      twoFactorRequirementFrom(
        new OrganizationApiError(
          "verification",
          "TWO_FACTOR_VERIFICATION_REQUIRED",
        ),
      ),
    ).toBe("verification");
    expect(twoFactorRequirementFrom(new Error("unrelated"))).toBeUndefined();
  });

  it("tells owners who can upgrade apart from members without a seat", () => {
    expect(
      seatRequirementFrom(
        new OrganizationApiError("upgrade", "UPGRADE_REQUIRED"),
      ),
    ).toBe("upgrade");
    expect(
      seatRequirementFrom(
        new OrganizationApiError("no seat", "SEAT_UNAVAILABLE"),
      ),
    ).toBe("ask-owner");
    expect(
      seatRequirementFrom(
        new OrganizationApiError("setup", "TWO_FACTOR_SETUP_REQUIRED"),
      ),
    ).toBeUndefined();
    expect(seatRequirementFrom(new Error("unrelated"))).toBeUndefined();
  });
});
