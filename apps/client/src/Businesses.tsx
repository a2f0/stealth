import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type Business,
  type BusinessListing,
  createBusiness,
  deleteBusiness,
  getBusinesses,
  updateBusiness,
} from "./businessesApi";
import { formatEin } from "./businessState";

export function Businesses() {
  const [data, setData] = useState<BusinessListing>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setData(await getBusinesses());
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Businesses</h1>
        </div>
      </header>
      <section className="content businessesContent">
        {error && <div className="errorBanner pageBanner">{error}</div>}
        {notice && <div className="successBanner pageBanner">{notice}</div>}
        {loading && !data ? (
          <BusinessEmptyState title="Loading businesses…" />
        ) : data ? (
          <div className="businessesLayout">
            {data.canManage && (
              <BusinessCreateForm
                onCreated={(business) => {
                  setData((current) =>
                    current
                      ? {
                          ...current,
                          businesses: [business, ...current.businesses],
                        }
                      : current,
                  );
                  setError(undefined);
                  setNotice("Business added.");
                }}
                onError={(message) => {
                  setNotice(undefined);
                  setError(message);
                }}
              />
            )}
            <BusinessList
              businesses={data.businesses}
              canManage={data.canManage}
              onDeleted={(id) => {
                setData((current) =>
                  current
                    ? {
                        ...current,
                        businesses: current.businesses.filter(
                          (business) => business.id !== id,
                        ),
                      }
                    : current,
                );
                setError(undefined);
                setNotice("Business deleted.");
              }}
              onError={(message) => {
                setNotice(undefined);
                setError(message);
              }}
              onUpdated={(updatedBusiness) => {
                setData((current) =>
                  current
                    ? {
                        ...current,
                        businesses: current.businesses.map((business) =>
                          business.id === updatedBusiness.id
                            ? updatedBusiness
                            : business,
                        ),
                      }
                    : current,
                );
                setError(undefined);
                setNotice("Business updated.");
              }}
            />
          </div>
        ) : (
          <BusinessEmptyState title="Businesses could not be loaded." />
        )}
      </section>
    </>
  );
}

function BusinessCreateForm({
  onCreated,
  onError,
}: {
  onCreated: (business: Business) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [ein, setEin] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await createBusiness({
        ein: ein.trim() || null,
        name: name.trim(),
      });
      setName("");
      setEin("");
      onCreated(result.business);
    } catch (cause) {
      onError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="settingsCard businessCreateCard"
      onSubmit={(event) => void submit(event)}
    >
      <div>
        <h2>Add a business</h2>
        <p>Keep the businesses belonging to this organization in one place.</p>
      </div>
      <div className="businessFields">
        <label className="field">
          <span>Business name</span>
          <input
            autoComplete="organization"
            disabled={busy}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            placeholder="Acme, Inc."
            required
            type="text"
            value={name}
          />
        </label>
        <label className="field">
          <span>EIN (optional)</span>
          <input
            disabled={busy}
            inputMode="numeric"
            maxLength={10}
            onChange={(event) => setEin(event.target.value)}
            pattern="[0-9]{2}-?[0-9]{7}"
            placeholder="12-3456789"
            type="text"
            value={ein}
          />
        </label>
      </div>
      <button
        className="primaryButton settingsSubmit"
        disabled={busy || !name.trim()}
        type="submit"
      >
        {busy ? "Adding…" : "Add business"}
      </button>
    </form>
  );
}

function BusinessList({
  businesses,
  canManage,
  onDeleted,
  onError,
  onUpdated,
}: {
  businesses: Business[];
  canManage: boolean;
  onDeleted: (id: string) => void;
  onError: (message: string) => void;
  onUpdated: (business: Business) => void;
}) {
  if (businesses.length === 0) {
    return <BusinessEmptyState title="No businesses yet." />;
  }
  return (
    <section className="businessListCard">
      <div className="businessListHeading">
        <div>
          <h2>Organization businesses</h2>
          <p>{businesses.length} total</p>
        </div>
      </div>
      <div className="businessList">
        {businesses.map((business) => (
          <BusinessRow
            business={business}
            canManage={canManage}
            key={business.id}
            onDeleted={onDeleted}
            onError={onError}
            onUpdated={onUpdated}
          />
        ))}
      </div>
    </section>
  );
}

function BusinessRow({
  business,
  canManage,
  onDeleted,
  onError,
  onUpdated,
}: {
  business: Business;
  canManage: boolean;
  onDeleted: (id: string) => void;
  onError: (message: string) => void;
  onUpdated: (business: Business) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!window.confirm(`Delete ${business.name}?`)) return;
    setBusy(true);
    try {
      await deleteBusiness(business.id);
      onDeleted(business.id);
    } catch (cause) {
      onError(messageFrom(cause));
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <BusinessEditRow
        business={business}
        onCancel={() => setEditing(false)}
        onError={onError}
        onUpdated={(updatedBusiness) => {
          onUpdated(updatedBusiness);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="businessRow">
      <div>
        <strong>{business.name}</strong>
        <span>
          {business.ein ? `EIN ${formatEin(business.ein)}` : "EIN not provided"}
        </span>
      </div>
      {canManage && (
        <div className="businessRowActions">
          <button
            className="businessEditButton tableActionButton"
            disabled={busy}
            onClick={() => setEditing(true)}
            type="button"
          >
            Edit
          </button>
          <button
            className="dangerButton tableActionButton"
            disabled={busy}
            onClick={() => void remove()}
            type="button"
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      )}
    </div>
  );
}

function BusinessEditRow({
  business,
  onCancel,
  onError,
  onUpdated,
}: {
  business: Business;
  onCancel: () => void;
  onError: (message: string) => void;
  onUpdated: (business: Business) => void;
}) {
  const [name, setName] = useState(business.name);
  const [ein, setEin] = useState(business.ein ?? "");
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await updateBusiness(business.id, {
        ein: ein.trim() || null,
        name: name.trim(),
      });
      onUpdated(result.business);
    } catch (cause) {
      onError(messageFrom(cause));
      setBusy(false);
    }
  }

  return (
    <form
      className="businessRow businessEditForm"
      onSubmit={(event) => void save(event)}
    >
      <div className="businessEditFields">
        <label className="field">
          <span>Business name</span>
          <input
            autoComplete="organization"
            disabled={busy}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            required
            type="text"
            value={name}
          />
        </label>
        <label className="field">
          <span>EIN (optional)</span>
          <input
            disabled={busy}
            inputMode="numeric"
            maxLength={10}
            onChange={(event) => setEin(event.target.value)}
            pattern="[0-9]{2}-?[0-9]{7}"
            placeholder="12-3456789"
            type="text"
            value={ein}
          />
        </label>
      </div>
      <div className="businessRowActions">
        <button
          className="businessCancelButton tableActionButton"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          className="primaryButton tableActionButton"
          disabled={busy || !name.trim()}
          type="submit"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function BusinessEmptyState({ title }: { title: string }) {
  return (
    <div className="emptyState compactEmptyState businessEmptyState">
      <div className="emptyGlyph">▦</div>
      <h3>{title}</h3>
      <p>Business names and EINs will appear here.</p>
    </div>
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Something went wrong.";
}
