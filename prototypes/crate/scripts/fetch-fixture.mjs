// Builds the prototype's fixture from the iTunes Search API: each album in
// albums.json gets its tracklist and two sizes of artwork, saved under public/.
// Run once with `npm run fixture`. The output is ignored by git.
//
// The iTunes API allows roughly 20 requests a minute, so requests are spaced
// out, and a 429 waits for its Retry-After.

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const coversDir = join(root, "public", "covers");
const dataDir = join(root, "public", "data");
const GAP_MS = 3200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function getJson(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 || res.status === 403) {
      const wait = Number(res.headers.get("retry-after") ?? 60) * 1000;
      console.log(`  rate limited, waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    await sleep(GAP_MS);
    return res.json();
  }
  throw new Error(`gave up on ${url}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, path) {
  if (await exists(path)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
}

const wanted = JSON.parse(await readFile(join(root, "scripts", "albums.json"), "utf8"));
await mkdir(coversDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

const out = [];
for (const want of wanted) {
  console.log(`${want.artist} — ${want.title}`);
  const term = encodeURIComponent(`${want.artist} ${want.title}`);
  const search = await getJson(
    `https://itunes.apple.com/search?term=${term}&entity=album&limit=25&country=gb`,
  );
  // The album itself: right artist, title contains what we asked for, and not
  // a single, live record, instrumental or remix version.
  const candidates = search.results.filter(
    (r) =>
      norm(r.artistName).includes(norm(want.artist).slice(0, 8)) &&
      norm(r.collectionName).includes(norm(want.title)) &&
      !/single|instrumental|remix|live|karaoke|tribute|acapella/i.test(
        r.collectionName.replace(want.title, ""),
      ),
  );
  // Prefer the plain album over deluxe editions and anniversary reissues.
  const pick = candidates.sort((a, b) => a.collectionName.length - b.collectionName.length)[0];
  if (!pick) {
    console.log("  not found, skipping");
    continue;
  }

  const lookup = await getJson(
    `https://itunes.apple.com/lookup?id=${pick.collectionId}&entity=song&country=gb`,
  );
  const tracks = lookup.results
    .filter((r) => r.wrapperType === "track")
    .map((r) => ({
      disc: r.discNumber,
      number: r.trackNumber,
      title: r.trackName,
      durationMs: r.trackTimeMillis,
    }))
    .sort((a, b) => a.disc - b.disc || a.number - b.number);

  const id = String(pick.collectionId);
  const art = pick.artworkUrl100;
  await download(art.replace("100x100bb", "600x600bb"), join(coversDir, `${id}-sm.jpg`));
  await download(art.replace("100x100bb", "1500x1500bb"), join(coversDir, `${id}-lg.jpg`));

  out.push({
    id,
    genre: want.genre,
    title: pick.collectionName,
    artist: pick.artistName,
    year: Number(pick.releaseDate?.slice(0, 4)) || null,
    label: pick.copyright ?? null,
    tracks,
  });
}

await writeFile(join(dataDir, "albums.json"), JSON.stringify(out, null, 2));
console.log(`\nWrote ${out.length} albums.`);
