/**
 * 금고 등록 페이지 (2-pane 콘솔). backend 코드를 import하지 않는다 — HTTP API로만 통신
 * (금고 코드가 클라이언트 번들에 딸려 나가는 경로 차단).
 *
 * 값은 보내기만 하고 되돌아오지 않는다. 등록 여부는 /vault/list의
 * 이름·타입·길이로만 판정한다. 저장은 지금 보고 있는 그룹 단위다 (FWL-054).
 */

import { EXTRA_KEY, SCHEMA_KEYS, SECTIONS, checkFields, groupOf, isSecretKey, type FieldDef, type KeyInfo } from './schema.js';
import { fmtRemain } from './format.js';

type Row = { key: string; type: string; grant: boolean; input: HTMLInputElement; field?: FieldDef; label: string };
/** 그룹 id → 그 그룹의 입력칸. 내장 그룹은 SECTIONS.id, 기타 키는 이름의 첫 세그먼트 */
const groups = new Map<string, Row[]>();
let current = SECTIONS[0]!.id;
let existing = new Map<string, KeyInfo>();
let ttlMax = 0; // 진행바 분모 — 이 세션에서 본 가장 긴 남은 시간

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const passphrase = (): string => $<HTMLInputElement>('pass').value;
const token = (): string | null => sessionStorage.getItem('wallet-wsess');
const LOCK_SVG = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4.5" y="9" width="11" height="7.5" rx="1.8"/><path d="M7.4 9V7A2.6 2.6 0 0 1 12.6 7v2" stroke-linecap="round"/></svg>';

function show(id: 'view-login' | 'view-main'): void {
  $('view-login').hidden = id !== 'view-login';
  $('view-main').hidden = id !== 'view-main';
}

// 하단 저장 바 위의 피드백 줄 — 성공 4초, 실패 10초 뒤 사라진다
let msgTimer: ReturnType<typeof setTimeout> | undefined;
function note(ok: boolean, text: string): void {
  const m = $('msg');
  m.hidden = false;
  m.className = `feedback ${ok ? 'ok' : 'err'}`;
  m.textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { m.hidden = true; }, ok ? 4_000 : 10_000);
}

async function api(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token() ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    sessionStorage.removeItem('wallet-wsess');
    show('view-login');
    throw new Error('Session expired — sign in again');
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
  if (!json?.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  return json as Record<string, unknown>;
}

// ── 로그인 ───────────────────────────────────────────────────

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: $<HTMLInputElement>('login-user').value,
        password: $<HTMLInputElement>('login-pass').value,
      }),
    });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean; token?: string; attemptsLeft?: number; retryAfterSeconds?: number;
    } | null;
    const msg = $('login-msg');
    if (res.ok && json?.ok && json.token) {
      sessionStorage.setItem('wallet-wsess', json.token);
      $<HTMLInputElement>('login-pass').value = '';
      msg.hidden = true;
      show('view-main');
      void refreshHealth();
      void refreshDryRun();
      return;
    }
    msg.hidden = false;
    msg.textContent = res.status === 429
      ? `Locked out — try again in ${json?.retryAfterSeconds ?? '?'} s.`
      : json?.attemptsLeft !== undefined
        ? `Sign-in failed — ${json.attemptsLeft} attempts left before this account is locked.`
        : 'Sign-in failed.';
  })();
});

$('btn-logout').addEventListener('click', () => {
  sessionStorage.removeItem('wallet-wsess');
  show('view-login');
});

// ── 금고 상태 (레일) ─────────────────────────────────────────

async function refreshHealth(): Promise<void> {
  const cards = ['vault-open', 'vault-locked', 'vault-missing', 'vault-offline'];
  let visible = 'vault-offline';
  try {
    const r = (await (await fetch('/health')).json()) as {
      vaultLocked?: boolean; vaultExists?: boolean; vaultTtlMs?: number;
    };
    // unlock은 CLI(wallet unlock) 또는 레일의 버튼 — 같은 /vault/unlock이다
    if (r.vaultExists === false) visible = 'vault-missing';
    else if (r.vaultLocked) visible = 'vault-locked';
    else {
      visible = 'vault-open';
      const ms = r.vaultTtlMs ?? 0;
      ttlMax = Math.max(ttlMax, ms);
      $('vault-remain').textContent = fmtRemain(ms);
      $('vault-bar').style.width = `${ttlMax > 0 ? Math.round((ms / ttlMax) * 100) : 0}%`;
    }
  } catch {
    /* offline card */
  }
  for (const id of cards) $(id).hidden = id !== visible;
}

