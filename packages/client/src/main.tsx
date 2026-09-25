import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@tearleads/ui/styles.css";
import { App } from "./App";
import "./styles/app.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
