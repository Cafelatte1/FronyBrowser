/**
 * 보안 키패드 입력 (FWL-033) — 실브라우저.
 *
 * 이미지 버튼형 보안 키패드 모사: <input>이 없고, 배경 위에 무작위로 배치된 숫자 이미지 버튼을
 * 누르는 것이 곧 입력이다. 키패드는 cross-origin iframe 안에 있으므로 어댑터가
 * ref로 프레임을 좁혀 그 안에서만 버튼을 찾는지까지 본다.
 */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import type { Ref, SessionId } from '@wallet/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserPool, createPlaywrightTarget } from '@wallet/app';

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
const SELECTOR = "img.kpd-data[role='button'][aria-label='{digit}']";

function serve(html: string): Promise<Server> {
  return new Promise((resolvePromise) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

function originOf(server: Server): string {
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** 실제 키패드처럼 순서가 섞여 있고, 7은 두 개다 — 지목이 모호한 경우를 만든다 */
function digitButton(label: string): string {
  return `<img class="kpd-data" role="button" aria-label="${label}" src="${PIXEL}" width="40" height="40"
    onclick="document.getElementById('out').textContent += '${label}'">`;
}

/**
 * 스프라이트 키패드 모사 (FWL-038): 버튼에는 자리 번호만 있고 숫자는 세션별 스프라이트 PNG의 셀이다.
 * 실측 sprite-2(7 3 0 8 / 4 9 6 2 / 5 1)를 그대로 쓴다. ?broken=1이면 글리프 한 픽셀을 바꾼 스프라이트 — 판독이 거부돼야 한다
 */
function spritePage(broken: boolean): string {
  const png = PNG.sync.read(readFileSync(resolve(__dirname, '../fixtures/sprite-keypad-2.png')));
  if (broken) {
    for (let i = 3; i < png.data.length; i += 4) if (png.data[i] === 255) { png.data[i - 3] = 0; break; }
  }
  const url = `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
  const css = Array.from({ length: 10 }, (_, i) => `span.pad-pos-${i}{background-position:-${(i % 4) * 25}px -${Math.floor(i / 4) * 26}px}`).join('');
  const keys = Array.from({ length: 10 }, (_, i) => `<li><a href="#" class="pad-key" data-key="${i}" onclick="document.getElementById('cp-out').textContent += '${i}'; return false"><span class="pad-pos-${i}"></span></a></li>`).join('');
  return `<style>span[class^=pad-pos-]{display:inline-block;width:25px;height:26px;background:url("${url}") no-repeat}${css}</style>
    <h2>비밀번호 입력</h2><ul>${keys}</ul><span id="cp-out"></span>`;
}

let padServer: Server;
let pageServer: Server;
let spriteServer: Server;
const pool = createBrowserPool();
const target = createPlaywrightTarget(pool);
const sid = 's_keypad' as SessionId;

beforeAll(async () => {
  padServer = await serve(`
    <div id="kp">${['5', '2', '9', '0', '7', '4', '1', '8', '6', '3', '7'].map(digitButton).join('')}</div>
    <span id="out"></span>
  `);
  spriteServer = await new Promise<Server>((r) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(spritePage((req.url ?? '').includes('broken=1')));
    });
    server.listen(0, '127.0.0.1', () => r(server));
  });
  // /pay-broken은 깨진 스프라이트 프레임을 싣는다
  pageServer = await new Promise<Server>((r) => {
    const server = createServer((req, res) => {
      const q = (req.url ?? '').startsWith('/pay-broken') ? '?broken=1' : '';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`
    <h1>결제 비밀번호</h1>
    <iframe title="키패드" src="${originOf(padServer)}/nppfs"></iframe>
    <iframe title="스프라이트 키패드" src="${originOf(spriteServer)}/sprite${q}"></iframe>
  `);
    });
    server.listen(0, '127.0.0.1', () => r(server));
  });
  await target.open(sid, { origin: originOf(pageServer), kind: 'browser', browser: 'chromium', headless: true });
}, 60_000);

afterAll(async () => {
  await target.close(sid);
  await pool.shutdown();
  padServer?.close();
  pageServer?.close();
  spriteServer?.close();
});

/** 페이지를 새로 열고(입력 상태 초기화) 키패드 버튼 하나의 ref를 딴다 */
async function freshRef(): Promise<Ref> {
  await target.act(sid, { kind: 'navigate', url: `${originOf(pageServer)}/pay` });
  const snap = await target.snapshot(sid);
  const line = snap.tree.split('\n').find((l) => l.includes('button "0"'));
  const m = line?.match(/\[ref=([^\]]+)\]/);
  if (!m) throw new Error(`키패드 버튼 ref를 못 찾음:\n${snap.tree}`);
  return m[1] as Ref;
}

/** 페이지가 기록한 입력 순서. 테스트 페이지라 값이 보인다 — 금고 값이 아니다 */
function typed(): Promise<string | null> {
  return target.extract(sid, '#out');
}

const SPRITE = { keySelector: 'a.pad-key', cellSelector: 'span[class^=pad-pos-]', resolver: 'sprite-template' } as const;

/** 스프라이트 프레임 안의 제목 ref — 프레임을 좁히는 용도 */
async function spriteRef(broken = false): Promise<Ref> {
  await target.act(sid, { kind: 'navigate', url: `${originOf(pageServer)}/${broken ? 'pay-broken' : 'pay'}` });
  const snap = await target.snapshot(sid);
  const line = snap.tree.split('\n').find((l) => l.includes('heading "비밀번호 입력"'));
  const m = line?.match(/\[ref=([^\]]+)\]/);
  if (!m) throw new Error(`스프라이트 프레임 ref를 못 찾음:\n${snap.tree}`);
  return m[1] as Ref;
}

describe('keypad — 서버가 숫자 버튼을 누른다', () => {
  it('자릿수마다 버튼을 순서대로 누른다 — ref는 프레임을 좁히는 데만 쓴다', async () => {
    const ref = await freshRef();
    const r = await target.act(sid, { kind: 'keypad', ref, digitSelector: SELECTOR, value: '4813' });
    expect(await typed()).toBe('4813');
    expect(r.role).toBe('button'); // 감사 로그 재구성용 (FWL-030)
  }, 30_000);

  it('셀렉터가 아무것도 못 찾으면 element_not_actionable — 아무것도 누르지 않는다', async () => {
    const ref = await freshRef();
    await expect(
      target.act(sid, { kind: 'keypad', ref, digitSelector: "img.nope[aria-label='{digit}']", value: '48' }),
    ).rejects.toMatchObject({ code: 'element_not_actionable' });
    expect(await typed()).toBe('');
  }, 30_000);

  it('스프라이트 키패드: 자리→숫자를 판독해 PIN 순서대로 누른다 (FWL-038)', async () => {
    const ref = await spriteRef();
    // sprite-2 배치 7 3 0 8 / 4 9 6 2 / 5 1 → 4·9·5·1은 자리 4·5·8·9
    const r = await target.act(sid, { kind: 'keypad_sprite', ref, ...SPRITE, value: '4951' });
    expect(await target.extract(sid, '#cp-out')).toBe('4589');
    expect(r.role).toBe('heading');
  }, 30_000);

  it('스프라이트 키패드: 글리프가 하나라도 안 맞으면 keypad_unresolved — 아무것도 누르지 않는다', async () => {
    const ref = await spriteRef(true);
    await expect(target.act(sid, { kind: 'keypad_sprite', ref, ...SPRITE, value: '4951' })).rejects.toMatchObject({ code: 'keypad_unresolved' });
    expect(await target.extract(sid, '#cp-out')).toBe('');
  }, 30_000);

  it('스프라이트 키패드: 셀렉터가 버튼을 못 찾으면 keypad_unresolved', async () => {
    const ref = await spriteRef();
    await expect(target.act(sid, { kind: 'keypad_sprite', ref, ...SPRITE, keySelector: 'a.nope', value: '4' })).rejects.toMatchObject({ code: 'keypad_unresolved' });
  }, 30_000);

  it('버튼이 둘 이상 걸리면 거기서 멈춘다 — 어느 것을 누를지 모른 채 누르지 않는다', async () => {
    const ref = await freshRef();
    await expect(
      target.act(sid, { kind: 'keypad', ref, digitSelector: SELECTOR, value: '47' }),
    ).rejects.toMatchObject({ code: 'element_not_actionable' });
    expect(await typed()).toBe('4'); // 실패한 자릿수 뒤로는 진행하지 않는다
  }, 30_000);
});
