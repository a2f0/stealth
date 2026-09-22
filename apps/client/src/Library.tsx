import {
  Banner,
  Button,
  EmptyState,
  Icon,
  Page,
  PageBody,
  PageHeader,
  PageSection,
} from "@tearleads/ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteObject,
  listObjects,
  objectDownloadUrl,
  type StoredObject,
  uploadObject,
} from "./api";
import { countLabel } from "./labels";
import type { WorkspaceUser } from "./WorkspaceShell";

interface LibraryProps {
  initialNotice?: string | undefined;
  onResendVerification: () => Promise<void>;
  user: WorkspaceUser;
}

export function Library({
  initialNotice,
  onResendVerification,
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
    <Page>
      <PageHeader
        actions={
          <Button
            busy={busy}
            icon="upload"
            onClick={() => fileInput.current?.click()}
            variant="primary"
          >
            Upload file
          </Button>
        }
        description="Documents, photos, and anything else your organization wants to keep close."
        eyebrow="Workspace"
        title="Library"
      />
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
      <PageBody>
        <VerificationStatus
          email={user.email}
          emailVerified={user.emailVerified}
          initialNotice={initialNotice}
          onResend={onResendVerification}
        />
        {error && <Banner tone="danger">{error}</Banner>}
        <PageSection
          actions={
            <span className="sectionCount">
              {countLabel(objects.length, "file")}
            </span>
          }
          title="All files"
        >
          {objects.length === 0 ? (
            <LibraryEmptyState onUpload={() => fileInput.current?.click()} />
          ) : (
            <FileGrid
              busy={busy}
              objects={objects}
              onRemove={(object) => void remove(object)}
            />
          )}
        </PageSection>
      </PageBody>
    </Page>
  );
}

function FileGrid({
  busy,
  objects,
  onRemove,
}: {
  busy: boolean;
  objects: StoredObject[];
  onRemove: (object: StoredObject) => void;
}) {
  return (
    <div className="gridAuto fileGrid">
      {objects.map((object) => (
        <article className="card cardInteractive fileCard" key={object.id}>
          <a className="fileCardLink" href={objectDownloadUrl(object.id)}>
            <div className="filePreview">
              <Icon name="document" size={28} strokeWidth={1.5} />
              <span className="filePreviewExtension">
                {extensionFor(object.filename)}
              </span>
            </div>
            <div className="fileMeta">
              <strong className="truncate">{object.filename}</strong>
              <span>
                {formatBytes(object.size)} · {formatDate(object.createdAt)}
              </span>
            </div>
          </a>
          <Button
            aria-label={`Delete ${object.filename}`}
            className="fileDelete"
            disabled={busy}
            icon="trash"
            iconOnly
            onClick={() => onRemove(object)}
            size="sm"
          />
        </article>
      ))}
    </div>
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

  if (!notice && emailVerified) return null;
  return (
    <div className="stack stackMd">
      {notice && <Banner tone="success">{notice}</Banner>}
      {!emailVerified && (
        <Banner
          actions={
            <Button busy={busy} onClick={() => void resend()} size="sm">
              {busy ? "Sending…" : "Resend email"}
            </Button>
          }
          announce={false}
          icon="mail"
          title="Verify your email"
          tone="warning"
        >
          <p>
            You can use Tearleads now, but confirming {email} helps secure your
            account.
          </p>
          {error && <p className="fieldError">{error}</p>}
        </Banner>
      )}
    </div>
  );
}

function LibraryEmptyState({ onUpload }: { onUpload: () => void }) {
  return (
    <EmptyState
      actions={
        <Button icon="upload" onClick={onUpload} variant="primary">
          Choose a file
        </Button>
      }
      icon="library"
      title="A quiet place for important things"
    >
      Upload your first file to keep it with your organization.
    </EmptyState>
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
