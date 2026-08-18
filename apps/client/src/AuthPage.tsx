import { type FormEvent, useState } from "react";
import { authClient } from "./authClient";

type AuthMode = "forgot" | "reset" | "sign-in" | "sign-up";

interface AuthPageProps {
  initialError?: string | undefined;
  initialMode?: AuthMode;
  initialNotice?: string | undefined;
  onAuthenticated: () => Promise<void>;
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
}: AuthPageProps) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);
  const [notice, setNotice] = useState<string | undefined>(initialNotice);
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
      if (result.nextMode) chooseMode(result.nextMode);
      if (result.clearLocation) window.history.replaceState({}, "", "/");
      setNotice(result.notice);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  const copy = content[mode];

  return (
    <div className="authShell">
      <AuthAside />

      <main className="authMain">
        <div className="authCard">
          <p className="eyebrow">{copy.eyebrow}</p>
          <h2>{copy.title}</h2>
          <p className="authIntro">{descriptionFor(mode)}</p>

          <form className="authForm" onSubmit={(event) => void submit(event)}>
            <AuthFields
              confirmation={confirmation}
              email={email}
              mode={mode}
              name={name}
              onConfirmation={setConfirmation}
              onEmail={setEmail}
              onName={setName}
              onPassword={setPassword}
              password={password}
            />

            {mode === "sign-in" && (
              <button
                className="forgotButton"
                onClick={() => chooseMode("forgot")}
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
              <button onClick={() => chooseMode("sign-up")} type="button">
                Create an account
              </button>
            </p>
          )}
          {mode !== "sign-in" && (
            <p className="authSwitch">
              <button onClick={() => chooseMode("sign-in")} type="button">
                Back to sign in
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
  onAuthenticated: () => Promise<void>;
  password: string;
  resetToken: string | null;
}

interface AuthActionResult {
  clearLocation?: boolean;
  nextMode?: AuthMode;
  notice?: string;
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
    const result = await authClient.signIn.email({
      email: input.email,
      password: input.password,
    });
    throwForAuthError(result.error);
    await input.onAuthenticated();
    return {};
  }

  if (mode === "sign-up") {
    const result = await authClient.signUp.email({
      callbackURL: `${window.location.origin}/?verified=true`,
      email: input.email,
      name: input.name,
      password: input.password,
    });
    throwForAuthError(result.error);
    return {
      nextMode: "sign-in" as const,
      notice:
        "Account created. Check your inbox to verify your email, then sign in.",
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
          autoComplete="email"
          label="Email"
          name="email"
          onValue={props.onEmail}
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
  autoComplete: string;
  help?: string;
  label: string;
  maxLength?: number;
  minLength?: number;
  name: string;
  onValue: (value: string) => void;
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
    <label className="field">
      <span>{label}</span>
      <input
        {...props}
        onChange={(event) => onValue(event.target.value)}
        required
        type={type}
      />
      {help && <small>{help}</small>}
    </label>
  );
}

function descriptionFor(mode: AuthMode) {
  if (mode === "forgot") {
    return "Enter your email and we’ll send you a secure, one-time link.";
  }
  if (mode === "reset") {
    return "Your new password will sign out every existing session.";
  }
  if (mode === "sign-up") {
    return "Start with an email address and a strong password.";
  }
  return "Sign in with the email and password attached to your account.";
}

function throwForAuthError(error: { message?: string | undefined } | null) {
  if (error) {
    throw new Error(error.message ?? "Authentication failed.");
  }
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Something went wrong.";
}
