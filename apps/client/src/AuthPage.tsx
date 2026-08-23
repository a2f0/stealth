import { type FormEvent, useState } from "react";
import { authClient } from "./authClient";

type AuthMode = "forgot" | "reset" | "sign-in" | "sign-up";
export type AuthenticationAction = "sign-in" | "sign-up";
type AuthVariant = "add-account" | "default";
// This flow explicitly refreshes the session only after every required factor.
// Better Auth's automatic password-sign-in refresh would otherwise unmount the
// pending MFA challenge when the server correctly returns no session yet.
const deferredSessionRefresh = { disableSignal: true } as const;

interface AuthPageProps {
  initialError?: string | undefined;
  initialMode?: AuthMode;
  initialNotice?: string | undefined;
  onAuthenticated: (action: AuthenticationAction) => Promise<void>;
  onCancel?: (() => Promise<void> | void) | undefined;
  variant?: AuthVariant;
}

const content: Record<
  AuthMode,
  { button: string; eyebrow: string; title: string }
> = {
  forgot: {
    button: "Send reset link",
    eyebrow: "Account recovery",
    title: "Reset your password",
  },
  reset: {
    button: "Set new password",
    eyebrow: "Account recovery",
    title: "Choose a new password",
  },
  "sign-in": {
    button: "Sign in",
    eyebrow: "Welcome back",
    title: "Enter your workspace",
  },
  "sign-up": {
    button: "Create account",
    eyebrow: "Get started",
    title: "Create your workspace",
  },
};

export function AuthPage({
  initialError,
  initialMode = "sign-in",
  initialNotice,
  onAuthenticated,
  onCancel,
  variant = "default",
}: AuthPageProps) {
  const auth = useAuthPageState({
    initialError,
    initialMode,
    initialNotice,
    onAuthenticated,
    onCancel,
  });

  if (auth.twoFactorRequired) {
    return (
      <TwoFactorChallenge
        onCancel={
          onCancel
            ? auth.cancel
            : () => {
                auth.setTwoFactorRequired(false);
                auth.setPassword("");
              }
        }
        onVerified={() => onAuthenticated("sign-in")}
        variant={variant}
      />
    );
  }

  return (
    <CredentialAuthPage
      {...auth}
      copy={contentFor(auth.mode, variant)}
      onCancel={onCancel ? auth.cancel : undefined}
      onMode={auth.chooseMode}
      onSubmit={auth.submit}
      variant={variant}
    />
  );
}

function useAuthPageState({
  initialError,
  initialMode,
  initialNotice,
  onAuthenticated,
  onCancel,
}: Required<Pick<AuthPageProps, "initialMode">> &
  Pick<
    AuthPageProps,
    "initialError" | "initialNotice" | "onAuthenticated" | "onCancel"
  >) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);
  const [notice, setNotice] = useState<string | undefined>(initialNotice);
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  const resetToken = new URLSearchParams(window.location.search).get("token");

  function chooseMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError(undefined);
    setNotice(undefined);
    setPassword("");
    setConfirmation("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);

    try {
      const result = await performAuthAction({
        confirmation,
        email,
        mode,
        name,
        onAuthenticated,
        password,
        resetToken,
      });
      if (result.twoFactorRequired) {
        setTwoFactorRequired(true);
        return;
      }
      if (result.nextMode) chooseMode(result.nextMode);
      if (result.clearLocation) window.history.replaceState({}, "", "/");
      setNotice(result.notice);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!onCancel) return;
    setBusy(true);
    setError(undefined);
    try {
      await onCancel();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    cancel,
    chooseMode,
    confirmation,
    email,
    error,
    mode,
    name,
    notice,
    onConfirmation: setConfirmation,
    onEmail: setEmail,
    onName: setName,
    onPassword: setPassword,
    password,
    setPassword,
    setTwoFactorRequired,
    submit,
    twoFactorRequired,
  };
}

