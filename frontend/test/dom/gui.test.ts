/**
 * 등록 화면 DOM — index.html을 jsdom에 올리고 main.ts를 그대로 실행한다. fetch는 가짜.
 * 렌더(레일 내비·배지·마스킹 범위)와 로그인 → 그룹 저장 → 기타 키 → 삭제 흐름을 본다.
 * 값이 화면 밖(요청 본문)으로 어떻게 나가는지도 여기서 확인한다.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SECTIONS } from '../../src/schema.js';

type Call = { path: string; body: Record<string, unknown> };
const calls: Call[] = [];
/** 서버 상태 흉내 — 등록된 키 목록 */
const registered = new Map<string, { name: string; type: string; len: number; grant: boolean }>();
let unlockedMs = 0;
let dryRunOn = false;

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ path, body });
  if (path === '/health') return jsonRes(200, { ok: true, vaultLocked: unlockedMs === 0, vaultExists: registered.size > 0, vaultTtlMs: unlockedMs });
  if (path === '/login') {
    return body['password'] === 'correct'
      ? jsonRes(200, { ok: true, token: 'wsess_test' })
      : jsonRes(401, { ok: false, attemptsLeft: 2 });
  }
  if (init?.headers && (init.headers as Record<string, string>)['authorization'] !== 'Bearer wsess_test') {
    return jsonRes(401, { ok: false, error: { code: 'unauthorized', message: 'no' } });
  }
  if (path === '/vault/set') {
    const items = Array.isArray(body['entries'])
      ? (body['entries'] as Array<{ key: string; type: string; value: string; grant?: boolean }>)
      : [{ key: String(body['key']), type: String(body['type']), value: String(body['value']), grant: body['grant'] === true }];
    for (const { key, type, value, grant } of items) registered.set(key, { name: key, type, len: value.length, grant: grant === true });
    return jsonRes(200, { ok: true, keys: items.map(({ key, type, value, grant }) => ({ key, type, len: value.length, grant: grant === true })) });
  }
  if (path === '/vault/rm') {
    registered.delete(String(body['key']));
    return jsonRes(200, { ok: true });
  }
  if (path === '/vault/list') return jsonRes(200, { ok: true, keys: [...registered.values()] });
  if (path === '/vault/unlock') {
    if (body['passphrase'] !== 'pw') return jsonRes(403, { ok: false, error: { code: 'vault_locked', message: 'unlock failed' } });
    unlockedMs = 2 * 24 * 60 * 60_000 + 3 * 60 * 60_000;
    return jsonRes(200, { ok: true, ttlMs: unlockedMs });
  }
  if (path === '/admin/test-mode') {
    if (init?.method === 'POST') dryRunOn = body['on'] === true;
    return jsonRes(200, { ok: true, on: dryRunOn });
  }
  return jsonRes(404, { ok: false });
});

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const tick = () => new Promise((r) => setTimeout(r, 0));
const inputFor = (key: string): HTMLInputElement =>
  $('panes').querySelector(`[data-key="${key}"] input`) as HTMLInputElement;
const nav = (group: string): HTMLElement => document.querySelector(`.nav-item[data-group="${group}"]`) as HTMLElement;
const visiblePane = (): string | undefined =>
  [...document.querySelectorAll<HTMLElement>('#panes .pane')].find((p) => !p.hidden)?.dataset['group'];

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'frontend/index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('<script type="module"'));
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('confirm', () => true);
  await import('../../src/main.js');
});

describe('렌더', () => {
  it('로그인 전에도 그룹 골격은 그려지고, 전부 Not set 배지다', () => {
    expect($('view-login').hidden).toBe(false);
    expect(document.querySelectorAll('#panes .row').length).toBe(SECTIONS.flatMap((s) => s.fields).length);
    expect([...document.querySelectorAll('#panes .badge')].every((b) => b.textContent === 'Not set')).toBe(true);
    expect(document.querySelectorAll('.nav-item').length).toBe(SECTIONS.length + 1); // 내장 3 + Add a key
    expect(nav('personal').classList.contains('on')).toBe(true);
    expect(visiblePane()).toBe('personal');
  });

  it('저장 버튼은 하나뿐이고, 마스킹 입력은 CVV·카드 비밀번호 둘뿐이다', () => {
    expect(document.querySelectorAll('#btn-save').length).toBe(1);
    expect(document.querySelectorAll('#panes button:not(.row-del)').length).toBe(0); // 항목별 저장 버튼 없음
    expect(document.querySelectorAll<HTMLInputElement>('#panes input[type=password]').length).toBe(2);
    expect($<HTMLInputElement>('free-value').type).toBe('text');
  });

  it('레일 내비로 그룹을 바꾸면 그 패널만 보이고 저장 버튼 문구가 따라간다', () => {
    nav('card').click();
    expect(visiblePane()).toBe('card');
    expect(nav('card').classList.contains('on')).toBe(true);
    expect($('pane-add').hidden).toBe(true);
    nav('add').click();
    expect($('pane-add').hidden).toBe(false);
    expect(visiblePane()).toBeUndefined();
    expect($('btn-save').textContent).toBe('Save this key');
    nav('personal').click();
    expect($('btn-save').textContent).toBe('Save this group');
  });
});

