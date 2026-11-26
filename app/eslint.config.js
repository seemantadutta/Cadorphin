import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src-tauri"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: { ecmaVersion: 2020, globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The UI must not depend on Tauri directly, so a browser-based backend can replace it later.
      // Only src/backend/ may import @tauri-apps/* (see docs/architecture.md).
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tauri-apps/*"],
              message: "Only files in src/backend/ may import @tauri-apps. Use the Backend interface via useBackend().",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/backend/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": "off" },
  },
);
