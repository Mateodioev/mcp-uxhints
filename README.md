# mcp-uxhints

MCP (Model Context Protocol) server that exposes the [uxhints.com](https://uxhints.com) catalog of bite-sized UX and product-design hints as MCP tools over stdio. Content comes from the site's public WordPress REST API (converted to clean Markdown), served through a local cache so tool calls are instant and work offline.

## Quick path

1. **Prerequisite:** Node.js 18 or newer.
2. **Install and build:**

   ```bash
   npm install && npm run build
   ```

3. **Register the server in your MCP client** (configs below) and restart the client.

### OpenCode

Add to `opencode.json`:

```json
{
  "mcp": {
    "mcp-uxhints": {
      "type": "local",
      "command": ["node", "/absolute/path/mcp-uxhints/build/index.js"],
      "enabled": true
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-uxhints": {
      "command": "node",
      "args": ["/absolute/path/mcp-uxhints/build/index.js"]
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `list_categories` | List all categories with slugs and hint counts. |
| `list_hints` | Paginated hint list, optionally filtered by category slug. |
| `search_hints` | Local search over title, excerpt and content; case- and diacritic-insensitive, title matches first. |
| `get_hint` | One hint by `id` or `slug` (exactly one), full content as Markdown. |
| `random_hint` | One random hint, full content as Markdown. |
| `refresh_hint_catalog` | Force a live sync and rewrite the local cache. |

Typical flow: `list_categories` → `list_hints` → `get_hint`. Slugs never include the category prefix (`occams-razor-law-in-ux-design`, not `ux-laws/occams-razor-law-in-ux-design`).

## Caching

Tool calls read from a local catalog cache (default TTL 24h) instead of hitting the API every time. Resolution order:

| Layer | Location | Role |
|---|---|---|
| 1. User cache | OS cache dir, `catalog.json` | Read first; refreshed when older than the TTL. |
| 2. Bundled snapshot | `catalog.snapshot.json` inside the package | Ships fresh at publish time; seeds the user cache with **zero network**. |
| 3. Live API | `uxhints.com` | Source of truth for refreshes; if it fails, stale caches are served with a notice in the output. |

Not fresh? Call `refresh_hint_catalog`, or wait for the TTL to expire. A `postinstall` hook warms the user cache automatically when the bundled snapshot has expired since publish.

| Env var | Default | Effect |
|---|---|---|
| `UXHINTS_CACHE_TTL_HOURS` | `24` | Hours a cached catalog counts as fresh (float; invalid values → 24). |
| `UXHINTS_CACHE_DIR` | OS cache dir¹ | Override where `catalog.json` lives. |
| `UXHINTS_NO_CACHE` | unset | Set to `1` to bypass all caching and call the live API on every tool call. |

¹ `~/.cache/mcp-uxhints` on Linux (honors `XDG_CACHE_HOME`), `~/Library/Caches/mcp-uxhints` on macOS, `%LOCALAPPDATA%\mcp-uxhints\Cache` on Windows.

## Details

| Topic | Notes |
|---|---|
| Data source | Public WordPress REST API of uxhints.com (`/wp-json/wp/v2`) |
| Content format | WordPress HTML → Markdown at sync time (block comments stripped, entities decoded) |
| Caching | 3 layers: user cache → bundled snapshot → live API (see above) |
| Resilience | 15 s request timeout; live failures fall back to stale caches; all failures surface as MCP tool errors, never crash the server |
| Scripts | `npm run build` (tsc), `npm run sync:snapshot` (regenerate the bundled snapshot), `npm start` (run the built server) |

## Credit

All content © [uxhints.com](https://uxhints.com) by **Paul Capcan**. This server only wraps the site's public API; it does not host or modify the content.