function CredentialAuthPage({
  busy,
  confirmation,
  copy,
  email,
  error,
  mode,
  name,
  notice,
  onCancel,
  onConfirmation,
  onEmail,
  onMode,
  onName,
  onPassword,
  onSubmit,
  password,
  variant,
}: {
  busy: boolean;
  confirmation: string;
  copy: { button: string; eyebrow: string; title: string };
  email: string;
  error: string | undefined;
  mode: AuthMode;
  name: string;
  notice: string | undefined;
  onCancel: (() => Promise<void>) | undefined;
  onConfirmation: (value: string) => void;
  onEmail: (value: string) => void;
  onMode: (mode: AuthMode) => void;
  onName: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  password: string;
  variant: AuthVariant;
}) {
  return (
    <div className="authShell">
      <AuthAside />

      <main className="authMain">
        <div className="authCard">
          <p className="eyebrow">{copy.eyebrow}</p>
          <h2>{copy.title}</h2>
          <p className="authIntro">{descriptionFor(mode, variant)}</p>

          <form
            autoComplete="on"
            className="authForm"
            method="post"
            onSubmit={(event) => void onSubmit(event)}
          >
            <AuthFields
              confirmation={confirmation}
              email={email}
              mode={mode}
              name={name}
              onConfirmation={onConfirmation}
              onEmail={onEmail}
              onName={onName}
              onPassword={onPassword}
              password={password}
            />

            {mode === "sign-in" && (
              <button
                className="forgotButton"
                onClick={() => onMode("forgot")}
                type="button"
              >
                Forgot password?
              </button>
            )}

            {error && (
              <div aria-live="polite" className="errorBanner">
                {error}
              </div>
            )}
            {notice && (
              <div aria-live="polite" className="successBanner">
                {notice}
              </div>
            )}

            <button className="authSubmit" disabled={busy} type="submit">
              {busy ? "One moment…" : copy.button}
            </button>
          </form>

          {mode === "sign-in" && (
            <p className="authSwitch">
              New here?{" "}
              <button onClick={() => onMode("sign-up")} type="button">
                Create an account
              </button>
            </p>
          )}
          {mode !== "sign-in" && (
            <p className="authSwitch">
              <button onClick={() => onMode("sign-in")} type="button">
                Back to sign in
              </button>
            </p>
          )}
          {onCancel && (
            <p className="authSwitch authCancel">
              <button
                disabled={busy}
                onClick={() => void onCancel()}
                type="button"
              >
                Cancel and return to your account
              </button>
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

interface AuthActionInput {
  confirmation: string;
  email: string;
  mode: AuthMode;
  name: string;
  onAuthenticated: (action: AuthenticationAction) => Promise<void>;
  password: string;
  resetToken: string | null;
}

interface AuthActionResult {
  clearLocation?: boolean;
  nextMode?: AuthMode;
  notice?: string;
  twoFactorRequired?: boolean;
}

async function performAuthAction(
  input: AuthActionInput,
): Promise<AuthActionResult> {
  const { mode } = input;
  if (
    (mode === "reset" || mode === "sign-up") &&
    input.password !== input.confirmation
  ) {
    throw new Error("Passwords do not match.");
  }

  if (mode === "sign-in") {
    const result = await authClient.signIn.email(
      passwordSignInInput(input.email, input.password),
    );
    throwForAuthError(result.error);
    if (requiresTwoFactor(result.data)) {
      return { twoFactorRequired: true };
    }
    await input.onAuthenticated("sign-in");
    return {};
  }

  if (mode === "sign-up") {
    const result = await authClient.signUp.email({
      callbackURL: `${window.location.origin}/?verified=true`,
      email: input.email,
      fetchOptions: deferredSessionRefresh,
      name: input.name,
      password: input.password,
    });
    throwForAuthError(result.error);
    const signInResult = await authClient.signIn.email(
      passwordSignInInput(input.email, input.password),
    );
    throwForAuthError(signInResult.error);
    await input.onAuthenticated("sign-up");
    return {
      notice:
        "Account created. Check your inbox when you’re ready to verify your email.",
    };
  }

  if (mode === "forgot") {
    const result = await authClient.requestPasswordReset({
      email: input.email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    throwForAuthError(result.error);
    return { notice: "If that account exists, a reset link is on its way." };
  }

  if (!input.resetToken) {
    throw new Error("This reset link is missing its token.");
  }

  const result = await authClient.resetPassword({
    newPassword: input.password,
    token: input.resetToken,
  });
  throwForAuthError(result.error);
  return {
    clearLocation: true,
    nextMode: "sign-in" as const,
    notice: "Password updated. Sign in with your new password.",
  };
}

function TwoFactorChallenge({
  onCancel,
  onVerified,
  variant,
}: {
  onCancel: () => Promise<void> | void;
  onVerified: () => Promise<void>;
  variant: AuthVariant;
}) {
  const [backupCode, setBackupCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [trustDevice, setTrustDevice] = useState(false);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = backupCode
        ? await authClient.twoFactor.verifyBackupCode({
            code: code.trim(),
            trustDevice,
          })
        : await authClient.twoFactor.verifyTotp({
            code: code.replace(/\D/g, ""),
            trustDevice,
          });
      throwForAuthError(result.error);
      await onVerified();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  function chooseBackupCode(nextBackupCode: boolean) {
    setBackupCode(nextBackupCode);
    setCode("");
    setError(undefined);
  }

  return (
    <div className="authShell">
      <AuthAside />
      <main className="authMain">
        <div className="authCard">
          <p className="eyebrow">Two-step verification</p>
          <h2>Confirm it’s you</h2>
          <p className="authIntro">
            {backupCode
              ? "Enter one of the recovery codes you saved when you enabled MFA."
              : "Enter the six-digit code from your authenticator app."}
          </p>
          <form
            autoComplete="on"
            className="authForm"
            method="post"
            onSubmit={(event) => void verify(event)}
          >
            <label className="field" htmlFor="two-factor-code">
              <span>
                {backupCode ? "Recovery code" : "Authentication code"}
              </span>
              <input
                autoCapitalize="none"
                autoComplete={backupCode ? "off" : "one-time-code"}
                id="two-factor-code"
                inputMode={backupCode ? "text" : "numeric"}
                maxLength={backupCode ? 32 : 8}
                onChange={(event) => setCode(event.target.value)}
                pattern={backupCode ? undefined : "[0-9 ]{6,8}"}
                required
                spellCheck={false}
                value={code}
              />
            </label>
            <label className="authCheckbox">
              <input
                checked={trustDevice}
                onChange={(event) => setTrustDevice(event.target.checked)}
                type="checkbox"
              />
              <span>Trust this device for 30 days</span>
            </label>
            {error && (
              <div aria-live="polite" className="errorBanner">
                {error}
              </div>
            )}
            <button className="authSubmit" disabled={busy} type="submit">
              {busy
                ? "Verifying…"
                : variant === "add-account"
                  ? "Verify and add account"
                  : "Verify and sign in"}
            </button>
          </form>
          <p className="authSwitch">
            <button
              disabled={busy}
              onClick={() => chooseBackupCode(!backupCode)}
              type="button"
            >
              {backupCode ? "Use an authenticator code" : "Use a recovery code"}
            </button>
          </p>
          <p className="authSwitch authCancel">
            <button
              disabled={busy}
              onClick={() => void onCancel()}
              type="button"
            >
              {variant === "add-account"
                ? "Cancel and return to your account"
                : "Back to sign in"}
            </button>
          </p>
        </div>
      </main>
    </div>
  );
}

function AuthAside() {
  return (
    <aside className="authAside">
      <a className="brand" href="/" aria-label="Stealth home">
        <span className="brandMark">S</span>
        <span>stealth</span>
      </a>
      <div className="authAsideCopy">
        <p className="eyebrow">Private by design</p>
        <h1>Keep the things that matter close.</h1>
        <p>
          A small, quiet workspace backed by Cloudflare. No noise, no
          ceremony—just your files when you need them.
        </p>
      </div>
      <div className="sidebarFoot">
        <span className="statusDot" /> Cloudflare connected
      </div>
    </aside>
  );
}

interface AuthFieldsProps {
  confirmation: string;
  email: string;
  mode: AuthMode;
  name: string;
  onConfirmation: (value: string) => void;
  onEmail: (value: string) => void;
  onName: (value: string) => void;
  onPassword: (value: string) => void;
  password: string;
}

function AuthFields(props: AuthFieldsProps) {
  const { mode } = props;
  const needsPassword =
    mode === "reset" || mode === "sign-in" || mode === "sign-up";
  const needsConfirmation = mode === "reset" || mode === "sign-up";

  return (
    <>
      {mode === "sign-up" && (
        <AuthInput
          autoComplete="name"
          label="Name"
          maxLength={100}
          name="name"
          onValue={props.onName}
          value={props.name}
        />
      )}
      {mode !== "reset" && (
        <AuthInput
          autoCapitalize="none"
          autoComplete={mode === "forgot" ? "email" : "username"}
          inputMode="email"
          label="Email"
          name="email"
          onValue={props.onEmail}
          spellCheck={false}
          type="email"
          value={props.email}
        />
      )}
      {needsPassword && (
        <AuthInput
          autoComplete={
            mode === "sign-in" ? "current-password" : "new-password"
          }
          label={mode === "sign-in" ? "Password" : "New password"}
          maxLength={128}
          minLength={12}
          name="password"
          onValue={props.onPassword}
          type="password"
          value={props.password}
        />
      )}
      {needsConfirmation && (
        <AuthInput
          autoComplete="new-password"
          help="Use at least 12 characters."
          label="Confirm password"
          maxLength={128}
          minLength={12}
          name="password-confirmation"
          onValue={props.onConfirmation}
          type="password"
          value={props.confirmation}
        />
      )}
    </>
  );
}

interface AuthInputProps {
  autoCapitalize?: "none";
  autoComplete: string;
  help?: string;
  inputMode?: "email";
  label: string;
  maxLength?: number;
  minLength?: number;
  name: string;
  onValue: (value: string) => void;
  spellCheck?: boolean;
  type?: "email" | "password";
  value: string;
}

function AuthInput({
  help,
  label,
  onValue,
  type = undefined,
  ...props
}: AuthInputProps) {
  return (
    <label className="field" htmlFor={props.name}>
      <span>{label}</span>
      <input
        {...props}
        id={props.name}
        onChange={(event) => onValue(event.target.value)}
        required
        type={type}
      />
      {help && <small>{help}</small>}
    </label>
  );
}

function contentFor(mode: AuthMode, variant: AuthVariant) {
  if (mode === "sign-in" && variant === "add-account") {
    return {
      button: "Add account",
      eyebrow: "Another account",
      title: "Sign in to another account",
    };
  }
  return content[mode];
}

function descriptionFor(mode: AuthMode, variant: AuthVariant) {
  if (mode === "forgot") {
    return "Enter your email and we’ll send you a secure, one-time link.";
  }
  if (mode === "reset") {
    return "Your new password will sign out every existing session.";
  }
  if (mode === "sign-up") {
    return "Start with an email address and a strong password.";
  }
  if (variant === "add-account") {
    return "This account will stay available on this browser so you can switch without signing in again.";
  }
  return "Sign in with the email and password attached to your account.";
}

function throwForAuthError(error: { message?: string | undefined } | null) {
  if (error) {
    throw new Error(error.message ?? "Authentication failed.");
  }
}

export function requiresTwoFactor(data: unknown) {
  return (
    typeof data === "object" &&
    data !== null &&
    "twoFactorRedirect" in data &&
    data.twoFactorRedirect === true
  );
}

export function passwordSignInInput(email: string, password: string) {
  return { email, fetchOptions: deferredSessionRefresh, password };
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Something went wrong.";
}
