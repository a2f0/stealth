import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteObject,
  listObjects,
  objectDownloadUrl,
  type StoredObject,
  uploadObject,
} from "./api";
import { WorkspaceShell, type WorkspaceUser } from "./WorkspaceShell";

interface LibraryProps {
  initialNotice?: string | undefined;
  onResendVerification: () => Promise<void>;
  onSignOut: () => Promise<void>;
  user: WorkspaceUser;
}

export function Library({
  initialNotice,
  onResendVerification,
  onSignOut,
  user,
}: LibraryProps) {
  const [objects, setObjects] = useState<StoredObject[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setError(undefined);
      setObjects(await listObjects());
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function upload(file: File) {
    setBusy(true);
    setError(undefined);
    try {
      await uploadObject(file);
      await refresh();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(object: StoredObject) {
    setBusy(true);
    setError(undefined);
    try {
      await deleteObject(object.id);
      setObjects((current) => current.filter(({ id }) => id !== object.id));
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <WorkspaceShell activePage="library" onSignOut={onSignOut} user={user}>
      <header className="topbar">
        <div>
          <p className="eyebrow">Personal workspace</p>
          <h1>Your library</h1>
        </div>
        <button
          className="primaryButton"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
          type="button"
        >
          {busy ? "Working…" : "+ Add file"}
        </button>
        <input
          ref={fileInput}
          hidden
          name="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.target.value = "";
          }}
          type="file"
        />
      </header>

      <section className="content" id="library">
        <VerificationStatus
          email={user.email}
          emailVerified={user.emailVerified}
          initialNotice={initialNotice}
          onResend={onResendVerification}
        />
        {error && <div className="errorBanner">{error}</div>}
        <div className="sectionHeading">
          <h2>All files</h2>
          <span>{objects.length} items</span>
        </div>
        {objects.length === 0 ? (
          <EmptyState onUpload={() => fileInput.current?.click()} />
        ) : (
          <div className="fileGrid">
            {objects.map((object) => (
              <article className="fileCard" key={object.id}>
                <a href={objectDownloadUrl(object.id)}>
                  <div className="filePreview">
                    {extensionFor(object.filename)}
                  </div>
                  <div className="fileMeta">
                    <strong>{object.filename}</strong>
                    <span>
                      {formatBytes(object.size)} ·{" "}
                      {formatDate(object.createdAt)}
                    </span>
                  </div>
                </a>
                <button
                  aria-label={`Delete ${object.filename}`}
                  className="deleteButton"
                  disabled={busy}
                  onClick={() => void remove(object)}
                  type="button"
                >
                  ×
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
    </WorkspaceShell>
  );
}

interface VerificationStatusProps {
  email: string;
  emailVerified: boolean;
  initialNotice?: string | undefined;
  onResend: () => Promise<void>;
}

function VerificationStatus({
  email,
  emailVerified,
  initialNotice,
  onResend,
}: VerificationStatusProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState(initialNotice);

  async function resend() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await onResend();
      setNotice("Verification email sent. Check your inbox.");
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {notice && (
        <div aria-live="polite" className="successBanner pageBanner">
          {notice}
        </div>
      )}
      {!emailVerified && (
        <div className="verificationBanner">
          <div>
            <strong>Verify your email</strong>
            <p>
              You can use Stealth now, but confirming {email} helps secure your
              account.
            </p>
            {error && <span className="verificationError">{error}</span>}
          </div>
          <button disabled={busy} onClick={() => void resend()} type="button">
            {busy ? "Sending…" : "Resend email"}
          </button>
        </div>
      )}
    </>
  );
}

function EmptyState({ onUpload }: { onUpload: () => void }) {
  return (
    <div className="emptyState">
      <div className="emptyGlyph">↥</div>
      <h3>A quiet place for important things.</h3>
      <p>Upload your first file. It will be stored in Cloudflare R2.</p>
      <button className="textButton" onClick={onUpload} type="button">
        Choose a file
      </button>
    </div>
  );
}

function extensionFor(filename: string) {
  const extension = filename.split(".").pop();
  return extension && extension !== filename ? extension.slice(0, 4) : "file";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Something went wrong.";
}
