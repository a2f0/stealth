import {
  Button,
  ButtonLink,
  cx,
  EmptyState,
  LoadingState,
  Logo,
  promptDialog,
} from "@tearleads/ui/react";
import { useEffect, useState } from "react";
import { fetchApi } from "./apiVersion";
import { boxStyle, ContractPages } from "./ContractDocument";
import { fieldTypeLabel, initialsFor } from "./contractFields";
import { SignatureDialog } from "./SignatureDialog";
import {
  declineContract,
  getSigning,
  type SigningField,
  type SigningView,
  signContract,
  signingDocumentUrl,
  signingFinalUrl,
} from "./signingApi";

/** The page a signer opens from their emailed link; needs no account. */
export function SigningPage({ token }: { token: string }) {
  const [view, setView] = useState<SigningView>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    getSigning(token)
      .then((result) => {
        if (active) setView(result);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "This link could not be opened.",
          );
      });
    return () => {
      active = false;
    };
  }, [token]);
  return (
    <div className="signingShell">
      <header className="signingTopBar">
        <Logo />
        {view && (
          <span className="signingFrom">
            From{" "}
            {view.contract.senderName ? `${view.contract.senderName}, ` : ""}
            {view.contract.organizationName}
          </span>
        )}
      </header>
      <main className="signingMain">
        {error && (
          <EmptyState icon="error" title="This signing link isn’t valid">
            {error}
          </EmptyState>
        )}
        {!view && !error && <LoadingState label="Opening document…" />}
        {view &&
          (view.canSign ? (
            <SigningSession onFinished={setView} token={token} view={view} />
          ) : (
            <SigningOutcome token={token} view={view} />
          ))}
      </main>
    </div>
  );
}

function useSigningSession(
  token: string,
  view: SigningView,
  onFinished: (view: SigningView) => void,
) {
  const [signature, setSignature] = useState<string>();
  const [initials, setInitials] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [dialog, setDialog] = useState<"initials" | "signature" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const remaining = view.fields.filter((field) => {
    if (field.type === "signature") return !signature;
    if (field.type === "initials") return !initials;
    if (field.type === "text")
      return field.required && !values[field.id]?.trim();
    return false;
  }).length;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onFinished(await getSigning(token));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Something went wrong.",
      );
      setBusy(false);
    }
  }
  return {
    busy,
    consent,
    decline: async () => {
      const reason = await askDeclineReason();
      if (reason === null) return;
      void run(async () => {
        await declineContract(token, reason);
      });
    },
    dialog,
    error,
    finish: () =>
      run(async () => {
        await signContract(token, { consent, initials, signature, values });
      }),
    initials,
    remaining,
    setConsent,
    setDialog,
    setInitials,
    setSignature,
    setValues,
    signature,
    values,
  };
}

type Session = ReturnType<typeof useSigningSession>;

function SigningSession({
  onFinished,
  token,
  view,
}: {
  onFinished: (view: SigningView) => void;
  token: string;
  view: SigningView;
}) {
  const session = useSigningSession(token, view, onFinished);
  const { contract, recipient } = view;
  return (
    <>
      <section className="signingIntro">
        <p className="eyebrow">Please review and sign</p>
        <h1 className="pageTitle">{contract.title}</h1>
        {contract.message && (
          <p className="signingMessage">{contract.message}</p>
        )}
        <p className="contractHint">
          Signing as {recipient.name} ({recipient.email})
          {contract.dueDate ? ` · due ${formatDate(contract.dueDate)}` : ""}.
          Complete the highlighted fields, then finish.
        </p>
        <div>
          <ButtonLink
            href={signingDocumentUrl(token)}
            icon="download"
            size="sm"
          >
            Download the PDF to read
          </ButtonLink>
        </div>
      </section>
      <ContractPages
        load={() => fetchSigningDocument(token)}
        renderOverlay={(page) =>
          view.fields
            .filter((field) => field.page === page.number)
            .map((field) => (
              <SigningFieldBox
                field={field}
                key={field.id}
                name={recipient.name}
                session={session}
              />
            ))
        }
      />
      <SigningFooter session={session} />
      {session.dialog && (
        <SignatureDialog
          defaultText={
            session.dialog === "signature"
              ? recipient.name
              : initialsFor(recipient.name)
          }
          mode={session.dialog}
          onAdopt={(dataUrl) => {
            if (session.dialog === "signature") session.setSignature(dataUrl);
            else session.setInitials(dataUrl);
            session.setDialog(null);
          }}
          onClose={() => session.setDialog(null)}
        />
      )}
    </>
  );
}

function SigningFieldBox({
  field,
  name,
  session,
}: {
  field: SigningField;
  name: string;
  session: Session;
}) {
  if (field.type === "signature" || field.type === "initials")
    return <SigningImageField field={field} session={session} />;
  if (field.type === "text")
    return <SigningTextField field={field} session={session} />;
  return (
    <span className="contractField signingFieldFixed" style={boxStyle(field)}>
      <span className="signingFieldText">
        {field.type === "name"
          ? name
          : formatDate(new Date().toISOString().slice(0, 10))}
      </span>
    </span>
  );
}

