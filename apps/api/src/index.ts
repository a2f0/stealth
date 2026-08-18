import { app } from "./app";
import { handleEmail } from "./email";
import type { Bindings } from "./types";

export default {
  email: handleEmail,
  fetch: app.fetch,
} satisfies ExportedHandler<Bindings>;
