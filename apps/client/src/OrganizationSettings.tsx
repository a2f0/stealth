import { type FormEvent, useCallback, useEffect, useState } from "react";
import { authClient } from "./authClient";

interface OrganizationRecord {
  createdAt: Date;
  id: string;
  name: string;
  slug: string;
}

export function OrganizationSettings() {
  const [organization, setOrganization] = useState<OrganizationRecord>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const loadOrganization = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await authClient.organization.list();
      if (result.error) {
        setError(result.error.message ?? "Could not load your organization.");
        return;
      }
      const current = result.data?.[0];
      if (!current) {
        setError("Your default organization could not be found.");
        return;
      }
      setOrganization(current);
      setName(current.name);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadOrganization();
  }, [loadOrganization]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    if (!organization || !nextName) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await authClient.organization.update({
        data: { name: nextName },
        organizationId: organization.id,
      });
      if (result.error) {
        setError(result.error.message ?? "Could not update your organization.");
        return;
      }
      setOrganization({ ...organization, name: nextName });
      setName(nextName);
      setNotice("Organization name updated.");
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Workspace settings</p>
          <h1>Organization</h1>
        </div>
      </header>
      <section className="content">
        {error && <div className="errorBanner">{error}</div>}
        {notice && (
          <div aria-live="polite" className="successBanner pageBanner">
            {notice}
          </div>
        )}
        {organization ? (
          <form className="settingsCard" onSubmit={(event) => void save(event)}>
            <div>
              <h2>Organization details</h2>
              <p>This is the default organization for your account.</p>
            </div>
            <label className="field">
              <span>Organization name</span>
              <input
                autoComplete="organization"
                disabled={busy}
                maxLength={100}
                name="organization"
                onChange={(event) => setName(event.target.value)}
                required
                type="text"
                value={name}
              />
            </label>
            <button
              className="primaryButton settingsSubmit"
              disabled={
                busy || !name.trim() || name.trim() === organization.name
              }
              type="submit"
            >
              {busy ? "Saving…" : "Save changes"}
            </button>
          </form>
        ) : !error ? (
          <div className="emptyState compactEmptyState">
            <div className="emptyGlyph">◇</div>
            <h3>{busy ? "Loading organization…" : "No organization found."}</h3>
          </div>
        ) : null}
      </section>
    </>
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not update your organization.";
}
