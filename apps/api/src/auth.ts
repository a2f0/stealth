import {
  betterAuth,
  type GenericEndpointContext,
  type Session,
  type User,
} from "better-auth";
import { admin, multiSession, organization } from "better-auth/plugins";
import type { Bindings } from "./types";

type WaitUntil = (promise: Promise<unknown>) => void;

export function createAuth(env: Bindings, waitUntil: WaitUntil) {
  return betterAuth({
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
    },
    baseURL: env.BETTER_AUTH_URL,
    database: env.DB,
    databaseHooks: authDatabaseHooks(env),
    emailAndPassword: {
      autoSignIn: false,
      customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
        ...coreFields,
        role: "user",
        banned: false,
        banReason: null,
        banExpires: null,
        ...additionalFields,
        id,
      }),
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        waitUntil(
          env.EMAIL.send({
            from: { email: env.AUTH_EMAIL_FROM, name: "Stealth" },
            subject: "Reset your Stealth password",
            text: [
              `Hi ${user.name},`,
              "",
              "Use this link to reset your Stealth password:",
              url,
              "",
              "The link expires in one hour. If you did not request this, you can ignore this email.",
            ].join("\n"),
            to: user.email,
          }),
        );
      },
    },
    emailVerification: {
      expiresIn: 60 * 60,
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        waitUntil(
          env.EMAIL.send({
            from: { email: env.AUTH_EMAIL_FROM, name: "Stealth" },
            subject: "Verify your Stealth email",
            text: [
              `Hi ${user.name},`,
              "",
              "Verify your email address for Stealth:",
              url,
              "",
              "The link expires in one hour. You can still sign in before verifying.",
            ].join("\n"),
            to: user.email,
          }),
        );
      },
    },
    plugins: [
      admin({ adminRoles: ["admin"], defaultRole: "user" }),
      multiSession({ maximumSessions: 5 }),
      configuredOrganizationPlugin(env, waitUntil),
    ],
    rateLimit: {
      enabled: true,
      storage: "database",
    },
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.CORS_ORIGIN],
    user: {
      additionalFields: {
        defaultOrganizationId: {
          input: false,
          references: { field: "id", model: "organization" },
          required: false,
          type: "string",
        },
      },
    },
  });
}

function authDatabaseHooks(env: Bindings) {
  return {
    session: { create: { before: activateDefaultOrganization } },
    user: {
      create: {
        after: (user: User, context: GenericEndpointContext | null) =>
          provisionDefaultOrganization(user, context, env.DB),
      },
    },
  };
}

function configuredOrganizationPlugin(env: Bindings, waitUntil: WaitUntil) {
  return organization({
    allowUserToCreateOrganization: true,
    cancelPendingInvitationsOnReInvite: true,
    disableOrganizationDeletion: true,
    invitationExpiresIn: 60 * 60 * 48,
    organizationHooks: {
      afterCreateOrganization: async ({ organization, user }) => {
        await updateDefaultOrganization(env.DB, user.id, organization.id);
        await createDefaultFinanceGroup(env.DB, organization.id, user.id);
      },
      afterAcceptInvitation: async ({ organization, user }) => {
        await updateDefaultOrganization(env.DB, user.id, organization.id);
      },
    },
    sendInvitationEmail: async (data) => {
      queueInvitationEmail(env, waitUntil, data);
    },
    teams: {
      allowRemovingAllTeams: true,
      enabled: true,
      maximumTeams: 50,
    },
  });
}

function queueInvitationEmail(
  env: Bindings,
  waitUntil: WaitUntil,
  data: {
    email: string;
    id: string;
    inviter: { user: { email: string; name: string } };
    organization: { name: string };
    role: string;
  },
) {
  const invitationURL = new URL("/invite", env.CORS_ORIGIN);
  invitationURL.searchParams.set("id", data.id);
  waitUntil(
    env.EMAIL.send({
      from: { email: env.AUTH_EMAIL_FROM, name: "Stealth" },
      subject: `You're invited to ${data.organization.name}`,
      text: [
        "Hi,",
        "",
        `${data.inviter.user.name} (${data.inviter.user.email}) invited you to join ${data.organization.name} on Stealth with the ${data.role} role.`,
        "",
        "Accept the invitation:",
        invitationURL.toString(),
        "",
        "This invitation expires in 48 hours. Sign in or create an account using this email address to accept it.",
      ].join("\n"),
      to: data.email,
    }),
  );
}

