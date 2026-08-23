import { QRCodeSVG } from "qrcode.react";
import { type FormEvent, useState } from "react";
import { authClient } from "./authClient";

interface TotpSetup {
  backupCodes: string[];
  totpURI: string;
}

type SecurityAction = "disable" | "enable" | "regenerate" | "verify";

export function AccountSecurity({
  onSecurityChanged,
  twoFactorEnabled,
}: {
  onSecurityChanged: () => Promise<unknown>;
  twoFactorEnabled: boolean;
}) {
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const enrollment = useMfaEnrollment({
    onSecurityChanged,
    setError,
    setNotice,
  });
  const maintenance = useMfaMaintenance({
    onRecoveryCodes: enrollment.showRecoveryCodes,
    onSecurityChanged,
    setError,
    setNotice,
  });
  return (
    <AccountSecurityPage
      enrollment={enrollment}
      error={error}
      maintenance={maintenance}
      notice={notice}
      twoFactorEnabled={twoFactorEnabled}
    />
  );
}

function useMfaEnrollment({
  onSecurityChanged,
  setError,
  setNotice,
}: SecurityWorkflowOptions) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [action, setAction] = useState<SecurityAction>();
  const [code, setCode] = useState("");
  const [enablePassword, setEnablePassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>();
  const [setup, setSetup] = useState<TotpSetup>();

  function start(nextAction: "enable" | "verify") {
    setAction(nextAction);
    setError(undefined);
    setNotice(undefined);
  }

  async function beginEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    start("enable");
    try {
      setSetup(await enableTotp(enablePassword));
      setEnablePassword("");
      setCode("");
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setAction(undefined);
    }
  }

  async function verifyEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!setup) return;
    start("verify");
    try {
      await verifyTotp(code);
      setRecoveryCodes(setup.backupCodes);
      setSetup(undefined);
      setCode("");
      setNotice(
        "MFA is enabled and your other sessions were signed out. Save these recovery codes before you continue.",
      );
      await onSecurityChanged();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setAction(undefined);
    }
  }

  function finishRecoveryCodes() {
    setRecoveryCodes(undefined);
    setAcknowledged(false);
    setNotice("MFA is enabled and your recovery codes are ready.");
  }

  function showRecoveryCodes(codes: string[]) {
    setRecoveryCodes(codes);
    setAcknowledged(false);
  }

  return {
    acknowledged,
    action,
    beginEnrollment,
    code,
    enablePassword,
    finishRecoveryCodes,
    recoveryCodes,
    setAcknowledged,
    setCode,
    setEnablePassword,
    setup,
    showRecoveryCodes,
    verifyEnrollment,
  };
}

function useMfaMaintenance({
  onRecoveryCodes,
  onSecurityChanged,
  setError,
  setNotice,
}: SecurityWorkflowOptions & { onRecoveryCodes: (codes: string[]) => void }) {
  const [action, setAction] = useState<SecurityAction>();
  const [disablePassword, setDisablePassword] = useState("");
  const [regeneratePassword, setRegeneratePassword] = useState("");

  async function run(
    nextAction: "disable" | "regenerate",
    operation: () => Promise<void>,
  ) {
    setAction(nextAction);
    setError(undefined);
    setNotice(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setAction(undefined);
    }
  }

  async function regenerateCodes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmRegeneration()) return;
    await run("regenerate", async () => {
      onRecoveryCodes(await generateRecoveryCodes(regeneratePassword));
      setRegeneratePassword("");
      setNotice("New recovery codes generated. Your old codes no longer work.");
    });
  }

  async function disable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmDisable()) return;
    await run("disable", async () => {
      await disableTotp(disablePassword);
      setDisablePassword("");
      setNotice("MFA disabled.");
      await onSecurityChanged();
    });
  }

  return {
    action,
    disable,
    disablePassword,
    regenerateCodes,
    regeneratePassword,
    setDisablePassword,
    setRegeneratePassword,
  };
}

interface SecurityWorkflowOptions {
  onSecurityChanged: () => Promise<unknown>;
  setError: (error: string | undefined) => void;
  setNotice: (notice: string | undefined) => void;
}

