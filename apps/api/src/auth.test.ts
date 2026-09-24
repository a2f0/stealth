import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { app } from "./app";
import { createAuth } from "./auth";
import type { Bindings } from "./types";

const baseURL = "https://api.test";
const origin = "https://app.test";
const email = "person@example.com";
const originalPassword = "correct horse battery staple";
const replacementPassword = "new correct horse battery staple";

describe("password authentication", () => {
  it("requires and records Terms of Service acceptance at sign-up", async () => {
    const fixture = await createFixture();
    const rejected = await post(fixture.auth, "/sign-up/email", {
      email: "declined@example.com",
      name: "Declined Person",
      password: originalPassword,
      termsAccepted: false,
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      message: "You must agree to the Terms of Service to create an account.",
    });
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM user").get(),
    ).toEqual({ count: 0 });

    const acceptedAfter = Date.now();
    const accepted = await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    expect(accepted.status).toBe(200);
    const record = fixture.database
      .query(
        `SELECT termsAccepted, termsAcceptedAt, termsVersion
         FROM user WHERE email = ?`,
      )
      .get(email) as {
      termsAccepted: number;
      termsAcceptedAt: string;
      termsVersion: string;
    };
    expect(record.termsAccepted).toBe(1);
    expect(record.termsVersion).toBe("2026-08-23");
    expect(new Date(record.termsAcceptedAt).getTime()).toBeGreaterThanOrEqual(
      acceptedAfter,
    );

    const signIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const changed = await post(
      fixture.auth,
      "/update-user",
      { termsAccepted: false },
      signIn.headers.get("set-cookie"),
    );
    expect(changed.status).toBe(400);
    expect(
      fixture.database
        .query("SELECT termsAccepted FROM user WHERE email = ?")
        .get(email),
    ).toEqual({ termsAccepted: 1 });
  });

  it("supports email verification without blocking login", async () => {
    const fixture = await createFixture();

    const signUp = await post(fixture.auth, "/sign-up/email", {
      callbackURL: `${origin}/?verified=true`,
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    expect(signUp.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT role FROM user WHERE email = ?")
        .get(email),
    ).toEqual({ role: "user" });
    const organization = fixture.database
      .query(
        `SELECT organization.id, organization.name, member.role
         FROM organization
         JOIN member ON member.organizationId = organization.id
         JOIN user ON user.defaultOrganizationId = organization.id
         WHERE user.email = ?`,
      )
      .get(email) as { id: string; name: string; role: string };
    expect(organization).toMatchObject({
      name: "Example Person's Organization",
      role: "owner",
    });
    expect(financeGroupFor(fixture.database, organization.id)).toMatchObject({
      capability: "finance",
      memberCount: 1,
      name: "Finance",
    });
    const storedPassword = fixture.database
      .query(
        "SELECT password FROM account WHERE userId = (SELECT id FROM user WHERE email = ?)",
      )
      .get(email) as { password: string };
    expect(storedPassword.password).not.toBe(originalPassword);
    await Promise.all(fixture.pending);
    expect(fixture.messages).toHaveLength(1);
    const verificationMessage = fixture.messages.find(({ subject }) =>
      subject.startsWith("Verify"),
    );
    const verificationURL =
      verificationMessage?.text?.match(/https:\/\/\S+/)?.[0];
    expect(verificationURL).toBeTruthy();

    const signIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get("set-cookie");
    expect(cookie).toContain("better-auth.session_token=");

    const session = await fixture.auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie: cookie ?? "", origin },
      }),
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      session: { activeOrganizationId: organization.id },
      user: { email, emailVerified: false, role: "user" },
    });

    const renamed = await post(
      fixture.auth,
      "/organization/update",
      {
        data: { name: "Example Company" },
        organizationId: organization.id,
      },
      cookie,
    );
    expect(renamed.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT name FROM organization WHERE id = ?")
        .get(organization.id),
    ).toEqual({ name: "Example Company" });

    const resend = await post(fixture.auth, "/send-verification-email", {
      callbackURL: `${origin}/?verified=true`,
      email,
    });
    expect(resend.status).toBe(200);
    await Promise.all(fixture.pending);
    expect(fixture.messages).toHaveLength(2);

    const verification = await fixture.auth.handler(
      new Request(verificationURL ?? ""),
    );
    expect(verification.status).toBe(302);
    expect(verification.headers.get("location")).toBe(
      `${origin}/?verified=true`,
    );

    const verifiedSession = await fixture.auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie: cookie ?? "", origin },
      }),
    );
    expect(await verifiedSession.json()).toMatchObject({
      user: { emailVerified: true },
    });

    const resetRequest = await post(fixture.auth, "/request-password-reset", {
      email,
      redirectTo: `${origin}/reset-password`,
    });
    expect(resetRequest.status).toBe(200);
    await Promise.all(fixture.pending);
    expect(fixture.messages).toHaveLength(3);

    const resetMessage = fixture.messages.find(({ subject }) =>
      subject.startsWith("Reset"),
    );
    const resetURL = resetMessage?.text?.match(/https:\/\/\S+/)?.[0];
    const token = resetURL?.match(/\/reset-password\/([^?]+)/)?.[1];
    expect(token).toBeTruthy();

    const reset = await post(fixture.auth, "/reset-password", {
      newPassword: replacementPassword,
      token,
    });
    expect(reset.status).toBe(200);

    const revokedSession = await fixture.auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie: cookie ?? "", origin },
      }),
    );
    expect(await revokedSession.json()).toBeNull();

    const oldPassword = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    expect(oldPassword.status).toBe(401);

    const newPassword = await post(fixture.auth, "/sign-in/email", {
      email,
      password: replacementPassword,
    });
    expect(newPassword.status).toBe(200);
  });

  it("keeps multiple browser accounts signed in and switches between them", async () => {
    const fixture = await createFixture();
    const secondEmail = "second@example.com";
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    await post(fixture.auth, "/sign-up/email", {
      email: secondEmail,
      name: "Second Person",
      password: originalPassword,
      termsAccepted: true,
    });

    const cookies = new CookieJar();
    cookies.absorb(
      await post(
        fixture.auth,
        "/sign-in/email",
        { email, password: originalPassword },
        cookies.header(),
      ),
    );
    cookies.absorb(
      await post(
        fixture.auth,
        "/sign-in/email",
        { email: secondEmail, password: originalPassword },
        cookies.header(),
      ),
    );

    const listing = await get(
      fixture.auth,
      "/multi-session/list-device-sessions",
      cookies.header(),
    );
    expect(listing.status).toBe(200);
    const sessions = (await listing.json()) as DeviceSession[];
    expect(sessions.map(({ user }) => user.email).sort()).toEqual([
      email,
      secondEmail,
    ]);
    expect(await activeEmail(fixture.auth, cookies)).toBe(secondEmail);

    const firstSession = sessions.find(
      (session) => session.user.email === email,
    );
    expect(firstSession).toBeTruthy();
    const switched = await post(
      fixture.auth,
      "/multi-session/set-active",
      { sessionToken: firstSession?.session.token },
      cookies.header(),
    );
    expect(switched.status).toBe(200);
    cookies.absorb(switched);
    expect(await activeEmail(fixture.auth, cookies)).toBe(email);

    const revoked = await post(
      fixture.auth,
      "/multi-session/revoke",
      { sessionToken: firstSession?.session.token },
      cookies.header(),
    );
    expect(revoked.status).toBe(200);
    cookies.absorb(revoked);
    expect(await activeEmail(fixture.auth, cookies)).toBe(secondEmail);
    const remaining = await get(
      fixture.auth,
      "/multi-session/list-device-sessions",
      cookies.header(),
    );
    expect(await remaining.json()).toMatchObject([
      { user: { email: secondEmail } },
    ]);
  });

  it("enrolls in TOTP MFA and requires a second factor at sign-in", async () => {
    const fixture = await createFixture();
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const enrollmentCookies = new CookieJar();
    enrollmentCookies.absorb(
      await post(fixture.auth, "/sign-in/email", {
        email,
        password: originalPassword,
      }),
    );
    expect(
      await (
        await get(fixture.auth, "/get-session", enrollmentCookies.header())
      ).json(),
    ).toMatchObject({ session: { twoFactorVerified: false } });

    const enabled = await post(
      fixture.auth,
      "/two-factor/enable",
      { method: "totp", password: originalPassword },
      enrollmentCookies.header(),
    );
    expect(enabled.status).toBe(200);
    const setup = (await enabled.json()) as {
      backupCodes: string[];
      method: string;
      totpURI: string;
    };
    expect(setup).toMatchObject({ method: "totp" });
    expect(setup.backupCodes).toHaveLength(10);
    expect(setup.totpURI).toStartWith("otpauth://totp/Tearleads:");
    const pendingMfa = fixture.database
      .query(
        `SELECT user.twoFactorEnabled, twoFactor.verified,
                twoFactor.secret, twoFactor.backupCodes
         FROM user JOIN twoFactor ON twoFactor.userId = user.id
         WHERE user.email = ?`,
      )
      .get(email) as {
      backupCodes: string;
      secret: string;
      twoFactorEnabled: number;
      verified: number;
    };
    expect(pendingMfa).toMatchObject({
      twoFactorEnabled: 0,
      verified: 0,
    });
    expect(pendingMfa.secret).not.toContain(totpSecret(setup.totpURI));
    expect(pendingMfa.backupCodes).not.toContain(setup.backupCodes[0] ?? "");

    const enrollmentVerification = await post(
      fixture.auth,
      "/two-factor/verify-totp",
      { code: await totpCode(setup.totpURI) },
      enrollmentCookies.header(),
    );
    expect(enrollmentVerification.status).toBe(200);
    enrollmentCookies.absorb(enrollmentVerification);
    expect(
      fixture.database
        .query(
          `SELECT user.twoFactorEnabled, twoFactor.verified
           FROM user JOIN twoFactor ON twoFactor.userId = user.id
           WHERE user.email = ?`,
        )
        .get(email),
    ).toEqual({ twoFactorEnabled: 1, verified: 1 });
    expect(
      await (
        await get(fixture.auth, "/get-session", enrollmentCookies.header())
      ).json(),
    ).toMatchObject({ session: { twoFactorVerified: true } });

    const loginCookies = new CookieJar();
    const passwordStep = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    expect(passwordStep.status).toBe(200);
    expect(hasMultiSessionCookie(passwordStep)).toBe(false);
    const passwordStepBody: unknown = await passwordStep.json();
    expect(passwordStepBody).toEqual({
      twoFactorMethods: ["totp"],
      twoFactorRedirect: true,
    });
    loginCookies.absorb(passwordStep);
    expect(
      await (
        await get(fixture.auth, "/get-session", loginCookies.header())
      ).json(),
    ).toBeNull();

    const secondFactor = await post(
      fixture.auth,
      "/two-factor/verify-totp",
      { code: await totpCode(setup.totpURI), trustDevice: true },
      loginCookies.header(),
    );
    expect(secondFactor.status).toBe(200);
    expect(hasMultiSessionCookie(secondFactor)).toBe(true);
    const secondFactorBody = (await secondFactor.clone().json()) as {
      token: string;
    };
    loginCookies.absorb(secondFactor);
    expect(
      await (
        await get(fixture.auth, "/get-session", loginCookies.header())
      ).json(),
    ).toMatchObject({
      session: { twoFactorVerified: true },
      user: { email, twoFactorEnabled: true },
    });
    const missingCompanionCookie = await post(
      fixture.auth,
      "/multi-session/revoke",
      { sessionToken: secondFactorBody.token },
      withoutMultiSessionCookies(loginCookies.header()),
    );
    expect(missingCompanionCookie.status).toBe(401);
    expect(await missingCompanionCookie.json()).toMatchObject({
      code: "INVALID_SESSION_TOKEN",
    });
    const signedOut = await post(
      fixture.auth,
      "/multi-session/revoke",
      { sessionToken: secondFactorBody.token },
      loginCookies.header(),
    );
    expect(signedOut.status).toBe(200);

    const backupLoginCookies = new CookieJar();
    const backupPasswordStep = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    backupLoginCookies.absorb(backupPasswordStep);
    const backupCode = setup.backupCodes[0] ?? "";
    const recovery = await post(
      fixture.auth,
      "/two-factor/verify-backup-code",
      { code: backupCode },
      backupLoginCookies.header(),
    );
    expect(recovery.status).toBe(200);
    backupLoginCookies.absorb(recovery);
    const reusedRecoveryCode = await post(
      fixture.auth,
      "/two-factor/verify-backup-code",
      { code: backupCode },
      backupLoginCookies.header(),
    );
    expect(reusedRecoveryCode.status).toBe(401);
  });

  it("only lets admins list users", async () => {
    const fixture = await createFixture();
    const signUp = await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    expect(signUp.status).toBe(200);

    const userSignIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const userCookie = userSignIn.headers.get("set-cookie");
    const forbidden = await get(
      fixture.auth,
      "/admin/list-users?limit=25",
      userCookie,
    );
    expect(forbidden.status).toBe(403);

    const nullableRoleEmail = "null-role@example.com";
    expect(
      (
        await post(fixture.auth, "/sign-up/email", {
          email: nullableRoleEmail,
          name: "Nullable Role",
          password: originalPassword,
          termsAccepted: true,
        })
      ).status,
    ).toBe(200);
    fixture.database
      .query('UPDATE "user" SET role = ? WHERE email = ?')
      .run("admin", email);
    fixture.database
      .query('UPDATE "user" SET role = NULL WHERE email = ?')
      .run(nullableRoleEmail);
    fixture.database
      .query(
        `INSERT INTO "user"
         (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "system:audit-library",
        "Stealth audit library",
        "audit-library+auth-test@system.invalid",
        true,
        "2026-08-26T12:00:00.000Z",
        "2026-08-26T12:00:00.000Z",
        "system",
        true,
      );
    const adminSignIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const adminCookie = adminSignIn.headers.get("set-cookie");
    const firstPage = await get(
      fixture.auth,
      "/admin/list-users?filterField=id&filterOperator=ne&filterValue=system%3Aaudit-library&limit=1&offset=0&sortBy=email&sortDirection=asc",
      adminCookie,
    );
    const secondPage = await get(
      fixture.auth,
      "/admin/list-users?filterField=id&filterOperator=ne&filterValue=system%3Aaudit-library&limit=1&offset=1&sortBy=email&sortDirection=asc",
      adminCookie,
    );
    expect(firstPage.status).toBe(200);
    expect(secondPage.status).toBe(200);
    expect(await firstPage.json()).toMatchObject({
      limit: 1,
      total: 2,
      users: [{ email: nullableRoleEmail, role: null }],
    });
    expect(await secondPage.json()).toMatchObject({
      limit: 1,
      offset: 1,
      total: 2,
      users: [{ email, role: "admin" }],
    });
  });

  it("only lets owners rename their organization", async () => {
    const fixture = await createFixture();
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const organization = fixture.database
      .query("SELECT id FROM organization")
      .get() as { id: string };
    await post(fixture.auth, "/sign-up/email", {
      email: "other@example.com",
      name: "Other Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const signIn = await post(fixture.auth, "/sign-in/email", {
      email: "other@example.com",
      password: originalPassword,
    });

    const response = await post(
      fixture.auth,
      "/organization/update",
      {
        data: { name: "Not Allowed" },
        organizationId: organization.id,
      },
      signIn.headers.get("set-cookie"),
    );

    expect(response.status).toBe(400);
    expect(
      fixture.database
        .query("SELECT name FROM organization WHERE id = ?")
        .get(organization.id),
    ).toEqual({ name: "Example Person's Organization" });
  });

  it("keeps Free organizations to one user", async () => {
    const fixture = await createFixture();
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const signIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const organization = fixture.database
      .query(`SELECT defaultOrganizationId AS id FROM user WHERE email = ?`)
      .get(email) as { id: string };
    const invite = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: "second@example.com",
        organizationId: organization.id,
        role: "member",
      },
      signIn.headers.get("set-cookie"),
    );
    expect(invite.status).toBe(403);
    expect(
      fixture.database
        .query(
          `SELECT COUNT(*) AS count FROM invitation
           WHERE organizationId = ?`,
        )
        .get(organization.id),
    ).toEqual({ count: 0 });
  });

  it("rejects a pending Pro invitation after downgrade to Free", async () => {
    const fixture = await createFixture();
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const ownerSignIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const organization = fixture.database
      .query(`SELECT defaultOrganizationId AS id FROM user WHERE email = ?`)
      .get(email) as { id: string };
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_price_id, stripe_status, seat_quantity,
          stripe_event_created, updated_at)
         VALUES (?, 'price_pro_test', 'active', 1, 1, ?)`,
      )
      .run(organization.id, new Date().toISOString());
    const invitedEmail = "downgraded-invitee@example.com";
    const invite = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: invitedEmail,
        organizationId: organization.id,
        role: "member",
      },
      ownerSignIn.headers.get("set-cookie"),
    );
    expect(invite.status).toBe(200);
    const invitation = (await invite.json()) as { id: string };
    fixture.database
      .query(
        `UPDATE organization_billing SET stripe_status = 'canceled',
         updated_at = ? WHERE organization_id = ?`,
      )
      .run(new Date().toISOString(), organization.id);

    await post(fixture.auth, "/sign-up/email", {
      email: invitedEmail,
      name: "Invited Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const inviteeSignIn = await post(fixture.auth, "/sign-in/email", {
      email: invitedEmail,
      password: originalPassword,
    });
    const accepted = await post(
      fixture.auth,
      "/organization/accept-invitation",
      { invitationId: invitation.id },
      inviteeSignIn.headers.get("set-cookie"),
    );

    expect(accepted.status).toBe(403);
    expect(
      fixture.database
        .query(
          `SELECT invitation.status,
                  (SELECT COUNT(*) FROM member
                   JOIN user ON user.id = member.userId
                   WHERE member.organizationId = invitation.organizationId
                     AND user.email = invitation.email) AS memberCount
           FROM invitation WHERE invitation.id = ?`,
        )
        .get(invitation.id),
    ).toEqual({ memberCount: 0, status: "pending" });
  });

  it("invites a user, accepts after sign-up, and safely leaves", async () => {
    const fixture = await createFixture();
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const ownerSignIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const ownerCookie = ownerSignIn.headers.get("set-cookie");
    const organization = fixture.database
      .query(
        `SELECT organization.id, organization.name
         FROM organization
         JOIN user ON user.defaultOrganizationId = organization.id
         WHERE user.email = ?`,
      )
      .get(email) as { id: string; name: string };
    const invitedEmail = "invitee@example.com";

    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_price_id, stripe_status, seat_quantity,
          stripe_event_created, updated_at)
         VALUES (?, 'price_pro_test', 'active', 1, 1, ?)`,
      )
      .run(organization.id, new Date().toISOString());

    const firstInvite = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: invitedEmail,
        organizationId: organization.id,
        role: "member",
      },
      ownerCookie,
    );
    expect(firstInvite.status).toBe(200);
    const firstInvitation = (await firstInvite.json()) as { id: string };
    fixture.database
      .query(`INSERT INTO employee_requirements
        (id, organization_id, invitation_id, target_email, kind, title,
         due_date, created_at, updated_at)
        VALUES ('renewed-form', ?, ?, ?, 'form', 'W-4', '2026-10-01', ?, ?)`)
      .run(
        organization.id,
        firstInvitation.id,
        invitedEmail,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    const invite = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: invitedEmail,
        organizationId: organization.id,
        role: "admin",
      },
      ownerCookie,
    );
    expect(invite.status).toBe(200);
    const invitation = (await invite.json()) as { id: string };
    await Promise.all(fixture.pending);
    expect(
      fixture.database
        .query("SELECT status FROM invitation WHERE id = ?")
        .get(firstInvitation.id),
    ).toEqual({ status: "canceled" });
    expect(
      fixture.database
        .query(
          "SELECT invitation_id FROM employee_requirements WHERE id = 'renewed-form'",
        )
        .get(),
    ).toEqual({ invitation_id: invitation.id });
    expect(
      fixture.messages.filter(({ subject }) => subject.startsWith("You're")),
    ).toMatchObject({
      length: 2,
    });
    const invitationMessage = fixture.messages
      .filter(({ subject }) => subject.startsWith("You're"))
      .at(-1);
    expect(invitationMessage).toMatchObject({
      subject: `You're invited to ${organization.name}`,
      to: invitedEmail,
    });
    expect(invitationMessage?.text).toContain(
      `${origin}/invite?id=${invitation.id}`,
    );
    expect(invitationMessage?.text).toContain("with the admin role");

    const inviteeSignUp = await post(fixture.auth, "/sign-up/email", {
      email: invitedEmail,
      name: "Invited Person",
      password: originalPassword,
      termsAccepted: true,
    });
    expect(inviteeSignUp.status).toBe(200);
    const inviteeSignIn = await post(fixture.auth, "/sign-in/email", {
      email: invitedEmail,
      password: originalPassword,
    });
    const inviteeCookie = inviteeSignIn.headers.get("set-cookie");
    expect(inviteeCookie).toContain("better-auth.session_token=");
    const accepted = await post(
      fixture.auth,
      "/organization/accept-invitation",
      { invitationId: invitation.id },
      inviteeCookie,
    );
    expect(accepted.status).toBe(200);

    expect(
      fixture.database
        .query(
          `SELECT COUNT(*) AS count
           FROM member
           JOIN user ON user.id = member.userId
           WHERE user.email = ?`,
        )
        .get(invitedEmail),
    ).toEqual({ count: 2 });
    const invitedMember = fixture.database
      .query(
        `SELECT member.id, member.role
         FROM member
         JOIN user ON user.id = member.userId
         WHERE user.email = ? AND member.organizationId = ?`,
      )
      .get(invitedEmail, organization.id) as { id: string; role: string };
    expect(invitedMember.role).toBe("admin");
    expect(
      fixture.database
        .query(
          "SELECT member_id, invitation_id FROM employee_requirements WHERE id = 'renewed-form'",
        )
        .get(),
    ).toEqual({ member_id: invitedMember.id, invitation_id: null });
    const ownerMember = fixture.database
      .query(
        `SELECT member.id
         FROM member
         JOIN user ON user.id = member.userId
         WHERE user.email = ? AND member.organizationId = ?`,
      )
      .get(email, organization.id) as { id: string };
    const adminUpdatingOwner = await post(
      fixture.auth,
      "/organization/update-member-role",
      {
        memberId: ownerMember.id,
        organizationId: organization.id,
        role: "member",
      },
      inviteeCookie,
    );
    expect(adminUpdatingOwner.status).toBe(403);
    const ownerUpdatingAdmin = await post(
      fixture.auth,
      "/organization/update-member-role",
      {
        memberId: invitedMember.id,
        organizationId: organization.id,
        role: "member",
      },
      ownerCookie,
    );
    expect(ownerUpdatingAdmin.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT role FROM member WHERE id = ?")
        .get(invitedMember.id),
    ).toEqual({ role: "member" });
    expect(
      fixture.database
        .query(
          `SELECT user.defaultOrganizationId, invitation.status
           FROM user JOIN invitation ON invitation.email = user.email
           WHERE user.email = ? AND invitation.id = ?`,
        )
        .get(invitedEmail, invitation.id),
    ).toEqual({
      defaultOrganizationId: organization.id,
      status: "accepted",
    });
    const session = await fixture.auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie: inviteeCookie ?? "", origin },
      }),
    );
    expect(await session.json()).toMatchObject({
      session: { activeOrganizationId: organization.id },
      user: { defaultOrganizationId: organization.id },
    });
    const personalOrganization = fixture.database
      .query(
        `SELECT member.organizationId AS id
         FROM member JOIN user ON user.id = member.userId
         WHERE user.email = ? AND member.organizationId != ?`,
      )
      .get(invitedEmail, organization.id) as { id: string };
    const switched = await post(
      fixture.auth,
      "/organization/set-active",
      { organizationId: personalOrganization.id },
      inviteeCookie,
    );
    expect(switched.status).toBe(200);
    const switchedSession = await fixture.auth.handler(
      new Request(`${baseURL}/api/auth/get-session`, {
        headers: { cookie: inviteeCookie ?? "", origin },
      }),
    );
    expect(await switchedSession.json()).toMatchObject({
      session: { activeOrganizationId: personalOrganization.id },
      user: { defaultOrganizationId: organization.id },
    });

    const secondarySignIn = await post(fixture.auth, "/sign-in/email", {
      email: invitedEmail,
      password: originalPassword,
    });
    const secondaryCookie = secondarySignIn.headers.get("set-cookie");
    expect(
      await (await get(fixture.auth, "/get-session", secondaryCookie)).json(),
    ).toMatchObject({
      session: { activeOrganizationId: organization.id },
    });
    expect(
      (
        await post(
          fixture.auth,
          "/organization/set-active",
          { organizationId: organization.id },
          inviteeCookie,
        )
      ).status,
    ).toBe(200);

    const leave = await post(
      fixture.auth,
      "/organization/leave",
      { organizationId: organization.id },
      inviteeCookie,
    );
    expect(leave.status).toBe(200);
    expect(
      fixture.database
        .query(
          `SELECT user.defaultOrganizationId,
                  (SELECT COUNT(*) FROM member
                   WHERE member.userId = user.id) AS membershipCount
           FROM user WHERE user.email = ?`,
        )
        .get(invitedEmail),
    ).toEqual({
      defaultOrganizationId: personalOrganization.id,
      membershipCount: 1,
    });
    expect(
      fixture.database
        .query(
          `SELECT session.activeOrganizationId
           FROM session JOIN user ON user.id = session.userId
           WHERE user.email = ?
           ORDER BY session.activeOrganizationId`,
        )
        .all(invitedEmail),
    ).toEqual([
      { activeOrganizationId: null },
      { activeOrganizationId: personalOrganization.id },
    ]);
    expect(
      (
        await post(
          fixture.auth,
          "/organization/set-active",
          { organizationId: personalOrganization.id },
          inviteeCookie,
        )
      ).status,
    ).toBe(200);
  });

  it("lets a user create and activate another organization", async () => {
    const fixture = await createFixture();
    const signUp = await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    expect(signUp.status).toBe(200);
    const signIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const cookie = signIn.headers.get("set-cookie");
    const created = await post(
      fixture.auth,
      "/organization/create",
      { name: "Field Operations", slug: "field-operations-12345678" },
      cookie,
    );
    expect(created.status).toBe(200);
    const organization = (await created.json()) as { id: string };
    expect(
      fixture.database
        .query(
          `SELECT user.defaultOrganizationId,
                  (SELECT COUNT(*) FROM member
                   WHERE member.userId = user.id) AS membershipCount
           FROM user WHERE user.email = ?`,
        )
        .get(email),
    ).toEqual({
      defaultOrganizationId: organization.id,
      membershipCount: 2,
    });
    expect(
      await (await get(fixture.auth, "/get-session", cookie)).json(),
    ).toMatchObject({
      session: { activeOrganizationId: organization.id },
    });
    expect(financeGroupFor(fixture.database, organization.id)).toMatchObject({
      capability: "finance",
      memberCount: 1,
      name: "Finance",
    });
    fixture.database
      .query("UPDATE user SET defaultOrganizationPinned = 1 WHERE email = ?")
      .run(email);
    const another = await post(
      fixture.auth,
      "/organization/create",
      { name: "Another Organization", slug: "another-organization-12345678" },
      cookie,
    );
    expect(another.status).toBe(200);
    expect(
      fixture.database
        .query("SELECT defaultOrganizationId FROM user WHERE email = ?")
        .get(email),
    ).toEqual({ defaultOrganizationId: organization.id });
  });

  it("keeps a saved default after accepting an invitation and signing in again", async () => {
    const fixture = await createFixture();
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
      termsAccepted: true,
    });
    const ownerSignIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const ownerOrganization = fixture.database
      .query("SELECT defaultOrganizationId AS id FROM user WHERE email = ?")
      .get(email) as { id: string };
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_price_id, stripe_status, seat_quantity,
          stripe_event_created, updated_at)
         VALUES (?, 'price_pro_test', 'active', 1, 1, ?)`,
      )
      .run(ownerOrganization.id, new Date().toISOString());

    const invitedEmail = "saved-default@example.com";
    await post(fixture.auth, "/sign-up/email", {
      email: invitedEmail,
      name: "Saved Default",
      password: originalPassword,
      termsAccepted: true,
    });
    const personalOrganization = fixture.database
      .query("SELECT defaultOrganizationId AS id FROM user WHERE email = ?")
      .get(invitedEmail) as { id: string };
    const inviteeSignIn = await post(fixture.auth, "/sign-in/email", {
      email: invitedEmail,
      password: originalPassword,
    });
    const inviteeCookie = inviteeSignIn.headers.get("set-cookie");
    const saved = await app.request(
      "/api/account-settings/default-organization",
      {
        body: JSON.stringify({ organizationId: personalOrganization.id }),
        headers: {
          "content-type": "application/json",
          cookie: inviteeCookie ?? "",
          origin,
        },
        method: "PATCH",
      },
      { ...fixture.bindings, DB: toD1(fixture.database) },
    );
    expect(saved.status).toBe(200);

    const invitation = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: invitedEmail,
        organizationId: ownerOrganization.id,
        role: "member",
      },
      ownerSignIn.headers.get("set-cookie"),
    );
    expect(invitation.status).toBe(200);
    const invitationId = ((await invitation.json()) as { id: string }).id;
    const accepted = await post(
      fixture.auth,
      "/organization/accept-invitation",
      { invitationId },
      inviteeCookie,
    );
    expect(accepted.status).toBe(200);
    expect(
      fixture.database
        .query(
          "SELECT defaultOrganizationId, defaultOrganizationPinned FROM user WHERE email = ?",
        )
        .get(invitedEmail),
    ).toEqual({
      defaultOrganizationId: personalOrganization.id,
      defaultOrganizationPinned: 1,
    });

    const freshSignIn = await post(fixture.auth, "/sign-in/email", {
      email: invitedEmail,
      password: originalPassword,
    });
    expect(freshSignIn.status).toBe(200);
    expect(
      await (
        await get(
          fixture.auth,
          "/get-session",
          freshSignIn.headers.get("set-cookie"),
        )
      ).json(),
    ).toMatchObject({
      session: { activeOrganizationId: personalOrganization.id },
      user: { defaultOrganizationId: personalOrganization.id },
    });
  });

  it("backfills an organization for an existing user", async () => {
    const database = new Database(":memory:");
    await applyMigration(database, "0003_create_auth.sql");
    database
      .query(
        `INSERT INTO user
         (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "existing-user",
        "Existing User",
        "existing@example.com",
        false,
        "2026-08-18T12:00:00.000Z",
        "2026-08-18T12:00:00.000Z",
        "user",
        false,
      );

    await applyMigration(database, "0004_create_organizations.sql");

    expect(
      database
        .query(
          `SELECT organization.name, member.role
           FROM user
           JOIN organization
             ON organization.id = user.defaultOrganizationId
           JOIN member ON member.organizationId = organization.id
           WHERE user.id = ?`,
        )
        .get("existing-user"),
    ).toEqual({ name: "Existing User's Organization", role: "owner" });
  });
});

