import {
  adminClient,
  inferAdditionalFields,
  multiSessionClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { apiUrl } from "./config";

export const authClient = createAuthClient({
  baseURL: apiUrl,
  plugins: [
    inferAdditionalFields({
      user: {
        termsAccepted: {
          required: false,
          returned: false,
          type: "boolean",
        },
      },
    }),
    adminClient(),
    multiSessionClient(),
    twoFactorClient(),
    organizationClient({ teams: { enabled: true } }),
  ],
});
