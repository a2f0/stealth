import { useEffect, useRef, useState } from "react";
import type { AccountSession } from "./accountSessions";

interface AccountControlProps {
  accounts: AccountSession[];
  activeSessionToken: string;
  loadError: string | undefined;
  onAddAccount: () => void;
  onRefreshAccounts: () => Promise<void>;
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
  onSignOut,
  onSwitchAccount,
  user,
}: AccountControlProps) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useAccountMenuDismissal(open, menu, trigger, () => setOpen(false));

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
    <div className="accountBlock">
      <span className="accountAvatar">{initialsFor(user.name)}</span>
      <span className="accountIdentity">
        <strong>{user.name}</strong>
        <span>{user.email}</span>
      </span>
      <div className="accountMenu" ref={menu}>
        <button
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label="Account menu"
          className="accountMenuButton"
          disabled={Boolean(busy)}
          onClick={toggleMenu}
          ref={trigger}
          type="button"
        >
          ⋮
        </button>
        {open && (
          <AccountMenu
            accounts={accounts}
            activeSessionToken={activeSessionToken}
            busy={busy}
            error={error ?? loadError}
            onAddAccount={onAddAccount}
            onSignOut={() => run(onSignOut, "sign-out")}
            onSwitchAccount={(token) =>
              run(() => onSwitchAccount(token), token)
            }
          />
        )}
      </div>
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
  onSwitchAccount,
}: {
  accounts: AccountSession[];
  activeSessionToken: string;
  busy: string | undefined;
  error: string | undefined;
  onAddAccount: () => void;
  onSignOut: () => Promise<void>;
  onSwitchAccount: (token: string) => Promise<void>;
}) {
  return (
    <div className="accountMenuPopover" role="menu">
      <p className="accountMenuLabel">Accounts</p>
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
              className={`accountChoice${active ? " active" : ""}`}
              disabled={Boolean(busy) || active}
              key={account.user.id}
              onClick={() => void onSwitchAccount(account.token)}
              role="menuitemradio"
              type="button"
            >
              <span className="accountChoiceAvatar">
                {initialsFor(account.user.name)}
              </span>
              <span className="accountChoiceIdentity">
                <strong>{account.user.name}</strong>
                <small>{account.user.email}</small>
              </span>
              <span className="accountChoiceStatus">
                {busy === account.token ? "…" : active ? "✓" : ""}
              </span>
            </button>
          );
        })}
      </div>
      <div className="accountMenuActions">
        <button
          className="accountMenuItem"
          disabled={Boolean(busy)}
          onClick={onAddAccount}
          role="menuitem"
          type="button"
        >
          <span aria-hidden="true">＋</span> Add another account
        </button>
        <button
          className="accountMenuItem accountSignOut"
          disabled={Boolean(busy)}
          onClick={() => void onSignOut()}
          role="menuitem"
          type="button"
        >
          {busy === "sign-out" ? "Signing out…" : "Sign out of this account"}
        </button>
      </div>
    </div>
  );
}

function useAccountMenuDismissal(
  open: boolean,
  menu: React.RefObject<HTMLDivElement | null>,
  trigger: React.RefObject<HTMLButtonElement | null>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target)
      ) {
        close();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [close, menu, open, trigger]);
}

function initialsFor(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not update accounts.";
}
