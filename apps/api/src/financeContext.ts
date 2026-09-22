import type { Context } from "hono";
import type { AuthVariables } from "./authMiddleware";
import type { Bindings } from "./types";

export type FinanceEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};

export type FinanceContext = Context<FinanceEnv>;
