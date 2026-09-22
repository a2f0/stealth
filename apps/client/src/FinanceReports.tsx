import {
  Banner,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  LoadingState,
  PageSection,
} from "@tearleads/ui/react";
import { useEffect, useState } from "react";
import {
  type ExpenseCategoryTotal,
  type ExpenseReport,
  type ExpenseReportCurrency,
  getExpenseReport,
} from "./financeApi";
import { formatMoney } from "./financeFormat";
import {
  categoryShare,
  presetRange,
  type ReportPreset,
  type ReportRange,
  reportPresets,
} from "./financePages";
import { countLabel } from "./labels";

export function FinanceReports({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const [preset, setPreset] = useState<ReportPreset>("this-month");
  const [custom, setCustom] = useState<ReportRange>(() =>
    presetRange("this-month", new Date()),
  );
  const range = preset === "custom" ? custom : presetRange(preset, new Date());
  const invalid = Boolean(range.from && range.to && range.from > range.to);
  const report = useExpenseReport(range, invalid);

  return (
    <PageSection
      description="Spending by expense category. Each transaction counts toward at most one category."
      title="Expenses"
    >
      <ReportControls
        custom={custom}
        invalid={invalid}
        onCustom={setCustom}
        onPreset={setPreset}
        preset={preset}
      />
      <ReportContent onNavigate={onNavigate} range={range} {...report} />
      <p className="financeReportNote">
        Totals include posted transactions only. Refunds assigned to a category
        reduce its total. Transfers and loan or card payments are left out
        unless you assign them a category, so money moved between your own
        accounts isn’t counted twice.
      </p>
    </PageSection>
  );
}

function useExpenseReport(range: ReportRange, invalid: boolean) {
  const [report, setReport] = useState<ExpenseReport>();
  const [error, setError] = useState<string>();
  const { from, to } = range;
  useEffect(() => {
    if (invalid) return;
    let current = true;
    setReport(undefined);
    setError(undefined);
    getExpenseReport({ from, to })
      .then((next) => {
        if (current) setReport(next);
      })
      .catch((cause: unknown) => {
        if (current) {
          setError(
            cause instanceof Error ? cause.message : "Could not load report.",
          );
        }
      });
    return () => {
      current = false;
    };
  }, [from, invalid, to]);
  return { error, report };
}

function ReportControls({
  custom,
  invalid,
  onCustom,
  onPreset,
  preset,
}: {
  custom: ReportRange;
  invalid: boolean;
  onCustom: (range: ReportRange) => void;
  onPreset: (preset: ReportPreset) => void;
  preset: ReportPreset;
}) {
  return (
    <div className="financeReportControls">
      <fieldset className="segmented">
        <legend className="srOnly">Report period</legend>
        {reportPresets.map((item) => (
          <button
            aria-pressed={preset === item.preset}
            key={item.preset}
            onClick={() => onPreset(item.preset)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </fieldset>
      {preset === "custom" && (
        <div className="financeReportDates">
          <Field label="From">
            <input
              aria-invalid={invalid || undefined}
              className="input inputSm"
              onChange={(event) =>
                onCustom({ ...custom, from: event.target.value || null })
              }
              type="date"
              value={custom.from ?? ""}
            />
          </Field>
          <Field label="To">
            <input
              aria-invalid={invalid || undefined}
              className="input inputSm"
              onChange={(event) =>
                onCustom({ ...custom, to: event.target.value || null })
              }
              type="date"
              value={custom.to ?? ""}
            />
          </Field>
          {invalid && (
            <p className="fieldError" role="alert">
              Choose a start date on or before the end date.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ReportContent({
  error,
  onNavigate,
  range,
  report,
}: {
  error: string | undefined;
  onNavigate: (pathname: string) => void;
  range: ReportRange;
  report: ExpenseReport | undefined;
}) {
  if (error) return <Banner tone="danger">{error}</Banner>;
  if (!report) return <LoadingState label="Totalling expenses…" />;
  if (!report.currencies.length) {
    return (
      <EmptyState icon="finance" title="No expenses in this period">
        Choose a longer period, or connect and sync a bank account.
      </EmptyState>
    );
  }
  const multiple = report.currencies.length > 1;
  return (
    <div className="stack stackLg">
      {report.currencies.map((currency) => (
        <CurrencyReport
          currency={currency}
          key={currency.currency}
          onNavigate={onNavigate}
          rangeLabel={rangeLabel(range)}
          showCurrency={multiple}
        />
      ))}
    </div>
  );
}

function CurrencyReport({
  currency,
  onNavigate,
  rangeLabel,
  showCurrency,
}: {
  currency: ExpenseReportCurrency;
  onNavigate: (pathname: string) => void;
  rangeLabel: string;
  showCurrency: boolean;
}) {
  const [showEmpty, setShowEmpty] = useState(false);
  const code = currency.currency || null;
  const active = currency.categories.filter((item) => item.transactionCount);
  const empty = currency.categories.filter((item) => !item.transactionCount);
  const excluded = currency.excludedTransfers;
  // Bars compare gross spending, so refunds and credits can't hide them.
  const spending = currency.categories.reduce(
    (sum, item) => sum + Math.max(item.total, 0),
    0,
  );
  return (
    <Card
      className="financeReportCard"
      description={`${countLabel(currency.transactionCount, "transaction")} · ${rangeLabel}`}
      flush
      footer={
        (excluded.transactionCount > 0 || empty.length > 0) && (
          <ReportFooter
            currency={code}
            empty={empty.length}
            excluded={excluded}
            onToggleEmpty={() => setShowEmpty(!showEmpty)}
            showEmpty={showEmpty}
          />
        )
      }
      title={
        <span className="financeReportTotal">
          <span className="financeReportTotalLabel">
            {showCurrency
              ? `Total expenses · ${currency.currency || "Unspecified currency"}`
              : "Total expenses"}
          </span>
          <span
            className={cx(
              "financeReportTotalAmount",
              currency.total < 0 && "financeAmountCredit",
            )}
          >
            {formatMoney(currency.total, code)}
          </span>
        </span>
      }
    >
      <ul aria-label="Expenses by category" className="rowList">
        {[...active, ...(showEmpty ? empty : [])].map((item) => (
          <CategoryTotalRow
            currency={code}
            spending={spending}
            item={item}
            key={item.id ?? "uncategorized"}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    </Card>
  );
}

function CategoryTotalRow({
  currency,
  item,
  onNavigate,
  spending,
}: {
  currency: string | null;
  item: ExpenseCategoryTotal;
  onNavigate: (pathname: string) => void;
  spending: number;
}) {
  const share = categoryShare(item.total, spending);
  return (
    <li className="row financeReportRow">
      <div className="rowMain">
        <span className="rowTitle">{item.name}</span>
        <span className="rowMeta">
          {countLabel(item.transactionCount, "transaction")}
          {share > 0 && ` · ${Math.round(share)}%`}
          {item.id === null && (
            <>
              {" · "}
              <button
                className="button buttonLink"
                onClick={() => onNavigate("/finance")}
                type="button"
              >
                Categorize
              </button>
            </>
          )}
        </span>
      </div>
      <span
        className={cx("financeAmount", item.total < 0 && "financeAmountCredit")}
      >
        {formatMoney(item.total, currency)}
      </span>
      <span aria-hidden="true" className="financeReportBar">
        <span style={{ width: `${share}%` }} />
      </span>
    </li>
  );
}

function ReportFooter({
  currency,
  empty,
  excluded,
  onToggleEmpty,
  showEmpty,
}: {
  currency: string | null;
  empty: number;
  excluded: ExpenseReportCurrency["excludedTransfers"];
  onToggleEmpty: () => void;
  showEmpty: boolean;
}) {
  return (
    <>
      <span className="textSm textSubtle">
        {excluded.transactionCount > 0 &&
          `Excluded transfers and payments: ${formatMoney(excluded.total, currency)} across ${countLabel(excluded.transactionCount, "transaction")}.`}
      </span>
      {empty > 0 && (
        <Button onClick={onToggleEmpty} size="sm" variant="ghost">
          {showEmpty
            ? "Hide categories with no spending"
            : `Show ${countLabel(empty, "category", "categories")} with no spending`}
        </Button>
      )}
    </>
  );
}

function rangeLabel(range: ReportRange) {
  const format = (value: string) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(`${value}T12:00:00`),
    );
  if (range.from && range.to) {
    return `${format(range.from)} – ${format(range.to)}`;
  }
  if (range.from) return `Since ${format(range.from)}`;
  if (range.to) return `Through ${format(range.to)}`;
  return "All time";
}
