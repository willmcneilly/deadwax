// Colours live only in theme.css, and an album's colours only reach the page
// through src/AlbumColours.tsx (RFC-002, "6. `DESIGN.md` starts here"). These
// run the app's own ESLint config (eslint.config.js) over small components, as
// if they were files in src, to prove the rule holds everywhere but there.

import { ESLint } from "eslint";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const app = resolve(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: app });

/** The colour rule's complaints about `code`, as if it were `file` in src. */
async function complaints(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${app}/src/${file}` });
  return result.messages
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message);
}

const HEX = `export default function Sleeve() {
  return <div style={{ color: "#1b1712" }} />;
}
`;
const FUNCTION = `export default function Sleeve({ alpha }: { alpha: number }) {
  return <div style={{ background: \`rgb(0 0 0 / \${alpha})\` }} />;
}
`;
const ALBUM = `export default function Sleeve({ ink }: { ink: string }) {
  return <div style={{ ["--album-ink" as string]: ink }} />;
}
`;
const ALBUM_KEY = `export default function Sleeve({ ink }: { ink: string }) {
  return <div style={{ "--album-ink": ink } as React.CSSProperties} />;
}
`;

describe("The colour rule", () => {
  // ESLint's first run loads the TypeScript parser, which can take more than
  // a test's 5 seconds while scripts/check runs everything else alongside.
  beforeAll(() => complaints("Warm.tsx", HEX), 60_000);

  it("rejects a colour in a style prop in any file but AlbumColours", async () => {
    expect(await complaints("Sleeve.tsx", HEX)).toEqual([
      expect.stringContaining("That's a colour written in the code."),
    ]);
    expect(await complaints("Sleeve.tsx", FUNCTION)).toEqual([
      expect.stringContaining("That's a colour written in the code."),
    ]);
    expect(await complaints("crate-spike/Spike.tsx", HEX)).toHaveLength(1);
  });

  it("rejects an album's colours set anywhere but AlbumColours", async () => {
    expect(await complaints("Sleeve.tsx", ALBUM_KEY)).toEqual([
      "An album's colours are set only by AlbumColours (src/AlbumColours.tsx).",
    ]);
    expect(await complaints("Crate.tsx", ALBUM)).toHaveLength(1);
  });

  it("allows colours in a style prop in AlbumColours.tsx", async () => {
    expect(await complaints("AlbumColours.tsx", HEX)).toEqual([]);
    expect(await complaints("AlbumColours.tsx", FUNCTION)).toEqual([]);
    expect(await complaints("AlbumColours.tsx", ALBUM_KEY)).toEqual([]);
  });
});
