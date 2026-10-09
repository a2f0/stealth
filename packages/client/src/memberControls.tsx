import { Badge } from "@tearleads/ui/react";
import { formatRole } from "./organizationPeopleState";
import type { OrganizationMember } from "./organizationSettingsApi";
import {
  type OrganizationInvitationRole,
  organizationRoleValue,
} from "./organizationState";

export function TwoFactorStatus({ member }: { member: OrganizationMember }) {
  if (member.twoFactorEnabled) {
    return <Badge tone="success">2FA enabled</Badge>;
  }
  return (
    <Badge tone={member.twoFactorRequired ? "warning" : "neutral"}>
      2FA not set up
    </Badge>
  );
}

/** Managers toggle the requirement; everyone else sees whether it applies. */
export function MemberTwoFactorControl({
  busy,
  canManage,
  member,
  onChange,
}: {
  busy: boolean;
  canManage: boolean;
  member: OrganizationMember;
  onChange: (member: OrganizationMember, required: boolean) => Promise<void>;
}) {
  if (!canManage) {
    return member.twoFactorRequired ? (
      <Badge tone="info">2FA required</Badge>
    ) : null;
  }
  return (
    <label className="check">
      <input
        aria-label={`Require two-factor authentication for ${member.user.name}`}
        checked={member.twoFactorRequired}
        disabled={busy}
        onChange={(event) => void onChange(member, event.target.checked)}
        type="checkbox"
      />
      <span>Require 2FA</span>
    </label>
  );
}

/** A role picker when the manager may change it, otherwise the role itself. */
export function MemberRoleControl({
  busy,
  member,
  onChange,
  roles,
}: {
  busy: boolean;
  member: OrganizationMember;
  onChange: (
    member: OrganizationMember,
    role: OrganizationInvitationRole,
  ) => Promise<void>;
  roles: OrganizationInvitationRole[];
}) {
  const role = organizationRoleValue(member.role);
  if (roles.length <= 1) return <Badge>{formatRole(role)}</Badge>;
  return (
    <select
      aria-label={`Role for ${member.user.name}`}
      className="select inputSm memberRoleSelect"
      disabled={busy}
      onChange={(event) =>
        void onChange(member, event.target.value as OrganizationInvitationRole)
      }
      value={role}
    >
      {roles.map((assignableRole) => (
        <option key={assignableRole} value={assignableRole}>
          {formatRole(assignableRole)}
        </option>
      ))}
    </select>
  );
}
