/**
 * SDK's `convertInteractive` flattens an interactive card by walking the
 * JSON tree (`walkCard`) and pulling text-bearing nodes. Three failure
 * modes we paper over here:
 *
 *   1. CardKit 2.0 webhook dual-publish. Feishu pushes v2 cards in webhook
 *      events as JSON with BOTH:
 *        - `elements`: a v1-shaped "请升级至最新版本客户端" fallback so
 *          older clients/SDKs aren't broken.
 *        - `user_dsl`: a JSON string containing the real schema 2.0 card.
 *      SDK only walks `elements`, so without intervention Claude sees the
 *      "please upgrade" downgrade. We pull `user_dsl` when present.
 *
 *   2. CardKit 2.0 API response. When `im.v1.message.get` is called with
 *      `card_msg_content_type=user_card_content` (SDK ≥ 1.65), the
 *      response's `body.content` IS the schema 2.0 DSL itself
 *      (`{schema:"2.0", body, config, header}`) — not wrapped in
 *      `user_dsl`. We detect by `schema:"2.0"` and inject as-is.
 *
 *   3. Zero-text v1 cards. Button-only / image-only / decorative cards
 *      have no text-bearing nodes; SDK collapses to the literal placeholder
 *      `[interactive card]` (lib/index.js:88951,88955). We fall back to the
 *      raw JSON so Claude can see the card structure.
 *
 * All branches wrap output in an `<interactive_card>` block. Claude is
 * taught in BRIDGE_SYSTEM_PROMPT not to echo the XML tag back to the user.
 */
export const INTERACTIVE_CARD_PLACEHOLDER = '[interactive card]';

export function expandInteractiveCard(
  flattenedContent: string,
  rawJsonContent: string | undefined,
): string {
  if (!rawJsonContent) return flattenedContent;

  const parsed = tryParseJson(rawJsonContent);

  // Branch 1: webhook v2 — `user_dsl` nested as a string. Prefer it over
  // `elements` (which would be the upgrade-fallback).
  if (parsed && typeof parsed.user_dsl === 'string' && parsed.user_dsl.trim().length > 0) {
    return `<interactive_card>\n${parsed.user_dsl}\n</interactive_card>`;
  }

  // Branch 2: API v2 — raw content already IS the schema 2.0 DSL.
  if (parsed && parsed.schema === '2.0') {
    return `<interactive_card>\n${rawJsonContent}\n</interactive_card>`;
  }

  // Branch 3: SDK collapsed a v1 card to placeholder (zero text-bearing
  // nodes). Substitute raw JSON so Claude can see the structure.
  if (flattenedContent === INTERACTIVE_CARD_PLACEHOLDER) {
    return `<interactive_card>\n${rawJsonContent}\n</interactive_card>`;
  }

  return flattenedContent;
}

function tryParseJson(s: string): { user_dsl?: unknown; schema?: unknown } | undefined {
  try {
    return JSON.parse(s) as { user_dsl?: unknown; schema?: unknown };
  } catch {
    return undefined;
  }
}

/**
 * Element tags whose `content` (or `text.content`) is human-readable copy
 * rather than layout. Mirrors the SDK's walkCard set plus `div`, which v1
 * cards use for their text blocks.
 */
const TEXT_TAGS = new Set(['markdown', 'plain_text', 'lark_md', 'div', 'text']);

/**
 * Reduce a CardKit card to the text a human sees.
 *
 * Alert cards are ~84% layout by weight (`element_id`, `text_align`,
 * `background_style`, column scaffolding). Feeding the raw JSON to the agent
 * spends tokens on nothing and dilutes the part that matters, so callers that
 * want the *content* of a card use this instead of {@link expandInteractiveCard}.
 *
 * Buttons keep their label and href — a "trace 详情" link is a lead the agent
 * can follow, not decoration. `config.summary` is skipped: it restates the
 * header. Returns `undefined` when the input isn't a card at all, so callers
 * can fall back to whatever the SDK flattened.
 */
export function extractCardText(rawJsonContent: string | undefined): string | undefined {
  if (!rawJsonContent) return undefined;
  const parsed = tryParseJson(rawJsonContent) as Record<string, unknown> | undefined;
  if (!parsed) return undefined;

  // Webhook v2 dual-publish: the real card hides in `user_dsl`, while
  // `elements` holds the "please upgrade" downgrade. Prefer the real one.
  if (typeof parsed.user_dsl === 'string' && parsed.user_dsl.trim()) {
    return extractCardText(parsed.user_dsl);
  }

  const out: string[] = [];
  collectText(parsed.header, out);
  collectText(parsed.body ?? parsed.elements, out);
  if (out.length === 0) return undefined;
  return out.join('\n');
}

function collectText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const el = node as Record<string, unknown>;

  const tag = typeof el.tag === 'string' ? el.tag : undefined;

  if (tag === 'button') {
    const label = textOf(el.text) ?? textOf(el.content);
    if (label) {
      const url = usefulUrl(el.url);
      out.push(url ? `[${label}](${url})` : label);
    }
    return;
  }

  // A text-bearing node contributes its own copy; anything else is a
  // container we walk through.
  if ((tag === undefined || TEXT_TAGS.has(tag)) && typeof el.content === 'string') {
    if (el.content.trim()) out.push(el.content);
  }
  const nested = textOf(el.text) ?? textOf(el.title);
  if (nested) out.push(nested);

  for (const key of ['elements', 'columns', 'rows', 'actions']) {
    if (key in el) collectText(el[key], out);
  }
}

/** Read `{tag, content}` (or a bare string) out of a text-ish field. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (!value || typeof value !== 'object') return undefined;
  const content = (value as Record<string, unknown>).content;
  return typeof content === 'string' && content.trim() ? content : undefined;
}

/**
 * Max button href length worth keeping. Past this, the href is almost always
 * the card's own text percent-encoded into a query param (alert platforms do
 * this for their "ask AI about this alert" buttons) — the agent already has
 * that content in readable form, and the link itself leads nowhere it needs
 * to go. Short hrefs are the opposite: a trace or dashboard link carries ids
 * the agent can act on.
 */
const MAX_BUTTON_URL_CHARS = 300;

function usefulUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (value.length > MAX_BUTTON_URL_CHARS) return undefined;
  return value;
}
