import {
  Banner,
  Button,
  Card,
  ContextMenu,
  cx,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Toast,
} from "@tearleads/ui/react";
import {
  type ComponentProps,
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  type Business,
  type BusinessDetail,
  type BusinessInput,
  createBusiness,
  deleteBusiness,
  getBusiness,
  getBusinesses,
  updateBusiness,
} from "./businessesApi";
import {
  type BusinessIdentifier,
  type BusinessListState,
  businessListReducer,
  copiedNotice,
  formatBusinessAddress,
  formatBusinessDate,
  formatDuns,
  formatEin,
  initialBusinessListState,
} from "./businessState";
import { countLabel } from "./labels";
import {
  businessIdForPath,
  businessPath,
  handleNavigation,
} from "./workspacePaths";

interface BusinessFormState {
  city: string;
  duns: string;
  ein: string;
  incorporationDate: string;
  name: string;
  state: string;
  streetAddress: string;
  zip: string;
}

export function Businesses({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const businessId = businessIdForPath(pathname);
  return businessId ? (
    <BusinessDetailPage
      id={businessId}
      key={businessId}
      onNavigate={onNavigate}
    />
  ) : (
    <BusinessListPage onNavigate={onNavigate} />
  );
}

function BusinessListPage({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const [state, dispatch] = useReducer(
    businessListReducer,
    initialBusinessListState,
  );
  const load = useCallback(async () => {
    dispatch({ type: "loadStarted" });
    try {
      dispatch({ type: "loaded", data: await getBusinesses() });
    } catch (cause) {
      dispatch({ type: "loadFailed", message: messageFrom(cause) });
    }
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <BusinessListView
      {...state}
      onAddingChange={(adding) =>
        dispatch({ type: adding ? "addOpened" : "addCancelled" })
      }
      onCopied={(identifier) => dispatch({ type: "copied", identifier })}
      onCreated={(business) => dispatch({ type: "created", business })}
      onDeleted={(id) => dispatch({ type: "deleted", id })}
      onError={(message) => dispatch({ type: "failed", message })}
      onNavigate={onNavigate}
      onUpdated={(business) => dispatch({ type: "updated", business })}
    />
  );
}

interface BusinessListViewProps extends BusinessListState {
  onAddingChange: (adding: boolean) => void;
  onCopied: (identifier: BusinessIdentifier) => void;
  onCreated: (business: Business) => void;
  onDeleted: (id: string) => void;
  onError: (message: string) => void;
  onNavigate: (pathname: string) => void;
  onUpdated: (business: Business) => void;
}

/**
 * The first business is added from an open form. Once one exists, the form
 * folds behind an "Add business" header action so the list leads the page.
 */
export function BusinessListView(props: BusinessListViewProps) {
  const { adding, data, onAddingChange } = props;
  const canManage = data?.canManage ?? false;
  const hasBusinesses = (data?.businesses.length ?? 0) > 0;
  const formOpen = canManage && (adding || !hasBusinesses);
  const addButton = useFocusWhenFolded(formOpen);
  return (
    <Page>
      <PageHeader
        actions={
          canManage &&
          hasBusinesses &&
          !adding && (
            <Button
              icon="add"
              onClick={() => onAddingChange(true)}
              ref={addButton}
              variant="primary"
            >
              Add business
            </Button>
          )
        }
        description="Keep the businesses belonging to this organization in one place."
        eyebrow="Records"
        title="Businesses"
      />
      <PageBody>
        <BusinessListBody {...props} formOpen={formOpen} />
      </PageBody>
    </Page>
  );
}

/**
 * Folding a form away (cancelled, or a business was added or saved) removes
 * the focused field; hand focus to the button that reopens it.
 */
function useFocusWhenFolded(formOpen: boolean) {
  const button = useRef<HTMLButtonElement>(null);
  const wasFormOpen = useRef(formOpen);
  useEffect(() => {
    if (wasFormOpen.current && !formOpen) button.current?.focus();
    wasFormOpen.current = formOpen;
  }, [formOpen]);
  return button;
}

function BusinessListBody({
  data,
  error,
  formOpen,
  loading,
  notice,
  onAddingChange,
  onCopied,
  onCreated,
  onDeleted,
  onError,
  onNavigate,
  onUpdated,
}: BusinessListViewProps & { formOpen: boolean }) {
  const hasBusinesses = (data?.businesses.length ?? 0) > 0;
  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Toast tone="success">{notice}</Toast>}
      {loading && !data ? (
        <LoadingState label="Loading businesses…" />
      ) : data ? (
        <>
          {!data.canManage && <ReadOnlyNotice />}
          {formOpen && (
            <BusinessCreateForm
              onCancel={hasBusinesses ? () => onAddingChange(false) : undefined}
              onCreated={onCreated}
              onError={onError}
            />
          )}
          <BusinessList
            businesses={data.businesses}
            canManage={data.canManage}
            onCopied={onCopied}
            onDeleted={onDeleted}
            onError={onError}
            onNavigate={onNavigate}
            onUpdated={onUpdated}
          />
        </>
      ) : (
        <BusinessEmptyState title="Businesses could not be loaded." />
      )}
    </>
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
  onCancel,
  onCreated,
  onError,
}: {
  /** Present when the form was opened on demand and can fold away again. */
  onCancel: (() => void) | undefined;
  onCreated: (business: Business) => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState<BusinessFormState>(emptyBusinessForm);
  const [busy, setBusy] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const openedOnDemand = Boolean(onCancel);
  // The header button that opened the form is gone; move focus into the form.
  // A form that is simply open on arrival leaves focus where it was.
  useEffect(() => {
    if (openedOnDemand) nameField.current?.focus();
  }, [openedOnDemand]);

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
          <div className="cluster">
            {onCancel && (
              <Button disabled={busy} onClick={onCancel} variant="ghost">
                Cancel
              </Button>
            )}
            <Button
              busy={busy}
              disabled={!form.name.trim()}
              icon="add"
              type="submit"
              variant="primary"
            >
              {busy ? "Adding…" : "Add business"}
            </Button>
          </div>
        </>
      }
      onSubmit={(event) => void submit(event)}
      title="Add a business"
    >
      <BusinessFields
        disabled={busy}
        form={form}
        nameField={nameField}
        onChange={setForm}
      />
    </Card>
  );
}

