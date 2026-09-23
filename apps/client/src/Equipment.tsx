import {
  Avatar,
  Banner,
  Button,
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
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type LinkedEmail, unlinkInboundEmail } from "./api";
import {
  createEquipment,
  deleteEquipment,
  type EquipmentDetail,
  type EquipmentInput,
  type EquipmentItem,
  type EquipmentListing,
  type EquipmentMember,
  getEquipment,
  listEquipment,
  updateEquipment,
} from "./equipmentApi";
import {
  equipmentName,
  equipmentTypeIcon,
  equipmentTypeLabel,
} from "./equipmentLabels";
import { LinkedEmailList } from "./LinkedEmailList";
import { countLabel } from "./labels";
import {
  equipmentIdForPath,
  equipmentPath,
  handleNavigation,
} from "./workspacePaths";

type AssigneeFilter = "everyone" | "unassigned" | string;

export function Equipment({
  onNavigate,
  pathname,
}: {
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const equipmentId = equipmentIdForPath(pathname);
  // Keyed so each page starts from its own state and ignores the other's
  // responses after navigation.
  return equipmentId ? (
    <EquipmentDetailPage
      id={equipmentId}
      key={equipmentId}
      onNavigate={onNavigate}
    />
  ) : (
    <EquipmentListPage onNavigate={onNavigate} />
  );
}

function useEquipmentListing() {
  const [listing, setListing] = useState<EquipmentListing>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let active = true;
    listEquipment()
      .then((result) => {
        if (active) setListing(result);
      })
      .catch((cause: unknown) => {
        if (active) setError(messageFrom(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  async function add(input: EquipmentInput) {
    setError(undefined);
    setNotice(undefined);
    try {
      const created = await createEquipment(input);
      setListing((current) =>
        current
          ? { ...current, equipment: [created, ...current.equipment] }
          : current,
      );
      setAdding(false);
      setNotice(`Added ${equipmentName(created)}.`);
      return true;
    } catch (cause) {
      setError(messageFrom(cause));
      return false;
    }
  }
  return { add, adding, error, listing, notice, setAdding };
}

function filterEquipment(
  equipment: EquipmentItem[],
  type: string,
  assignee: AssigneeFilter,
) {
  return equipment.filter(
    (item) =>
      (type === "all" || item.type === type) &&
      (assignee === "everyone" ||
        (assignee === "unassigned"
          ? !item.assignee
          : item.assignee?.id === assignee)),
  );
}

function EquipmentListPage({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const { add, adding, error, listing, notice, setAdding } =
    useEquipmentListing();
  const [typeFilter, setTypeFilter] = useState("all");
  const [assigneeFilter, setAssigneeFilter] =
    useState<AssigneeFilter>("everyone");
  const visible = filterEquipment(
    listing?.equipment ?? [],
    typeFilter,
    assigneeFilter,
  );

  return (
    <Page>
      <PageHeader
        actions={
          listing?.canManage &&
          !adding && (
            <Button
              icon="add"
              onClick={() => setAdding(true)}
              variant="primary"
            >
              Add equipment
            </Button>
          )
        }
        description="Computers, phones, and monitors your organization owns, who has them, and their receipts."
        eyebrow="Records"
        title="Equipment"
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {notice && <Banner tone="success">{notice}</Banner>}
        {!listing ? (
          !error && <LoadingState label="Loading equipment…" />
        ) : (
          <>
            {!listing.canManage && <ReadOnlyNotice />}
            {adding && (
              <EquipmentForm
                members={listing.members}
                onCancel={() => setAdding(false)}
                onSave={add}
                types={listing.types}
              />
            )}
            <PageSection
              actions={
                <span className="sectionCount">
                  {visible.length === listing.equipment.length
                    ? countLabel(listing.equipment.length, "item")
                    : `${visible.length} of ${listing.equipment.length}`}
                </span>
              }
              title="Inventory"
            >
              {listing.equipment.length > 0 && (
                <EquipmentFilters
                  assignee={assigneeFilter}
                  members={listing.members}
                  onAssigneeChange={setAssigneeFilter}
                  onTypeChange={setTypeFilter}
                  type={typeFilter}
                  types={listing.types}
                />
              )}
              <EquipmentList
                canManage={listing.canManage}
                empty={listing.equipment.length === 0}
                equipment={visible}
                onAdd={() => setAdding(true)}
                onNavigate={onNavigate}
              />
            </PageSection>
          </>
        )}
      </PageBody>
    </Page>
  );
}

function ReadOnlyNotice() {
  return (
    <Banner announce={false} icon="lock" tone="neutral">
      Only organization owners and admins can add, change, or assign equipment.
      Anyone can link receipts to it from the Inbox.
    </Banner>
  );
}

function EquipmentFilters({
  assignee,
  members,
  onAssigneeChange,
  onTypeChange,
  type,
  types,
}: {
  assignee: AssigneeFilter;
  members: EquipmentMember[];
  onAssigneeChange: (assignee: AssigneeFilter) => void;
  onTypeChange: (type: string) => void;
  type: string;
  types: string[];
}) {
  return (
    <div className="equipmentFilters">
      <nav aria-label="Equipment types" className="segmented">
        {["all", ...types].map((value) => (
          <button
            aria-pressed={type === value}
            key={value}
            onClick={() => onTypeChange(value)}
            type="button"
          >
            {value !== "all" && (
              <Icon name={equipmentTypeIcon(value)} size={16} />
            )}
            {value === "all" ? "All" : equipmentTypeLabel(value)}
          </button>
        ))}
      </nav>
      <select
        aria-label="Assigned to"
        className="select inputSm equipmentAssigneeFilter"
        onChange={(event) => onAssigneeChange(event.target.value)}
        value={assignee}
      >
        <option value="everyone">Everyone</option>
        <option value="unassigned">Unassigned</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function EquipmentList({
  canManage,
  empty,
  equipment,
  onAdd,
  onNavigate,
}: {
  canManage: boolean;
  empty: boolean;
  equipment: EquipmentItem[];
  onAdd: () => void;
  onNavigate: (pathname: string) => void;
}) {
  if (empty) {
    return (
      <EmptyState
        actions={
          canManage && (
            <Button icon="add" onClick={onAdd} variant="primary">
              Add equipment
            </Button>
          )
        }
        icon="equipment"
        title="No equipment yet"
      >
        Track computers, phones, and monitors, who has each one, and the
        receipts that came with them.
      </EmptyState>
    );
  }
  if (!equipment.length) {
    return (
      <EmptyState compact icon="search" title="Nothing matches these filters" />
    );
  }
  return (
    <Card flush>
      <ul className="rowList">
        {equipment.map((item) => {
          const path = equipmentPath(item.id);
          return (
            <li key={item.id}>
              <a
                className="row equipmentRow"
                href={path}
                onClick={(event) => handleNavigation(event, path, onNavigate)}
              >
                <span className="equipmentTypeMark">
                  <Icon name={equipmentTypeIcon(item.type)} size={20} />
                </span>
                <span className="rowMain">
                  <span className="rowTitle truncate">
                    {equipmentName(item)}
                  </span>
                  <span className="rowMeta truncate">
                    {equipmentMeta(item)}
                  </span>
                </span>
                {item.emailCount > 0 && (
                  <span
                    className="equipmentEmailCount"
                    title={countLabel(item.emailCount, "linked email")}
                  >
                    <Icon name="mail" size={14} />
                    {item.emailCount}
                  </span>
                )}
                <Assignee member={item.assignee} />
              </a>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Assignee({ member }: { member: EquipmentMember | null }) {
  if (!member) {
    return (
      <span className="equipmentAssignee equipmentUnassigned">Unassigned</span>
    );
  }
  return (
    <span className="equipmentAssignee">
      <Avatar name={member.name} size="sm" />
      <span className="truncate">{member.name}</span>
    </span>
  );
}

function useEquipmentDetail(
  id: string,
  onNavigate: (pathname: string) => void,
) {
  const [detail, setDetail] = useState<EquipmentDetail>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await getEquipment(id));
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  async function save(changes: Partial<EquipmentInput>, message: string) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const equipment = await updateEquipment(id, changes);
      setDetail((current) => (current ? { ...current, equipment } : current));
      setNotice(message);
      return true;
    } catch (cause) {
      setError(messageFrom(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: EquipmentItem) {
    const links = item.emailCount
      ? ` ${countLabel(item.emailCount, "linked email")} will be unlinked but stay in the inbox.`
      : "";
    if (!window.confirm(`Delete ${equipmentName(item)}?${links}`)) return;
    setBusy(true);
    setError(undefined);
    try {
      await deleteEquipment(id);
      onNavigate(equipmentPath());
    } catch (cause) {
      setError(messageFrom(cause));
      setBusy(false);
    }
  }

  async function unlink(email: LinkedEmail) {
    setBusy(true);
    setError(undefined);
    try {
      await unlinkInboundEmail(email.id, email.linkId);
      await load();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }
  return {
    busy,
    detail,
    editing,
    error,
    notice,
    remove,
    save,
    setEditing,
    unlink,
  };
}

function EquipmentDetailPage({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (pathname: string) => void;
}) {
  const {
    busy,
    detail,
    editing,
    error,
    notice,
    remove,
    save,
    setEditing,
    unlink,
  } = useEquipmentDetail(id, onNavigate);
  const item = detail?.equipment;
  return (
    <Page>
      <EquipmentDetailHeader
        busy={busy}
        canEdit={Boolean(detail?.canManage && item && !editing)}
        item={item}
        onBack={() => onNavigate(equipmentPath())}
        onDelete={() => item && void remove(item)}
        onEdit={() => setEditing(true)}
        unavailable={Boolean(error)}
      />
      <PageBody>
        {error && <Banner tone="danger">{error}</Banner>}
        {notice && <Banner tone="success">{notice}</Banner>}
        {!detail || !item ? (
          !error && <LoadingState label="Loading equipment…" />
        ) : (
          <>
            {editing ? (
              <EquipmentForm
                initial={item}
                members={detail.members}
                onCancel={() => setEditing(false)}
                onSave={async (input) => {
                  const saved = await save(input, "Equipment updated.");
                  if (saved) setEditing(false);
                  return saved;
                }}
                types={detail.types}
              />
            ) : (
              <EquipmentDetails
                busy={busy}
                canManage={detail.canManage}
                item={item}
                members={detail.members}
                onAssign={(assigneeId) =>
                  void save(
                    { assigneeId },
                    assigneeId
                      ? "Equipment assigned."
                      : "Equipment unassigned.",
                  )
                }
              />
            )}
            <LinkedEmailList
              busy={busy}
              description="Receipts and other Inbox messages linked to this equipment."
              emails={detail.emails}
              emptyText="Open a receipt in the Inbox and link it to this equipment."
              onNavigate={onNavigate}
              onUnlink={(email) => void unlink(email)}
              title="Emails and receipts"
            />
          </>
        )}
      </PageBody>
    </Page>
  );
}

function EquipmentDetailHeader({
  busy,
  canEdit,
  item,
  onBack,
  onDelete,
  onEdit,
  unavailable,
}: {
  busy: boolean;
  canEdit: boolean;
  item: EquipmentItem | undefined;
  onBack: () => void;
  onDelete: () => void;
  onEdit: () => void;
  unavailable: boolean;
}) {
  let title = "Loading…";
  if (item) title = equipmentName(item);
  else if (unavailable) title = "Equipment unavailable";
  return (
    <PageHeader
      actions={
        canEdit && (
          <>
            <Button disabled={busy} icon="edit" onClick={onEdit}>
              Edit
            </Button>
            <Button
              disabled={busy}
              icon="trash"
              onClick={onDelete}
              variant="danger"
            >
              Delete
            </Button>
          </>
        )
      }
      back={
        <Button icon="arrowLeft" onClick={onBack} size="sm" variant="ghost">
          Equipment
        </Button>
      }
      eyebrow={item ? equipmentTypeLabel(item.type) : "Equipment"}
      title={title}
    />
  );
}

function EquipmentDetails({
  busy,
  canManage,
  item,
  members,
  onAssign,
}: {
  busy: boolean;
  canManage: boolean;
  item: EquipmentItem;
  members: EquipmentMember[];
  onAssign: (assigneeId: string | null) => void;
}) {
  return (
    <PageSection title="Details">
      <Card>
        <dl className="keyValue equipmentDetails">
          <dt>Type</dt>
          <dd>
            <span className="equipmentTypeInline">
              <Icon name={equipmentTypeIcon(item.type)} size={16} />
              {equipmentTypeLabel(item.type)}
            </span>
          </dd>
          <dt>Make</dt>
          <dd>{item.make}</dd>
          <dt>Model</dt>
          <dd>{item.model}</dd>
          <dt>Serial number</dt>
          <dd className={item.serialNumber ? "mono" : "equipmentMissing"}>
            {item.serialNumber ?? "Not recorded"}
          </dd>
          <dt>Purchase date</dt>
          <dd className={item.purchaseDate ? undefined : "equipmentMissing"}>
            {item.purchaseDate ? formatDate(item.purchaseDate) : "Not recorded"}
          </dd>
          <dt>Assigned to</dt>
          <dd>
            {canManage ? (
              <AssigneeSelect
                disabled={busy}
                label={`Assign ${equipmentName(item)}`}
                members={members}
                onChange={onAssign}
                value={item.assignee?.id ?? null}
              />
            ) : (
              <Assignee member={item.assignee} />
            )}
          </dd>
        </dl>
      </Card>
    </PageSection>
  );
}

function AssigneeSelect({
  compact = true,
  disabled,
  label,
  members,
  onChange,
  value,
}: {
  /** Inline on the details card; full size in the form. */
  compact?: boolean;
  disabled?: boolean;
  label: string;
  members: EquipmentMember[];
  onChange: (assigneeId: string | null) => void;
  value: string | null;
}) {
  return (
    <select
      aria-label={label}
      className={compact ? "select inputSm equipmentAssigneeSelect" : "select"}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
      value={value ?? ""}
    >
      <option value="">Unassigned</option>
      {members.map((member) => (
        <option key={member.id} value={member.id}>
          {member.name} ({member.email})
        </option>
      ))}
    </select>
  );
}

function EquipmentForm({
  initial,
  members,
  onCancel,
  onSave,
  types,
}: {
  initial?: EquipmentItem;
  members: EquipmentMember[];
  onCancel: () => void;
  onSave: (input: EquipmentInput) => Promise<boolean>;
  types: string[];
}) {
  const [form, setForm] = useState<EquipmentInput>({
    assigneeId: initial?.assignee?.id ?? null,
    make: initial?.make ?? "",
    model: initial?.model ?? "",
    purchaseDate: initial?.purchaseDate ?? null,
    serialNumber: initial?.serialNumber ?? null,
    type: initial?.type ?? types[0] ?? "",
  });
  const [saving, setSaving] = useState(false);
  const set = <Key extends keyof EquipmentInput>(
    key: Key,
    value: EquipmentInput[Key],
  ) => setForm((current) => ({ ...current, [key]: value }));
  // Keep a type the list no longer offers selectable while editing.
  const typeOptions =
    initial && !types.includes(initial.type) ? [...types, initial.type] : types;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    await onSave({
      ...form,
      make: form.make.trim(),
      model: form.model.trim(),
      serialNumber: form.serialNumber?.trim() || null,
    });
    setSaving(false);
  }

  return (
    <Card
      footer={
        <div className="cluster">
          <Button onClick={onCancel} variant="ghost">
            Cancel
          </Button>
          <Button
            busy={saving}
            disabled={!form.make.trim() || !form.model.trim() || !form.type}
            icon={initial ? undefined : "add"}
            type="submit"
            variant="primary"
          >
            {initial ? "Save changes" : "Add equipment"}
          </Button>
        </div>
      }
      onSubmit={(event) => void submit(event)}
      title={initial ? "Edit equipment" : "Add equipment"}
    >
      <EquipmentFields
        form={form}
        members={members}
        set={set}
        typeOptions={typeOptions}
      />
    </Card>
  );
}

function EquipmentFields({
  form,
  members,
  set,
  typeOptions,
}: {
  form: EquipmentInput;
  members: EquipmentMember[];
  set: <Key extends keyof EquipmentInput>(
    key: Key,
    value: EquipmentInput[Key],
  ) => void;
  typeOptions: string[];
}) {
  return (
    <div className="equipmentFields">
      <Field label="Type">
        <select
          className="select"
          onChange={(event) => set("type", event.target.value)}
          required
          value={form.type}
        >
          {typeOptions.map((type) => (
            <option key={type} value={type}>
              {equipmentTypeLabel(type)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Assigned to" optional>
        <AssigneeSelect
          compact={false}
          label="Assigned to"
          members={members}
          onChange={(assigneeId) => set("assigneeId", assigneeId)}
          value={form.assigneeId}
        />
      </Field>
      <Field label="Make">
        <input
          className="input"
          maxLength={80}
          onChange={(event) => set("make", event.target.value)}
          placeholder="Apple"
          required
          value={form.make}
        />
      </Field>
      <Field label="Model">
        <input
          className="input"
          maxLength={120}
          onChange={(event) => set("model", event.target.value)}
          placeholder="MacBook Pro 14-inch"
          required
          value={form.model}
        />
      </Field>
      <Field label="Serial number" optional>
        <input
          autoCapitalize="characters"
          className="input mono"
          maxLength={100}
          onChange={(event) => set("serialNumber", event.target.value)}
          spellCheck={false}
          value={form.serialNumber ?? ""}
        />
      </Field>
      <Field label="Purchase date" optional>
        <input
          className="input"
          onChange={(event) => set("purchaseDate", event.target.value || null)}
          type="date"
          value={form.purchaseDate ?? ""}
        />
      </Field>
    </div>
  );
}

function equipmentMeta(item: EquipmentItem) {
  return [
    equipmentTypeLabel(item.type),
    item.serialNumber,
    item.purchaseDate && `Purchased ${formatDate(item.purchaseDate)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(`${value}T12:00:00`),
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load equipment.";
}
