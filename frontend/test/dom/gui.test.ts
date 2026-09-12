/**
 * 콘솔 DOM — index.html을 jsdom에 올리고 main.ts를 그대로 실행한다. fetch는 가짜.
 * 금고 4가지 상태·내비·그룹 저장·grant 토글·키 보류·기타 그룹 추가·삭제·생성·초기화를 본다.
 * 값이 화면 밖(요청 본문)으로 어떻게 나가는지도 여기서 확인한다.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SECTIONS } from '../../src/schema.js';

type Call = { path: string; method: string; body: Record<string, unknown> };
const calls: Call[] = [];

/** 서버 상태 흉내 */
type Entry = { name: string; type: string; len: number; grant: boolean; label: string };
const registered = new Map<string, Entry>();
const MASTER = 'master-pass';
const TTL_MAX = 3 * 24 * 60 * 60_000; // fmtRemain → '3d'
let vaultExists = false;
let vaultLocked = true;
let ttlMs = 0;
let healthDown = false;
let testOn = false;
let heldKeys: string[] = [];

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const locked = (): Response => jsonRes(403, { ok: false, error: { code: 'vault_locked', message: 'unlock required' } });

const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
  const method = init?.method ?? 'GET';
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ path, method, body });

  if (path === '/health') {
    if (healthDown) throw new Error('offline');
    return jsonRes(200, {
      ok: true, vaultLocked, vaultExists, vaultTtlMs: ttlMs, vaultTtlMaxMs: TTL_MAX, local: false,
    });
  }
  if (path === '/login') {
    return body['password'] === 'correct'
      ? jsonRes(200, { ok: true, token: 'wsess_test' })
      : jsonRes(401, { ok: false, attemptsLeft: 2 });
  }
  if ((init?.headers as Record<string, string> | undefined)?.['authorization'] !== 'Bearer wsess_test') {
    return jsonRes(401, { ok: false, error: { code: 'unauthorized', message: 'no' } });
  }
  if (path === '/admin/test-mode') {
    if (method === 'POST') {
      if (typeof body['on'] === 'boolean') testOn = body['on'];
      if (Array.isArray(body['held'])) heldKeys = body['held'] as string[];
    }
    return jsonRes(200, { ok: true, on: testOn, held: heldKeys });
  }
  if (path === '/vault/create') {
    if (vaultExists) return jsonRes(409, { ok: false, error: { code: 'already_exists', message: 'vault already exists' } });
    vaultExists = true; vaultLocked = false; ttlMs = TTL_MAX;
    return jsonRes(200, { ok: true });
  }
  if (path === '/vault/reset') {
    registered.clear(); vaultExists = false; vaultLocked = true; ttlMs = 0;
    return jsonRes(200, { ok: true });
  }
  if (path === '/vault/unlock') {
    if (body['passphrase'] !== MASTER) return jsonRes(403, { ok: false, error: { code: 'vault_locked', message: 'unlock failed' } });
    vaultLocked = false; ttlMs = TTL_MAX;
    return jsonRes(200, { ok: true, ttlMs });
  }
  if (path === '/vault/list') {
    if (vaultLocked) return locked();
    return jsonRes(200, { ok: true, keys: [...registered.values()] });
  }
  if (path === '/vault/set') {
    if (body['passphrase'] !== MASTER) return jsonRes(403, { ok: false, error: { code: 'vault_locked', message: 'wrong passphrase' } });
    const items = body['entries'] as Array<{ key: string; type: string; value: string; grant?: boolean; label?: string }>;
    for (const e of items) {
      registered.set(e.key, { name: e.key, type: e.type, len: e.value.length, grant: e.grant === true, label: e.label ?? '' });
    }
    return jsonRes(200, { ok: true, keys: [...registered.values()] });
  }
  if (path === '/vault/rm') {
    if (vaultLocked) return locked();
    registered.delete(String(body['key']));
    return jsonRes(200, { ok: true, key: body['key'] });
  }
  if (path === '/vault/grant') {
    if (vaultLocked) return locked();
    const cur = registered.get(String(body['key']));
    if (!cur) return jsonRes(404, { ok: false, error: { code: 'key_not_found', message: 'not in vault' } });
    cur.grant = body['grant'] === true;
    return jsonRes(200, { ok: true, key: cur.name, grant: cur.grant });
  }
  if (path === '/vault/seed-labels') {
    if (vaultLocked) return locked();
    const seeded: Array<{ key: string; label: string }> = [];
    for (const e of registered.values()) {
      if (e.label === '') { e.label = e.name; seeded.push({ key: e.name, label: e.label }); }
    }
    return jsonRes(200, { ok: true, seeded });
  }
  return jsonRes(404, { ok: false });
});

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
const row = (key: string): HTMLElement => $('rows').querySelector(`[data-key="${key}"]`) as HTMLElement;
const inputFor = (key: string): HTMLInputElement => row(key).querySelector('input') as HTMLInputElement;
const nav = (group: string): HTMLElement => document.querySelector(`.nav-item[data-group="${group}"]`) as HTMLElement;
const rowKeys = (): string[] => [...$('rows').querySelectorAll<HTMLElement>('.row')].map((r) => r.dataset['key'] as string);
const sets = (): Call[] => calls.filter((c) => c.path === '/vault/set');

