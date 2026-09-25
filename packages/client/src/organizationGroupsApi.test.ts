import { describe, expect, it } from "bun:test";
import {
  OrganizationApiError,
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
});
