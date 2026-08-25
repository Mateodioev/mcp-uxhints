#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getCatalog, refreshCatalog, type CatalogResult } from "./catalog.js";
import {
  UXHintsError,
  type CatalogHint,
  type CatalogSnapshot,
  type HintDetail,
  type HintPage,
  type HintSummary,
} from "./uxhints-client.js";

const server = new McpServer(
  {
    name: "mcp-uxhints",
    version: "1.0.0",
  },
  {
    instructions:
      "Browse the uxhints.com catalog of bite-sized UX and product-design hints. " +
      "Use list_categories to see the topics, list_hints or search_hints to find hints, " +
      "then get_hint (by id or slug) for the full content as Markdown. random_hint returns a surprise.",
  },
);

// --- Result formatting helpers ---

type TextResult = { content: Array<{ type: "text"; text: string }> };

function textResult(text: string): TextResult {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(err: unknown): TextResult & { isError: true } {
  const message =
    err instanceof UXHintsError
      ? err.message
      : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

function formatHintPage(page: HintPage, context: string): string {
  const header = `Hints (${context}) — page ${page.page} of ${page.totalPages} · ${page.total} total`;
  if (page.hints.length === 0) {
    return `${header}\n\nNo hints found. Try a different category or search term.`;
  }
  const items = page.hints.map((hint, index) => {
    const position = (page.page - 1) * page.perPage + index + 1;
    const categories = hint.categories.join(", ") || "uncategorized";
    return (
      `${position}. **${hint.title}** (${categories}) — ${formatDate(hint.date)}\n` +
      `   ${hint.link}\n` +
      `   slug: ${hint.slug} · id: ${hint.id}`
    );
  });
  const footer =
    page.page < page.totalPages
      ? `\n\nMore available: call again with page ${page.page + 1}.`
      : "";
  return `${header}\n\n${items.join("\n")}${footer}`;
}

function formatHintDetail(hint: HintDetail): string {
  const categories = hint.categories.join(", ") || "uncategorized";
  const updated =
    hint.modified && hint.modified !== hint.date
      ? ` (updated ${formatDate(hint.modified)})`
      : "";
  return [
    `# ${hint.title}`,
    "",
    `**Link:** ${hint.link}`,
    `**Published:** ${formatDate(hint.date)}${updated}`,
    `**Categories:** ${categories}`,
    "",
    "---",
    "",
    hint.markdown,
  ].join("\n");
}

function notFoundResult(args: { id?: number; slug?: string }): ReturnType<typeof errorResult> {
  const what =
    args.id !== undefined ? `id ${args.id}` : `slug "${args.slug ?? ""}"`;
  return errorResult(
    new UXHintsError(
      `No hint found with ${what}. ` +
        "Note: slugs do not include the category prefix (e.g. use \"occams-razor-law-in-ux-design\", not \"ux-laws/...\"). " +
        "Use search_hints or list_hints to discover valid hints.",
    ),
  );
}

/** Stale-cache notice appended to successful tool output when the data is not fresh. */
function withStaleNotice(text: string, result: CatalogResult): string {
  if (!result.stale) return text;
  return (
    `${text}\n\nShowing cached data last refreshed at ${result.catalog.fetchedAt} ` +
    "(offline or API unreachable)."
  );
}

// --- Catalog-to-view-model helpers ---

function categoryNamesById(catalog: CatalogSnapshot): Map<number, string> {
  return new Map(catalog.categories.map((c) => [c.id, c.name]));
}

function toSummary(hint: CatalogHint, names: Map<number, string>): HintSummary {
  return {
    id: hint.id,
    title: hint.title,
    slug: hint.slug,
    link: hint.link,
    date: hint.date,
    categories: hint.categoryIds.map((id) => names.get(id) ?? `category #${id}`),
  };
}

function toDetail(hint: CatalogHint, names: Map<number, string>): HintDetail {
  return {
    ...toSummary(hint, names),
    modified: hint.modified,
    markdown: hint.contentMarkdown,
  };
}

function paginate(
  hints: CatalogHint[],
  names: Map<number, string>,
  page: number,
  perPage: number,
): HintPage {
  const total = hints.length;
  return {
    hints: hints
      .slice((page - 1) * perPage, page * perPage)
      .map((hint) => toSummary(hint, names)),
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/** Case-insensitive, diacritic-insensitive normalization for local search. */
function normalizeForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

// --- Shared input schemas ---

const paginationShape = {
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("Page number, 1-based."),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe("Results per page (max 100)."),
};

const getHintShape = {
  id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Numeric post id of the hint (shown by list_hints / search_hints)."),
  slug: z
    .string()
    .min(1)
    .optional()
    .describe("Post slug of the hint, without category prefix."),
};

const getHintSchema = z
  .object(getHintShape)
  .refine((value) => (value.id === undefined) !== (value.slug === undefined), {
    message: "Provide exactly one of: id, slug.",
  });

const CACHE_NOTE =
  "Results are served from a local catalog cache (default 24h TTL); call refresh_hint_catalog to force an update.";

// --- Tool registrations ---

server.registerTool(
  "list_categories",
  {
    title: "List categories",
    description:
      "List the hint categories on uxhints.com with hint counts and the slugs to filter list_hints with. " +
      CACHE_NOTE,
  },
  async () => {
    try {
      const result = await getCatalog();
      const categories = result.catalog.categories;
      if (categories.length === 0) {
        return textResult("No categories found on uxhints.com.");
      }
      const lines = categories.map(
        (c) =>
          `- **${c.name}** (slug: ${c.slug}) — ${c.count} hint${c.count === 1 ? "" : "s"}`,
      );
      return textResult(
        withStaleNotice(
          `Categories on uxhints.com (${categories.length}):\n\n${lines.join("\n")}`,
          result,
        ),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "list_hints",
  {
    title: "List hints",
    description:
      "List UX hints from uxhints.com (id, title, slug, link, date, categories), optionally filtered by a category slug from list_categories. Includes total/totalPages for pagination. " +
      CACHE_NOTE,
    inputSchema: {
      category: z
        .string()
        .min(1)
        .optional()
        .describe("Category slug, e.g. \"ux-laws\". Omit to list all hints."),
      ...paginationShape,
    },
  },
  async ({ category, page, per_page }) => {
    try {
      const result = await getCatalog();
      const names = categoryNamesById(result.catalog);
      let hints = result.catalog.hints;
      if (category !== undefined) {
        const slug = category.trim().toLowerCase();
        const found = result.catalog.categories.find((c) => c.slug === slug);
        if (!found) {
          throw new UXHintsError(
            `Unknown category slug "${category}". Run list_categories to see the valid slugs.`,
          );
        }
        hints = hints.filter((hint) => hint.categoryIds.includes(found.id));
      }
      const context = category
        ? `category "${category}"`
        : "all categories";
      return textResult(
        withStaleNotice(formatHintPage(paginate(hints, names, page, per_page), context), result),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "search_hints",
  {
    title: "Search hints",
    description:
      "Local search over the cached uxhints.com catalog: case-insensitive and diacritic-insensitive substring matching over hint titles, excerpts, and full Markdown content. Title matches rank before content matches. Same result shape and pagination as list_hints. " +
      CACHE_NOTE,
    inputSchema: {
      query: z.string().min(1).describe("Search term(s)."),
      ...paginationShape,
    },
  },
  async ({ query, page, per_page }) => {
    try {
      const trimmed = query.trim();
      if (!trimmed) throw new UXHintsError("Search query must not be empty.");
      const needle = normalizeForSearch(trimmed);
      const result = await getCatalog();
      const names = categoryNamesById(result.catalog);
      const matches = result.catalog.hints
        .map((hint) => ({
          hint,
          titleHit: normalizeForSearch(hint.title).includes(needle),
          bodyHit:
            normalizeForSearch(hint.excerpt).includes(needle) ||
            normalizeForSearch(hint.contentMarkdown).includes(needle),
        }))
        .filter((match) => match.titleHit || match.bodyHit)
        .sort((a, b) => Number(b.titleHit) - Number(a.titleHit))
        .map((match) => match.hint);
      return textResult(
        withStaleNotice(
          formatHintPage(paginate(matches, names, page, per_page), `search "${query}"`),
          result,
        ),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "get_hint",
  {
    title: "Get a hint",
    description:
      "Get one uxhints.com hint by id or slug (exactly one is required), with the full content already converted from WordPress HTML to clean Markdown. " +
      CACHE_NOTE,
    inputSchema: getHintShape,
  },
  async (args) => {
    const parsed = getHintSchema.safeParse(args);
    if (!parsed.success) {
      return errorResult(
        new UXHintsError(parsed.error.issues.map((i) => i.message).join(" ")),
      );
    }
    const { id, slug } = parsed.data;
    try {
      const result = await getCatalog();
      const hint =
        id !== undefined
          ? result.catalog.hints.find((h) => h.id === id)
          : result.catalog.hints.find((h) => h.slug === slug);
      if (!hint) return notFoundResult({ id, slug });
      return textResult(
        withStaleNotice(formatHintDetail(toDetail(hint, categoryNamesById(result.catalog))), result),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "random_hint",
  {
    title: "Get a random hint",
    description:
      "Get one random hint from uxhints.com, same shape as get_hint: full content as Markdown. " +
      CACHE_NOTE,
  },
  async () => {
    try {
      const result = await getCatalog();
      if (result.catalog.hints.length === 0) {
        return errorResult(new UXHintsError("The uxhints.com catalog is empty."));
      }
      const hint =
        result.catalog.hints[Math.floor(Math.random() * result.catalog.hints.length)];
      return textResult(
        withStaleNotice(formatHintDetail(toDetail(hint, categoryNamesById(result.catalog))), result),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "refresh_hint_catalog",
  {
    title: "Refresh hint catalog",
    description:
      "Force a live sync of the uxhints.com catalog and rewrite the local cache, bypassing the TTL. Returns the new hint/category counts and fetch timestamp. On failure the existing caches stay untouched.",
  },
  async () => {
    try {
      const snapshot = await refreshCatalog();
      return textResult(
        `Catalog refreshed: ${snapshot.hints.length} hints in ${snapshot.categories.length} categories, fetched at ${snapshot.fetchedAt}.`,
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- Entry point ---

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-uxhints server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting mcp-uxhints:", err);
  process.exit(1);
});
