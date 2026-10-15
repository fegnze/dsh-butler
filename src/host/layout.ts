import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Stored card-order sections shared with the browser console. */
export const LAYOUT_SECTIONS = ['services', 'tools'] as const;
/** Sections an older layout.json may still carry. Accepted (and ignored by the
 * browser) so that file keeps loading; workflows became a live run feed. */
const LEGACY_SECTIONS = ['workflows'];
export const LAYOUT_VERSION = 1;
export const MAX_IDS_PER_SECTION = 64;
export const MAX_ID_LENGTH = 64;
export const MAX_BODY_BYTES = 32 * 1024;

const EMPTY = { version: LAYOUT_VERSION, order: {} } as const;

type LayoutValue = { version: number; order: Record<string, string[]>; display?: Record<string, { mode: 'all' | 'resident'; stored: string[] }> };

/** Create the local layout preference route for one Butler state directory. */
export function createLayoutHandler(stateDir: string): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const layoutFile = join(stateDir, 'layout.json');
  return async function layout(request, response) {
    if (request.method === 'GET') {
      try {
        const value = JSON.parse(await readFile(layoutFile, 'utf8')) as unknown;
        const problem = layoutProblem(value);
        if (problem) return fail(response, 500, problem);
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify(value));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify(EMPTY));
          return;
        }
        return fail(response, 500, error instanceof SyntaxError ? `layout.json is not JSON: ${error.message}` : String((error as Error)?.message ?? error));
      }
      return;
    }
    if (request.method !== 'PUT') {
      methodNotAllowed(response, ['GET', 'PUT']);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse((await readBody(request)) || '{}');
    } catch (error) {
      fail(response, 400, String((error as Error)?.message ?? error));
      return;
    }
    const problem = layoutProblem(value);
    if (problem) {
      fail(response, 400, problem);
      return;
    }
    const temp = `${layoutFile}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(temp, JSON.stringify(value), 'utf8');
      await rename(temp, layoutFile);
    } catch (error) {
      fail(response, 500, String((error as Error)?.message ?? error));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  };
}

function layoutProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'expected an object';
  const candidate = value as Partial<LayoutValue>;
  if (candidate.version !== LAYOUT_VERSION) return `expected version ${LAYOUT_VERSION}`;
  if (!candidate.order || typeof candidate.order !== 'object' || Array.isArray(candidate.order)) return 'expected an order object';
  for (const key of Object.keys(candidate.order)) {
    if (!(LAYOUT_SECTIONS as readonly string[]).includes(key) && !LEGACY_SECTIONS.includes(key)) return `layout.json is not a layout: unknown section ${key}`;
    const ids = candidate.order[key];
    if (!Array.isArray(ids) || ids.length > MAX_IDS_PER_SECTION) return `layout.json is not a layout: invalid section ${key}`;
    if (ids.some((id) => typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH)) return `layout.json is not a layout: invalid id in ${key}`;
    if (new Set(ids).size !== ids.length) return `layout.json is not a layout: duplicate id in ${key}`;
  }
  if (candidate.display !== undefined) {
    if (!candidate.display || typeof candidate.display !== 'object' || Array.isArray(candidate.display)) return 'expected a display object';
    for (const [key, entry] of Object.entries(candidate.display)) {
      if (!(LAYOUT_SECTIONS as readonly string[]).includes(key)) return `unknown display section ${key}`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !['all', 'resident'].includes(entry.mode)) return `invalid display mode in ${key}`;
      if (Object.keys(entry).some(field => !['mode', 'stored'].includes(field))) return `unknown display preference in ${key}`;
      const ids = entry.stored;
      if (!Array.isArray(ids) || ids.length > MAX_IDS_PER_SECTION || ids.some(id => typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH) || new Set(ids).size !== ids.length) return `invalid stored ids in ${key}`;
    }
  }
  return null;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function fail(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: message }));
}

function methodNotAllowed(response: ServerResponse, allowed: string[]): void {
  response.writeHead(405, { 'content-type': 'application/json', allow: allowed.join(', ') });
  response.end(JSON.stringify({ error: `method not allowed; expected ${allowed.join(' or ')}` }));
}
