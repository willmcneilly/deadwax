// Stylelint fails on a colour written directly in CSS. Project 1 has no
// DESIGN.md (RFC-001, open question 2): colours live only in the CSS variables
// in `src/theme.css`, the one file allowed raw colours.
//
// The escape, for a colour that has to stay (with the reason after `--`):
//   /* stylelint-disable-next-line <rule> -- <reason> */

const message = (what) =>
  `${what} is a colour written in the code. Use a CSS variable from src/theme.css (such as var(--ink)). ` +
  "If it has to stay, add /* stylelint-disable-next-line <rule> -- <reason> */.";

export default {
  // Every escape has to say why.
  reportDescriptionlessDisables: true,
  ignoreFiles: ["src/theme.css", "dist/**", "src-tauri/**", "node_modules/**"],
  rules: {
    "color-no-hex": [true, { message: (hex) => message(hex) }],
    "color-named": ["never", { message: (name) => message(name) }],
    // CSS function names ignore case, so match them that way.
    "function-disallowed-list": [
      ["/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/i"],
      { message: (fn) => message(`${fn}()`) },
    ],
  },
};
