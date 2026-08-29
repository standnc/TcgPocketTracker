import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "screenshots/**", "deploy/mcpb/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
