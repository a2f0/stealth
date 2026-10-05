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
  // Like the app's other API calls, look fetch up per request instead of
  // keeping the one present when this client was created.
  fetchOptions: { customFetchImpl: (input, init) => fetch(input, init) },
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
