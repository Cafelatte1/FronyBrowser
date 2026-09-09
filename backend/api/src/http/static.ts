/**
 * frontend/dist 정적 서빙. GET 전용, 디렉토리 탈출 차단.
 * frontend는 backend를 import하지 않는다 — 이 경로가 유일한 접점이다.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export function serveStatic(rootDir: string, urlPath: string, res: ServerResponse): boolean {
  const root = resolve(rootDir);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const path = resolve(root, rel);
  if (!path.startsWith(root)) return false;
  if (!existsSync(path) || !statSync(path).isFile()) return false;

  const type = MIME[extname(path).toLowerCase()];
  if (!type) return false; // 알 수 없는 확장자는 내보내지 않는다
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(readFileSync(path));
  return true;
}