function AccountSecurityPage({
  enrollment,
  error,
  maintenance,
  notice,
  twoFactorEnabled,
}: {
  enrollment: ReturnType<typeof useMfaEnrollment>;
  error: string | undefined;
  maintenance: ReturnType<typeof useMfaMaintenance>;
  notice: string | undefined;
  twoFactorEnabled: boolean;
}) {
  const busy =
    enrollment.action !== undefined || maintenance.action !== undefined;
  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Account settings</p>
          <h1>Security</h1>
        </div>
      </header>
      <section className="content accountSecurityContent">
        {error && (
          <div aria-live="polite" className="errorBanner pageBanner">
            {error}
          </div>
        )}
        {notice && (
          <div aria-live="polite" className="successBanner pageBanner">
            {notice}
          </div>
        )}
        <div className="accountSecurityGrid">
          {enrollment.recoveryCodes ? (
            <RecoveryCodesCard
              acknowledged={enrollment.acknowledged}
              codes={enrollment.recoveryCodes}
              onAcknowledged={enrollment.setAcknowledged}
              onDone={enrollment.finishRecoveryCodes}
            />
          ) : enrollment.setup ? (
            <AuthenticatorSetupCard
              busy={busy}
              code={enrollment.code}
              onCode={enrollment.setCode}
              onSubmit={enrollment.verifyEnrollment}
              setup={enrollment.setup}
            />
          ) : twoFactorEnabled ? (
            <EnabledSecurityCards
              action={maintenance.action}
              disablePassword={maintenance.disablePassword}
              onDisable={maintenance.disable}
              onDisablePassword={maintenance.setDisablePassword}
              onRegenerate={maintenance.regenerateCodes}
              onRegeneratePassword={maintenance.setRegeneratePassword}
              regeneratePassword={maintenance.regeneratePassword}
            />
          ) : (
            <EnableSecurityCard
              busy={busy}
              onPassword={enrollment.setEnablePassword}
              onSubmit={enrollment.beginEnrollment}
              password={enrollment.enablePassword}
            />
          )}
        </div>
      </section>
    </>
  );
}

function EnableSecurityCard({
  busy,
  onPassword,
  onSubmit,
  password,
}: {
  busy: boolean;
  onPassword: (password: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  password: string;
}) {
  return (
    <form className="settingsCard" onSubmit={(event) => void onSubmit(event)}>
      <div>
        <h2>Authenticator app</h2>
        <p>
          Add a second step to sign-in using 1Password, Authy, Google
          Authenticator, or another TOTP app.
        </p>
      </div>
      <label className="field">
        <span>Current password</span>
        <input
          autoComplete="current-password"
          disabled={busy}
          maxLength={128}
          onChange={(event) => onPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </label>
      <button
        className="primaryButton settingsSubmit"
        disabled={busy || !password}
        type="submit"
      >
        {busy ? "Starting setup…" : "Set up authenticator app"}
      </button>
    </form>
  );
}

function AuthenticatorSetupCard({
  busy,
  code,
  onCode,
  onSubmit,
  setup,
}: {
  busy: boolean;
  code: string;
  onCode: (code: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  setup: TotpSetup;
}) {
  const secret = totpSecret(setup.totpURI);
  return (
    <form
      className="settingsCard authenticatorSetupCard"
      onSubmit={(event) => void onSubmit(event)}
    >
      <div>
        <h2>Connect your authenticator</h2>
        <p>
          Scan the QR code, then enter the six-digit code your app generates.
          MFA will not turn on until the code is verified.
        </p>
      </div>
      <div className="totpSetup">
        <div className="totpQrCode">
          <QRCodeSVG
            aria-label="Authenticator setup QR code"
            level="M"
            marginSize={2}
            size={190}
            title="Authenticator setup QR code"
            value={setup.totpURI}
          />
        </div>
        {secret && (
          <div className="totpManualCode">
            <span>Can’t scan it? Enter this key manually</span>
            <code>{formatSecret(secret)}</code>
          </div>
        )}
      </div>
      <label className="field">
        <span>Authentication code</span>
        <input
          autoComplete="one-time-code"
          disabled={busy}
          inputMode="numeric"
          maxLength={8}
          onChange={(event) => onCode(event.target.value)}
          pattern="[0-9 ]{6,8}"
          required
          value={code}
        />
      </label>
      <button
        className="primaryButton settingsSubmit"
        disabled={busy || code.replace(/\D/g, "").length !== 6}
        type="submit"
      >
        {busy ? "Verifying…" : "Verify and enable MFA"}
      </button>
    </form>
  );
}

function RecoveryCodesCard({
  acknowledged,
  codes,
  onAcknowledged,
  onDone,
}: {
  acknowledged: boolean;
  codes: string[];
  onAcknowledged: (acknowledged: boolean) => void;
  onDone: () => void;
}) {
  const [copyNotice, setCopyNotice] = useState<string>();

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodesText(codes));
      setCopyNotice("Copied.");
    } catch {
      setCopyNotice("Copy failed. Download or save the codes manually.");
    }
  }

  return (
    <section className="settingsCard recoveryCodesCard">
      <div>
        <h2>Save your recovery codes</h2>
        <p>
          Each code works once if you lose your authenticator. Keep them in a
          password manager or another secure place.
        </p>
      </div>
      <fieldset className="recoveryCodeGrid">
        <legend className="srOnly">Recovery codes</legend>
        {codes.map((code) => (
          <code key={code}>{code}</code>
        ))}
      </fieldset>
      <div className="securityButtonRow">
        <button
          className="primaryButton"
          onClick={() => void copyCodes()}
          type="button"
        >
          Copy codes
        </button>
        <button
          className="securitySecondaryButton"
          onClick={() => downloadRecoveryCodes(codes)}
          type="button"
        >
          Download
        </button>
        {copyNotice && <small aria-live="polite">{copyNotice}</small>}
      </div>
      <label className="securityAcknowledgement">
        <input
          checked={acknowledged}
          onChange={(event) => onAcknowledged(event.target.checked)}
          type="checkbox"
        />
        <span>I saved these recovery codes somewhere secure.</span>
      </label>
      <button
        className="primaryButton settingsSubmit"
        disabled={!acknowledged}
        onClick={onDone}
        type="button"
      >
        Done
      </button>
    </section>
  );
}

