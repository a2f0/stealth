import {
  Badge,
  Banner,
  Button,
  Card,
  Field,
  Page,
  PageBody,
  PageHeader,
} from "@tearleads/ui/react";
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
    <Page narrow>
      <PageHeader
        description="Protect your account with a second step at sign-in."
        eyebrow="Account settings"
        title="Security"
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {notice && <Banner tone="success">{notice}</Banner>}
        <SecurityContent
          busy={busy}
          enrollment={enrollment}
          maintenance={maintenance}
          twoFactorEnabled={twoFactorEnabled}
        />
      </PageBody>
    </Page>
  );
}

function SecurityContent({
  busy,
  enrollment,
  maintenance,
  twoFactorEnabled,
}: {
  busy: boolean;
  enrollment: ReturnType<typeof useMfaEnrollment>;
  maintenance: ReturnType<typeof useMfaMaintenance>;
  twoFactorEnabled: boolean;
}) {
  if (enrollment.recoveryCodes) {
    return (
      <RecoveryCodesCard
        acknowledged={enrollment.acknowledged}
        codes={enrollment.recoveryCodes}
        onAcknowledged={enrollment.setAcknowledged}
        onDone={enrollment.finishRecoveryCodes}
      />
    );
  }
  if (enrollment.setup) {
    return (
      <AuthenticatorSetupCard
        busy={busy}
        code={enrollment.code}
        onCode={enrollment.setCode}
        onSubmit={enrollment.verifyEnrollment}
        setup={enrollment.setup}
      />
    );
  }
  if (twoFactorEnabled) {
    return (
      <EnabledSecurityCards
        action={maintenance.action}
        disablePassword={maintenance.disablePassword}
        onDisable={maintenance.disable}
        onDisablePassword={maintenance.setDisablePassword}
        onRegenerate={maintenance.regenerateCodes}
        onRegeneratePassword={maintenance.setRegeneratePassword}
        regeneratePassword={maintenance.regeneratePassword}
      />
    );
  }
  return (
    <EnableSecurityCard
      busy={busy}
      onPassword={enrollment.setEnablePassword}
      onSubmit={enrollment.beginEnrollment}
      password={enrollment.enablePassword}
    />
  );
}

