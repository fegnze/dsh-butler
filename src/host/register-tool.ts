import { lstat, mkdir, readFile, readlink, realpath, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { ButlerConfig } from './config.ts';

/**
 * Register a tool by its directory.
 *
 * A tool is not something the console configures: it is a directory carrying
 * the conventional `butler.json` (kind=tool). Registering one only makes the
 * normal scan see it. A directory already under the tools scan root needs
 * nothing but a rescan; one elsewhere is linked in as `tools/<id>` so the
 * manifest stays where the tool lives and there is still one registry: the scan.
 *
 * Services are different (the Host writes their manifest: command, port…);
 * that path stays in routes.ts.
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface RegisteredTool { id: string; name: string; linked: boolean }

function toolsRoot(config: ButlerConfig): string {
  const root = config.scanRoots.find((candidate) => basename(candidate) === 'tools');
  if (!root) throw new Error('未配置 tools 扫描目录');
  return resolve(root);
}

/**
 * @param config - Butler work directory configuration.
 * @param input - absolute (or `~/`) path of the tool directory.
 * @returns the tool id/name and whether a link was created.
 */
export async function registerToolDir(config: ButlerConfig, input: string): Promise<RegisteredTool> {
  const raw = typeof input === 'string' ? input.trim() : '';
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  if (!expanded || !isAbsolute(expanded)) throw new Error('目录必须是绝对路径（可用 ~/ 开头）');
  let dir: string;
  try { dir = await realpath(expanded); } catch { throw new Error(`目录不存在：${expanded}`); }
  if (!(await lstat(dir)).isDirectory()) throw new Error(`不是目录：${dir}`);

  let text: string;
  try { text = await readFile(join(dir, 'butler.json'), 'utf8'); } catch { throw new Error(`目录下没有 butler.json：${dir}`); }
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(text) as Record<string, unknown>; } catch (error) { throw new Error(`butler.json 不是合法 JSON：${(error as Error).message}`); }
  if (manifest.schemaVersion !== 1) throw new Error('butler.json 需要 schemaVersion=1');
  if (manifest.kind !== 'tool') throw new Error(`butler.json 的 kind 必须是 tool，得到 ${String(manifest.kind)}`);
  const id = manifest.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error(`butler.json 的 id 无效：${String(id)}`);
  const name = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name : '';
  if (!name) throw new Error('butler.json 缺少 name');

  const root = toolsRoot(config);
  const realRoot = await realpath(root).catch(() => root);
  const rel = relative(realRoot, dir);
  // Already inside the scan root (directly): the scan will find it as is.
  if (rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('/')) return { id, name, linked: false };

  const link = join(root, id);
  const existing = await lstat(link).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink() && resolve(root, await readlink(link)) === dir) return { id, name, linked: false };
    throw new Error(`tools/${id} 已存在，不覆盖`);
  }
  await mkdir(root, { recursive: true });
  await symlink(dir, link, 'dir');
  return { id, name, linked: true };
}
