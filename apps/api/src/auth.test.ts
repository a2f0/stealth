import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createAuth } from "./auth";
import type { Bindings } from "./types";

const baseURL = "https://api.test";
const origin = "https://app.test";
const email = "person@example.com";
const originalPassword = "correct horse battery staple";
const replacementPassword = "new correct horse battery staple";

describe("password authentication", () => {
  it("supports email verification without blocking login", async () => {
    const fixture = await createFixture();

    const signUp = await post(fixture.auth, "/sign-up/email", {
      callbackURL: `${origin}/?verified=true`,
      email,
      name: "Example Person",
      password: originalPassword,
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
    });
    await post(fixture.auth, "/sign-up/email", {
      email: secondEmail,
      name: "Second Person",
      password: originalPassword,
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

  it("only lets admins list users", async () => {
    const fixture = await createFixture();
    const signUp = await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
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

    fixture.database
      .query('UPDATE "user" SET role = ? WHERE email = ?')
      .run("admin", email);
    const adminSignIn = await post(fixture.auth, "/sign-in/email", {
      email,
      password: originalPassword,
    });
    const adminCookie = adminSignIn.headers.get("set-cookie");
    const listing = await get(
      fixture.auth,
      "/admin/list-users?limit=25&sortBy=createdAt&sortDirection=desc",
      adminCookie,
    );
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({
      total: 1,
      users: [{ email, role: "admin" }],
    });
  });

  it("only lets owners rename their organization", async () => {
    const fixture = await createFixture();
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
    });
    const organization = fixture.database
      .query("SELECT id FROM organization")
      .get() as { id: string };
    await post(fixture.auth, "/sign-up/email", {
      email: "other@example.com",
      name: "Other Person",
      password: originalPassword,
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

  it("invites a user into an organization and activates it on acceptance", async () => {
    const fixture = await createFixture();
    await post(fixture.auth, "/sign-up/email", {
      email,
      name: "Example Person",
      password: originalPassword,
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

    const invite = await post(
      fixture.auth,
      "/organization/invite-member",
      {
        email: invitedEmail,
        organizationId: organization.id,
        role: "member",
      },
      ownerCookie,
    );
    expect(invite.status).toBe(200);
    const invitation = (await invite.json()) as { id: string };
    await Promise.all(fixture.pending);
    expect(
      fixture.messages.find(({ subject }) => subject.startsWith("You're")),
    ).toMatchObject({
      subject: `You're invited to ${organization.name}`,
      to: invitedEmail,
    });
    const invitationMessage = fixture.messages.find(({ subject }) =>
      subject.startsWith("You're"),
    );
    expect(invitationMessage?.text).toContain(
      `${origin}/invite?id=${invitation.id}`,
    );

    await post(fixture.auth, "/sign-up/email", {
      email: invitedEmail,
      name: "Invited Person",
      password: originalPassword,
    });
    const inviteeSignIn = await post(fixture.auth, "/sign-in/email", {
      email: invitedEmail,
      password: originalPassword,
    });
    const inviteeCookie = inviteeSignIn.headers.get("set-cookie");
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
    expect(
      fixture.database
        .query(
          `SELECT user.defaultOrganizationId, invitation.status
           FROM user JOIN invitation ON invitation.email = user.email
           WHERE user.email = ?`,
        )
        .get(invitedEmail),
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

async function createFixture() {
  const database = new Database(":memory:");
  const messages: EmailMessageBuilder[] = [];
  const pending: Promise<unknown>[] = [];
  const bindings = {
    AUTH_EMAIL_FROM: "security@auth.tearleads.com",
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
    INBOUND_EMAIL_ADDRESS: "upload@inbox.tearleads.com",
    STORAGE: {} as R2Bucket,
  } satisfies Bindings;
  const auth = createAuth(bindings, (promise) => pending.push(promise));

  await applyMigration(database, "0003_create_auth.sql");
  await applyMigration(database, "0004_create_organizations.sql");

  return { auth, database, messages, pending };
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
