import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceShell } from "./WorkspaceShell";

function navigationGroups(role: string) {
  const markup = renderToStaticMarkup(
    <WorkspaceShell
      accountLoadError={undefined}
      accounts={[]}
      activeOrganizationId={undefined}
      activePage="organization"
      activeSessionToken=""
      canAccessFinance={false}
      contentKey={undefined}
      onAccountChange={async () => undefined}
      onAccountSettings={() => undefined}
      onAddAccount={() => undefined}
      onNavigate={() => undefined}
      onOrganizationChange={async () => undefined}
      onOrganizationCreate={async () => undefined}
      onRefreshAccounts={async () => undefined}
      onSignOut={async () => undefined}
      organizations={[]}
      user={{
        email: "user@example.com",
        emailVerified: true,
        name: "User",
        role,
      }}
    >
      <span>Workspace content</span>
    </WorkspaceShell>,
  );
  return [...markup.matchAll(/<div class="navGroup">([\s\S]*?)<\/div>/g)].map(
    (match) => match[1],
  );
}

describe("workspace navigation", () => {
  it("shows Organization in Admin without showing Root Admin to a regular user", () => {
    const groups = navigationGroups("user");
    const admin = groups.find((group) => group?.includes(">Admin</p>"));

    expect(admin).toContain('href="/organization"');
    expect(groups.some((group) => group?.includes(">Root Admin</p>"))).toBe(
      false,
    );
  });

  it("keeps root-only Users separate from Organization", () => {
    const groups = navigationGroups("admin");
    const admin = groups.find((group) => group?.includes(">Admin</p>"));
    const rootAdmin = groups.find((group) =>
      group?.includes(">Root Admin</p>"),
    );

    expect(admin).toContain('href="/organization"');
    expect(admin).not.toContain('href="/root/users"');
    expect(admin).not.toContain('href="/root/organizations"');
    expect(rootAdmin).toContain('href="/root/users"');
    expect(rootAdmin).toContain('href="/root/organizations"');
    expect(rootAdmin).not.toContain('href="/organization"');
    expect(rootAdmin).not.toContain('href="/admin"');
  });
});
