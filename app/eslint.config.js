import js from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

// A hex colour or a colour function, anywhere in a string.
const colour = String.raw`/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i`;

export default defineConfig(
  { ignores: ["dist", "src-tauri"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },
  // No colour in an inline style: colours live only in src/theme.css
  // (stylelint covers the CSS files). Catches hex and colour functions in a
  // `style` prop, including in template literals, and an album's colours
  // (`--album-*`) set anywhere but AlbumColours.
  //
  // AlbumColours is the one exception (RFC-002, "6. `DESIGN.md` starts
  // here"): an album's colours come from its cover, so they're data, and it
  // sets them as CSS custom properties. scripts/colourLint.test.ts proves the rule
  // holds everywhere else.
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["src/AlbumColours.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `JSXAttribute[name.name='style'] :matches(Literal[value=${colour}], TemplateElement[value.raw=${colour}])`,
          message:
            "That's a colour written in the code. Use a CSS variable from src/theme.css (such as var(--ink)), or an album's colours through AlbumColours.",
        },
        {
          selector: `JSXAttribute[name.name='style'] :matches(Literal[value=/^--album-/], TemplateElement[value.raw=/^--album-/])`,
          message:
            "An album's colours are set only by AlbumColours (src/AlbumColours.tsx).",
        },
      ],
    },
  },
  // Every escape has to say why, after `--`.
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "@eslint-community/eslint-comments": comments },
    rules: { "@eslint-community/eslint-comments/require-description": "error" },
  },
);
