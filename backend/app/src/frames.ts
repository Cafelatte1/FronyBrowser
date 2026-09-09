/**
 * 대상 요소가 속한 프레임의 origin 판정 (규칙 4, 3.1).
 *
 * 스냅샷 시점 캐시가 아니라 **행동 직전에 라이브로** 읽는다 — 스냅샷과
 * fill 사이에 프레임이 이동했을 수 있다. 카드 필드는 보통 PG사
 * cross-origin iframe 안에 있으므로 최상위 URL을 쓰면 보안 결함이다.
 */

import type { ElementHandle } from 'patchright';

export async function originOfHandle(handle: ElementHandle): Promise<string> {
  const frame = await handle.ownerFrame();
  if (!frame) throw new Error('element detached from frame');
  try {
    return new URL(frame.url()).origin;
  } catch {
    return 'null';
  }
}
