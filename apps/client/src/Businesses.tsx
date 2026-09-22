import {
  Banner,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
} from "@tearleads/ui/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type Business,
  type BusinessInput,
  type BusinessListing,
  createBusiness,
  deleteBusiness,
  getBusinesses,
  updateBusiness,
} from "./businessesApi";
import {
  formatBusinessAddress,
  formatBusinessDate,
  formatEin,
} from "./businessState";
import { countLabel } from "./labels";

interface BusinessFormState {
  city: string;
  ein: string;
  incorporationDate: string;
  name: string;
  state: string;
  streetAddress: string;
  zip: string;
}

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

  const showError = (message: string) => {
    setNotice(undefined);
    setError(message);
  };

  return (
    <Page>
      <PageHeader
        description="Keep the businesses belonging to this organization in one place."
        eyebrow="Records"
        title="Businesses"
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {notice && <Banner tone="success">{notice}</Banner>}
        {loading && !data ? (
          <LoadingState label="Loading businesses…" />
        ) : data ? (
          <>
            {data.canManage ? (
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
                onError={showError}
              />
            ) : (
              <ReadOnlyNotice />
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
              onError={showError}
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
          </>
        ) : (
          <BusinessEmptyState title="Businesses could not be loaded." />
        )}
      </PageBody>
    </Page>
  );
}

function ReadOnlyNotice() {
  return (
    <Banner announce={false} icon="lock" tone="neutral">
      Only organization owners and admins can add or change businesses.
    </Banner>
  );
}

function BusinessCreateForm({
  onCreated,
  onError,
}: {
  onCreated: (business: Business) => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState<BusinessFormState>(emptyBusinessForm);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await createBusiness(businessInput(form));
      setForm(emptyBusinessForm());
      onCreated(result.business);
    } catch (cause) {
      onError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      footer={
        <>
          <span className="textSm textSubtle">
            Only the business name is required.
          </span>
          <Button
            busy={busy}
            disabled={!form.name.trim()}
            icon="add"
            type="submit"
            variant="primary"
          >
            {busy ? "Adding…" : "Add business"}
          </Button>
        </>
      }
      onSubmit={(event) => void submit(event)}
      title="Add a business"
    >
      <BusinessFields disabled={busy} form={form} onChange={setForm} />
    </Card>
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
  const count = businesses.length;
  return (
    <PageSection
      actions={
        <span className="sectionCount">
          {countLabel(count, "business", "businesses")}
        </span>
      }
      title="Organization businesses"
    >
      {count === 0 ? (
        <BusinessEmptyState title="No businesses yet." />
      ) : (
        <Card flush>
          <ul className="rowList">
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
          </ul>
        </Card>
      )}
    </PageSection>
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
    <li className="row">
      <BusinessSummary business={business} />
      {canManage && (
        <div className="rowActions businessRowActions">
          <Button
            disabled={busy}
            icon="edit"
            onClick={() => setEditing(true)}
            size="sm"
          >
            Edit
          </Button>
          <Button
            busy={busy}
            icon="trash"
            onClick={() => void remove()}
            size="sm"
            variant="danger"
          >
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </div>
      )}
    </li>
  );
}

function BusinessSummary({ business }: { business: Business }) {
  const facts = [
    business.ein ? `EIN ${formatEin(business.ein)}` : "EIN not provided",
  ];
  if (business.incorporationDate) {
    facts.push(
      `Incorporated ${formatBusinessDate(business.incorporationDate)}`,
    );
  }
  const address = formatBusinessAddress(business);
  return (
    <div className="businessSummary">
      <span aria-hidden="true" className="businessMark">
        <Icon name="businesses" size={18} />
      </span>
      <div className="rowMain">
        <span className="rowTitle">{business.name}</span>
        <span className="rowMeta tabular">{facts.join(" · ")}</span>
        {address && <span className="rowMeta">{address}</span>}
      </div>
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
  const [form, setForm] = useState<BusinessFormState>(() =>
    businessForm(business),
  );
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await updateBusiness(business.id, businessInput(form));
      onUpdated(result.business);
    } catch (cause) {
      onError(messageFrom(cause));
      setBusy(false);
    }
  }

  return (
    <li className="row businessEditRow">
      <form
        aria-label={`Edit ${business.name}`}
        className="formGrid businessEditForm"
        onSubmit={(event) => void save(event)}
      >
        <p className="textSm textStrong">Edit business</p>
        <BusinessFields
          compact
          disabled={busy}
          form={form}
          onChange={setForm}
        />
        <div className="formActions businessEditActions">
          <Button disabled={busy} onClick={onCancel} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!form.name.trim()}
            icon="check"
            size="sm"
            type="submit"
            variant="primary"
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </li>
  );
}