function EnabledSecurityCards({
  action,
  disablePassword,
  onDisable,
  onDisablePassword,
  onRegenerate,
  onRegeneratePassword,
  regeneratePassword,
}: {
  action: SecurityAction | undefined;
  disablePassword: string;
  onDisable: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onDisablePassword: (password: string) => void;
  onRegenerate: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onRegeneratePassword: (password: string) => void;
  regeneratePassword: string;
}) {
  const busy = action !== undefined;
  return (
    <>
      <section className="settingsCard securityStatusCard">
        <div>
          <h2>Authenticator app</h2>
          <p>
            MFA is on. Sign-ins require a code from your authenticator or one
            unused recovery code.
          </p>
        </div>
        <span className="securityStatus">
          <span className="statusDot" /> Enabled
        </span>
      </section>
      <form
        className="settingsCard"
        onSubmit={(event) => void onRegenerate(event)}
      >
        <div>
          <h2>Recovery codes</h2>
          <p>
            Generate a new set if your saved codes are lost or may have been
            exposed. This immediately invalidates the old set.
          </p>
        </div>
        <label className="field">
          <span>Current password</span>
          <input
            autoComplete="current-password"
            disabled={busy}
            maxLength={128}
            onChange={(event) => onRegeneratePassword(event.target.value)}
            required
            type="password"
            value={regeneratePassword}
          />
        </label>
        <button
          className="primaryButton settingsSubmit"
          disabled={busy || !regeneratePassword}
          type="submit"
        >
          {action === "regenerate" ? "Generating…" : "Generate new codes"}
        </button>
      </form>
      <form
        className="settingsCard"
        onSubmit={(event) => void onDisable(event)}
      >
        <div>
          <h2>Disable MFA</h2>
          <p>
            This removes the authenticator secret and every recovery code from
            your account.
          </p>
        </div>
        <label className="field">
          <span>Current password</span>
          <input
            autoComplete="current-password"
            disabled={busy}
            maxLength={128}
            onChange={(event) => onDisablePassword(event.target.value)}
            required
            type="password"
            value={disablePassword}
          />
        </label>
        <button
          className="dangerButton settingsSubmit"
          disabled={busy || !disablePassword}
          type="submit"
        >
          {action === "disable" ? "Disabling…" : "Disable MFA"}
        </button>
      </form>
    </>
  );
}

async function enableTotp(password: string): Promise<TotpSetup> {
  const result = await authClient.twoFactor.enable({
    method: "totp",
    password,
  });
  throwForSecurityError(result.error, "Could not start MFA setup.");
  if (result.data?.method !== "totp" || !("totpURI" in result.data)) {
    throw new Error("The authenticator setup details were not returned.");
  }
  return {
    backupCodes: result.data.backupCodes,
    totpURI: result.data.totpURI,
  };
}

async function verifyTotp(code: string) {
  const result = await authClient.twoFactor.verifyTotp({
    code: code.replace(/\D/g, ""),
  });
  throwForSecurityError(result.error, "Could not verify that code.");
  const revoked = await authClient.revokeOtherSessions();
  throwForSecurityError(
    revoked.error,
    "MFA is enabled, but other sessions could not be signed out.",
  );
}

async function generateRecoveryCodes(password: string) {
  const result = await authClient.twoFactor.generateBackupCodes({ password });
  throwForSecurityError(result.error, "Could not generate new recovery codes.");
  return result.data?.backupCodes ?? [];
}

async function disableTotp(password: string) {
  const result = await authClient.twoFactor.disable({ password });
  throwForSecurityError(result.error, "Could not disable MFA.");
}

function confirmRegeneration() {
  return window.confirm(
    "Generate new recovery codes? Every existing recovery code will stop working.",
  );
}

function confirmDisable() {
  return window.confirm(
    "Disable MFA? Your password will be the only protection on your next sign-in.",
  );
}

function totpSecret(totpURI: string) {
  try {
    return new URL(totpURI).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

function formatSecret(secret: string) {
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}

function recoveryCodesText(codes: string[]) {
  return ["Tearleads MFA recovery codes", "", ...codes].join("\n");
}

function downloadRecoveryCodes(codes: string[]) {
  const url = URL.createObjectURL(
    new Blob([recoveryCodesText(codes)], { type: "text/plain" }),
  );
  const link = document.createElement("a");
  link.download = "tearleads-mfa-recovery-codes.txt";
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

function throwForSecurityError(
  error: { message?: string | undefined } | null,
  fallback: string,
) {
  if (error) throw new Error(error.message ?? fallback);
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not update account security.";
}
