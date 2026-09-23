import { describe, expect, it } from "bun:test";
import { apiUrl } from "./config";
import {
  createExpenseCategory,
  getExpenseReport,
  getFinanceData,
  setTransactionCategory,
} from "./financeApi";

describe("finance API", () => {
  it("loads the listing from the mounted route without a trailing slash", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl: string | undefined;
    globalThis.fetch = (async (input, init) => {
      requestedUrl = input.toString();
      expect(init?.credentials).toBe("include");
      return Response.json({
        accounts: [],
        configured: true,
        connections: [],
        transactions: [],
      });
    }) as typeof fetch;

    try {
      await getFinanceData();
      expect(requestedUrl).toBe(`${apiUrl}/api/finance`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("requests expense reports for a range, or all time without one", async () => {
    const requested = await captureRequests(async () => {
      await getExpenseReport({ from: "2026-08-01", to: "2026-08-31" });
      await getExpenseReport({ from: null, to: null });
      await getExpenseReport({ from: "2026-01-01", to: null });
    });
    expect(requested.map(({ url }) => url)).toEqual([
      `${apiUrl}/api/finance/reports/expenses?from=2026-08-01&to=2026-08-31`,
      `${apiUrl}/api/finance/reports/expenses`,
      `${apiUrl}/api/finance/reports/expenses?from=2026-01-01`,
    ]);
  });

  it("sets or clears a transaction's single category", async () => {
    const requested = await captureRequests(async () => {
      await setTransactionCategory("txn/1", "category-1");
      await setTransactionCategory("txn/1", null);
    });
    expect(requested).toEqual([
      {
        body: JSON.stringify({ categoryId: "category-1" }),
        method: "PUT",
        url: `${apiUrl}/api/finance/transactions/txn%2F1/category`,
      },
      {
        body: JSON.stringify({ categoryId: null }),
        method: "PUT",
        url: `${apiUrl}/api/finance/transactions/txn%2F1/category`,
      },
    ]);
  });

  it("surfaces the API's message when a category name is taken", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json(
        { error: "A category with that name exists." },
        { status: 409 },
      )) as unknown as typeof fetch;
    try {
      await expect(createExpenseCategory("Meals")).rejects.toThrow(
        "A category with that name exists.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function captureRequests(run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const requests: { body?: unknown; method?: string; url: string }[] = [];
  globalThis.fetch = (async (input, init) => {
    const request: { body?: unknown; method?: string; url: string } = {
      url: input.toString(),
    };
    if (init?.method) request.method = init.method;
    if (init?.body) request.body = init.body;
    requests.push(request);
    return Response.json({});
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return requests;
}