function PasswordField({
  busy,
  onChange,
  value,
}: {
  busy: boolean;
  onChange: (password: string) => void;
  value: string;
}) {
  return (
    <Field label="Current password">
      <input
        autoComplete="current-password"
        className="input"
        disabled={busy}
        maxLength={128}
        onChange={(event) => onChange(event.target.value)}
        required
        type="password"
        value={value}
      />
    </Field>
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
    <Card
      actions={<Badge dot>Not enabled</Badge>}
      description="Add a second step to sign-in using 1Password, Authy, Google Authenticator, or another TOTP app."
      footer={
        <Button
          busy={busy}
          disabled={!password}
          icon="shield"
          type="submit"
          variant="primary"
        >
          {busy ? "Starting setup…" : "Set up authenticator app"}
        </Button>
      }
      onSubmit={(event) => void onSubmit(event)}
      title="Authenticator app"
    >
      <PasswordField busy={busy} onChange={onPassword} value={password} />
    </Card>
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
    <Card
      actions={
        <Badge dot tone="warning">
          Pending verification
        </Badge>
      }
      description="Scan the QR code, then enter the six-digit code your app generates. MFA will not turn on until the code is verified."
      footer={
        <Button
          busy={busy}
          disabled={code.replace(/\D/g, "").length !== 6}
          icon="check"
          type="submit"
          variant="primary"
        >
          {busy ? "Verifying…" : "Verify and enable MFA"}
        </Button>
      }
      onSubmit={(event) => void onSubmit(event)}
      title="Connect your authenticator"
    >
      <div className="totpSetup">
        <div className="totpQrTile">
          <QRCodeSVG
            aria-label="Authenticator setup QR code"
            level="M"
            marginSize={2}
            size={176}
            title="Authenticator setup QR code"
            value={setup.totpURI}
          />
        </div>
        <div className="totpSetupFields">
          {secret && (
            <div className="totpManualKey">
              <p className="totpManualLabel">
                Can’t scan it? Enter this key manually
              </p>
              <code className="codeChip totpSecret">
                {formatSecret(secret)}
              </code>
            </div>
          )}
          <Field label="Authentication code">
            <input
              autoComplete="one-time-code"
              className="input totpCodeInput"
              disabled={busy}
              inputMode="numeric"
              maxLength={8}
              onChange={(event) => onCode(event.target.value)}
              pattern="[0-9 ]{6,8}"
              required
              value={code}
            />
          </Field>
        </div>
      </div>
    </Card>
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
    <Card
      description="Each code works once if you lose your authenticator. Keep them in a password manager or another secure place."
      footer={
        <>
          <label className="check">
            <input
              checked={acknowledged}
              onChange={(event) => onAcknowledged(event.target.checked)}
              type="checkbox"
            />
            <span>I saved these recovery codes somewhere secure.</span>
          </label>
          <Button disabled={!acknowledged} onClick={onDone} variant="primary">
            Done
          </Button>
        </>
      }
      title="Save your recovery codes"
    >
      <fieldset className="recoveryCodeGrid">
        <legend className="srOnly">Recovery codes</legend>
        {codes.map((code) => (
          <code key={code}>{code}</code>
        ))}
      </fieldset>
      <div className="cluster">
        <Button icon="copy" onClick={() => void copyCodes()} size="sm">
          Copy codes
        </Button>
        <Button
          icon="download"
          onClick={() => downloadRecoveryCodes(codes)}
          size="sm"
        >
          Download
        </Button>
        <span aria-live="polite" className="recoveryCopyNotice">
          {copyNotice}
        </span>
      </div>
    </Card>
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
  return (
    <div className="stack stackLg">
      <Card
        actions={
          <Badge dot tone="success">
            Enabled
          </Badge>
        }
        description="MFA is on. Sign-ins require a code from your authenticator or one unused recovery code."
        title="Authenticator app"
      />
      <MaintenanceCard
        action={action}
        description="Generate a new set if your saved codes are lost or may have been exposed. This immediately invalidates the old set."
        kind="regenerate"
        onPassword={onRegeneratePassword}
        onSubmit={onRegenerate}
        password={regeneratePassword}
        title="Recovery codes"
      />
      <MaintenanceCard
        action={action}
        description="This removes the authenticator secret and every recovery code from your account."
        kind="disable"
        onPassword={onDisablePassword}
        onSubmit={onDisable}
        password={disablePassword}
        title="Disable MFA"
      />
    </div>
  );
}

const maintenanceButtons = {
  disable: { busyLabel: "Disabling…", label: "Disable MFA" },
  regenerate: { busyLabel: "Generating…", label: "Generate new codes" },
} as const;

function MaintenanceCard({
  action,
  description,
  kind,
  onPassword,
  onSubmit,
  password,
  title,
}: {
  action: SecurityAction | undefined;
  description: string;
  kind: "disable" | "regenerate";
  onPassword: (password: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  password: string;
  title: string;
}) {
  const busy = action !== undefined;
  const destructive = kind === "disable";
  const button = maintenanceButtons[kind];
  return (
    <Card
      className={destructive ? "cardDanger" : undefined}
      description={description}
      footer={
        <Button
          busy={action === kind}
          disabled={busy || !password}
          icon={destructive ? undefined : "refresh"}
          type="submit"
          variant={destructive ? "danger" : "secondary"}
        >
          {action === kind ? button.busyLabel : button.label}
        </Button>
      }
      onSubmit={(event) => void onSubmit(event)}
      title={title}
    >
      <PasswordField busy={busy} onChange={onPassword} value={password} />
    </Card>
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