function financeGroupFor(database: Database, organizationId: string) {
  return database
    .query(
      `SELECT "team"."name", "team"."memberCount",
              access."capability"
       FROM "team"
       JOIN organization_group_capability AS access
         ON access.team_id = "team"."id"
       WHERE "team"."organizationId" = ? AND access.capability = 'finance'`,
    )
    .get(organizationId);
}

function toD1(database: Database) {
  return {
    batch: async (statements: Array<{ execute: () => unknown }>) =>
      statements.map((statement) => statement.execute()),
    exec: async (query: string) => database.exec(query),
    prepare: (query: string) => {
      let values: SQLQueryBindings[] = [];
      const statement = {
        all: async () => {
          const results = database.query(query).all(...values);
          const meta = database
            .query(
              `SELECT changes() AS changes,
                      last_insert_rowid() AS last_row_id`,
            )
            .get() as { changes: number; last_row_id: number };
          return { meta, results, success: true };
        },
        bind: (...nextValues: SQLQueryBindings[]) => {
          values = nextValues;
          return statement;
        },
        execute: () => run(),
        first: async () => database.query(query).get(...values),
        raw: async () => database.query(query).values(...values),
        run: async () => run(),
      };
      const run = () => {
        const result = database.query(query).run(...values);
        return {
          meta: { changes: result.changes },
          results: [],
          success: true,
        };
      };
      return statement;
    },
  } as unknown as D1Database;
}

