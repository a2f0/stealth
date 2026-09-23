import {
  Banner,
  Button,
  buttonClass,
  Card,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
} from "@tearleads/ui/react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  createLibraryFolder,
  deleteLibraryFolder,
  deleteObject,
  getLibraryFolder,
  type LibraryFolder,
  type LinkedEmail,
  listLibraryFolders,
  listObjects,
  moveObject,
  objectDownloadUrl,
  renameLibraryFolder,
  type StoredObject,
  unlinkInboundEmail,
  uploadObject,
} from "./api";
import { countLabel, formatBytes } from "./labels";
import { useMenuDismissal } from "./useMenuDismissal";
import type { WorkspaceUser } from "./WorkspaceShell";
import {
  handleNavigation,
  inboxEmailPath,
  libraryFolderIdForPath,
  libraryPath,
} from "./workspacePaths";

const maxFolderNameLength = 80;

interface LibraryProps {
  initialNotice?: string | undefined;
  onNavigate: (pathname: string) => void;
  onResendVerification: () => Promise<void>;
  pathname: string;
  user: WorkspaceUser;
}

interface FolderDetail {
  emails: LinkedEmail[];
  folder: LibraryFolder;
}

type FolderForm = "create" | "rename";

export function Library({
  initialNotice,
  onNavigate,
  onResendVerification,
  pathname,
  user,
}: LibraryProps) {
  const folderId = libraryFolderIdForPath(pathname);
  const data = useLibraryData(folderId);
  const actions = useLibraryActions(folderId, data.refresh, onNavigate);
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseFile = () => fileInput.current?.click();
  const error = actions.error ?? data.error;
  const unavailable = Boolean(folderId && data.error && !data.detail);

  return (
    <Page>
      <LibraryHeader
        busy={actions.busy}
        detail={data.detail}
        folderId={folderId}
        onDeleteFolder={actions.deleteFolder}
        onNavigate={onNavigate}
        onNewFolder={() => actions.setFolderForm("create")}
        onRenameFolder={() => actions.setFolderForm("rename")}
        onUpload={chooseFile}
        unavailable={unavailable}
      />
      <input
        ref={fileInput}
        hidden
        name="file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void actions.upload(file);
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
        {actions.folderForm && (
          <FolderNameForm
            busy={actions.busy}
            initialName={
              actions.folderForm === "rename" ? data.detail?.folder.name : ""
            }
            key={actions.folderForm}
            mode={actions.folderForm}
            onCancel={() => actions.setFolderForm(undefined)}
            onSave={actions.saveFolder}
          />
        )}
        {unavailable ? (
          <EmptyState
            actions={
              <Button
                icon="arrowLeft"
                onClick={() => onNavigate(libraryPath())}
              >
                Back to the library
              </Button>
            }
            icon="folder"
            title="This folder isn’t available"
          >
            It may have been deleted.
          </EmptyState>
        ) : (
          <LibraryContent
            actions={actions}
            data={data}
            folderId={folderId}
            onNavigate={onNavigate}
            onUpload={chooseFile}
          />
        )}
      </PageBody>
    </Page>
  );
}

/**
 * The folders, the files at the root or in the open folder, and that
 * folder's linked emails. Stale responses from a previous folder are dropped.
 */
function useLibraryData(folderId: string | undefined) {
  const [folders, setFolders] = useState<LibraryFolder[]>();
  const [objects, setObjects] = useState<StoredObject[]>();
  const [detail, setDetail] = useState<FolderDetail>();
  const [error, setError] = useState<string>();
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestSequence.current;
    try {
      const [nextFolders, nextObjects, nextDetail] = await Promise.all([
        listLibraryFolders(),
        listObjects(folderId),
        folderId ? getLibraryFolder(folderId) : undefined,
      ]);
      if (requestId !== requestSequence.current) return;
      setError(undefined);
      setFolders(nextFolders);
      setObjects(nextObjects);
      setDetail(nextDetail);
    } catch (cause) {
      if (requestId === requestSequence.current) setError(messageFrom(cause));
    }
  }, [folderId]);

  useEffect(() => {
    setObjects(undefined);
    setDetail(undefined);
    setError(undefined);
    void refresh();
  }, [refresh]);

  return { detail, error, folders, objects, refresh };
}