async function provisionDefaultOrganization(
  user: User,
  context: GenericEndpointContext | null,
  database: D1Database,
) {
  if (!context) {
    throw new Error(
      "An auth context is required to provision an organization.",
    );
  }

  const adapter = context.context.adapter;
  const organizationRecord = await adapter.create<
    { createdAt: Date; name: string; slug: string },
    { id: string }
  >({
    data: {
      createdAt: new Date(),
      name: defaultOrganizationName(user.name),
      slug: `personal-${user.id.toLowerCase()}`,
    },
    model: "organization",
  });

  try {
    await adapter.create({
      data: {
        createdAt: new Date(),
        organizationId: organizationRecord.id,
        role: "owner",
        userId: user.id,
      },
      model: "member",
    });
    await adapter.update({
      model: "user",
      update: { defaultOrganizationId: organizationRecord.id },
      where: [{ field: "id", value: user.id }],
    });
    await createDefaultFinanceGroup(database, organizationRecord.id, user.id);
  } catch (error) {
    await adapter.delete({
      model: "organization",
      where: [{ field: "id", value: organizationRecord.id }],
    });
    throw error;
  }
}

async function createDefaultFinanceGroup(
  database: D1Database,
  organizationId: string,
  userId: string,
) {
  const teamId = crypto.randomUUID();
  const now = new Date().toISOString();
  await runStatement(
    database,
    `INSERT INTO "team"
     ("id", "name", "organizationId", "memberCount", "createdAt", "updatedAt")
     VALUES (?, 'Finance', ?, 1, ?, ?)`,
    [teamId, organizationId, now, now],
  );
  await runStatement(
    database,
    `INSERT INTO "teamMember"
     ("id", "teamId", "userId", "membershipKey", "createdAt")
     VALUES (?, ?, ?, NULL, ?)`,
    [crypto.randomUUID(), teamId, userId, now],
  );
  await runStatement(
    database,
    `INSERT INTO "organization_group_capability"
     ("organization_id", "team_id", "capability") VALUES (?, ?, 'finance')`,
    [organizationId, teamId],
  );
}

async function runStatement(
  database: D1Database,
  query: string,
  values: string[],
) {
  const statement = database.prepare(query);
  if (typeof statement.bind === "function") {
    await statement.bind(...values).run();
    return;
  }
  await (
    statement as unknown as { run: (...bindings: string[]) => unknown }
  ).run(...values);
}

async function activateDefaultOrganization(
  session: Session,
  context: GenericEndpointContext | null,
) {
  if (!context) return;
  const user = await context.context.adapter.findOne<{
    defaultOrganizationId: string | null;
  }>({
    model: "user",
    select: ["defaultOrganizationId"],
    where: [{ field: "id", value: session.userId }],
  });
  if (!user?.defaultOrganizationId) return;
  return {
    data: {
      ...session,
      activeOrganizationId: user.defaultOrganizationId,
    },
  };
}

function defaultOrganizationName(userName: string) {
  const name = userName.trim();
  return name ? `${name}'s Organization` : "My Organization";
}

async function updateDefaultOrganization(
  database: D1Database,
  userId: string,
  organizationId: string,
) {
  const statement = database.prepare(
    'UPDATE "user" SET "defaultOrganizationId" = ? WHERE "id" = ?',
  );
  if (typeof statement.bind === "function") {
    await statement.bind(organizationId, userId).run();
    return;
  }
  await (statement as unknown as { run: (...values: string[]) => unknown }).run(
    organizationId,
    userId,
  );
}

type Auth = ReturnType<typeof createAuth>;
type BaseAuthSession = NonNullable<
  Awaited<ReturnType<Auth["api"]["getSession"]>>
>;
export type AuthSession = Omit<BaseAuthSession, "user"> & {
  user: BaseAuthSession["user"] & {
    role: string;
    defaultOrganizationId?: string | null | undefined;
  };
};
