import { afterEach, describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountSettings } from "./AccountSettings";
import { saveDefaultOrganizationPreference } from "./accountSettingsApi";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("account settings", () => {
  it("saves the selected organization before refreshing the session", async () => {
    const events: string[] = [];
    const fetch = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.credentials).toBe("include");
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          organizationId: "org-two",
        });
        events.push("saved");
        return new Response(
          JSON.stringify({ defaultOrganizationId: "org-two" }),
        );
      },
    );
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    await saveDefaultOrganizationPreference("org-two", async () => {
      events.push("refreshed");
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["saved", "refreshed"]);
  });

  it("surfaces save errors without refreshing the session", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "Organization is unavailable." }, { status: 403 }),
    ) as unknown as typeof globalThis.fetch;
    const refresh = mock(async () => undefined);

    await expect(
      saveDefaultOrganizationPreference("org-two", refresh),
    ).rejects.toThrow("Organization is unavailable.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("disables the selector and save button when no organizations exist", () => {
    const markup = renderToStaticMarkup(
      <AccountSettings
        defaultOrganizationId={null}
        onNavigate={() => undefined}
        onSessionChanged={async () => undefined}
        organizations={[]}
        pathname="/account"
        twoFactorEnabled={false}
      />,
    );

    expect(markup).toContain("No organizations available</option>");
    expect(markup).toMatch(/<select[^>]*disabled=""/);
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*>Save changes<\/button>/,
    );
  });
});
