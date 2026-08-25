import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UXHintsClient,
  UXHintsError,
  type CatalogSnapshot,
} from "./uxhints-client.js";

/**
 * Three-layer catalog cache:
 *   1. user cache  — <os cache dir>/mcp-uxhints/catalog.json, refreshed when older than the TTL
 *   2. bundled snapshot — catalog.snapshot.json shipped with the package, seeds the user cache
 *   3. live API    — uxhints.com, last resort and the source of truth for refreshes
 *
 * `UXHINTS_NO_CACHE=1` bypasses all layers and hits the live API on every call.
 */

export type CatalogSource = "user-cache" | "bundled" | "live";

export interface CatalogResult {
  catalog: CatalogSnapshot;
  source: CatalogSource;
  stale: boolean;
}

export interface GetCatalogOptions {
  /** Test seam: override the WordPress API base URL (e.g. point at an unreachable host to force fallbacks). */
  baseUrl?: string;
}

const DEFAULT_TTL_HOURS = 24;
const USER_CACHE_FILENAME = "catalog.json";

/** Cache TTL in hours from `UXHINTS_CACHE_TTL_HOURS`; invalid values fall back to the default. */
export function cacheTtlHours(): number {
  const parsed = Number.parseFloat(process.env.UXHINTS_CACHE_TTL_HOURS ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_HOURS;
}

/** A catalog is fresh while `now - fetchedAt < ttl`. */
export function isFresh(snapshot: CatalogSnapshot, now: number = Date.now()): boolean {
  return now - Date.parse(snapshot.fetchedAt) < cacheTtlHours() * 3_600_000;
}

export function userCacheDir(): string {
  if (process.env.UXHINTS_CACHE_DIR) return process.env.UXHINTS_CACHE_DIR;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "mcp-uxhints");
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "mcp-uxhints", "Cache");
  }
  const xdgCacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(xdgCacheHome, "mcp-uxhints");
}

export function userCachePath(): string {
  return join(userCacheDir(), USER_CACHE_FILENAME);
}

/** catalog.snapshot.json sits at the package root, one level above this built file. */
function bundledSnapshotPath(): string {
  return fileURLToPath(new URL("../catalog.snapshot.json", import.meta.url));
}

/** Shape-check a parsed JSON file; anything unexpected is treated as "no cache". */
function parseSnapshot(raw: unknown): CatalogSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const snapshot = raw as CatalogSnapshot;
  if (
    typeof snapshot.fetchedAt !== "string" ||
    Number.isNaN(Date.parse(snapshot.fetchedAt)) ||
    !Array.isArray(snapshot.categories) ||
    !Array.isArray(snapshot.hints)
  ) {
    return null;
  }
  return snapshot;
}

export async function loadBundledSnapshot(): Promise<CatalogSnapshot | null> {
  try {
    return parseSnapshot(JSON.parse(await readFile(bundledSnapshotPath(), "utf8")));
  } catch {
    return null;
  }
}

export async function readUserCache(): Promise<CatalogSnapshot | null> {
  try {
    return parseSnapshot(JSON.parse(await readFile(userCachePath(), "utf8")));
  } catch {
    return null;
  }
}

export async function writeUserCache(snapshot: CatalogSnapshot): Promise<void> {
  const path = userCachePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

/** Fetch the whole live catalog. Never reads or writes any cache layer. */
export async function syncCatalog(options: GetCatalogOptions = {}): Promise<CatalogSnapshot> {
  const client = options.baseUrl ? new UXHintsClient(options.baseUrl) : new UXHintsClient();
  return client.fetchCatalog();
}

/** Single concise stderr line; stdout stays clean for the stdio transport. */
function logFallback(message: string): void {
  console.error(`mcp-uxhints: ${message}`);
}

function noCacheEnabled(): boolean {
  return process.env.UXHINTS_NO_CACHE === "1";
}

/**
 * Resolve the catalog following the layer chain:
 *   0. UXHINTS_NO_CACHE=1 -> live fetch, no cache reads or writes.
 *   1. fresh user cache    -> return it.
 *   2. missing user cache + fresh bundled snapshot -> copy into user cache, zero network.
 *   3. otherwise           -> live sync; success rewrites the user cache.
 *   4. live sync failure   -> stale user cache, else stale bundled snapshot, else throw.
 */
export async function getCatalog(options: GetCatalogOptions = {}): Promise<CatalogResult> {
  if (noCacheEnabled()) {
    const catalog = await syncCatalog(options);
    return { catalog, source: "live", stale: false };
  }

  const userCache = await readUserCache();
  if (userCache && isFresh(userCache)) {
    return { catalog: userCache, source: "user-cache", stale: false };
  }

  if (!userCache) {
    const bundled = await loadBundledSnapshot();
    if (bundled && isFresh(bundled)) {
      try {
        await writeUserCache(bundled);
      } catch {
        // Read-only install dirs are fine; the next lookup just re-reads the bundled file.
      }
      return { catalog: bundled, source: "bundled", stale: false };
    }
  }

  try {
    const catalog = await syncCatalog(options);
    try {
      await writeUserCache(catalog);
    } catch {
      // Failed writes degrade the cache to "always live" but must not break the call.
    }
    return { catalog, source: "live", stale: false };
  } catch (err) {
    if (userCache) {
      logFallback(
        `live sync failed, serving stale user cache from ${userCache.fetchedAt}`,
      );
      return { catalog: userCache, source: "user-cache", stale: true };
    }
    const bundled = await loadBundledSnapshot();
    if (bundled) {
      logFallback(
        `live sync failed, serving stale bundled snapshot from ${bundled.fetchedAt}`,
      );
      return { catalog: bundled, source: "bundled", stale: true };
    }
    throw err;
  }
}

/**
 * Force a live sync and rewrite the user cache. Throws on failure, leaving
 * every existing cache layer untouched.
 */
export async function refreshCatalog(options: GetCatalogOptions = {}): Promise<CatalogSnapshot> {
  try {
    const catalog = await syncCatalog(options);
    await writeUserCache(catalog);
    return catalog;
  } catch (err) {
    if (err instanceof UXHintsError) throw err;
    throw new UXHintsError(
      `Catalog refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
