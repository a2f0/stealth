/*
 * Product facts shared by the marketing site and the client, so pricing and
 * legal navigation never drift between the two.
 */
export const productName = "Tearleads";

export const legalLinks = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/data-retention", label: "Data retention" },
] as const;

export interface Plan {
  cadence: string;
  description: string;
  features: readonly string[];
  id: "free" | "pro";
  name: string;
  price: string;
}

export const plans = [
  {
    cadence: "per month",
    description: "For one person getting their checklists in order.",
    features: ["1 user", "5 form templates", "30-day audit history"],
    id: "free",
    name: "Free",
    price: "$0",
  },
  {
    cadence: "per user / month",
    description: "For teams that audit together and keep every record.",
    features: [
      "Unlimited form templates",
      "Unlimited audit history",
      "Seats stay in sync with your team",
    ],
    id: "pro",
    name: "Pro",
    price: "$10",
  },
] as const satisfies readonly Plan[];
