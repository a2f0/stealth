import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth";
import { type AuthVariables, requireAuth, requireRole } from "./authMiddleware";
import { objects } from "./objects";
import type { Bindings } from "./types";

const app = new Hono<{
  Bindings: Bindings;
  Variables: AuthVariables;
}>();

app.use(
  "/api/*",
  cors({
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    origin: (_origin, context) => context.env.CORS_ORIGIN,
  }),
);

app.all("/api/auth/*", (context) =>
  createAuth(context.env, (promise) =>
    context.executionCtx.waitUntil(promise),
  ).handler(context.req.raw),
);

app.get("/", (context) =>
  context.json({ name: "stealth-api", documentation: "/api" }),
);

app.get("/health", (context) =>
  context.json({ status: "ok", timestamp: new Date().toISOString() }),
);

app.get("/api", (context) =>
  context.json({
    endpoints: {
      objects: "/api/objects",
      session: "/api/me",
      health: "/health",
    },
  }),
);

app.get("/api/me", requireAuth, (context) =>
  context.json({ user: context.get("authSession").user }),
);

app.get("/api/admin", requireAuth, requireRole("admin"), (context) =>
  context.json({ user: context.get("authSession").user }),
);

app.route("/api/objects", objects);

app.notFound((context) => context.json({ error: "Not found." }, 404));

app.onError((error, context) => {
  console.error(error);
  return context.json({ error: "Unexpected server error." }, 500);
});

export { app };