// 레일 버튼 = 목록 조회 + 서버 금고 unlock. 패스프레이즈는 하단 바 하나에서 읽는다 — 비어 있으면 거기로 보낸다.
// 목록이 먼저다 — 패스프레이즈가 틀리면 거기서 끝나고 unlock 시도는 없다
for (const btn of document.querySelectorAll<HTMLButtonElement>('.btn-unlock')) {
  btn.addEventListener('click', () => {
    if (!passphrase()) { $('pass').focus(); return note(false, 'Enter the master password in the bar below first.'); }
    void (async () => {
      await refreshList();
      const r = await api('/vault/unlock', { passphrase: passphrase() });
      await refreshHealth();
      note(true, `Vault open for ${fmtRemain(Number(r['ttlMs'] ?? 0))}. Status refreshed.`);
    })().catch((e: Error) => note(false, `Could not open the vault: ${e.message}`));
  });
}

// ── dry-run 토글 ─────────────────────────────────────────────
// 켜져 있으면 결제 비밀번호(grant 플래그 키) fill이 grant 검증까지만 하고 입력하지 않는다.
// 실결제 없이 E2E를 돌리는 스위치 — 켜진 채 두면 실주행이 조용히 결제 없이 끝나므로 레일에 크게 띄운다

function renderDryRun(on: boolean): void {
  $('dry-on').hidden = !on;
  $('dry-off').hidden = on;
}

async function refreshDryRun(): Promise<void> {
  try {
    const res = await fetch('/admin/dry-run', { headers: { authorization: `Bearer ${token() ?? ''}` } });
    const r = (await res.json().catch(() => null)) as { ok?: boolean; on?: boolean } | null;
    if (res.ok && r?.ok) renderDryRun(r.on === true);
  } catch {
    /* 레일 상태일 뿐이다 — 다음 폴링에서 다시 */
  }
}

async function setDryRun(on: boolean): Promise<void> {
  if (on && !confirm('DRY RUN skips typing payment PINs — turn it off before the next live run. Turn it on?')) return;
  try {
    const r = (await api('/admin/dry-run', { on })) as { on?: boolean };
    renderDryRun(r.on === true);
    note(true, r.on ? 'DRY RUN on — payment PINs are not typed.' : 'DRY RUN off — payments are live.');
  } catch (e) {
    note(false, `Could not change dry-run: ${(e as Error).message}`);
  }
}
$('btn-dry-on').addEventListener('click', () => { void setDryRun(true); });
$('btn-dry-off').addEventListener('click', () => { void setDryRun(false); });

// ── 그룹 내비 + 패널 ─────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function badge(info: KeyInfo | undefined): HTMLElement {
  return el('span', `badge ${info ? 'filled' : 'empty'}`, info ? `Registered · ${info.len}` : 'Not set');
}

function delButton(key: string, label: string): HTMLButtonElement {
  const del = el('button', 'row-del', 'Delete');
  del.addEventListener('click', () => {
    void (async () => {
      if (!confirm(`Delete the stored value of ${label}?`)) return;
      try {
        await api('/vault/rm', { passphrase: passphrase(), key });
        note(true, `Deleted ${label}. Status refreshed.`);
        await refreshList();
      } catch (e) {
        note(false, `Delete failed: ${(e as Error).message}`);
      }
    })();
  });
  return del;
}

function fieldRow(field: FieldDef, info: KeyInfo | undefined): { row: HTMLElement; input: HTMLInputElement } {
  const row = el('div', 'row');
  row.dataset['key'] = field.key;
  const head = el('div');
  const label = el('div', 'label', field.label);
  if (field.secret) label.insertAdjacentHTML('beforeend', LOCK_SVG);
  head.append(label, el('div', 'key', `${field.key}${field.grant ? ' · grant' : ''}`));
  const input = el('input');
  // 화면 마스킹은 CVV·카드 비번만 — 나머지는 사람이 확인하며 적도록 평문 표시
  input.type = field.secret ? 'password' : 'text';
  input.autocomplete = 'off';
  input.placeholder = field.hint ?? '';
  row.append(head, badge(info), input, info ? delButton(field.key, field.label) : el('span'));
  return { row, input };
}

function freeRow(k: KeyInfo): { row: HTMLElement; input: HTMLInputElement } {
  const row = el('div', 'row free');
  row.dataset['key'] = k.name;
  const head = el('div');
  head.append(el('div', 'label', k.name), el('div', 'key', `type ${k.type}${k.grant ? ' · grant' : ''}`));
  const input = el('input');
  input.type = isSecretKey(k.name) ? 'password' : 'text';
  input.autocomplete = 'off';
  input.placeholder = 'New value';
  row.append(head, badge(k), input, delButton(k.name, k.name));
  return { row, input };
}