/** A signature or initials box; opens the dialog to adopt one. */
function SigningImageField({
  field,
  session,
}: {
  field: SigningField;
  session: Session;
}) {
  const mode = field.type === "signature" ? "signature" : "initials";
  const image = mode === "signature" ? session.signature : session.initials;
  return (
    <button
      aria-label={image ? `Change your ${mode}` : `Add your ${mode}`}
      className={cx("contractField signingField", !image && "signingFieldTodo")}
      onClick={() => session.setDialog(mode)}
      style={boxStyle(field)}
      type="button"
    >
      {image ? (
        <img alt="" className="signingFieldImage" src={image} />
      ) : (
        <span className="contractFieldLabel">
          {mode === "signature" ? "Sign here" : "Initial"}
        </span>
      )}
    </button>
  );
}

function SigningTextField({
  field,
  session,
}: {
  field: SigningField;
  session: Session;
}) {
  const value = session.values[field.id] ?? "";
  const label = field.label ?? fieldTypeLabel(field.type);
  return (
    <input
      aria-label={field.label ?? "Text"}
      className={cx(
        "signingFieldInput",
        field.required && !value.trim() && "signingFieldTodo",
      )}
      maxLength={500}
      onChange={(event) =>
        session.setValues((current) => ({
          ...current,
          [field.id]: event.target.value,
        }))
      }
      placeholder={field.required ? label : `${label} (optional)`}
      style={boxStyle(field)}
      value={value}
    />
  );
}

function SigningFooter({ session }: { session: Session }) {
  const ready = session.remaining === 0 && session.consent;
  return (
    <footer className="signingFooter">
      {/* Beside Finish, so a rejected signature is seen where it was tapped. */}
      {session.error && (
        <p className="fieldError signingFooterError" role="alert">
          {session.error}
        </p>
      )}
      <label className="check signingConsent">
        <input
          checked={session.consent}
          onChange={(event) => session.setConsent(event.target.checked)}
          type="checkbox"
        />
        I agree to use electronic records and signatures, and that my electronic
        signature is as valid as one written by hand.
      </label>
      <div className="signingFooterActions">
        <span className="contractHint">
          {session.remaining > 0
            ? `${session.remaining} ${session.remaining === 1 ? "field" : "fields"} left`
            : "All fields complete"}
        </span>
        <Button
          disabled={session.busy}
          onClick={session.decline}
          variant="ghost"
        >
          Decline
        </Button>
        <Button
          busy={session.busy}
          disabled={!ready}
          icon="signature"
          onClick={() => void session.finish()}
          variant="primary"
        >
          Finish
        </Button>
      </div>
    </footer>
  );
}

function SigningOutcome({ token, view }: { token: string; view: SigningView }) {
  const { contract, recipient } = view;
  const download = contract.status === "completed" && (
    <ButtonLink href={signingFinalUrl(token)} icon="download" variant="primary">
      Download the signed copy
    </ButtonLink>
  );
  if (contract.status === "voided") {
    return (
      <EmptyState icon="void" title="This contract was voided">
        {contract.organizationName} voided “{contract.title}”. You don’t need to
        sign it.
      </EmptyState>
    );
  }
  if (recipient.status === "declined") {
    return (
      <EmptyState icon="error" title="You declined to sign">
        We let {contract.senderName ?? contract.organizationName} know.
      </EmptyState>
    );
  }
  if (recipient.status === "signed" && contract.status === "declined") {
    return (
      <EmptyState icon="error" title="Another signer declined">
        You signed “{contract.title}”, but another signer declined it, so it
        will not be completed.
      </EmptyState>
    );
  }
  if (recipient.status === "signed") {
    return (
      <EmptyState actions={download} icon="success" title="You’ve signed">
        {contract.status === "completed"
          ? "Everyone has signed. A copy with its certificate of completion was emailed to you."
          : "We’ll email you the signed copy once everyone has signed."}
      </EmptyState>
    );
  }
  return (
    <EmptyState icon="contract" title="This contract can’t be signed now">
      {contract.status === "declined"
        ? "Another signer declined it."
        : "It isn’t your turn to sign yet. We’ll email you when it is."}
    </EmptyState>
  );
}

async function fetchSigningDocument(token: string) {
  const response = await fetchApi(signingDocumentUrl(token), {
    credentials: "omit",
  });
  if (!response.ok) throw new Error("The document could not be loaded.");
  return response.arrayBuffer();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(`${value}T12:00:00`),
  );
}

function askDeclineReason() {
  return promptDialog({
    confirmLabel: "Decline to sign",
    label: "Reason (optional)",
    maxLength: 500,
    message: "The sender will be told.",
    multiline: true,
    title: "Decline to sign?",
    tone: "danger",
  });
}
