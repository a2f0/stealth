import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import { type AuthVariables, requireOrganization } from "./authMiddleware";
import type { Bindings } from "./types";

describe("organization middleware", () => {
  it("uses the session's one active organization", async () => {
    const response = await testApp("active-org", "default-org").request("/");
    const body: unknown = await response.json();
    expect(body).toEqual({ organizationId: "active-org" });
  });

  it("falls back to the user's default organization", async () => {
    const response = await testApp(null, "default-org").request("/");
    const body: unknown = await response.json();
    expect(body).toEqual({ organizationId: "default-org" });
  });
});

function testApp(
  activeOrganizationId: string | null,
  defaultOrganizationId: string,
) {
  const app = new Hono<{
    Bindings: Bindings;
    Variables: AuthVariables;
  }>();
  app.use("*", async (context, next) => {
    context.set("authSession", {
      session: { activeOrganizationId },
      user: { defaultOrganizationId },
    } as unknown as AuthSession);
    await next();
  });
  app.use("*", requireOrganization);
  app.get("/", (context) =>
    context.json({ organizationId: context.get("organizationId") }),
  );
  return app;
}
