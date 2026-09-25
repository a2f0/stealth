export const apiUrl = (
  import.meta.env.VITE_API_URL ?? "http://localhost:8787"
).replace(/\/$/, "");

export const websiteUrl = (
  import.meta.env.VITE_WEBSITE_URL ?? "https://tearleads.de"
).replace(/\/$/, "");