function BusinessList({
  businesses,
  canManage,
  onNavigate,
  onCopied,
  onDeleted,
  onError,
  onUpdated,
}: {
  businesses: Business[];
  canManage: boolean;
  onNavigate: (pathname: string) => void;
  onCopied: (identifier: BusinessIdentifier) => void;
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
                onNavigate={onNavigate}
                onCopied={onCopied}
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
  onNavigate,
  onCopied,
  onDeleted,
  onError,
  onUpdated,
}: {
  business: Business;
  canManage: boolean;
  onNavigate: (pathname: string) => void;
  onCopied: (identifier: BusinessIdentifier) => void;
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
    <BusinessContextMenu
      business={business}
      onCopied={onCopied}
      onError={onError}
    >
      {(targetProps) => (
        <li className="row" {...targetProps}>
          <BusinessSummary business={business} onNavigate={onNavigate} />
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
      )}
    </BusinessContextMenu>
  );
}

function BusinessContextMenu({
  business,
  children,
  onCopied,
  onError,
}: {
  business: Business;
  children: ComponentProps<typeof ContextMenu>["children"];
  onCopied: (identifier: BusinessIdentifier) => void;
  onError: (message: string) => void;
}) {
  return (
    <ContextMenu
      items={businessIdentifiers(business).map(({ id, identifier, value }) => ({
        disabled: !value,
        icon: "copy",
        id: `copy-${id}`,
        label: `Copy ${identifier}`,
        onSelect: () => {
          if (value) {
            void copyIdentifier(identifier, value, { onCopied, onError });
          }
        },
      }))}
      label={`Actions for ${business.name}`}
    >
      {children}
    </ContextMenu>
  );
}

