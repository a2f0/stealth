import { adminClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { apiUrl } from "./config";

export const authClient = createAuthClient({
  baseURL: apiUrl,
  plugins: [adminClient(), organizationClient()],
});
