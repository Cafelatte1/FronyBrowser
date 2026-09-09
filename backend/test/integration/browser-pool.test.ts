/**
 * 브라우저 idle 종료 (FWL-036): 마지막 컨텍스트가 닫히고 idleMs가 지나면 Browser가 사라지고,
 * 다음 open이 다시 띄운다. 그 사이 새 컨텍스트가 열리면 종료는 취소된다.
 */

import type { SessionId } from '@wallet/core';
import { afterAll, describe, expect, it } from 'vitest';
import { createBrowserPool } from '@wallet/app';

const pool = createBrowserPool({ idleMs: 300 });
const A = 's_a' as SessionId;
const B = 's_b' as SessionId;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
  await pool.shutdown();
});

describe('browser pool idle shutdown', () => {
  it('마지막 컨텍스트가 닫히고 idle이 지나면 Browser가 0개, 다음 open은 다시 띄운다', async () => {
    await pool.open(A);
    expect(pool.browserCount()).toBe(1);
    await pool.close(A);
    expect(pool.browserCount()).toBe(1); // 아직 idle 중
    await sleep(600);
    expect(pool.browserCount()).toBe(0);

    await pool.open(B);
    expect(pool.browserCount()).toBe(1);
    expect(pool.get(B)?.page).toBeDefined();
  });

  it('idle 중에 새 컨텍스트가 열리면 종료가 취소된다', async () => {
    // B는 위 테스트에서 열려 있다
    await pool.close(B);
    await sleep(100);
    await pool.open(A);
    await sleep(600);
    expect(pool.browserCount()).toBe(1);
    expect(pool.get(A)?.page.isClosed()).toBe(false);
    await pool.close(A);
  }, 15_000);
});
