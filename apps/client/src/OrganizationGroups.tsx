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
    return (
      <div className="emptyState compactEmptyState">
        <div className="emptyGlyph">◇</div>
        <h3>Loading access settings…</h3>
      </div>
    );
  }
  if (!data) {
    return (
      <>
        <div className="errorBanner">{error}</div>
        <button
          className="primaryButton"
          onClick={() => void load()}
          type="button"
        >
          Try again
        </button>
      </>
    );
  }
  return (
    <>
      {error && <div className="errorBanner">{error}</div>}
      <div className="organizationSettingsGrid">
        <OrganizationGroups
          groups={data.groups}
          members={data.members}
          onChanged={changed}
        />
      </div>
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
    <section className="settingsCard organizationGroupsCard">
      <div>
        <h2>Groups</h2>
        <p>Control feature access for sets of organization members.</p>
      </div>
      <form
        className="organizationGroupCreate"
        onSubmit={(event) => void create(event)}
      >
        <label className="field">
          <span>New group name</span>
          <input
            disabled={busy}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder="Operations"
            type="text"
            value={name}
          />
        </label>
        <button
          className="primaryButton"
          disabled={busy || !name.trim()}
          type="submit"
        >
          Add group
        </button>
      </form>
      {error && <div className="errorBanner compactBanner">{error}</div>}
      <div className="organizationGroupList">
        {groups.map((group) => (
          <GroupEditor
            group={group}
            key={group.id}
            members={members}
            onChanged={onChanged}
          />
        ))}
      </div>
    </section>
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
    <form
      className="organizationGroupEditor"
      onSubmit={(event) => void editor.save(event)}
    >
      <div className="organizationGroupHeading">
        <label className="field">
          <span>Group name</span>
          <input
            disabled={editor.busy}
            maxLength={100}
            onChange={(event) => editor.setName(event.target.value)}
            required
            type="text"
            value={editor.name}
          />
        </label>
        <label className="organizationCapabilityToggle">
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
      {editor.error && (
        <div className="errorBanner compactBanner">{editor.error}</div>
      )}
      {editor.notice && (
        <div className="successBanner compactBanner">{editor.notice}</div>
      )}
      <div className="organizationGroupActions">
        <button
          className="dangerButton"
          disabled={editor.busy}
          onClick={() => void editor.remove()}
          type="button"
        >
          Delete group
        </button>
        <button
          className="primaryButton"
          disabled={editor.busy || !editor.name.trim()}
          type="submit"
        >
          {editor.busy ? "Saving…" : "Save group"}
        </button>
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
  return (
    <fieldset className="organizationGroupMembers" disabled={disabled}>
      <legend>Members</legend>
      {members.map((member) => (
        <label key={member.id}>
          <input
            checked={memberIds.has(member.user.id)}
            onChange={() => onToggle(member.user.id)}
            type="checkbox"
          />
          <span>
            <strong>{member.user.name}</strong>
            <small>{member.user.email}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not update the group.";
}
