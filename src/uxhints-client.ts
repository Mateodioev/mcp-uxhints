import TurndownService from "turndown";

const DEFAULT_BASE_URL = "https://uxhints.com/wp-json/wp/v2";
const USER_AGENT = "mcp-uxhints/1.0 (+https://uxhints.com)";
const REQUEST_TIMEOUT_MS = 15_000;

const CATEGORY_FIELDS = "id,name,slug,count";
const SUMMARY_FIELDS = "id,slug,link,date,modified,title,excerpt,categories";
const FULL_FIELDS = "id,slug,link,date,modified,title,content,categories";

/** Error raised for any failure while talking to the uxhints.com API. */
export class UXHintsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UXHintsError";
  }
}

// --- Raw WordPress REST shapes (subset returned by our _fields projections) ---

interface WPCategory {
  id: number;
  name: string;
  slug: string;
  count: number;
}

interface WPRendered {
  rendered: string;
}

interface WPPostSummary {
  id: number;
  slug: string;
  link: string;
  date: string;
  modified: string;
  title: WPRendered;
  excerpt: WPRendered;
  categories: number[];
}

interface WPPostFull extends WPPostSummary {
  content: WPRendered;
}

// --- Public shapes returned by the client ---

export interface Category {
  id: number;
  name: string;
  slug: string;
  count: number;
}

export interface HintSummary {
  id: number;
  title: string;
  slug: string;
  link: string;
  date: string;
  categories: string[];
}

export interface HintPage {
  hints: HintSummary[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface HintDetail {
  id: number;
  title: string;
  slug: string;
  link: string;
  date: string;
  modified: string;
  categories: string[];
  markdown: string;
}

export interface ListHintsOptions {
  category?: string;
  page?: number;
  perPage?: number;
}

/** Decode the HTML entities WordPress commonly emits (e.g. "Visual &amp; UI Design"), plus numeric refs. */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
  };
  return text.replace(
    /&(?:#(x?[0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (match, numeric: string | undefined, name: string | undefined) => {
      if (numeric !== undefined) {
        const code = numeric.toLowerCase().startsWith("x")
          ? Number.parseInt(numeric.slice(1), 16)
          : Number.parseInt(numeric, 10);
        return Number.isNaN(code) ? match : String.fromCodePoint(code);
      }
      return (name !== undefined && named[name]) || match;
    },
  );
}

/** Remove WordPress block editor comments such as `<!-- wp:paragraph -->` and `<!-- /wp:list -->`. */
function stripBlockComments(html: string): string {
  return html.replace(/<!--\s+\/?wp:[\s\S]*?-->/g, "");
}