describe('로그인 → 저장 → 현황 → 삭제', () => {
  it('틀린 비밀번호는 남은 시도 안내, 맞으면 메인 화면 + 레일 상태 갱신', async () => {
    $<HTMLInputElement>('login-user').value = 'admin';
    $<HTMLInputElement>('login-pass').value = 'wrong';
    $('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(); await tick();
    expect($('login-msg').textContent).toContain('2 attempts left');

    $<HTMLInputElement>('login-pass').value = 'correct';
    $('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(); await tick();
    expect($('view-main').hidden).toBe(false);
    expect(sessionStorage.getItem('wallet-wsess')).toBe('wsess_test');
    expect($('vault-missing').hidden).toBe(false);
    expect($('vault-open').hidden).toBe(true);
  });

  it('형식이 틀린 항목이 하나라도 있으면 아무것도 저장하지 않는다', async () => {
    $<HTMLInputElement>('pass').value = 'pp';
    inputFor('profile.phone').value = '010-1234-5678';
    inputFor('profile.email').value = 'not-an-email';
    calls.length = 0;
    $('btn-save').click();
    await tick(); await tick();
    expect(calls.filter((c) => c.path === '/vault/set')).toHaveLength(0);
    expect($('msg').textContent).toContain('Email');
  });

  it('보고 있는 그룹의 값을 적은 칸만 저장하고, 앞뒤 공백은 잘라 보내며, 저장 후 배지가 Registered로 바뀐다', async () => {
    inputFor('profile.email').value = '  a@b.co  ';
    inputFor('card.personal.expiry').value = '12/27'; // 다른 그룹 — 이번 저장에 실리지 않는다
    calls.length = 0;
    $('btn-save').click();
    for (let i = 0; i < 6; i++) await tick();
    const sets = calls.filter((c) => c.path === '/vault/set');
    expect(sets).toHaveLength(1); // 한 요청 — 서버 복호화·재암호화 한 번
    const entries = sets[0]?.body['entries'] as Array<{ key: string; value: string; grant: boolean }>;
    expect(entries.map((e) => e.key).sort()).toEqual(['profile.email', 'profile.phone']);
    expect(entries.find((e) => e.key === 'profile.email')?.value).toBe('a@b.co');
    expect(entries.every((e) => e.grant === false)).toBe(true); // grant 키가 아닌 항목은 false로 나간다
    expect(sets[0]?.body['passphrase']).toBe('pp');
    // 저장 후 현황을 다시 그렸다
    expect(document.querySelector('[data-key="profile.email"] .badge')?.textContent).toBe('Registered · 6');
    expect(inputFor('profile.email').value).toBe(''); // 입력칸은 비운다
    expect(nav('personal').querySelector('.nav-count')?.textContent).toBe('2/5');
    expect(registered.has('card.personal.expiry')).toBe(false);
  });

  it('기타 키는 규칙에 안 맞으면 거부, 맞으면 저장되고 첫 세그먼트 그룹이 레일에 생긴다', async () => {
    nav('add').click();
    $<HTMLInputElement>('free-key').value = 'memo';
    $<HTMLInputElement>('free-value').value = 'x';
    calls.length = 0;
    $('btn-save').click();
    await tick();
    expect(calls.filter((c) => c.path === '/vault/set')).toHaveLength(0);
    expect($('msg').textContent).toContain('scope.field');

    $<HTMLInputElement>('free-key').value = 'example-shop.payment.pinnumber';
    $<HTMLInputElement>('free-value').value = '123456';
    $<HTMLInputElement>('free-grant').checked = true;
    calls.length = 0;
    $('btn-save').click();
    for (let i = 0; i < 6; i++) await tick();
    expect(calls.find((c) => c.path === '/vault/set')?.body['grant']).toBe(true);
    expect($<HTMLInputElement>('free-grant').checked).toBe(false); // 저장 뒤 체크는 풀린다
    expect(registered.has('example-shop.payment.pinnumber')).toBe(true);
    expect(nav('example-shop')).not.toBeNull();
    expect(visiblePane()).toBe('example-shop'); // 저장한 키의 그룹으로 이동
    expect(inputFor('example-shop.payment.pinnumber').type).toBe('password'); // pin은 마스킹
    expect(document.querySelector('[data-key="example-shop.payment.pinnumber"] .badge')?.textContent).toBe('Registered · 6');
  });

  it('삭제하면 목록에서 빠지고 배지가 Not set으로 돌아간다', async () => {
    nav('personal').click();
    const del = document.querySelector<HTMLButtonElement>('[data-key="profile.email"] .row-del');
    expect(del).not.toBeNull();
    del!.click();
    for (let i = 0; i < 6; i++) await tick();
    expect(registered.has('profile.email')).toBe(false);
    expect(document.querySelector('[data-key="profile.email"] .badge')?.textContent).toBe('Not set');
    expect(document.querySelector('[data-key="profile.email"] .row-del')).toBeNull();
  });

  it('Test Mode 카드는 켜졌을 때만 보이고, 버튼이 새 상태를 보낸다 (FWL-035)', async () => {
    expect($('dry-on').hidden).toBe(true);
    expect($('dry-off').hidden).toBe(false);
    calls.length = 0;
    $('btn-dry-on').click();
    for (let i = 0; i < 4; i++) await tick();
    expect(calls.find((c) => c.path === '/admin/test-mode')?.body).toEqual({ on: true });
    expect($('dry-on').hidden).toBe(false);
    $('btn-dry-off').click();
    for (let i = 0; i < 4; i++) await tick();
    expect(dryRunOn).toBe(false);
    expect($('dry-on').hidden).toBe(true);
  });

  it('레일의 열기 버튼은 목록 조회와 서버 금고 unlock을 한 번에 한다 — 상태 카드가 열림으로 바뀐다', async () => {
    const open = document.querySelector<HTMLButtonElement>('#vault-locked .btn-unlock')!;
    $<HTMLInputElement>('pass').value = '';
    calls.length = 0;
    open.click();
    for (let i = 0; i < 2; i++) await tick();
    expect(calls.some((c) => c.path === '/vault/list' || c.path === '/vault/unlock')).toBe(false); // 빈 패스프레이즈는 보내지 않는다
    $<HTMLInputElement>('pass').value = 'wrong';
    open.click();
    for (let i = 0; i < 6; i++) await tick();
    expect($('msg').textContent).toContain('Could not open');
    expect($('vault-locked').hidden).toBe(false);
    $<HTMLInputElement>('pass').value = 'pw';
    calls.length = 0;
    open.click();
    for (let i = 0; i < 8; i++) await tick();
    expect(calls.map((c) => c.path).filter((p) => p.startsWith('/vault'))).toEqual(['/vault/list', '/vault/unlock']);
    expect(calls.find((c) => c.path === '/vault/unlock')?.body).toEqual({ passphrase: 'pw' });
    expect($('msg').textContent).toContain('2d 3h');
    expect($('vault-open').hidden).toBe(false);
    expect($('vault-remain').textContent).toBe('2d 3h');
    unlockedMs = 0;
  });

  it('피드백 줄은 잠시 뒤 사라진다', async () => {
    vi.useFakeTimers();
    try {
      nav('add').click();
      $<HTMLInputElement>('free-key').value = 'bad';
      $('btn-save').click();
      expect($('msg').hidden).toBe(false);
      vi.advanceTimersByTime(9_000);
      expect($('msg').hidden).toBe(false); // 실패 메시지는 10초 유지
      vi.advanceTimersByTime(1_500);
      expect($('msg').hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('401이 오면 로그인 화면으로 돌아간다', async () => {
    sessionStorage.setItem('wallet-wsess', 'wsess_expired');
    $<HTMLInputElement>('pass').value = 'pw';
    document.querySelector<HTMLButtonElement>('#vault-locked .btn-unlock')!.click();
    for (let i = 0; i < 4; i++) await tick();
    expect($('view-login').hidden).toBe(false);
    expect(sessionStorage.getItem('wallet-wsess')).toBeNull();
  });
});
