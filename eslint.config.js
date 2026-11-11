import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "legacy/**",
      "docs/**",
      ".claude/**",
      ".superpowers/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Módulos NestJS são classes vazias decoradas com @Module.
    rules: { "@typescript-eslint/no-extraneous-class": ["error", { allowWithDecorator: true }] },
  },
);
