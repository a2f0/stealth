import { Avatar } from "@tearleads/ui/react";

export function Identity({
  avatar = false,
  detail,
  name,
}: {
  avatar?: boolean;
  detail?: string | undefined;
  name: string;
}) {
  return (
    <div className="adminIdentity">
      {avatar && <Avatar name={name} size="sm" />}
      <div className="adminIdentityText">
        <span className="adminIdentityName">{name}</span>
        {detail && <span className="adminIdentityDetail">{detail}</span>}
      </div>
    </div>
  );
}

export function formatDate(value: Date | number | string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(value));
}
