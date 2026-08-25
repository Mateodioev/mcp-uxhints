// Best-effort cache warm-up after install. NEVER exits non-zero.
// If the bundled snapshot is expired (package published more than the TTL ago),
// sync the live catalog into the user cache so the first tool call is fresh.
// Anything failing (missing build, no network, read-only fs) is silently ignored.

async function warmUpIfExpired() {
  if (process.env.UXHINTS_NO_CACHE === "1") return;

  const catalog = await import("../build/catalog.js").catch(() => null);
  if (!catalog) return; // source checkout without a build; prepare will produce one

  const bundled = await catalog.loadBundledSnapshot();
  if (!bundled || catalog.isFresh(bundled)) return;

  const userCache = await catalog.readUserCache();
  if (userCache && catalog.isFresh(userCache)) return;

  const snapshot = await catalog.syncCatalog();
  await catalog.writeUserCache(snapshot);
  console.error("mcp-uxhints: bundled snapshot was stale; user cache warmed from the live API.");
}

try {
  await warmUpIfExpired();
} catch {
  // Silent by design: a failed warm-up must never break npm install.
}
process.exit(0);
