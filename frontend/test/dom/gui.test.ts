/**
 * 등록 화면 DOM — index.html을 jsdom에 올리고 main.ts를 그대로 실행한다. fetch는 가짜.
 * 렌더(배지·단일 저장 버튼·마스킹 범위)와 로그인 → 저장 → 삭제 흐름을 본다.
 * 값이 화면 밖(요청 본문)으로 어떻게 나가는지도 여기서 확인한다.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SECTIONS } from '../../src/schema.js';

type Call = { path: string; body: Record<string, unknown> };
const calls: Call[] = [];
/** 서버 상태 흉내 — 등록된 키 목록 */
const registered = new Map<string, { name: string; type: string; len: number }>();
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
      ? (body['entries'] as Array<{ key: string; type: string; value: string }>)
      : [{ key: String(body['key']), type: String(body['type']), value: String(body['value']) }];
    for (const { key, type, value } of items) registered.set(key, { name: key, type, len: value.length });
    return jsonRes(200, { ok: true, keys: items.map(({ key, type, value }) => ({ key, type, len: value.length })) });
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
  if (path === '/admin/dry-run') {
    if (init?.method === 'POST') dryRunOn = body['on'] === true;
    return jsonRes(200, { ok: true, on: dryRunOn });
  }
  return jsonRes(404, { ok: false });
});

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const tick = () => new Promise((r) => setTimeout(r, 0));
const inputFor = (key: string): HTMLInputElement =>
  $<HTMLInputElement>(`sections`).querySelector(`[data-key="${key}"] input`) as HTMLInputElement;

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'frontend/index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<main'), html.indexOf('</main>') + '</main>'.length);
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('confirm', () => true);
  await import('../../src/main.js');
});

describe('렌더', () => {
  it('로그인 전에도 섹션 골격은 그려지고, 전부 미등록 배지다', () => {
    expect($('view-login').hidden).toBe(false);
    const rows = document.querySelectorAll('#sections .field-row');
    expect(rows.length).toBe(SECTIONS.flatMap((s) => s.fields).length);
    expect([...document.querySelectorAll('#sections .badge')].every((b) => b.textContent === '미등록')).toBe(true);
    expect(document.querySelectorAll('#sections h2').length).toBe(3);
  });

  it('저장 버튼은 하나뿐이고, 마스킹 입력은 CVV·카드 비밀번호 둘뿐이다', () => {
    expect(document.querySelectorAll('#btn-save-all').length).toBe(1);
    expect(document.querySelectorAll('#sections button:not(.danger)').length).toBe(0); // 항목별 저장 버튼 없음
    const masked = [...document.querySelectorAll<HTMLInputElement>('#sections input[type=password]')];
    expect(masked.length).toBe(2);
    expect($<HTMLInputElement>('free-value').type).toBe('text');
  });
});

