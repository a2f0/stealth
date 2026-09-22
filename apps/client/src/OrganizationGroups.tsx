import {
  Avatar,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  LoadingState,
} from "@tearleads/ui/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  createOrganizationGroup,
  deleteOrganizationGroup,
  getOrganizationGroups,
  type OrganizationGroup,
  updateOrganizationGroup,
} from "./organizationGroupsApi";
import type { OrganizationMember } from "./organizationSettingsApi";

export function OrganizationAccessSettings({
  onAccessChanged,
  organizationId,
}: {
  onAccessChanged: () => Promise<void>;
  organizationId: string;
}) {
  const [data, setData] = useState<Awaited<
    ReturnType<typeof getOrganizationGroups>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(undefined);
    try {
      setData(await getOrganizationGroups());
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoading(false);
    }
  }, [organizationId]);
  useEffect(() => void load(), [load]);

  async function changed() {
    await Promise.all([load(), onAccessChanged()]);
  }

  if (!data && loading) {
    return <LoadingState label="Loading access settings…" />;
  }
  if (!data) {
    return (
      <Banner
        actions={
          <Button onClick={() => void load()} size="sm">
            Try again
          </Button>
        }
        tone="danger"
      >
        {error}
      </Banner>
    );
  }
  return (
    <>
      {error && <Banner tone="danger">{error}</Banner>}
      <OrganizationGroups
        groups={data.groups}
        members={data.members}
        onChanged={changed}
      />
    </>
  );
}

function OrganizationGroups({
  groups,
  members,
  onChanged,
}: {
  groups: OrganizationGroup[];
  members: OrganizationMember[];
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function create(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) return;
    setBusy(true);
    setError(undefined);
    try {
      await createOrganizationGroup({
        capabilities: [],
        name: nextName,
        userIds: [],
      });
      setName("");
      await onChanged();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      description="Control feature access for sets of organization members."
      flush
      title="Groups"
    >
      <form className="groupCreate" onSubmit={(event) => void create(event)}>
        <div className="groupCreateRow">
          <Field label="New group name">
            <input
              className="input"
              disabled={busy}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="Operations"
              type="text"
              value={name}
            />
          </Field>
          <Button
            busy={busy}
            disabled={!name.trim()}
            icon="add"
            type="submit"
            variant="primary"
          >
            Add group
          </Button>
        </div>
        {error && <Banner tone="danger">{error}</Banner>}
      </form>
      <div className="groupList">
        {groups.length === 0 ? (
          <EmptyState compact icon="layers" title="No groups yet">
            Create a group to give a set of members access to features like
            Finance.
          </EmptyState>
        ) : (
          groups.map((group) => (
            <GroupEditor
              group={group}
              key={group.id}
              members={members}
              onChanged={onChanged}
            />
          ))
        )}
      </div>
    </Card>
  );
}

function GroupEditor({
  group,
  members,
  onChanged,
}: {
  group: OrganizationGroup;
  members: OrganizationMember[];
  onChanged: () => Promise<void>;
}) {
  const editor = useGroupEditor(group, onChanged);
  return (
    <form className="groupPanel" onSubmit={(event) => void editor.save(event)}>
      <div className="groupPanelBody">
        <div className="groupPanelHeading">
          <Field className="groupNameField" label="Group name">
            <input
              className="input"
              disabled={editor.busy}
              maxLength={100}
              onChange={(event) => editor.setName(event.target.value)}
              required
              type="text"
              value={editor.name}
            />
          </Field>
          <label className="check groupCapability">
            <input
              checked={editor.finance}
              disabled={editor.busy}
              onChange={(event) => editor.setFinance(event.target.checked)}
              type="checkbox"
            />
            Finance access
          </label>
        </div>
        <GroupMemberPicker
          disabled={editor.busy}
          memberIds={editor.memberIds}
          members={members}
          onToggle={editor.toggleMember}
        />
        {editor.error && <Banner tone="danger">{editor.error}</Banner>}
        {editor.notice && <Banner tone="success">{editor.notice}</Banner>}
      </div>
      <div className="groupPanelFooter">
        <Button
          disabled={editor.busy}
          icon="trash"
          onClick={() => void editor.remove()}
          size="sm"
          variant="danger"
        >
          Delete group
        </Button>
        <Button
          busy={editor.busy}
          disabled={!editor.name.trim()}
          size="sm"
          type="submit"
          variant="primary"
        >
          {editor.busy ? "Saving…" : "Save group"}
        </Button>
      </div>
    </form>
  );
}

function useGroupEditor(
  group: OrganizationGroup,
  onChanged: () => Promise<void>,
) {
  const [name, setName] = useState(group.name);
  const [finance, setFinance] = useState(
    group.capabilities.includes("finance"),
  );
  const [memberIds, setMemberIds] = useState(
    () => new Set(group.memberUserIds),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const start = () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    start();
    try {
      await updateOrganizationGroup(group.id, {
        capabilities: finance ? ["finance"] : [],
        name: name.trim(),
        userIds: [...memberIds],
      });
      setNotice("Group updated.");
      await onChanged();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the ${group.name} group?`)) return;
    start();
    try {
      await deleteOrganizationGroup(group.id);
      await onChanged();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      // A failed reload can leave this panel mounted; keep it usable.
      setBusy(false);
    }
  };
  const toggleMember = (userId: string) =>
    setMemberIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  return {
    busy,
    error,
    finance,
    memberIds,
    name,
    notice,
    remove,
    save,
    setFinance,
    setName,
    toggleMember,
  };
}

function GroupMemberPicker({
  disabled,
  memberIds,
  members,
  onToggle,
}: {
  disabled: boolean;
  memberIds: Set<string>;
  members: OrganizationMember[];
  onToggle: (userId: string) => void;
}) {
  const selected = members.filter(({ user }) => memberIds.has(user.id)).length;
  return (
    <fieldset className="fieldset" disabled={disabled}>
      <legend>
        Members{" "}
        <span className="groupMembersCount">
          {selected} of {members.length} selected
        </span>
      </legend>
      <div className="gridAuto groupMemberGrid">
        {members.map((member) => (
          <label className="check groupMemberOption" key={member.id}>
            <input
              checked={memberIds.has(member.user.id)}
              onChange={() => onToggle(member.user.id)}
              type="checkbox"
            />
            <Avatar name={member.user.name} size="sm" />
            <span className="groupMemberText">
              <span className="groupMemberName truncate">
                {member.user.name}
              </span>
              <span className="groupMemberEmail truncate">
                {member.user.email}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not update the group.";
}
