import {
  betterAuth,
  type GenericEndpointContext,
  type Session,
  type User,
} from "better-auth";
import { admin, organization } from "better-auth/plugins";
import type { Bindings } from "./types";

type WaitUntil = (promise: Promise<unknown>) => void;
const authPlugins = [
  admin({ adminRoles: ["admin"], defaultRole: "user" }),
  organization({
    allowUserToCreateOrganization: false,
    disableOrganizationDeletion: true,
    organizationLimit: 1,
  }),
];

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
    databaseHooks: {
      session: { create: { before: activateDefaultOrganization } },
      user: { create: { after: provisionDefaultOrganization } },
    },
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
    plugins: authPlugins,
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

async function provisionDefaultOrganization(
  user: User,
  context: GenericEndpointContext | null,
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
  } catch (error) {
    await adapter.delete({
      model: "organization",
      where: [{ field: "id", value: organizationRecord.id }],
    });
    throw error;
  }
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
