interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
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
    throw new Error(`FCC ECFS request failed (${response.status})`);
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
