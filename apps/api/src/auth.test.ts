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
      user: { email, emailVerified: false, role: "user" },
    });

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

  database.exec(
    await Bun.file(
      new URL("../migrations/0003_create_auth.sql", import.meta.url),
    ).text(),
  );

  return { auth, database, messages, pending };
}

function post(
  auth: ReturnType<typeof createAuth>,
  path: string,
  body: Record<string, unknown>,
) {
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    }),
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