function pane(id: string, title: string, blurb: string, mono = false): { pane: HTMLElement; body: HTMLElement } {
  const p = el('div', 'pane');
  p.dataset['group'] = id;
  const head = el('header', 'pane-head');
  const h = el('h1', mono ? 'display mono' : 'display', title);
  head.append(h, el('p', 'caption muted', blurb));
  const body = el('div', 'pane-body');
  p.append(head, body);
  return { pane: p, body };
}

function navItem(id: string, label: string, count?: string): HTMLElement {
  const item = el('div', 'nav-item');
  item.dataset['group'] = id;
  item.append(el('span', 'nav-label', label));
  if (count !== undefined) item.append(el('span', 'nav-count', count));
  item.addEventListener('click', () => select(id));
  return item;
}

function render(): void {
  const nav = $('nav');
  const panes = $('panes');
  nav.querySelectorAll('.nav-item, .nav-sep').forEach((n) => n.remove());
  panes.textContent = '';
  groups.clear();

  for (const s of SECTIONS) {
    const filled = s.fields.filter((f) => existing.has(f.key)).length;
    nav.append(navItem(s.id, s.title, `${filled}/${s.fields.length}`));
    const { pane: p, body } = pane(s.id, s.title, s.blurb);
    const rows: Row[] = [];
    for (const f of s.fields) {
      const { row, input } = fieldRow(f, existing.get(f.key));
      body.append(row);
      rows.push({ key: f.key, type: f.type, grant: f.grant === true, input, field: f, label: f.label });
    }
    groups.set(s.id, rows);
    panes.append(p);
  }

  // 기타 키 — 이름의 첫 세그먼트로 묶어 레일 항목이 된다
  const extras = new Map<string, KeyInfo[]>();
  for (const k of existing.values()) {
    if (SCHEMA_KEYS.has(k.name)) continue;
    const g = groupOf(k.name);
    extras.set(g, [...(extras.get(g) ?? []), k]);
  }
  if (extras.size > 0) nav.append(el('div', 'nav-sep'));
  for (const [g, keys] of [...extras].sort(([a], [b]) => a.localeCompare(b))) {
    nav.append(navItem(g, g, `${keys.length}/${keys.length}`));
    const { pane: p, body } = pane(g, g, 'Keys you added yourself, grouped by the first part of their name. The type travels with the value in the vault, so it is shown here rather than guessed.', true);
    const rows: Row[] = [];
    for (const k of keys.sort((a, b) => a.name.localeCompare(b.name))) {
      const { row, input } = freeRow(k);
      body.append(row);
      rows.push({ key: k.name, type: k.type, grant: k.grant, input, label: k.name });
    }
    const noteEl = el('div', 'note');
    noteEl.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7"/><path d="M10 13.4V9.2M10 6.6h.01" stroke-linecap="round"/></svg>');
    noteEl.append(el('span', undefined, 'A key marked grant is filled only when the calling service hands over a pay grant for the session. Everything else fills wherever the agent points it.'));
    body.append(noteEl);
    groups.set(g, rows);
    panes.append(p);
  }

  const add = el('div', 'nav-item add');
  add.dataset['group'] = 'add';
  add.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 4.5v11M4.5 10h11" stroke-linecap="round"/></svg>');
  add.append(el('span', 'nav-label', 'Add a key'));
  add.addEventListener('click', () => select('add'));
  nav.append(add);

  for (const rows of groups.values()) for (const r of rows) r.input.addEventListener('input', updateEntered);
  select(groups.has(current) || current === 'add' ? current : SECTIONS[0]!.id);
}

function select(id: string): void {
  current = id;
  for (const n of document.querySelectorAll<HTMLElement>('.nav-item')) n.classList.toggle('on', n.dataset['group'] === id);
  for (const p of document.querySelectorAll<HTMLElement>('#panes .pane')) p.hidden = p.dataset['group'] !== id;
  $('pane-add').hidden = id !== 'add';
  $('btn-save').textContent = id === 'add' ? 'Save this key' : 'Save this group';
  updateEntered();
}

function entered(): Row[] {
  return (groups.get(current) ?? []).filter((r) => r.input.value.trim().length > 0);
}

function updateEntered(): void {
  const n = current === 'add' ? Number($<HTMLInputElement>('free-value').value.length > 0) : entered().length;
  $('entered').innerHTML = `<span class="mono text">${n}</span> ${n === 1 ? 'field' : 'fields'} entered`;
}
$('free-value').addEventListener('input', updateEntered);