/** A business's copyable identifiers, formatted as they are displayed. */
function businessIdentifiers(business: Business) {
  return [
    {
      id: "ein",
      identifier: "EIN",
      value: business.ein ? formatEin(business.ein) : null,
    },
    {
      id: "duns",
      identifier: "DUNS number",
      value: business.duns ? formatDuns(business.duns) : null,
    },
  ] satisfies {
    id: string;
    identifier: BusinessIdentifier;
    value: string | null;
  }[];
}

/** Copies an identifier from the row menu or the detail page alike. */
async function copyIdentifier(
  identifier: BusinessIdentifier,
  value: string,
  {
    onCopied,
    onError,
  }: {
    onCopied: (identifier: BusinessIdentifier) => void;
    onError: (message: string) => void;
  },
) {
  try {
    await navigator.clipboard.writeText(value);
    onCopied(identifier);
  } catch {
    onError(`Could not copy the ${identifier}. Please try again.`);
  }
}

function BusinessSummary({
  business,
  onNavigate,
}: {
  business: Business;
  onNavigate: (pathname: string) => void;
}) {
  const facts = [
    business.ein ? `EIN ${formatEin(business.ein)}` : "EIN not provided",
  ];
  if (business.duns) facts.push(`DUNS ${formatDuns(business.duns)}`);
  if (business.incorporationDate) {
    facts.push(
      `Incorporated ${formatBusinessDate(business.incorporationDate)}`,
    );
  }
  const address = formatBusinessAddress(business);
  return (
    <a
      className="businessSummary businessSummaryLink"
      href={businessPath(business.id)}
      onClick={(event) =>
        handleNavigation(event, businessPath(business.id), onNavigate)
      }
    >
      <span aria-hidden="true" className="businessMark">
        <Icon name="businesses" size={18} />
      </span>
      <div className="rowMain">
        <span className="rowTitle">{business.name}</span>
        <span className="rowMeta tabular">{facts.join(" · ")}</span>
        {address && <span className="rowMeta">{address}</span>}
      </div>
    </a>
  );
}

function BusinessDetailPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (pathname: string) => void;
}) {
  const [detail, setDetail] = useState<BusinessDetail>();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const editButton = useFocusWhenFolded(editing);
  const business = detail?.business;
  const announce = (message: string) => {
    setError(undefined);
    setNotice(message);
  };
  const fail = (message: string) => {
    setNotice(undefined);
    setError(message);
  };
  useEffect(() => {
    let active = true;
    getBusiness(id)
      .then((result) => {
        if (active) setDetail(result);
      })
      .catch((cause: unknown) => {
        if (active) setError(messageFrom(cause));
      });
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <Page>
      <PageHeader
        actions={
          <>
            {detail?.canManage && !editing && (
              <Button
                icon="edit"
                onClick={() => setEditing(true)}
                ref={editButton}
              >
                Edit
              </Button>
            )}
            <Button icon="arrowLeft" onClick={() => onNavigate(businessPath())}>
              Businesses
            </Button>
          </>
        }
        eyebrow="Business"
        title={business?.name ?? "Business details"}
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {notice && <Toast tone="success">{notice}</Toast>}
        {!business && !error && <LoadingState label="Loading business…" />}
        {business &&
          (editing ? (
            <BusinessEditCard
              business={business}
              onCancel={() => setEditing(false)}
              onError={fail}
              onSaved={(updated) => {
                setDetail((current) =>
                  current ? { ...current, business: updated } : current,
                );
                setEditing(false);
                announce("Business updated.");
              }}
            />
          ) : (
            <BusinessDetailCard
              business={business}
              onCopied={(identifier) => announce(copiedNotice(identifier))}
              onError={fail}
            />
          ))}
      </PageBody>
    </Page>
  );
}

function BusinessDetailCard({
  business,
  onCopied,
  onError,
}: {
  business: Business;
  onCopied: (identifier: BusinessIdentifier) => void;
  onError: (message: string) => void;
}) {
  return (
    <PageSection title="Details">
      <Card>
        <dl className="businessDetails">
          <div>
            <dt>Name</dt>
            <dd>{business.name}</dd>
          </div>
          {businessIdentifiers(business).map(({ id, identifier, value }) => (
            <div key={id}>
              <dt>{identifier}</dt>
              <dd className="businessDetailValue">
                {value ?? "Not provided"}
                {value && (
                  <Button
                    aria-label={`Copy ${identifier}`}
                    icon="copy"
                    iconOnly
                    onClick={() =>
                      void copyIdentifier(identifier, value, {
                        onCopied,
                        onError,
                      })
                    }
                    size="sm"
                    variant="ghost"
                  />
                )}
              </dd>
            </div>
          ))}
          <div>
            <dt>Incorporation date</dt>
            <dd>
              {business.incorporationDate
                ? formatBusinessDate(business.incorporationDate)
                : "Not provided"}
            </dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>{formatBusinessAddress(business) || "Not provided"}</dd>
          </div>
        </dl>
      </Card>
    </PageSection>
  );
}

/** The detail page's editor: the add form's fields, filled from the business. */
function BusinessEditCard({
  business,
  onCancel,
  onError,
  onSaved,
}: {
  business: Business;
  onCancel: () => void;
  onError: (message: string) => void;
  onSaved: (business: Business) => void;
}) {
  const [form, setForm] = useState<BusinessFormState>(() =>
    businessForm(business),
  );
  const [busy, setBusy] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  // The Edit button that opened the form is gone; move focus into the form.
  useEffect(() => nameField.current?.focus(), []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await updateBusiness(business.id, businessInput(form));
      onSaved(result.business);
    } catch (cause) {
      onError(messageFrom(cause));
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
          <div className="cluster">
            <Button disabled={busy} onClick={onCancel} variant="ghost">
              Cancel
            </Button>
            <Button
              busy={busy}
              disabled={!form.name.trim()}
              icon="check"
              type="submit"
              variant="primary"
            >
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </>
      }
      onSubmit={(event) => void save(event)}
      title="Edit business"
    >
      <BusinessFields
        disabled={busy}
        form={form}
        nameField={nameField}
        onChange={setForm}
      />
    </Card>
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
  nameField,
  onChange,
}: {
  compact?: boolean;
  disabled: boolean;
  form: BusinessFormState;
  nameField?: RefObject<HTMLInputElement | null>;
  onChange: (form: BusinessFormState) => void;
}) {
  const set = (field: keyof BusinessFormState, value: string) => {
    onChange({ ...form, [field]: value });
  };
  const input = cx("input", compact && "inputSm");
  return (
    <div className="businessFieldsFrame">
      <div className="businessFields">
        <Field className="businessFieldWide" label="Business name">
          <input
            autoComplete="organization"
            className={input}
            disabled={disabled}
            maxLength={120}
            onChange={(event) => set("name", event.target.value)}
            placeholder="Acme, Inc."
            ref={nameField}
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
        <Field className="businessFieldHalf" label="DUNS number" optional>
          <input
            className={input}
            disabled={disabled}
            inputMode="numeric"
            maxLength={11}
            onChange={(event) => set("duns", event.target.value)}
            pattern="[0-9]{9}|[0-9]{2}-[0-9]{3}-[0-9]{4}"
            placeholder="12-345-6789"
            type="text"
            value={form.duns}
          />
        </Field>
        <Field
          className="businessFieldHalf"
          label="Incorporation date"
          optional
        >
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
    duns: business.duns ? formatDuns(business.duns) : "",
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
    duns: "",
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
    duns: form.duns.trim() || null,
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
