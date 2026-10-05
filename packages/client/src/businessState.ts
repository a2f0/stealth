import type { Business, BusinessListing } from "./businessesApi";

export function formatEin(ein: string) {
  return /^\d{9}$/.test(ein) ? `${ein.slice(0, 2)}-${ein.slice(2)}` : ein;
}

export function formatDuns(duns: string) {
  return /^\d{9}$/.test(duns)
    ? `${duns.slice(0, 2)}-${duns.slice(2, 5)}-${duns.slice(5)}`
    : duns;
}

/** The identifiers a business row offers to copy, as the notice names them. */
export type BusinessIdentifier = "DUNS number" | "EIN";

export function formatBusinessDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(date);
}

/** One line: street, then city with state and ZIP; blank parts are skipped. */
export function formatBusinessAddress(
  business: Pick<Business, "city" | "state" | "streetAddress" | "zip">,
) {
  const region = [business.state, business.zip].filter(Boolean).join(" ");
  const location = [business.city, region].filter(Boolean).join(", ");
  return [business.streetAddress, location].filter(Boolean).join(", ");
}

export interface BusinessListState {
  /** The add form was opened on demand while businesses already exist. */
  adding: boolean;
  data: BusinessListing | undefined;
  error: string | undefined;
  loading: boolean;
  notice: string | undefined;
}

export type BusinessListEvent =
  | { type: "loadStarted" }
  | { type: "loaded"; data: BusinessListing }
  | { type: "loadFailed"; message: string }
  | { type: "addOpened" }
  | { type: "addCancelled" }
  | { type: "created"; business: Business }
  | { type: "updated"; business: Business }
  | { type: "deleted"; id: string }
  | { type: "copied"; identifier: BusinessIdentifier }
  | { type: "failed"; message: string };

export const initialBusinessListState: BusinessListState = {
  adding: false,
  data: undefined,
  error: undefined,
  loading: true,
  notice: undefined,
};

function withBusinesses(
  state: BusinessListState,
  change: (businesses: Business[]) => Business[],
  notice: string,
): BusinessListState {
  return {
    ...state,
    data: state.data
      ? { ...state.data, businesses: change(state.data.businesses) }
      : state.data,
    error: undefined,
    notice,
  };
}

/**
 * The business list page's transitions. A created business folds the on-demand
 * add form away again; a failure leaves it open with the entered values.
 */
export function businessListReducer(
  state: BusinessListState,
  event: BusinessListEvent,
): BusinessListState {
  switch (event.type) {
    case "loadStarted":
      return { ...state, error: undefined, loading: true };
    case "loaded":
      return { ...state, data: event.data, loading: false };
    case "loadFailed":
      return { ...state, error: event.message, loading: false };
    case "addOpened":
      return { ...state, adding: true };
    case "addCancelled":
      return { ...state, adding: false };
    case "created":
      return {
        ...withBusinesses(
          state,
          (businesses) => [event.business, ...businesses],
          "Business added.",
        ),
        adding: false,
      };
    case "updated":
      return withBusinesses(
        state,
        (businesses) =>
          businesses.map((business) =>
            business.id === event.business.id ? event.business : business,
          ),
        "Business updated.",
      );
    case "deleted":
      return withBusinesses(
        state,
        (businesses) =>
          businesses.filter((business) => business.id !== event.id),
        "Business deleted.",
      );
    case "failed":
      return { ...state, error: event.message, notice: undefined };
    case "copied":
      return {
        ...state,
        error: undefined,
        notice: `${event.identifier} copied.`,
      };
  }
}