async function refreshList(): Promise<void> {
  const r = (await api('/vault/list', { passphrase: passphrase() })) as unknown as { keys: KeyInfo[] };
  existing = new Map(r.keys.map((k) => [k.name, k]));
  render();
}

// ── 저장 ─────────────────────────────────────────────────────

async function saveGroup(): Promise<void> {
  // 앞뒤 공백은 잘라서 저장한다 — 복사·붙여넣기로 딸려오는 공백이 값의 일부가 되지 않게
  for (const r of groups.get(current) ?? []) r.input.value = r.input.value.trim();
  const pending = entered();
  if (pending.length === 0) return note(false, 'Nothing entered in this group.');
  // 형식이 틀린 게 하나라도 있으면 아무것도 저장하지 않는다 — 반쯤 저장된 상태를 만들지 않는다
  const bad = checkFields(pending.filter((r) => r.field).map((r) => ({ field: r.field!, value: r.input.value })));
  if (bad.length > 0) return note(false, `Nothing was saved. Expected format — ${bad.join(', ')}. The write is all-or-nothing, so fix it and save again.`);
  const title = current === groupOf(current) && !SECTIONS.some((s) => s.id === current) ? current : (SECTIONS.find((s) => s.id === current)?.title ?? current);
  // 한 요청으로 보낸다 — 서버가 복호화·재암호화를 한 번만 하고, 전부 저장되거나 아무것도 저장되지 않는다
  try {
    await api('/vault/set', {
      passphrase: passphrase(),
      entries: pending.map((r) => ({ key: r.key, type: r.type, value: r.input.value, grant: r.grant })),
    });
    for (const r of pending) r.input.value = '';
    note(true, `Saved ${pending.length} ${pending.length === 1 ? 'key' : 'keys'} in ${title} — ${pending.map((r) => r.key).join(', ')}. Status refreshed.`);
  } catch (e) {
    note(false, `Nothing was saved: ${(e as Error).message}`);
  }
  void refreshHealth();
  await refreshList().catch(() => {});
}

async function saveFreeKey(): Promise<void> {
  const key = $<HTMLInputElement>('free-key').value.trim();
  const value = $<HTMLInputElement>('free-value').value.trim();
  if (!EXTRA_KEY.test(key)) return note(false, 'Key names are scope.field or scope.instance.field (e.g. example-shop.payment.pinnumber).');
  if (!value) return note(false, 'Enter a value.');
  try {
    await api('/vault/set', {
      passphrase: passphrase(), key, type: $<HTMLSelectElement>('free-type').value, value,
      grant: $<HTMLInputElement>('free-grant').checked,
    });
    $<HTMLInputElement>('free-key').value = '';
    $<HTMLInputElement>('free-value').value = '';
    $<HTMLInputElement>('free-grant').checked = false;
    note(true, `Saved ${key}. Status refreshed.`);
    current = groupOf(key);
    void refreshHealth();
    await refreshList();
  } catch (e) {
    note(false, `Nothing was saved: ${(e as Error).message}`);
  }
}

$('btn-save').addEventListener('click', () => {
  if (!passphrase()) { $('pass').focus(); return note(false, 'Enter the master password first.'); }
  void (current === 'add' ? saveFreeKey() : saveGroup());
});

// ── 초기화 ───────────────────────────────────────────────────

render(); // 로그인 전에도 골격은 그려둔다 (전부 미등록 표시)

/** 로컬 모드(FWL-053)면 로그인 폼 없이 세션을 받아 바로 연다. 확인에 실패하면 평소대로 로그인 화면 */
async function bootstrap(): Promise<void> {
  if (!token()) {
    try {
      const health = (await (await fetch('/health')).json()) as { local?: boolean };
      if (health.local === true) {
        const res = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const json = (await res.json()) as { ok?: boolean; token?: string };
        if (res.ok && json.ok && json.token) {
          sessionStorage.setItem('wallet-wsess', json.token);
          $('btn-logout').hidden = true; // 돌아갈 로그인 화면이 없다
        }
      }
    } catch {
      /* 평소 동작으로 떨어진다 */
    }
  }
  if (token()) {
    show('view-main');
    void refreshHealth();
    void refreshDryRun();
    setInterval(() => { void refreshHealth(); void refreshDryRun(); }, 30_000); // TTL 만료·첫 저장·dry-run을 레일에 반영
  } else {
    show('view-login');
  }
}

void bootstrap();
