import { useCallback, useEffect, useState } from "react";
import { authClient } from "./authClient";

export interface AccountSession {
  token: string;
  user: AccountUser;
}

interface AccountUser {
  email: string;
  id: string;
  name: string;
}

interface CurrentSession {
  session: { token: string };
  user: AccountUser;
}

export function accountSessionsFor(
  current: AccountSession,
  listed: AccountSession[],
) {
  const sessionsByUser = new Map(
    listed.map((session) => [session.user.id, session]),
  );
  sessionsByUser.set(current.user.id, current);
  const otherSessions = [...sessionsByUser.values()]
    .filter(({ user }) => user.id !== current.user.id)
    .sort((left, right) => left.user.name.localeCompare(right.user.name));
  return [current, ...otherSessions];
}

export function useAccountSessions(
  session: CurrentSession | null | undefined,
  refetchSession: () => Promise<unknown>,
) {
  const [listed, setListed] = useState<AccountSession[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const load = useCallback(async () => {
    const result = await authClient.multiSession.listDeviceSessions();
    if (result.error) {
      const message = result.error.message ?? "Could not load your accounts.";
      setLoadError(message);
      throw new Error(message);
    }
    setLoadError(undefined);
    setListed(
      (result.data ?? []).map(({ session: listedSession, user }) => ({
        token: listedSession.token,
        user: { email: user.email, id: user.id, name: user.name },
      })),
    );
  }, []);
  const userId = session?.user.id;
  const sessionToken = session?.session.token;

  useEffect(() => {
    setListed([]);
    setLoadError(undefined);
    if (!userId || !sessionToken) return;
    void load().catch(() => undefined);
  }, [load, sessionToken, userId]);

  const current = session
    ? { token: session.session.token, user: session.user }
    : undefined;
  const accounts = current ? accountSessionsFor(current, listed) : [];

  async function switchAccount(token: string) {
    if (token === sessionToken) return;
    const result = await authClient.multiSession.setActive({
      sessionToken: token,
    });
    throwForAccountError(result.error, "Could not switch accounts.");
    await refetchSession();
  }

  async function signOutActiveAccount() {
    if (!sessionToken) return;
    const result = await authClient.multiSession.revoke({
      sessionToken,
    });
    throwForAccountError(result.error, "Could not sign out.");
    await refetchSession();
  }

  return {
    accounts,
    loadError,
    refresh: load,
    signOutActiveAccount,
    switchAccount,
  };
}

function throwForAccountError(
  error: { message?: string | undefined } | null,
  fallback: string,
) {
  if (error) throw new Error(error.message ?? fallback);
}
