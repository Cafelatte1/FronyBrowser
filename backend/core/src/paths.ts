/**
 * 데이터 디렉토리 기본값 — 홈서버 Frony 관행: %LOCALAPPDATA%\Frony\<서비스>\data.
 * WALLET_DATA_DIR이 있으면 그것을 쓴다 (런처 cmd에서 지정). LOCALAPPDATA가 없는 환경(비 Windows)은 ./data.
 */

import { join } from 'node:path';

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['WALLET_DATA_DIR'];
  if (explicit) return explicit;
  const local = env['LOCALAPPDATA'];
  return local ? join(local, 'Frony', 'FronyBrowser', 'data') : join(process.cwd(), 'data');
}
