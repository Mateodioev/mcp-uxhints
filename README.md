# mcp-uxhints

MCP (Model Context Protocol) server that exposes the [uxhints.com](https://uxhints.com) catalog of bite-sized UX and product-design hints as MCP tools over stdio. Content is fetched live from the site's public WordPress REST API and, for full hints, converted from WordPress HTML to clean Markdown.

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
| `search_hints` | Full-text search over hint titles and content. |
| `get_hint` | One hint by `id` or `slug` (exactly one), full content as Markdown. |
| `random_hint` | One random hint, full content as Markdown. |

Typical flow: `list_categories` → `list_hints` → `get_hint`. Slugs never include the category prefix (`occams-razor-law-in-ux-design`, not `ux-laws/occams-razor-law-in-ux-design`).

## Details

| Topic | Notes |
|---|---|
| Data source | Public WordPress REST API of uxhints.com (`/wp-json/wp/v2`) |
| Content format | WordPress HTML → Markdown (block comments stripped, entities decoded) |
| Caching | Category map kept in memory for the process lifetime |
| Resilience | 15 s request timeout; all failures surface as MCP tool errors, never crash the server |
| Scripts | `npm run build` (tsc), `npm start` (run the built server) |

## Credit

All content © [uxhints.com](https://uxhints.com) by **Paul Capcan**. This server only wraps the site's public API; it does not host or modify the content.
