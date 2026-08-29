import tseslint from "typescript-eslint";
import {
  backfillBoundary,
  domainBoundary,
  exitCodeAtEntryPoint,
  mcpNoWrite,
} from "./eslint-rules/boundaries.js";

const pkePlugin = {
  rules: {
    "domain-boundary": domainBoundary,
    "mcp-no-write": mcpNoWrite,
    "backfill-boundary": backfillBoundary,
    "exit-code-at-entry-point": exitCodeAtEntryPoint,
  },
};

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".docker/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/domain/**/*.ts"],
    plugins: { pke: pkePlugin },
    rules: {
      "pke/domain-boundary": "error",
    },
  },
  {
    files: ["src/mcp/**/*.ts"],
    plugins: { pke: pkePlugin },
    rules: {
      "pke/mcp-no-write": "error",
    },
  },
  {
    files: ["src/**/*.ts", "src/cli.ts"],
    plugins: { pke: pkePlugin },
    rules: {
      "pke/backfill-boundary": "error",
      "pke/exit-code-at-entry-point": "error",
    },
  },
);
