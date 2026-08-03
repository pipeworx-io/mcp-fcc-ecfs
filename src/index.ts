interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */
const MAX_DETAIL = 300;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(`${name}: ${res.status}${detailSuffix(await readDetail(res))}`);
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  return `${name}: ${res.status}${detailSuffix(await readDetail(res))}`;
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an HTML page instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. First 120 chars: ${collapse(raw).slice(0, 120)}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `First 120 chars: ${collapse(raw).slice(0, 120)}`,
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  if (!raw) return '';

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) carries no API-level explanation, only markup that would crowd out
  // the status. Recognising it is worth more than stripping it: dropping it
  // keeps the message honest instead of filling it with `<!DOCTYPE html><html>`.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml')) return '';

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return collapse(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


/** FCC Electronic Comment Filing System public search and retrieval. */

const BASE = 'https://publicapi.fcc.gov/ecfs';
const MAX_BYTES = 4_000_000;
const keySchema = { type: 'string', description: 'Optional api.data.gov key for higher limits; defaults to DEMO_KEY.' };
const listSchema = (key: string) => ({
  type: 'object', properties: {
    returned: { type: 'number' }, [key]: { type: 'array', items: { type: 'object' } },
    source: { type: 'string' },
  }, required: ['returned', key, 'source'],
});

const tools: McpToolExport['tools'] = [
  {
    name: 'ecfs_search_filings',
    description: 'Search FCC ECFS filings using the public API full-text index. Returns filer/author, proceeding, submission type, dates, and official document links. Search matches are filings in the public record, not FCC findings or endorsements.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Full-text query, company, filer, author, or topic.' },
      limit: { type: 'number', description: 'Results (1-100, default 25).' },
      offset: { type: 'number', description: 'Pagination offset (default 0).' },
      _apiKey: keySchema,
    }, required: ['query'] },
    outputSchema: listSchema('filings'),
  },
  {
    name: 'ecfs_docket_filings',
    description: 'List FCC ECFS filings in an exact proceeding/docket, newest first, including documents and parties. A filing reflects the submitter’s position and is not an FCC decision.',
    inputSchema: { type: 'object', properties: {
      proceeding: { type: 'string', description: 'Exact docket/proceeding number, e.g. 11-42.' },
      limit: { type: 'number' }, offset: { type: 'number' }, _apiKey: keySchema,
    }, required: ['proceeding'] },
    outputSchema: listSchema('filings'),
  },
  {
    name: 'ecfs_filing_detail',
    description: 'Retrieve one FCC ECFS filing by submission ID with all public proceedings, filers, authors, law firms, status, and official document/attachment URLs.',
    inputSchema: { type: 'object', properties: {
      submission_id: { type: 'string' }, _apiKey: keySchema,
    }, required: ['submission_id'] },
    outputSchema: { type: 'object', properties: {
      submission_id: { type: 'string' }, proceedings: { type: 'array', items: { type: 'object' } },
      documents: { type: 'array', items: { type: 'object' } }, source_url: { type: 'string' },
    }, required: ['submission_id', 'proceedings', 'documents', 'source_url'] },
  },
  {
    name: 'ecfs_search_proceedings',
    description: 'Search FCC ECFS proceedings/dockets by exact number or public API query and return descriptions, bureau, dates, and docket links.',
    inputSchema: { type: 'object', properties: {
      proceeding: { type: 'string', description: 'Exact proceeding number.' },
      query: { type: 'string', description: 'Optional proceeding search text.' },
      limit: { type: 'number' }, offset: { type: 'number' }, _apiKey: keySchema,
    }},
    outputSchema: listSchema('proceedings'),
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const key = stringArg(args._apiKey) ?? 'DEMO_KEY';
  switch (name) {
    case 'ecfs_search_filings':
      return listFilings({ q: requiredString(args, 'query') }, args, key);
    case 'ecfs_docket_filings':
      return listFilings({ proceedings_name: normalizeProceeding(requiredString(args, 'proceeding')) }, args, key);
    case 'ecfs_filing_detail':
      return filingDetail(requiredString(args, 'submission_id'), key);
    case 'ecfs_search_proceedings':
      return listProceedings(args, key);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function listFilings(filters: Record<string, string>, args: Record<string, unknown>, key: string) {
  const payload = await ecfs('filings', {
    ...filters, limit: String(intArg(args.limit, 25, 1, 100)),
    offset: String(intArg(args.offset, 0, 0, 10_000)), sort: 'date_received,DESC', api_key: key,
  });
  const filings = Array.isArray(payload.filing) ? payload.filing.map(projectFiling) : [];
  return {
    returned: filings.length, filings,
    aggregations: compactAggregations(payload.aggregations),
    source: 'FCC Electronic Comment Filing System public API',
    interpretation: 'ECFS filings are submissions by outside parties or FCC offices in a public docket. Their presence, claims, and requested outcomes are not FCC findings, decisions, or endorsements.',
  };
}

async function filingDetail(id: string, key: string) {
  if (!/^\d{6,20}$/.test(id)) throw new Error('submission_id must contain 6-20 digits');
  const payload = await ecfs(`filings/${id}`, { api_key: key });
  return { ...projectFiling(payload), source: 'FCC Electronic Comment Filing System public API' };
}

async function listProceedings(args: Record<string, unknown>, key: string) {
  const proceeding = stringArg(args.proceeding);
  const query = stringArg(args.query);
  const payload = await ecfs('proceedings', compact({
    name: proceeding ? normalizeProceeding(proceeding) : null,
    q: query, limit: String(intArg(args.limit, 25, 1, 100)),
    offset: String(intArg(args.offset, 0, 0, 10_000)), api_key: key,
  }));
  const proceedings = Array.isArray(payload.proceeding) ? payload.proceeding.map(projectProceeding) : [];
  return { returned: proceedings.length, proceedings, source: 'FCC Electronic Comment Filing System public API' };
}

async function ecfs(path: string, params: Record<string, unknown>): Promise<Record<string, any>> {
  const url = new URL(`${BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) throw new Error('FCC ECFS API quota/authentication failure. Pass a free api.data.gov key via _apiKey for higher limits.');
    if (response.status === 404) throw new Error('FCC ECFS record was not found.');
    throw await httpError(response, 'FCC ECFS request failed');
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error('FCC ECFS response exceeded size limit');
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('FCC ECFS response exceeded size limit');
  return JSON.parse(text);
}

function projectFiling(r: Record<string, any>) {
  const id = String(r.id_submission ?? '');
  return compact({
    submission_id: id,
    submission_type: r.submissiontype?.description,
    date_received: iso(r.date_received), date_disseminated: iso(r.date_disseminated),
    status: r.filingstatus?.description, viewing_status: r.viewingstatus?.description,
    proceedings: (r.proceedings ?? []).map(projectProceeding),
    filers: (r.filers ?? []).map((x: any) => x.name).filter(Boolean),
    authors: (r.authors ?? []).map((x: any) => x.name).filter(Boolean),
    law_firms: (r.lawfirms ?? []).map((x: any) => x.name).filter(Boolean),
    presented_to: (r.presented_to ?? []).map((x: any) => x.name).filter(Boolean),
    documents: [...(r.documents ?? []), ...(r.attachments ?? [])].slice(0, 100).map((d: any) => compact({
      filename: d.filename, description: d.description, url: d.src,
    })),
    total_page_count: r.total_page_count,
    source_url: id ? `https://www.fcc.gov/ecfs/search/search-filings/filing/${id}` : null,
  });
}
function projectProceeding(r: Record<string, any>) {
  const name = String(r.name ?? '');
  return compact({
    proceeding: name, description: r.description_display || r.description,
    bureau_code: r.bureau_code, bureau_name: r.bureau_name,
    created_date: iso(r.created_date), closed_date: iso(r.date_closed),
    source_url: name ? `https://www.fcc.gov/ecfs/search/filings?proceedings_name=${encodeURIComponent(name)}` : null,
  });
}
function compactAggregations(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  return value;
}
function normalizeProceeding(value: string): string {
  const cleaned = value.trim().toUpperCase().replace(/^(GN|WC|WT|MB|EB|PS|RM|ET)\s+(DOCKET\s+)?(NO\.?\s*)?/i, '');
  if (!/^\d{2,4}-\d{1,5}$/.test(cleaned)) throw new Error('proceeding must look like 11-42 or 24-186');
  return cleaned;
}
function iso(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function requiredString(args: Record<string, unknown>, key: string): string { const v = stringArg(args[key]); if (!v) throw new Error(`${key} is required`); return v; }
function stringArg(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function intArg(value: unknown, fallback: number, min: number, max: number) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback; }
function compact<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== '' && (!Array.isArray(v) || v.length))) as T; }

export default { tools, callTool, meter: { credits: 3 } } satisfies McpToolExport;