describe('로그인 → 저장 → 현황 → 삭제', () => {
  it('틀린 비밀번호는 남은 시도 안내, 맞으면 메인 화면 + 헤더 갱신', async () => {
    $<HTMLInputElement>('login-user').value = 'admin';
    $<HTMLInputElement>('login-pass').value = 'wrong';
    $('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(); await tick();
    expect($('login-msg').textContent).toContain('남은 시도 2회');

    $<HTMLInputElement>('login-pass').value = 'correct';
    $('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(); await tick();
    expect($('view-main').hidden).toBe(false);
    expect(sessionStorage.getItem('wallet-wsess')).toBe('wsess_test');
    expect($('vault-state').textContent).toContain('미생성');
  });

  it('형식이 틀린 항목이 하나라도 있으면 아무것도 저장하지 않는다', async () => {
    $<HTMLInputElement>('pass').value = 'pp';
    inputFor('profile.phone').value = '010-1234-5678';
    inputFor('profile.email').value = 'not-an-email';
    calls.length = 0;
    $('btn-save-all').click();
    await tick(); await tick();
    expect(calls.filter((c) => c.path === '/vault/set')).toHaveLength(0);
    expect($('msg').textContent).toContain('이메일');
  });

  it('값을 적은 칸만 저장하고, 앞뒤 공백은 잘라 보내며, 저장 후 배지가 등록됨으로 바뀐다', async () => {
    inputFor('profile.email').value = '  a@b.co  ';
    calls.length = 0;
    $('btn-save-all').click();
    for (let i = 0; i < 6; i++) await tick();
    const sets = calls.filter((c) => c.path === '/vault/set');
    expect(sets).toHaveLength(1); // 한 요청 — 서버 복호화·재암호화 한 번
    const entries = sets[0]?.body['entries'] as Array<{ key: string; value: string }>;
    expect(entries.map((e) => e.key).sort()).toEqual(['profile.email', 'profile.phone']);
    expect(entries.find((e) => e.key === 'profile.email')?.value).toBe('a@b.co');
    expect(sets[0]?.body['passphrase']).toBe('pp');
    // 저장 후 현황을 다시 그렸다
    const emailBadge = document.querySelector('[data-key="profile.email"] .badge');
    expect(emailBadge?.textContent).toBe('등록됨 · 6자');
    expect(inputFor('profile.email').value).toBe(''); // 입력칸은 비운다
  });

  it('기타 키는 규칙에 안 맞으면 거부, 맞으면 저장되고 표에 나타난다', async () => {
    $<HTMLInputElement>('free-key').value = 'memo';
    $<HTMLInputElement>('free-value').value = 'x';
    calls.length = 0;
    $('btn-free-save').click();
    await tick();
    expect(calls.filter((c) => c.path === '/vault/set')).toHaveLength(0);
    expect($('msg').textContent).toContain('범위.항목');

    $<HTMLInputElement>('free-key').value = 'example-shop.payment.pinnumber';
    $<HTMLInputElement>('free-value').value = '123456';
    $('btn-free-save').click();
    for (let i = 0; i < 6; i++) await tick();
    expect(registered.has('example-shop.payment.pinnumber')).toBe(true);
    expect($('extra-keys').hidden).toBe(false);
    expect($('extra-keys').textContent).toContain('example-shop.payment.pinnumber');
  });

  it('삭제하면 목록에서 빠지고 배지가 미등록으로 돌아간다', async () => {
    const del = document.querySelector<HTMLButtonElement>('[data-key="profile.email"] button.danger');
    expect(del?.hidden).toBe(false);
    del!.click();
    for (let i = 0; i < 6; i++) await tick();
    expect(registered.has('profile.email')).toBe(false);
    expect(document.querySelector('[data-key="profile.email"] .badge')?.textContent).toBe('미등록');
  });

  it('DRY RUN 배지는 켜졌을 때만 보이고, 버튼이 새 상태를 보낸다 (FWL-035)', async () => {
    expect($('dry-badge').hidden).toBe(true);
    expect($('btn-dry').textContent).toBe('DRY RUN 켜기');
    calls.length = 0;
    $('btn-dry').click();
    for (let i = 0; i < 4; i++) await tick();
    expect(calls.find((c) => c.path === '/admin/dry-run')?.body).toEqual({ on: true });
    expect($('dry-badge').hidden).toBe(false);
    expect($('btn-dry').textContent).toBe('DRY RUN 끄기');
    $('btn-dry').click();
    for (let i = 0; i < 4; i++) await tick();
    expect(dryRunOn).toBe(false);
    expect($('dry-badge').hidden).toBe(true);
  });

  it('불러오기는 목록 조회와 서버 금고 unlock을 한 번에 한다 — 헤더가 열림으로 바뀐다', async () => {
    $<HTMLInputElement>('pass').value = '';
    calls.length = 0;
    $('btn-refresh').click();
    for (let i = 0; i < 2; i++) await tick();
    expect(calls.some((c) => c.path === '/vault/list' || c.path === '/vault/unlock')).toBe(false); // 빈 패스프레이즈는 보내지 않는다
    $<HTMLInputElement>('pass').value = 'wrong';
    $('btn-refresh').click();
    for (let i = 0; i < 6; i++) await tick();
    expect($('msg').textContent).toContain('불러오기 실패');
    expect($('vault-state').textContent).toContain('잠김');
    $<HTMLInputElement>('pass').value = 'pw';
    calls.length = 0;
    $('btn-refresh').click();
    for (let i = 0; i < 8; i++) await tick();
    expect(calls.map((c) => c.path).filter((p) => p.startsWith('/vault'))).toEqual(['/vault/list', '/vault/unlock']);
    expect(calls.find((c) => c.path === '/vault/unlock')?.body).toEqual({ passphrase: 'pw' });
    expect($('msg').textContent).toContain('2일 3시간');
    expect($('vault-state').textContent).toContain('열림 · 2일 3시간 남음');
    unlockedMs = 0;
  });

  it('메인 메시지는 토스트다 — 잠시 뒤 사라진다', async () => {
    vi.useFakeTimers();
    try {
      $<HTMLInputElement>('free-key').value = 'bad';
      $('btn-free-save').click();
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
    $('btn-refresh').click();
    for (let i = 0; i < 4; i++) await tick();
    expect($('view-login').hidden).toBe(false);
    expect(sessionStorage.getItem('wallet-wsess')).toBeNull();
  });
});
