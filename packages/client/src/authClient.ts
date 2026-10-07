import {
  adminClient,
  inferAdditionalFields,
  multiSessionClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { fetchApi } from "./apiVersion";
import { apiUrl } from "./config";

export const authClient = createAuthClient({
  baseURL: apiUrl,
  // Like the app's other API calls, go through fetchApi: it looks fetch up per
  // request and records the API version each response names.
  fetchOptions: { customFetchImpl: (input, init) => fetchApi(input, init) },
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
