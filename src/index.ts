#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  UXHintsClient,
  UXHintsError,
  type HintDetail,
  type HintPage,
} from "./uxhints-client.js";

const client = new UXHintsClient();

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

// --- Tool registrations ---

server.registerTool(
  "list_categories",
  {
    title: "List categories",
    description:
      "List the hint categories on uxhints.com with hint counts and the slugs to filter list_hints with.",
  },
  async () => {
    try {
      const categories = await client.listCategories();
      if (categories.length === 0) {
        return textResult("No categories found on uxhints.com.");
      }
      const lines = categories.map(
        (c) =>
          `- **${c.name}** (slug: ${c.slug}) — ${c.count} hint${c.count === 1 ? "" : "s"}`,
      );
      return textResult(
        `Categories on uxhints.com (${categories.length}):\n\n${lines.join("\n")}`,
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
      "List UX hints from uxhints.com (id, title, slug, link, date, categories), optionally filtered by a category slug from list_categories. Includes total/totalPages for pagination.",
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
      const result = await client.listHints({
        category,
        page,
        perPage: per_page,
      });
      const context = category
        ? `category "${category}"`
        : "all categories";
      return textResult(formatHintPage(result, context));
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
      "Full-text search over uxhints.com hint titles and content (e.g. \"hick\", \"dark patterns\"). Same result shape and pagination as list_hints.",
    inputSchema: {
      query: z.string().min(1).describe("Search term(s)."),
      ...paginationShape,
    },
  },
  async ({ query, page, per_page }) => {
    try {
      const result = await client.searchHints(query, page, per_page);
      return textResult(formatHintPage(result, `search "${query}"`));
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
      "Get one uxhints.com hint by id or slug (exactly one is required), with the full content converted from WordPress HTML to clean Markdown.",
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
      const hint =
        id !== undefined ? await client.getHintById(id) : await client.getHintBySlug(slug!);
      if (!hint) return notFoundResult({ id, slug });
      return textResult(formatHintDetail(hint));
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
      "Get one random hint from uxhints.com, same shape as get_hint: full content converted to Markdown.",
  },
  async () => {
    try {
      const hint = await client.getRandomHint();
      if (!hint) {
        return errorResult(new UXHintsError("The uxhints.com catalog is empty."));
      }
      return textResult(formatHintDetail(hint));
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
