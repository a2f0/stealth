import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FinanceView } from "./Finance";
import type { FinanceData } from "./financeApi";

const emptyData: FinanceData = {
  accounts: [],
  categories: [],
  configured: true,
  connections: [],
  transactions: [],
};

const populatedData: FinanceData = {
  ...emptyData,
  accounts: [
    {
      availableBalance: null,
      currencyCode: "USD",
      currentBalance: 100,
      id: "account-1",
      institutionName: "Bank",
      mask: "1234",
      name: "Checking",
      officialName: null,
      subtype: "checking",
      type: "depository",
    },
  ],
};

function renderFinance(
  data: FinanceData | undefined,
  options: { error?: string; notice?: string } = {},
) {
  return renderToStaticMarkup(
    <FinanceView
      busy={false}
      data={data}
      error={options.error}
      notice={options.notice}
      onAnnotate={async () => undefined}
      onCategorize={async () => undefined}
      onConnect={async () => undefined}
      onDeleteData={async () => undefined}
      onDisconnect={async () => undefined}
      onNavigate={() => undefined}
      onReload={async () => undefined}
      onSync={async () => undefined}
      page="overview"
    />,
  );
}

describe("Finance overview notices", () => {
  it("waits for account data before showing the account notice", () => {
    expect(renderFinance(undefined)).not.toContain("Before you add an account");
  });

  it("shows the account notice when there are no accounts", () => {
    expect(renderFinance(emptyData)).toContain("Before you add an account");
  });

  it("hides the account notice after an account is added", () => {
    expect(renderFinance(populatedData)).not.toContain(
      "Before you add an account",
    );
  });

  it("preserves setup, error, and success banners after an account is added", () => {
    const markup = renderFinance(
      { ...populatedData, configured: false },
      { error: "Could not sync", notice: "Account connected" },
    );

    expect(markup).not.toContain("Before you add an account");
    expect(markup).toContain("Plaid setup is incomplete");
    expect(markup).toContain("Could not sync");
    expect(markup).toContain("Account connected");
  });
});