/** 값을 적고 input 이벤트까지 흘려 보낸다 */
function type(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

/** 저장 대화상자를 열고 마스터 비밀번호로 확인한다 */
async function confirmSave(pass = MASTER): Promise<void> {
  $('btn-save').click();
  type($<HTMLInputElement>('dlg-pass'), pass);
  $('dlg-submit').click();
  await settle();
}

/** 로그아웃 → 재로그인으로 서버 상태를 다시 읽게 한다 */
async function relogin(): Promise<void> {
  $('btn-logout').click();
  $<HTMLInputElement>('login-user').value = 'admin';
  $<HTMLInputElement>('login-pass').value = 'correct';
  $('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
}

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'frontend/index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('<script type="module"'));
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('confirm', () => true);
  await import('../../src/main.js');
  await settle();
});

describe('로그인과 금고 상태 카드', () => {
  it('로그인 전에는 로그인 화면이고 내비 골격은 이미 그려져 있다', () => {
    expect($('view-login').hidden).toBe(false);
    expect(document.querySelectorAll('.nav-item').length).toBe(SECTIONS.length + 1); // 내장 3 + New key group
    expect(nav('personal').classList.contains('on')).toBe(true);
  });

  it('틀린 비밀번호는 안내만 하고 시도 횟수를 말하지 않는다', async () => {
    $<HTMLInputElement>('login-user').value = 'admin';
    $<HTMLInputElement>('login-pass').value = 'wrong';
    $('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect($('login-msg').hidden).toBe(false);
    expect($('login-msg').textContent).toContain('Sign-in failed. Check the username and password.');
    expect($('login-msg').textContent).not.toContain('attempts left');
    expect($('view-main').hidden).toBe(true);
  });

  it('맞으면 콘솔이 열리고, 금고가 없으면 No vault yet 카드와 생성 화면이다', async () => {
    $<HTMLInputElement>('login-pass').value = 'correct';
    $('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect($('view-main').hidden).toBe(false);
    expect(sessionStorage.getItem('wallet-wsess')).toBe('wsess_test');
    expect($('vault-missing').hidden).toBe(false);
    expect($('vault-open').hidden).toBe(true);
    expect($('pane-create').hidden).toBe(false);
    expect($('pane-rows').hidden).toBe(true);
    expect($('lock-notice').hidden).toBe(false);
    expect($('save-controls').hidden).toBe(true);
  });

  it('마스터 비밀번호를 정하면 금고를 만들고 열림 카드로 바뀐다', async () => {
    type($<HTMLInputElement>('setup-pass'), 'short');
    type($<HTMLInputElement>('setup-pass2'), 'short');
    $('btn-setup').click();
    await settle();
    expect($('setup-msg').textContent).toContain('at least 8 characters');
    expect(calls.some((c) => c.path === '/vault/create')).toBe(false);

    type($<HTMLInputElement>('setup-pass'), MASTER);
    type($<HTMLInputElement>('setup-pass2'), 'something-else');
    $('btn-setup').click();
    await settle();
    expect($('setup-msg').textContent).toContain('do not match');

    type($<HTMLInputElement>('setup-pass2'), MASTER);
    calls.length = 0;
    $('btn-setup').click();
    await settle();
    expect(calls.find((c) => c.path === '/vault/create')?.body).toEqual({ passphrase: MASTER });
    expect($('vault-open').hidden).toBe(false);
    expect($('vault-missing').hidden).toBe(true);
    expect($('vault-remain').textContent).toBe('3d');
    expect($('vault-bar-track').hidden).toBe(false);
    expect($('vault-bar').style.width).toBe('100%');
    expect($('pane-rows').hidden).toBe(false);
    expect($('save-controls').hidden).toBe(false);
  });
});

describe('내비와 행', () => {
  it('내비로 그룹을 바꾸면 머리글과 행이 따라간다', () => {
    nav('card').click();
    expect($('pane-title').textContent).toBe('Card');
    expect($('pane-blurb').textContent).toContain("payment gateway's own frame");
    expect(nav('card').classList.contains('on')).toBe(true);
    expect(rowKeys()).toEqual(SECTIONS.find((s) => s.id === 'card')!.fields.map((f) => f.key));
    // 스키마 그룹에는 키 추가 폼이 없다
    expect($('add-area').hidden).toBe(true);
    nav('personal').click();
    expect($('pane-title').textContent).toBe('Personal');
    expect(rowKeys()).toEqual(SECTIONS[0]!.fields.map((f) => f.key));
    expect([...$('rows').querySelectorAll('.badge')].every((b) => b.textContent === 'Not set')).toBe(true);
  });

  it('마스킹 입력은 CVV·카드 비밀번호뿐이다', () => {
    nav('card').click();
    expect($('rows').querySelectorAll('input[type=password]').length).toBe(2);
    nav('personal').click();
    expect($('rows').querySelectorAll('input[type=password]').length).toBe(0);
  });
});

describe('그룹 저장', () => {
  it('형식이 틀린 항목이 하나라도 있으면 비밀번호도 묻지 않는다', async () => {
    type(inputFor('profile.personal.phone'), '010-1234-5678');
    type(inputFor('profile.personal.email'), 'not-an-email');
    expect($('entered').textContent).toContain('2 fields');
    calls.length = 0;
    $('btn-save').click();
    await settle();
    expect($('dialog').hidden).toBe(true);
    expect(sets()).toHaveLength(0);
    expect($('banner').className).toContain('err');
    expect($('banner-text').textContent).toContain('Email');
  });

  it('보고 있는 그룹의 적은 칸만, 키·타입·값·grant·라벨로 보낸다', async () => {
    type(inputFor('profile.personal.email'), '  a@b.co  ');
    nav('card').click();
    type(inputFor('card.personal.expiry'), '12/27'); // 다른 그룹 — 이번 저장에 실리지 않는다
    nav('personal').click();
    calls.length = 0;
    await confirmSave();
    expect(sets()).toHaveLength(1);
    expect(sets()[0]?.body['passphrase']).toBe(MASTER);
    const entries = sets()[0]?.body['entries'] as Array<{ key: string; type: string; value: string; grant: boolean; label: string }>;
    expect(entries.map((e) => e.key).sort()).toEqual(['profile.personal.email', 'profile.personal.phone']);
    expect(entries.find((e) => e.key === 'profile.personal.email')).toEqual({ key: 'profile.personal.email', type: 'email', value: 'a@b.co', grant: false, label: 'Email' });
    expect(registered.has('card.personal.expiry')).toBe(false);
    // 저장 뒤 현황을 다시 그렸다
    expect(row('profile.personal.email').querySelector('.badge')?.textContent).toBe('Registered');
    expect(inputFor('profile.personal.email').value).toBe('');
    expect(nav('personal').querySelector('.nav-count')?.textContent).toBe('2/5');
    expect($('dialog').hidden).toBe(true);
  });
});

describe('grant 토글과 키 보류', () => {
  it('등록된 키의 grant 체크는 그 자리에서 /vault/grant를 부른다', async () => {
    calls.length = 0;
    (row('profile.personal.email').querySelector('.grant') as HTMLButtonElement).click();
    await settle();
    expect(calls.find((c) => c.path === '/vault/grant')?.body).toEqual({ key: 'profile.personal.email', grant: true });
    expect(sets()).toHaveLength(0);
    expect(registered.get('profile.personal.email')?.grant).toBe(true);
    expect(row('profile.personal.email').querySelector('.grant')?.getAttribute('data-grant')).toBe('on');
  });

  it('grant를 끌 때는 확인을 거친다 — 취소하면 체크도 서버도 그대로다', async () => {
    // 앞 테스트가 켜 둔 상태에서 시작한다
    expect(registered.get('profile.personal.email')?.grant).toBe(true);
    calls.length = 0;

    (row('profile.personal.email').querySelector('.grant') as HTMLButtonElement).click();
    await settle();
    expect($('dialog').hidden).toBe(false);
    expect($('dlg-title').textContent).toBe('Stop requiring a pay grant?');
    expect(calls.some((c) => c.path === '/vault/grant')).toBe(false);
    expect(row('profile.personal.email').querySelector('.grant')?.getAttribute('data-grant')).toBe('on');

    $('dlg-cancel').click();
    await settle();
    expect(calls.some((c) => c.path === '/vault/grant')).toBe(false);
    expect(registered.get('profile.personal.email')?.grant).toBe(true);

    (row('profile.personal.email').querySelector('.grant') as HTMLButtonElement).click();
    $('dlg-submit').click();
    await settle();
    expect($('dialog').hidden).toBe(true);
    expect(calls.find((c) => c.path === '/vault/grant')?.body).toEqual({ key: 'profile.personal.email', grant: false });
    expect(registered.get('profile.personal.email')?.grant).toBe(false);
    expect(row('profile.personal.email').querySelector('.grant')?.getAttribute('data-grant')).toBe('off');
  });

  it('값이 없는 키의 grant는 저장 때 같이 나간다', async () => {
    (row('profile.personal.carrier').querySelector('.grant') as HTMLButtonElement).click();
    expect(row('profile.personal.carrier').querySelector('.grant')?.getAttribute('data-grant')).toBe('on');
    expect(calls.some((c) => c.path === '/vault/grant' && c.body['key'] === 'profile.personal.carrier')).toBe(false);
    type(inputFor('profile.personal.carrier'), 'SKT');
    calls.length = 0;
    await confirmSave();
    const entries = sets()[0]?.body['entries'] as Array<{ key: string; grant: boolean }>;
    expect(entries).toEqual([{ key: 'profile.personal.carrier', type: 'text', value: 'SKT', grant: true, label: 'Carrier' }]);
  });

  it('키 이름을 누르면 보류 목록 전체를 /admin/test-mode로 보낸다', async () => {
    calls.length = 0;
    (row('profile.personal.phone').querySelector('.row-label') as HTMLElement).click();
    await settle();
    expect(calls.find((c) => c.path === '/admin/test-mode' && c.method === 'POST')?.body).toEqual({ held: ['profile.personal.phone'] });
    expect(row('profile.personal.phone').dataset['hold']).toBe('on');
    // Test Mode가 꺼져 있어도 보류 표시는 남고, 레일의 안내는 켰을 때만 나온다
    expect($('test-note').hidden).toBe(true);

    calls.length = 0;
    (row('profile.personal.email').querySelector('.row-label') as HTMLElement).click();
    await settle();
    expect((calls.find((c) => c.path === '/admin/test-mode' && c.method === 'POST')?.body['held'] as string[]).sort())
      .toEqual(['profile.personal.email', 'profile.personal.phone']);
  });

  it('Test Mode 알약은 확인 대화상자를 거쳐 켜지고 레일에 안내가 붙는다', async () => {
    calls.length = 0;
    $('btn-test').click();
    expect($('dialog').hidden).toBe(false);
    expect($('dlg-title').textContent).toBe('Turn on Test Mode?');
    expect($('dlg-pass-wrap').hidden).toBe(true); // 비밀번호를 묻지 않는다
    $('dlg-submit').click();
    await settle();
    expect(calls.find((c) => c.path === '/admin/test-mode' && c.method === 'POST')?.body).toEqual({ on: true });
    expect($('btn-test').getAttribute('data-test')).toBe('on');
    expect($('test-note').hidden).toBe(false);
    $('btn-test').click();
    $('dlg-submit').click();
    await settle();
    expect(testOn).toBe(false);
    expect($('test-note').hidden).toBe(true);
  });
});

describe('사용자가 만든 그룹', () => {
  it('새 그룹을 만들고 키를 더하면 저장 전까지는 서버에 아무것도 가지 않는다', async () => {
    calls.length = 0;
    nav('new-group').click();
    expect($('dlg-title').textContent).toBe('New key group');
    type($<HTMLInputElement>('dlg-group'), 'example-shop');
    $('dlg-submit').click();
    await settle();
    expect(calls).toHaveLength(0); // 그룹은 화면 위에만 생긴다
    expect($('dialog').hidden).toBe(true);
    expect($('pane-title').textContent).toBe('example-shop');
    expect($('pane-blurb').textContent).toContain('Keys you added yourself.');
    expect(nav('example-shop')).not.toBeNull();
    expect($('add-area').hidden).toBe(false);
    expect($('add-panel').hidden).toBe(false);

    type($<HTMLInputElement>('add-name'), 'Payment PIN');
    type($<HTMLInputElement>('add-field'), 'payment.pinnumber');
    expect($('add-full').textContent).toBe('example-shop.payment.pinnumber');
    $('btn-add-key').click();
    await settle();
    expect(calls).toHaveLength(0);
    expect(rowKeys()).toEqual(['example-shop.payment.pinnumber']);
    expect(row('example-shop.payment.pinnumber').querySelector('.badge')?.textContent).toBe('Not set');
    expect(row('example-shop.payment.pinnumber').querySelector('.row-del')?.textContent).toBe('Discard'); // 등록 전에는 삭제가 없다
    expect(inputFor('example-shop.payment.pinnumber').type).toBe('password');
  });

  it('키 이름이 규칙에 안 맞으면 줄을 만들지 않는다', () => {
    type($<HTMLInputElement>('add-name'), 'Bad');
    type($<HTMLInputElement>('add-field'), 'a.b.c');
    $('btn-add-key').click();
    expect($('banner-text').textContent).toContain('group.subject.field');
    expect(rowKeys()).toEqual(['example-shop.payment.pinnumber']);
  });

  it('저장하면 그 줄이 라벨과 함께 나가고 등록으로 바뀐다', async () => {
    type(inputFor('example-shop.payment.pinnumber'), '123456');
    calls.length = 0;
    await confirmSave();
    const entries = sets()[0]?.body['entries'] as Array<Record<string, unknown>>;
    expect(entries).toEqual([{ key: 'example-shop.payment.pinnumber', type: 'text', value: '123456', grant: false, label: 'Payment PIN' }]);
    expect(row('example-shop.payment.pinnumber').querySelector('.badge')?.textContent).toBe('Registered');
    expect(nav('example-shop').querySelector('.nav-count')?.textContent).toBe('1/1');
  });
});

describe('이름 없는 키', () => {
  it('라벨이 빈 키가 있을 때만 줄이 뜨고, 버튼이 /vault/seed-labels를 부른다', async () => {
    expect($('unnamed').hidden).toBe(true);
    registered.set('other-shop.login.id', { name: 'other-shop.login.id', type: 'text', len: 4, grant: false, label: '' });
    await relogin();
    expect($('unnamed').hidden).toBe(false);
    expect($('unnamed-text').textContent).toBe('1 key has no name yet.');
    nav('other-shop').click();
    expect(row('other-shop.login.id').querySelector('.row-label div')?.textContent).toBe('other-shop.login.id');

    calls.length = 0;
    $('btn-seed').click();
    await settle();
    expect(calls.some((c) => c.path === '/vault/seed-labels')).toBe(true);
    expect($('unnamed').hidden).toBe(true);
  });
});

describe('삭제 · 대화상자 · 상태 변화', () => {
  it('삭제하면 목록에서 빠지고 배지가 Not set으로 돌아간다', async () => {
    nav('personal').click();
    calls.length = 0;
    (row('profile.personal.email').querySelector('.row-del') as HTMLButtonElement).click();
    await settle();
    expect(calls.find((c) => c.path === '/vault/rm')?.body).toEqual({ key: 'profile.personal.email' });
    expect(registered.has('profile.personal.email')).toBe(false);
    expect(row('profile.personal.email').querySelector('.badge')?.textContent).toBe('Not set');
    expect(row('profile.personal.email').querySelector('.row-del')).toBeNull();
  });

  it('Escape로 대화상자가 닫힌다', () => {
    $('btn-extend').click();
    expect($('dialog').hidden).toBe(false);
    expect($('dlg-body').textContent).toContain('3d'); // 72시간이 아니라 설정된 TTL
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect($('dialog').hidden).toBe(true);
  });

  it('잠기면 잠김 카드와 잠김 안내가, 서버가 안 보이면 unreachable 카드가 뜬다', async () => {
    vaultLocked = true;
    await relogin();
    expect($('vault-locked').hidden).toBe(false);
    expect($('pane-locked').hidden).toBe(false);
    expect($('pane-rows').hidden).toBe(true);
    expect($('locked-blurb').textContent).toContain('it stays open for 3d');

    healthDown = true;
    await relogin();
    expect($('vault-offline').hidden).toBe(false);
    expect($('vault-locked').hidden).toBe(true);
    expect($('vault-offline').textContent).toContain('Check that the server is running.');

    healthDown = false;
    await relogin();
    document.querySelector<HTMLButtonElement>('#pane-locked .btn-unlock')!.click();
    expect($('dlg-title').textContent).toBe('Open the vault');
    type($<HTMLInputElement>('dlg-pass'), 'wrong');
    $('dlg-submit').click();
    await settle();
    expect($('dialog').hidden).toBe(false); // 틀리면 대화상자에 그대로 남는다
    expect($('dlg-error').hidden).toBe(false);
    type($<HTMLInputElement>('dlg-pass'), MASTER);
    $('dlg-submit').click();
    await settle();
    expect($('dialog').hidden).toBe(true);
    expect($('vault-open').hidden).toBe(false);
  });

  it('금고 초기화는 비밀번호 없이 확인만 받고, 끝나면 생성 화면으로 돌아간다', async () => {
    $('btn-reset').click();
    expect($('dlg-title').textContent).toBe('Reset the vault?');
    expect($('dlg-pass-wrap').hidden).toBe(true);
    calls.length = 0;
    $('dlg-submit').click();
    await settle();
    expect(calls.find((c) => c.path === '/vault/reset')?.body).toEqual({});
    expect(registered.size).toBe(0);
    expect($('vault-missing').hidden).toBe(false);
    expect($('pane-create').hidden).toBe(false);
    expect(document.querySelectorAll('.nav-item').length).toBe(SECTIONS.length + 1);
  });

  it('401이 오면 로그인 화면으로 돌아간다', async () => {
    sessionStorage.setItem('wallet-wsess', 'wsess_expired');
    $('btn-seed').click();
    await settle();
    expect($('view-login').hidden).toBe(false);
    expect(sessionStorage.getItem('wallet-wsess')).toBeNull();
  });
});
