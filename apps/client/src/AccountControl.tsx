import { Avatar, Icon } from "@tearleads/ui/react";
import { useRef, useState } from "react";
import type { AccountSession } from "./accountSessions";
import { useMenuDismissal } from "./useMenuDismissal";

interface AccountControlProps {
  accounts: AccountSession[];
  activeSessionToken: string;
  loadError: string | undefined;
  onAddAccount: () => void;
  onRefreshAccounts: () => Promise<void>;
  onSecurity: () => void;
  onSignOut: () => Promise<void>;
  onSwitchAccount: (sessionToken: string) => Promise<void>;
  user: { email: string; name: string };
}

export function AccountControl({
  accounts,
  activeSessionToken,
  loadError,
  onAddAccount,
  onRefreshAccounts,
  onSecurity,
  onSignOut,
  onSwitchAccount,
  user,
}: AccountControlProps) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useMenuDismissal(open, menu, trigger, () => setOpen(false));

  async function run(action: () => Promise<void>, busyKey: string) {
    setBusy(busyKey);
    setError(undefined);
    try {
      await action();
      setOpen(false);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(undefined);
    }
  }

  function toggleMenu() {
    const nextOpen = !open;
    setError(undefined);
    setOpen(nextOpen);
    if (nextOpen) {
      void onRefreshAccounts().catch((cause) => setError(messageFrom(cause)));
    }
  }

  return (
    <div className="accountControl" ref={menu}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account menu for ${user.name}`}
        className="accountTrigger"
        disabled={Boolean(busy)}
        onClick={toggleMenu}
        ref={trigger}
        type="button"
      >
        <Avatar name={user.name} />
        <span className="accountIdentity">
          <strong className="truncate">{user.name}</strong>
          <span className="truncate">{user.email}</span>
        </span>
        <Icon className="accountTriggerIcon" name="more" size={18} />
      </button>
      {open && (
        <AccountMenu
          accounts={accounts}
          activeSessionToken={activeSessionToken}
          busy={busy}
          error={error ?? loadError}
          onAddAccount={onAddAccount}
          onSecurity={() => {
            setOpen(false);
            onSecurity();
          }}
          onSignOut={() => run(onSignOut, "sign-out")}
          onSwitchAccount={(token) => run(() => onSwitchAccount(token), token)}
        />
      )}
    </div>
  );
}

function AccountMenu({
  accounts,
  activeSessionToken,
  busy,
  error,
  onAddAccount,
  onSignOut,
  onSecurity,
  onSwitchAccount,
}: {
  accounts: AccountSession[];
  activeSessionToken: string;
  busy: string | undefined;
  error: string | undefined;
  onAddAccount: () => void;
  onSignOut: () => Promise<void>;
  onSecurity: () => void;
  onSwitchAccount: (token: string) => Promise<void>;
}) {
  return (
    <div className="popover accountMenu" role="menu">
      <p className="menuLabel">Accounts</p>
      {error && (
        <p className="accountMenuError" role="alert">
          {error}
        </p>
      )}
      <div className="accountChoices">
        {accounts.map((account) => {
          const active = account.token === activeSessionToken;
          return (
            <button
              aria-checked={active}
              className="accountChoice"
              disabled={Boolean(busy) || active}
              key={account.user.id}
              onClick={() => void onSwitchAccount(account.token)}
              role="menuitemradio"
              type="button"
            >
              <Avatar name={account.user.name} size="sm" />
              <span className="accountIdentity">
                <strong className="truncate">{account.user.name}</strong>
                <span className="truncate">{account.user.email}</span>
              </span>
              <span className="accountChoiceStatus">
                {busy === account.token ? (
                  <span aria-hidden="true" className="spinner" />
                ) : (
                  active && <Icon label="Active account" name="check" />
                )}
              </span>
            </button>
          );
        })}
      </div>
      <hr className="menuSeparator" />
      <button
        className="menuItem"
        disabled={Boolean(busy)}
        onClick={onSecurity}
        role="menuitem"
        type="button"
      >
        <Icon name="security" /> Account security
      </button>
      <button
        className="menuItem"
        disabled={Boolean(busy)}
        onClick={onAddAccount}
        role="menuitem"
        type="button"
      >
        <Icon name="userAdd" /> Add another account
      </button>
      <hr className="menuSeparator" />
      <button
        className="menuItem"
        disabled={Boolean(busy)}
        onClick={() => void onSignOut()}
        role="menuitem"
        type="button"
      >
        <Icon name="signOut" />
        {busy === "sign-out" ? "Signing out…" : "Sign out of this account"}
      </button>
    </div>
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not update accounts.";
}
