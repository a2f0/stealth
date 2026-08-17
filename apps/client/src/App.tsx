import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteObject,
  listObjects,
  objectDownloadUrl,
  type StoredObject,
  uploadObject,
} from "./api";

export function App() {
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
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Stealth home">
          <span className="brandMark">S</span>
          <span>stealth</span>
        </a>
        <nav aria-label="Workspace">
          <a className="navItem active" href="#library">
            <span className="navIcon">⌁</span> Library
          </a>
          <a className="navItem" href="#recent">
            <span className="navIcon">◷</span> Recent
          </a>
        </nav>
        <div className="sidebarFoot">
          <span className="statusDot" /> Cloudflare connected
        </div>
      </aside>

      <main>
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
      </main>
    </div>
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
