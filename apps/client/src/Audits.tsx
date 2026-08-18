import { AuditHome } from "./AuditHome";
import { AuditRunPage } from "./AuditRunPage";
import { AuditTemplateBuilder } from "./AuditTemplateBuilder";

interface AuditsProps {
  onNavigate: (pathname: string) => void;
  pathname: string;
}

export function Audits({ onNavigate, pathname }: AuditsProps) {
  const templateId = routeId(pathname, "/audits/templates/");
  if (templateId) {
    return <AuditTemplateBuilder id={templateId} onNavigate={onNavigate} />;
  }
  const auditId = routeId(pathname, "/audits/runs/");
  if (auditId) {
    return <AuditRunPage id={auditId} onNavigate={onNavigate} />;
  }
  return <AuditHome onNavigate={onNavigate} />;
}

function routeId(pathname: string, prefix: string) {
  if (!pathname.startsWith(prefix)) return undefined;
  const id = pathname.slice(prefix.length).split("/")[0];
  return id ? decodeURIComponent(id) : undefined;
}