function BusinessFields({
  compact = false,
  disabled,
  form,
  onChange,
}: {
  compact?: boolean;
  disabled: boolean;
  form: BusinessFormState;
  onChange: (form: BusinessFormState) => void;
}) {
  const set = (field: keyof BusinessFormState, value: string) => {
    onChange({ ...form, [field]: value });
  };
  const input = cx("input", compact && "inputSm");
  return (
    <div className="businessFields">
      <Field className="businessFieldWide" label="Business name">
        <input
          autoComplete="organization"
          className={input}
          disabled={disabled}
          maxLength={120}
          onChange={(event) => set("name", event.target.value)}
          placeholder="Acme, Inc."
          required
          type="text"
          value={form.name}
        />
      </Field>
      <Field className="businessFieldHalf" label="EIN" optional>
        <input
          className={input}
          disabled={disabled}
          inputMode="numeric"
          maxLength={10}
          onChange={(event) => set("ein", event.target.value)}
          pattern="[0-9]{2}-?[0-9]{7}"
          placeholder="12-3456789"
          type="text"
          value={form.ein}
        />
      </Field>
      <Field className="businessFieldHalf" label="Incorporation date" optional>
        <input
          className={input}
          disabled={disabled}
          onChange={(event) => set("incorporationDate", event.target.value)}
          type="date"
          value={form.incorporationDate}
        />
      </Field>
      <BusinessAddressFields
        disabled={disabled}
        form={form}
        input={input}
        set={set}
      />
    </div>
  );
}

function BusinessAddressFields({
  disabled,
  form,
  input,
  set,
}: {
  disabled: boolean;
  form: BusinessFormState;
  input: string;
  set: (field: keyof BusinessFormState, value: string) => void;
}) {
  return (
    <>
      <Field className="businessFieldWide" label="Street address" optional>
        <input
          autoComplete="street-address"
          className={input}
          disabled={disabled}
          maxLength={240}
          onChange={(event) => set("streetAddress", event.target.value)}
          placeholder="123 Main Street"
          type="text"
          value={form.streetAddress}
        />
      </Field>
      <Field className="businessFieldHalf" label="City" optional>
        <input
          autoComplete="address-level2"
          className={input}
          disabled={disabled}
          maxLength={100}
          onChange={(event) => set("city", event.target.value)}
          placeholder="New York"
          type="text"
          value={form.city}
        />
      </Field>
      <Field className="businessFieldQuarter" label="State" optional>
        <input
          autoCapitalize="characters"
          autoComplete="address-level1"
          className={input}
          disabled={disabled}
          maxLength={2}
          onChange={(event) => set("state", event.target.value)}
          pattern="[A-Za-z]{2}"
          placeholder="NY"
          type="text"
          value={form.state}
        />
      </Field>
      <Field className="businessFieldQuarter" label="ZIP" optional>
        <input
          autoComplete="postal-code"
          className={input}
          disabled={disabled}
          inputMode="numeric"
          maxLength={10}
          onChange={(event) => set("zip", event.target.value)}
          pattern="[0-9]{5}(-[0-9]{4})?"
          placeholder="10001"
          type="text"
          value={form.zip}
        />
      </Field>
    </>
  );
}

function businessForm(business: Business): BusinessFormState {
  return {
    city: business.city ?? "",
    ein: business.ein ? formatEin(business.ein) : "",
    incorporationDate: business.incorporationDate ?? "",
    name: business.name,
    state: business.state ?? "",
    streetAddress: business.streetAddress ?? "",
    zip: business.zip ?? "",
  };
}

function emptyBusinessForm(): BusinessFormState {
  return {
    city: "",
    ein: "",
    incorporationDate: "",
    name: "",
    state: "",
    streetAddress: "",
    zip: "",
  };
}

function businessInput(form: BusinessFormState): BusinessInput {
  return {
    city: form.city.trim() || null,
    ein: form.ein.trim() || null,
    incorporationDate: form.incorporationDate || null,
    name: form.name.trim(),
    state: form.state.trim() || null,
    streetAddress: form.streetAddress.trim() || null,
    zip: form.zip.trim() || null,
  };
}

function BusinessEmptyState({ title }: { title: string }) {
  return (
    <EmptyState icon="businesses" title={title}>
      Business details will appear here.
    </EmptyState>
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Something went wrong.";
}