async function createFixture() {
  const database = new Database(":memory:");
  const messages: EmailMessageBuilder[] = [];
  const pending: Promise<unknown>[] = [];
  const bindings = {
    AUTH_EMAIL_FROM: "security@auth.tearleads.de",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: baseURL,
    CORS_ORIGIN: origin,
    DB: database as unknown as D1Database,
    EMAIL: {
      send: async (message: EmailMessageBuilder) => {
        messages.push(message);
        return { messageId: "test-message" };
      },
    } as unknown as SendEmail,
    IMAGES: {} as ImagesBinding,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.de",
    STRIPE_PRO_PRICE_ID: "price_pro_test",
    STORAGE: {} as R2Bucket,
  } satisfies Bindings;
  const auth = createAuth(bindings, (promise) => pending.push(promise));

  await applyMigration(database, "0003_create_auth.sql");
  await applyMigration(database, "0004_create_organizations.sql");
  await applyMigration(database, "0008_keep_organization_defaults_valid.sql");
  await applyMigration(database, "0010_create_organization_groups.sql");
  await applyMigration(database, "0011_soft_delete_organizations.sql");
  await applyMigration(database, "0020_add_two_factor_authentication.sql");
  await applyMigration(database, "0021_track_terms_acceptance.sql");
  await applyMigration(database, "0031_require_member_two_factor.sql");
  await applyMigration(database, "0032_create_billing.sql");
  await applyMigration(database, "0040_pin_default_organization.sql");
  await applyMigration(database, "0041_create_employee_requirements.sql");

  return { auth, bindings, database, messages, pending };
}

