import { Hono } from "hono";
import { cors } from "hono/cors";
import { objects } from "./objects";
import type { Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

app.use(
  "/api/*",
  cors({
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    origin: (_origin, context) => context.env.CORS_ORIGIN,
  }),
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
      health: "/health",
    },
  }),
);

app.route("/api/objects", objects);

app.notFound((context) => context.json({ error: "Not found." }, 404));

app.onError((error, context) => {
  console.error(error);
  return context.json({ error: "Unexpected server error." }, 500);
});

export { app };
