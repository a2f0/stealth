import { app } from "./app";
import { handleEmail } from "./email";
import { maintenanceTasks, runScheduledMaintenance } from "./maintenance";
import type { Bindings } from "./types";

export default {
  email: handleEmail,
  fetch: app.fetch,
  scheduled: (controller, environment, context) => {
    context.waitUntil(
      runScheduledMaintenance(maintenanceTasks(environment), {
        trigger: "scheduled",
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      }),
    );
  },
} satisfies ExportedHandler<Bindings>;
