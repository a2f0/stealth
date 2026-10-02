import { Page, PageBody, PageHeader } from "@tearleads/ui/react";
import { ActivityFeed } from "./ActivityFeed";

export function Activity({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  return (
    <Page>
      <PageHeader
        description="See who changed forms, answers, and issues in this organization."
        eyebrow="Workspace"
        title="Activity"
      />
      <PageBody>
        <ActivityFeed onNavigate={onNavigate} />
      </PageBody>
    </Page>
  );
}
