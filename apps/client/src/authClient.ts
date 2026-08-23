import {
  adminClient,
  multiSessionClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { apiUrl } from "./config";

export const authClient = createAuthClient({
  baseURL: apiUrl,
  plugins: [
    adminClient(),
    multiSessionClient(),
    twoFactorClient(),
    organizationClient({ teams: { enabled: true } }),
  ],
});