function post(
  auth: ReturnType<typeof createAuth>,
  path: string,
  body: Record<string, unknown>,
  cookie?: string | null,
) {
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        cookie: cookie ?? "",
        origin,
      },
      method: "POST",
    }),
  );
}

async function applyMigration(database: Database, filename: string) {
  database.exec(
    await Bun.file(
      new URL(`../migrations/${filename}`, import.meta.url),
    ).text(),
  );
}

function get(
  auth: ReturnType<typeof createAuth>,
  path: string,
  cookie: string | null,
) {
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      headers: { cookie: cookie ?? "", origin },
    }),
  );
}

interface DeviceSession {
  session: { token: string };
  user: { email: string };
}

function totpSecret(uri: string) {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI is missing its secret.");
  return secret;
}

function hasMultiSessionCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .some((header) => header.includes("_multi-"));
}

function withoutMultiSessionCookies(header: string) {
  return header
    .split("; ")
    .filter((cookie) => !cookie.includes("_multi-"))
    .join("; ");
}

async function totpCode(uri: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase32(totpSecret(uri)),
    { hash: "SHA-1", name: "HMAC" },
    false,
    ["sign"],
  );
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(
    0,
    BigInt(Math.floor(Date.now() / 30_000)),
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const value =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return (value % 1_000_000).toString().padStart(6, "0");
}

function decodeBase32(encoded: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of encoded.toUpperCase().replace(/=+$/, "")) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("TOTP secret is not valid base32.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Uint8Array.from(bytes);
}

class CookieJar {
  readonly #cookies = new Map<string, string>();

  absorb(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (!value || /max-age=0/i.test(header)) {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, value);
      }
    }
  }

  header() {
    return [...this.#cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

async function activeEmail(
  auth: ReturnType<typeof createAuth>,
  cookies: CookieJar,
) {
  const response = await get(auth, "/get-session", cookies.header());
  const session = (await response.json()) as { user: { email: string } };
  return session.user.email;
}
