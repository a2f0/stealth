import { AuditHome } from "./AuditHome";
import { AuditRunPage } from "./AuditRunPage";
import { AuditTemplateBuilder } from "./AuditTemplateBuilder";

interface AuditsProps {
  isPlatformAdmin: boolean;
  onNavigate: (pathname: string) => void;
  pathname: string;
}

export function Audits({ isPlatformAdmin, onNavigate, pathname }: AuditsProps) {
  const templateId = routeId(pathname, "/audits/templates/");
  if (templateId) {
    return (
      <AuditTemplateBuilder
        id={templateId}
        isPlatformAdmin={isPlatformAdmin}
        onNavigate={onNavigate}
      />
    );
  }
  const auditId = routeId(pathname, "/audits/runs/");
  if (auditId) {
    return <AuditRunPage id={auditId} onNavigate={onNavigate} />;
  }
  return (
    <AuditHome canManageGlobal={isPlatformAdmin} onNavigate={onNavigate} />
  );
}

function routeId(pathname: string, prefix: string) {
  if (!pathname.startsWith(prefix)) return undefined;
  const id = pathname.slice(prefix.length).split("/")[0];
  return id ? decodeURIComponent(id) : undefined;
}
