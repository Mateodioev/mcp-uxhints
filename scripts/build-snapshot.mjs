// Regenerates catalog.snapshot.json from the live uxhints.com API.
// Run directly via `npm run sync:snapshot`: exits non-zero on failure.
// Run with --allow-stale (used by prepublishOnly): a sync failure prints a loud
// warning and exits 0, because a stale bundled snapshot is acceptable.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const allowStale = process.argv.includes("--allow-stale");
const snapshotPath = fileURLToPath(new URL("../catalog.snapshot.json", import.meta.url));

try {
  const { syncCatalog } = await import("../build/catalog.js");
  console.log("Fetching the live uxhints.com catalog...");
  const snapshot = await syncCatalog();
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(
    `catalog.snapshot.json written: ${snapshot.categories.length} categories, ` +
      `${snapshot.hints.length} hints, fetchedAt ${snapshot.fetchedAt}`,
  );
} catch (err) {
  if (allowStale) {
    console.error("==============================================================");
    console.error("WARNING: catalog snapshot sync FAILED. Continuing with the");
    console.error("existing (possibly stale) catalog.snapshot.json. The TTL-based");
    console.error("cache design tolerates a stale bundled snapshot.");
    console.error(`Cause: ${err instanceof Error ? err.message : String(err)}`);
    console.error("==============================================================");
    process.exit(0);
  }
  console.error(`sync:snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