function useLibraryActions(
  folderId: string | undefined,
  refresh: () => Promise<void>,
  onNavigate: (pathname: string) => void,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [folderForm, setFolderForm] = useState<FolderForm>();

  // Opening another folder closes a create or rename form left open.
  const openedFolder = useRef(folderId);
  if (openedFolder.current !== folderId) {
    openedFolder.current = folderId;
    setFolderForm(undefined);
    setError(undefined);
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await refresh();
      return true;
    } catch (cause) {
      setError(messageFrom(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    deleteFolder: async (detail: FolderDetail) => {
      const { emailCount, fileCount, name } = detail.folder;
      const consequences = [
        fileCount
          ? `${countLabel(fileCount, "file")} will move back to the library`
          : "",
        emailCount
          ? `${countLabel(emailCount, "linked email")} will be unlinked but stay in the inbox`
          : "",
      ].filter(Boolean);
      const message = consequences.length
        ? `Delete “${name}”? ${consequences.join(", and ")}.`
        : `Delete “${name}”?`;
      if (!window.confirm(message)) return;
      setBusy(true);
      setError(undefined);
      try {
        await deleteLibraryFolder(detail.folder.id);
        onNavigate(libraryPath());
      } catch (cause) {
        setError(messageFrom(cause));
      } finally {
        setBusy(false);
      }
    },
    error,
    folderForm,
    move: (object: StoredObject, destination: string | null) =>
      run(() => moveObject(object.id, destination)),
    remove: (object: StoredObject) => run(() => deleteObject(object.id)),
    saveFolder: async (name: string) => {
      const saved = await run(() =>
        folderForm === "rename" && folderId
          ? renameLibraryFolder(folderId, name)
          : createLibraryFolder(name),
      );
      if (saved) setFolderForm(undefined);
    },
    setFolderForm,
    unlink: (email: LinkedEmail) =>
      run(() => unlinkInboundEmail(email.id, email.linkId)),
    upload: (file: File) => run(() => uploadObject(file, folderId)),
  };
}

type LibraryData = ReturnType<typeof useLibraryData>;
type LibraryActions = ReturnType<typeof useLibraryActions>;

function LibraryHeader({
  busy,
  detail,
  folderId,
  onDeleteFolder,
  onNavigate,
  onNewFolder,
  onRenameFolder,
  onUpload,
  unavailable,
}: {
  busy: boolean;
  detail: FolderDetail | undefined;
  folderId: string | undefined;
  onDeleteFolder: (detail: FolderDetail) => Promise<void>;
  onNavigate: (pathname: string) => void;
  onNewFolder: () => void;
  onRenameFolder: () => void;
  onUpload: () => void;
  unavailable: boolean;
}) {
  const upload = (
    <Button
      busy={busy}
      disabled={unavailable || Boolean(folderId && !detail)}
      icon="upload"
      onClick={onUpload}
      variant="primary"
    >
      Upload file
    </Button>
  );
  if (!folderId) {
    return (
      <PageHeader
        actions={
          <>
            <Button disabled={busy} icon="folderAdd" onClick={onNewFolder}>
              New folder
            </Button>
            {upload}
          </>
        }
        description="Documents, photos, and anything else your organization wants to keep close."
        eyebrow="Workspace"
        title="Library"
      />
    );
  }
  return (
    <PageHeader
      actions={
        detail && (
          <>
            <Button disabled={busy} icon="edit" onClick={onRenameFolder}>
              Rename
            </Button>
            <Button
              disabled={busy}
              icon="trash"
              onClick={() => void onDeleteFolder(detail)}
              variant="danger"
            >
              Delete
            </Button>
            {upload}
          </>
        )
      }
      back={
        <Button
          icon="arrowLeft"
          onClick={() => onNavigate(libraryPath())}
          size="sm"
          variant="ghost"
        >
          Library
        </Button>
      }
      eyebrow="Folder"
      title={detail?.folder.name ?? (unavailable ? "Folder" : "Loading…")}
    />
  );
}

function LibraryContent({
  actions,
  data,
  folderId,
  onNavigate,
  onUpload,
}: {
  actions: LibraryActions;
  data: LibraryData;
  folderId: string | undefined;
  onNavigate: (pathname: string) => void;
  onUpload: () => void;
}) {
  if (!data.objects || !data.folders || (folderId && !data.detail)) {
    return <LoadingState label="Loading library…" />;
  }
  const destinations = [
    ...(folderId ? [{ id: null, name: "Library (no folder)" }] : []),
    ...data.folders.filter(({ id }) => id !== folderId),
  ];
  const files = (
    <FileGrid
      busy={actions.busy}
      destinations={destinations}
      objects={data.objects}
      onMove={(object, destination) => void actions.move(object, destination)}
      onRemove={(object) => void actions.remove(object)}
    />
  );
  const fileCount = (
    <span className="sectionCount">
      {countLabel(data.objects.length, "file")}
    </span>
  );

  if (data.detail) {
    return (
      <>
        <PageSection actions={fileCount} title="Files">
          {data.objects.length ? (
            files
          ) : (
            <EmptyState
              actions={
                <Button icon="upload" onClick={onUpload} variant="primary">
                  Choose a file
                </Button>
              }
              icon="folder"
              title="This folder is empty"
            >
              Upload a file here, or move one in from the library.
            </EmptyState>
          )}
        </PageSection>
        <LinkedEmails
          busy={actions.busy}
          emails={data.detail.emails}
          onNavigate={onNavigate}
          onUnlink={(email) => void actions.unlink(email)}
        />
      </>
    );
  }

  if (!data.folders.length && !data.objects.length) {
    return (
      <PageSection title="All files">
        <LibraryEmptyState onUpload={onUpload} />
      </PageSection>
    );
  }
  return (
    <>
      {data.folders.length > 0 && (
        <PageSection
          actions={
            <span className="sectionCount">
              {countLabel(data.folders.length, "folder")}
            </span>
          }
          title="Folders"
        >
          <FolderGrid folders={data.folders} onNavigate={onNavigate} />
        </PageSection>
      )}
      <PageSection actions={fileCount} title="Files">
        {data.objects.length ? (
          files
        ) : (
          <EmptyState compact icon="document" title="No loose files">
            Files you upload here stay outside any folder.
          </EmptyState>
        )}
      </PageSection>
    </>
  );
}

function FolderGrid({
  folders,
  onNavigate,
}: {
  folders: LibraryFolder[];
  onNavigate: (pathname: string) => void;
}) {
  return (
    <div className="gridAuto folderGrid">
      {folders.map((folder) => {
        const path = libraryPath(folder.id);
        return (
          <a
            className="card cardInteractive folderCard"
            href={path}
            key={folder.id}
            onClick={(event) => handleNavigation(event, path, onNavigate)}
          >
            <span className="folderCardIcon">
              <Icon name="folder" size={20} />
            </span>
            <span className="folderCardText">
              <strong className="truncate">{folder.name}</strong>
              <span>
                {countLabel(folder.fileCount, "file")}
                {folder.emailCount > 0 &&
                  ` · ${countLabel(folder.emailCount, "email")}`}
              </span>
            </span>
          </a>
        );
      })}
    </div>
  );
}

interface Destination {
  id: string | null;
  name: string;
}

function FileGrid({
  busy,
  destinations,
  objects,
  onMove,
  onRemove,
}: {
  busy: boolean;
  destinations: Destination[];
  objects: StoredObject[];
  onMove: (object: StoredObject, destination: string | null) => void;
  onRemove: (object: StoredObject) => void;
}) {
  return (
    <div className="gridAuto fileGrid">
      {objects.map((object) => (
        <FileCard
          busy={busy}
          destinations={destinations}
          key={object.id}
          object={object}
          onMove={(destination) => onMove(object, destination)}
          onRemove={() => onRemove(object)}
        />
      ))}
    </div>
  );
}

function FileCard({
  busy,
  destinations,
  object,
  onMove,
  onRemove,
}: {
  busy: boolean;
  destinations: Destination[];
  object: StoredObject;
  onMove: (destination: string | null) => void;
  onRemove: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const card = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setMoving(false), []);
  useMenuDismissal(moving, card, trigger, close);
  return (
    <article className="card cardInteractive fileCard" ref={card}>
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
      <div className="fileActions" data-open={moving || undefined}>
        {destinations.length > 0 && (
          <button
            aria-expanded={moving}
            aria-haspopup="menu"
            aria-label={`Move ${object.filename}`}
            className={buttonClass({ iconOnly: true, size: "sm" })}
            disabled={busy}
            onClick={() => setMoving((open) => !open)}
            ref={trigger}
            type="button"
          >
            <Icon name="move" size={16} />
          </button>
        )}
        <Button
          aria-label={`Delete ${object.filename}`}
          disabled={busy}
          icon="trash"
          iconOnly
          onClick={onRemove}
          size="sm"
        />
      </div>
      {moving && (
        <div className="popover fileMoveMenu" role="menu">
          <p className="menuLabel">Move to</p>
          {destinations.map((destination) => (
            <button
              className="menuItem"
              key={destination.id ?? "root"}
              onClick={() => {
                setMoving(false);
                onMove(destination.id);
              }}
              role="menuitem"
              type="button"
            >
              <Icon name={destination.id ? "folder" : "library"} />
              <span className="truncate">{destination.name}</span>
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

function LinkedEmails({
  busy,
  emails,
  onNavigate,
  onUnlink,
}: {
  busy: boolean;
  emails: LinkedEmail[];
  onNavigate: (pathname: string) => void;
  onUnlink: (email: LinkedEmail) => void;
}) {
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(emails.length, "email")}
        </span>
      }
      description="Inbox messages linked to this folder."
      title="Linked emails"
    >
      {emails.length === 0 ? (
        <EmptyState compact icon="mail" title="No linked emails">
          Open a message in the Inbox and link it to this folder.
        </EmptyState>
      ) : (
        <Card flush>
          <ul className="rowList">
            {emails.map((email) => {
              const path = inboxEmailPath(email.id);
              const subject = email.subject || "(no subject)";
              return (
                <li className="row folderEmail" key={email.linkId}>
                  <Icon className="folderEmailIcon" name="mail" />
                  <a
                    className="rowMain folderEmailLink"
                    href={path}
                    onClick={(event) =>
                      handleNavigation(event, path, onNavigate)
                    }
                  >
                    <span className="rowTitle truncate">{subject}</span>
                    <span className="rowMeta truncate">
                      {email.from} · {formatDate(email.receivedAt)}
                      {email.attachmentCount > 0 &&
                        ` · ${countLabel(email.attachmentCount, "attachment")}`}
                    </span>
                  </a>
                  <div className="rowActions">
                    <Button
                      aria-label={`Unlink ${subject}`}
                      disabled={busy}
                      icon="unlink"
                      onClick={() => onUnlink(email)}
                      size="sm"
                      variant="ghost"
                    >
                      Unlink
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </PageSection>
  );
}

function FolderNameForm({
  busy,
  initialName = "",
  mode,
  onCancel,
  onSave,
}: {
  busy: boolean;
  initialName?: string | undefined;
  mode: FolderForm;
  onCancel: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const input = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  useEffect(() => input.current?.select(), []);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSave(trimmed);
  }
  return (
    <Card
      footer={
        <div className="cluster">
          <Button onClick={onCancel} variant="ghost">
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!trimmed || trimmed === initialName}
            icon={mode === "create" ? "folderAdd" : undefined}
            type="submit"
            variant="primary"
          >
            {mode === "create" ? "Create folder" : "Save"}
          </Button>
        </div>
      }
      onSubmit={submit}
      title={mode === "create" ? "New folder" : "Rename folder"}
    >
      <Field label="Folder name">
        <input
          className="input"
          maxLength={maxFolderNameLength}
          onChange={(event) => setName(event.target.value)}
          placeholder="Tax returns"
          ref={input}
          required
          value={name}
        />
      </Field>
    </Card>
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
      Upload your first file, or create a folder to keep related documents
      together.
    </EmptyState>
  );
}

function extensionFor(filename: string) {
  const extension = filename.split(".").pop();
  return extension && extension !== filename ? extension.slice(0, 4) : "file";
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