function parseCountHeader(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Typed client for the public WordPress REST API of https://uxhints.com,
 * a catalog of bite-sized UX / product-design hints.
 */
export class UXHintsClient {
  private categoriesBySlug: Map<string, Category> | null = null;
  private readonly categoriesById = new Map<number, Category>();
  private readonly turndown: TurndownService;

  constructor(private readonly baseUrl: string = DEFAULT_BASE_URL) {
    this.turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
      linkStyle: "inlined",
      hr: "---",
    });
    this.turndown.remove(["script", "style", "noscript", "iframe"]);
  }

  /** All non-empty categories, most used first. */
  async listCategories(): Promise<Category[]> {
    const bySlug = await this.getCategoryMap();
    return [...bySlug.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    );
  }

  /** Paginated hints, optionally filtered by a category slug. */
  async listHints(options: ListHintsOptions = {}): Promise<HintPage> {
    const { page = 1, perPage = 10 } = options;
    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
      _fields: SUMMARY_FIELDS,
    });
    if (options.category !== undefined) {
      const slug = options.category.trim().toLowerCase();
      const category = (await this.getCategoryMap()).get(slug);
      if (!category) {
        throw new UXHintsError(
          `Unknown category slug "${options.category}". Run list_categories to see the valid slugs.`,
        );
      }
      params.set("categories", String(category.id));
    }
    const page1 = await this.fetchPostsPage(`/posts?${params.toString()}`);
    return { ...page1, page, perPage };
  }

  /** Full-text search over hint titles and content (native WordPress search). */
  async searchHints(query: string, page = 1, perPage = 10): Promise<HintPage> {
    const trimmed = query.trim();
    if (!trimmed) throw new UXHintsError("Search query must not be empty.");
    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
      search: trimmed,
      _fields: SUMMARY_FIELDS,
    });
    const result = await this.fetchPostsPage(`/posts?${params.toString()}`);
    return { ...result, page, perPage };
  }

  /** One hint by id, full content converted to Markdown. `null` when it does not exist. */
  async getHintById(id: number): Promise<HintDetail | null> {
    try {
      const { data: post } = await this.request<WPPostFull>(
        `/posts/${id}?_fields=${FULL_FIELDS}`,
      );
      return this.toDetail(post);
    } catch (err) {
      if (err instanceof UXHintsError && err.status === 404) return null;
      throw err;
    }
  }

  /** One hint by slug, full content converted to Markdown. `null` when no post matches. */
  async getHintBySlug(slug: string): Promise<HintDetail | null> {
    const { data: posts } = await this.request<WPPostFull[]>(
      `/posts?slug=${encodeURIComponent(slug)}&_fields=${FULL_FIELDS}`,
    );
    const post = posts[0];
    return post ? this.toDetail(post) : null;
  }

  /** A random hint from the catalog. `null` when the catalog is empty. */
  async getRandomHint(): Promise<HintDetail | null> {
    const { data: posts } = await this.request<Array<{ id: number }>>(
      "/posts?per_page=100&_fields=id",
    );
    if (posts.length === 0) return null;
    const pick = posts[Math.floor(Math.random() * posts.length)];
    return this.getHintById(pick.id);
  }

  private async fetchPostsPage(
    path: string,
  ): Promise<Omit<HintPage, "page" | "perPage">> {
    const { data, total, totalPages } = await this.request<WPPostSummary[]>(path);
    await this.getCategoryMap(); // make sure category names can be resolved
    return {
      hints: data.map((post) => this.toSummary(post)),
      total: total ?? data.length,
      totalPages: totalPages ?? 1,
    };
  }

  /**
   * Slug-to-category map, cached for the process lifetime (categories are static).
   * The id map also includes empty categories (e.g. "uncategorized") so post
   * category labels still resolve; only non-empty categories are listed.
   */
  private async getCategoryMap(): Promise<Map<string, Category>> {
    if (this.categoriesBySlug) return this.categoriesBySlug;
    const { data } = await this.request<WPCategory[]>(
      `/categories?per_page=100&_fields=${CATEGORY_FIELDS}&hide_empty=true`,
    );
    const bySlug = new Map<string, Category>();
    this.categoriesById.clear();
    for (const raw of data) {
      const category: Category = {
        id: raw.id,
        name: decodeEntities(raw.name),
        slug: raw.slug,
        count: raw.count,
      };
      this.categoriesById.set(category.id, category);
      // Defensive filter: hide_empty should already drop unused categories.
      if (category.count > 0) bySlug.set(category.slug, category);
    }
    this.categoriesBySlug = bySlug;
    return bySlug;
  }

  private categoryNames(ids: number[]): string[] {
    return ids.map((id) => this.categoriesById.get(id)?.name ?? `category #${id}`);
  }

  private toSummary(post: WPPostSummary): HintSummary {
    return {
      id: post.id,
      title: decodeEntities(post.title.rendered),
      slug: post.slug,
      link: post.link,
      date: post.date,
      categories: this.categoryNames(post.categories),
    };
  }

  private toDetail(post: WPPostFull): HintDetail {
    return {
      id: post.id,
      title: decodeEntities(post.title.rendered),
      slug: post.slug,
      link: post.link,
      date: post.date,
      modified: post.modified,
      categories: this.categoryNames(post.categories),
      markdown: this.htmlToMarkdown(post.content.rendered),
    };
  }

  private htmlToMarkdown(html: string): string {
    return this.turndown.turndown(stripBlockComments(html)).trim();
  }

  private async request<T>(
    path: string,
  ): Promise<{ data: T; total: number | null; totalPages: number | null }> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new UXHintsError(
          `Request to uxhints.com timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
        );
      }
      throw new UXHintsError(
        `Could not reach uxhints.com: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new UXHintsError(
        `uxhints.com responded with HTTP ${res.status} for ${path}.`,
        res.status,
      );
    }
    let data: T;
    try {
      data = (await res.json()) as T;
    } catch {
      throw new UXHintsError(
        `uxhints.com returned invalid JSON for ${path}.`,
        res.status,
      );
    }
    return {
      data,
      total: parseCountHeader(res.headers.get("x-wp-total")),
      totalPages: parseCountHeader(res.headers.get("x-wp-totalpages")),
    };
  }
}
