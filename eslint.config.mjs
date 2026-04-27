import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
  // Renderer files run in the browser with Electron preload bridge
  {
    files: ["renderer.js", "session-renderer.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        electronAPI: "readonly",
      },
    },
  },
  // Test files
  {
    files: ["test/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "eslint.config.mjs"],
  },
];
