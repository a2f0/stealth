import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
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
    plugins: [admin({ adminRoles: ["admin"], defaultRole: "user" })],
    rateLimit: {
      enabled: true,
      storage: "database",
    },
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.CORS_ORIGIN],
  });
}

type Auth = ReturnType<typeof createAuth>;
type BaseAuthSession = NonNullable<
  Awaited<ReturnType<Auth["api"]["getSession"]>>
>;
export type AuthSession = Omit<BaseAuthSession, "user"> & {
  user: BaseAuthSession["user"] & {
    role: string;
  };
};
