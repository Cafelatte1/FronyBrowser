/**
 * 금고 콘솔 (레일 + 내용). backend 코드를 import하지 않는다 — HTTP API로만 통신
 * (금고 코드가 클라이언트 번들에 딸려 나가는 경로 차단).
 *
 * 값은 보내기만 하고 되돌아오지 않는다. 등록 여부는 /vault/list의
 * 이름·타입·길이·라벨로만 판정한다. 저장은 지금 보고 있는 그룹 단위고,
 * 마스터 비밀번호는 저장·열기·연장 대화상자에서만 받는다 (FWL-056).
 */

import { CUSTOM_BLURB, EXTRA_KEY, SCHEMA_KEYS, SECTIONS, checkFields, groupOf, isSecretKey, type FieldDef, type KeyInfo } from './schema.js';
import { fmtRemain } from './format.js';

/** 화면 한 줄 — 스키마 항목이거나, 금고에 있는 기타 키거나, 아직 저장 안 한 추가 줄이다 */
type Row = {
  key: string; type: string; label: string; grant: boolean;
  registered: boolean; secret: boolean; field?: FieldDef;
};
type VaultState = 'open' | 'locked' | 'missing' | 'offline';
type Dlg = 'unlock' | 'extend' | 'group' | 'testOn' | 'testOff' | 'wipe' | 'grantOff';

let existing = new Map<string, KeyInfo>();
let current = SECTIONS[0]!.id;
let vault: VaultState = 'offline';
let ttlMs = 0;
let ttlMaxMs: number | null = null;
let testOn = false;
/** Test Mode에서 빼 둘 키 — 서버가 전체 목록을 들고 있다 */
const held = new Set<string>();
/** 저장 전까지만 존재하는 줄 — 그룹 id → 줄들 */
const pendingRows = new Map<string, Array<{ key: string; type: string; label: string }>>();
/** 사용자가 만들었지만 아직 키가 하나도 없는 그룹 */
const newGroups = new Set<string>();
/** 입력칸 값 — 다시 그려도 살아남게 여기 둔다 */
const draft = new Map<string, string>();
/** 아직 등록되지 않은 키의 grant 체크 상태 (저장 때 같이 나간다) */
const grantDraft = new Map<string, boolean>();
let dlg: Dlg | null = null;
/** grantOff 대화상자가 묻고 있는 줄 — 확인을 누르면 이 줄의 플래그를 끈다 */
let grantOffRow: Row | null = null;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const token = (): string | null => sessionStorage.getItem('wallet-wsess');
const CHECK_SVG = '<span class="box"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 10.4 8.3 13.7 15 7"/></svg></span>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function show(id: 'view-login' | 'view-main'): void {
  $('view-login').hidden = id !== 'view-login';
  $('view-main').hidden = id !== 'view-main';
  if (id === 'view-login') closeDialog();
}

// 오른쪽 아래 토스트 — 성공 4초, 실패 10초 뒤 사라진다
let msgTimer: ReturnType<typeof setTimeout> | undefined;
function note(ok: boolean, text: string): void {
  const b = $('banner');
  b.hidden = false;
  b.className = `banner ${ok ? 'ok' : 'err'}`;
  $('banner-text').textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { b.hidden = true; }, ok ? 4_000 : 10_000);
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
      ok?: boolean; token?: string; retryAfterSeconds?: number;
    } | null;
    const msg = $('login-msg');
    if (res.ok && json?.ok && json.token) {
      sessionStorage.setItem('wallet-wsess', json.token);
      $<HTMLInputElement>('login-pass').value = '';
      msg.hidden = true;
      show('view-main');
      void reload();
      return;
    }
    msg.hidden = false;
    $('login-msg-text').textContent = res.status === 429
      ? `Locked out — try again in ${json?.retryAfterSeconds ?? '?'} s.`
      : 'Sign-in failed. Check the username and password.';
  })();
});

$('btn-logout').addEventListener('click', () => {
  sessionStorage.removeItem('wallet-wsess');
  show('view-login');
});

// ── 서버 상태 ────────────────────────────────────────────────

async function refreshHealth(): Promise<void> {
  try {
    const r = (await (await fetch('/health')).json()) as {
      vaultLocked?: boolean; vaultExists?: boolean; vaultTtlMs?: number; vaultTtlMaxMs?: number | null;
    };
    vault = r.vaultExists === false ? 'missing' : r.vaultLocked ? 'locked' : 'open';
    ttlMs = r.vaultTtlMs ?? 0;
    ttlMaxMs = typeof r.vaultTtlMaxMs === 'number' ? r.vaultTtlMaxMs : null;
  } catch {
    vault = 'offline';
  }
}

async function refreshTestMode(): Promise<void> {
  try {
    const res = await fetch('/admin/test-mode', { headers: { authorization: `Bearer ${token() ?? ''}` } });
    const r = (await res.json().catch(() => null)) as { ok?: boolean; on?: boolean; held?: string[] } | null;
    if (!res.ok || !r?.ok) return;
    testOn = r.on === true;
    held.clear();
    for (const k of r.held ?? []) held.add(k);
  } catch {
    /* 다음 폴링에서 다시 */
  }
}

async function refreshList(): Promise<void> {
  const r = (await api('/vault/list', {})) as unknown as { keys: KeyInfo[] };
  existing = new Map(r.keys.map((k) => [k.name, k]));
}

/** 서버 상태 + 키 목록을 다시 읽고 화면을 그린다 */
async function reload(): Promise<void> {
  await refreshHealth();
  await refreshTestMode();
  if (vault === 'open') await refreshList().catch(() => { existing = new Map(); });
  else existing = new Map();
  render();
}

/** 설정된 unlock 시간 — 대화상자 문구에 실제 값을 쓴다. 알 수 없으면 null */
function ttlSpan(): string | null {
  return ttlMaxMs !== null && ttlMaxMs > 0 ? fmtRemain(ttlMaxMs) : null;
}

// ── 그룹과 줄 ────────────────────────────────────────────────

function sectionOf(id: string): { title: string; blurb: string; fields: FieldDef[] } | undefined {
  return SECTIONS.find((s) => s.id === id);
}

function titleOf(id: string): string {
  return sectionOf(id)?.title ?? id;
}

function rowsOf(id: string): Row[] {
  const section = sectionOf(id);
  if (section) {
    return section.fields.map((f) => {
      const info = existing.get(f.key);
      return {
        // 이미 등록된 키는 서버에 저장된 이름이 진실이다 (FWL-079). 스키마의 이름은 아직 없는 행의 기본값일 뿐이라,
        // 이걸 안 보면 운영자가 바꾼 이름이 콘솔에 안 뜨고 다음 저장 때 스키마 이름으로 되돌아간다
        key: f.key, type: f.type, label: info && info.label !== '' ? info.label : f.label, field: f, secret: f.secret === true,
        registered: info !== undefined,
        grant: info ? info.grant : grantDraft.get(f.key) ?? f.grant === true,
      };
    });
  }
  const rows: Row[] = [...existing.values()]
    .filter((k) => !SCHEMA_KEYS.has(k.name) && groupOf(k.name) === id)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((k) => ({
      key: k.name, type: k.type, label: k.label !== '' ? k.label : k.name,
      grant: k.grant, registered: true, secret: isSecretKey(k.name),
    }));
  for (const p of pendingRows.get(id) ?? []) {
    rows.push({
      key: p.key, type: p.type, label: p.label, registered: false,
      secret: isSecretKey(p.key), grant: grantDraft.get(p.key) === true,
    });
  }
  return rows;
}

/** 스키마 밖 그룹 — 금고에 있는 키, 만들어만 둔 그룹, 저장 전 줄을 모두 모은다 */
function customGroups(): string[] {
  const set = new Set<string>(newGroups);
  for (const k of existing.keys()) if (!SCHEMA_KEYS.has(k)) set.add(groupOf(k));
  for (const g of pendingRows.keys()) set.add(g);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function valueOf(key: string): string {
  return (draft.get(key) ?? '').trim();
}

function enteredRows(): Row[] {
  return rowsOf(current).filter((r) => valueOf(r.key) !== '');
}

// ── 그리기 ───────────────────────────────────────────────────

function render(): void {
  renderRail();
  renderNav();
  renderContent();
}

function renderRail(): void {
  $('vault-open').hidden = vault !== 'open';
  $('vault-locked').hidden = vault !== 'locked';
  $('vault-missing').hidden = vault !== 'missing';
  $('vault-offline').hidden = vault !== 'offline';
  $('vault-remain').textContent = fmtRemain(ttlMs);
  // 분모를 모르면 진행바는 숨긴다 — 눈금 없는 막대는 거짓말이다
  $('vault-bar-track').hidden = ttlMaxMs === null;
  if (ttlMaxMs !== null && ttlMaxMs > 0) {
    $('vault-bar').style.width = `${Math.round(Math.min(1, ttlMs / ttlMaxMs) * 100)}%`;
  }
  $('btn-test').dataset['test'] = testOn ? 'on' : 'off';
  $('test-note').hidden = !testOn;
}

function navItem(id: string, label: string, count?: string): HTMLElement {
  const item = el('div', 'nav-item');
  item.dataset['group'] = id;
  if (id === current) item.classList.add('on');
  item.append(el('span', 'nav-label', label));
  if (count !== undefined) item.append(el('span', 'nav-count', count));
  item.addEventListener('click', () => { select(id); });
  return item;
}

function renderNav(): void {
  const nav = $('nav');
  nav.querySelectorAll('.nav-item, .nav-sep').forEach((n) => { n.remove(); });
  const count = (id: string): string => {
    const rows = rowsOf(id);
    return `${rows.filter((r) => r.registered).length}/${rows.length}`;
  };
  for (const s of SECTIONS) nav.append(navItem(s.id, s.title, count(s.id)));
  const custom = customGroups();
  if (custom.length > 0) nav.append(el('div', 'nav-sep'));
  for (const g of custom) nav.append(navItem(g, g, count(g)));

  const add = el('div', 'nav-item add');
  add.dataset['group'] = 'new-group';
  add.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 4.5v11M4.5 10h11" stroke-linecap="round"/></svg>');
  add.append(el('span', 'nav-label', 'New key group'));
  add.addEventListener('click', () => { openDialog('group'); });
  nav.append(add);
}

function isPending(r: Row): boolean {
  return (pendingRows.get(current) ?? []).some((p) => p.key === r.key);
}

function delButton(r: Row): HTMLButtonElement {
  const del = el('button', 'row-del', 'Delete');
  del.addEventListener('click', () => {
    void (async () => {
      if (!confirm(`Delete the stored value of ${r.label}?`)) return;
      try {
        await api('/vault/rm', { key: r.key });
        note(true, `Deleted ${r.label}. Status refreshed.`);
        await reload();
      } catch (e) {
        note(false, `Delete failed: ${(e as Error).message}`);
      }
    })();
  });
  return del;
}

/** 저장 전 행은 서버에 없다 — 화면에서만 지운다 */
function discardButton(r: Row): HTMLButtonElement {
  const dis = el('button', 'row-del', 'Discard');
  dis.addEventListener('click', () => {
    const left = (pendingRows.get(current) ?? []).filter((p) => p.key !== r.key);
    if (left.length > 0) pendingRows.set(current, left);
    else pendingRows.delete(current);
    render();
  });
  return dis;
}

function rowEl(r: Row): HTMLElement {
  const row = el('div', 'row');
  row.dataset['key'] = r.key;
  row.dataset['hold'] = held.has(r.key) ? 'on' : 'off';

  const label = el('div', 'row-label');
  label.title = 'Hold this key back from test runs';
  label.append(el('div', undefined, r.label), el('div', 'row-key', r.key));
  label.addEventListener('click', () => { void toggleHold(r.key); });

  const grant = el('button', 'grant');
  grant.dataset['grant'] = r.grant ? 'on' : 'off';
  grant.title = 'Requires a grant before an agent may use this key';
  grant.insertAdjacentHTML('beforeend', CHECK_SVG);
  grant.addEventListener('click', () => { void toggleGrant(r); });

  const badge = el('span', `badge ${r.registered ? 'filled' : 'empty'}`, r.registered ? 'Registered' : 'Not set');

  const input = el('input');
  // 화면 마스킹은 CVV·카드 비번과 password·pin으로 끝나는 기타 키 — 나머지는 보며 적도록 평문
  input.type = r.secret ? 'password' : 'text';
  input.autocomplete = 'off';
  input.placeholder = r.field?.hint ?? 'New value';
  input.value = draft.get(r.key) ?? '';
  input.addEventListener('input', () => {
    draft.set(r.key, input.value);
    updateEntered();
  });

  row.append(label, grant, badge, input, r.registered ? delButton(r) : isPending(r) ? discardButton(r) : el('span'));
  return row;
}

function renderContent(): void {
  const section = sectionOf(current);
  const title = $('pane-title');
  title.textContent = titleOf(current);
  title.classList.toggle('mono', section === undefined);
  $('pane-blurb').textContent = section?.blurb ?? CUSTOM_BLURB;

  $('save-controls').hidden = vault !== 'open';
  $('lock-notice').hidden = vault === 'open';
  $('pane-locked').hidden = vault !== 'locked';
  $('pane-create').hidden = vault !== 'missing';
  $('pane-rows').hidden = vault !== 'open';

  const span = ttlSpan();
  $('locked-blurb').textContent = span === null
    ? 'Registering a key writes into the vault, so it has to be open. Enter the master password once and it stays open until it locks itself.'
    : `Registering a key writes into the vault, so it has to be open. Enter the master password once and it stays open for ${span}.`;

  const rows = $('rows');
  rows.querySelectorAll('.row, .rows-empty').forEach((n) => { n.remove(); });
  const list = rowsOf(current);
  if (list.length === 0) rows.append(el('div', 'rows-empty', 'No keys in this group yet.'));
  for (const r of list) rows.append(rowEl(r));

  const unnamed = [...existing.values()].filter((k) => k.label === '').length;
  $('unnamed').hidden = unnamed === 0;
  $('unnamed-text').textContent = `${unnamed} ${unnamed === 1 ? 'key has' : 'keys have'} no name yet.`;

  // 그룹 통째로 지우기는 스키마 밖 그룹에만 — 스키마 그룹은 줄마다 Delete로 지운다
  $('btn-del-group').hidden = section !== undefined || vault !== 'open';
  $('add-area').hidden = section !== undefined;
  $('add-full').textContent = `${current}.${$<HTMLInputElement>('add-field').value.trim() || 'login.id'}`;

  updateEntered();
}

function updateEntered(): void {
  const n = enteredRows().length;
  $('entered').innerHTML = `<span class="mono text">${n}</span> ${n === 1 ? 'field' : 'fields'} entered`;
  $('btn-save').dataset['save'] = n > 0 ? 'on' : 'off';
}

function select(id: string): void {
  current = id;
  closeAddPanel();
  render();
}

// ── grant 토글 · 키 보류 ─────────────────────────────────────

async function toggleGrant(r: Row): Promise<void> {
  if (!r.registered) {
    // 값이 아직 없는 줄은 표시만 바꾼다 — 플래그는 저장 때 같이 나간다
    grantDraft.set(r.key, !r.grant);
    render();
    return;
  }
  // 끄는 쪽은 보호를 없애는 방향이라 한 번 묻는다. 켜는 쪽은 그대로 즉시 반영한다
  if (r.grant) {
    grantOffRow = r;
    openDialog('grantOff');
    return;
  }
  await applyGrant(r, true);
}

/** 먼저 뒤집어 그리고 서버에는 뒤이어 보낸다 — 클릭이 왕복을 기다리지 않는다. 실패하면 되돌린다 */
async function applyGrant(r: Row, grant: boolean): Promise<void> {
  const info = existing.get(r.key);
  if (info === undefined) return;
  existing.set(r.key, { ...info, grant });
  render();
  try {
    const res = (await api('/vault/grant', { key: r.key, grant })) as { grant?: boolean };
    note(true, res.grant === true
      ? `${r.label} now needs a pay grant.`
      : `${r.label} no longer needs a pay grant.`);
  } catch (e) {
    existing.set(r.key, info);
    render();
    note(false, `Could not change the grant flag: ${(e as Error).message}`);
  }
}

async function toggleHold(key: string): Promise<void> {
  const before = new Set(held);
  if (held.has(key)) held.delete(key); else held.add(key);
  render();
  try {
    await api('/admin/test-mode', { held: [...held] });
  } catch (e) {
    held.clear();
    for (const k of before) held.add(k);
    render();
    note(false, `Could not change the held keys: ${(e as Error).message}`);
  }
}

// ── 키 추가 (스키마 밖 그룹) ─────────────────────────────────

function closeAddPanel(): void {
  $('add-panel').hidden = true;
  $('btn-add-open').hidden = false;
  $<HTMLInputElement>('add-name').value = '';
  $<HTMLInputElement>('add-field').value = '';
  $<HTMLSelectElement>('add-type').value = 'text';
}

$('btn-add-open').addEventListener('click', () => {
  $('add-panel').hidden = false;
  $('btn-add-open').hidden = true;
  $<HTMLInputElement>('add-name').focus();
});
$('btn-add-discard').addEventListener('click', () => {
  closeAddPanel();
  $('add-full').textContent = `${current}.login.id`;
});
$('add-field').addEventListener('input', () => {
  $('add-full').textContent = `${current}.${$<HTMLInputElement>('add-field').value.trim() || 'login.id'}`;
});

$('btn-del-group').addEventListener('click', () => {
  void (async () => {
    const group = current;
    const stored = [...existing.keys()].filter((k) => !SCHEMA_KEYS.has(k) && groupOf(k) === group);
    const what = stored.length === 0
      ? `Delete the group ${group}?`
      : `Delete ${group} and the ${stored.length} ${stored.length === 1 ? 'value' : 'values'} stored under it? The values are gone for good.`;
    if (!confirm(what)) return;
    try {
      // 키를 명시해 보낸다 — 다이얼로그가 센 목록과 실제로 지워지는 목록이 같아야 한다
      if (stored.length > 0) await api('/vault/rm-keys', { keys: stored });
      newGroups.delete(group);
      pendingRows.delete(group);
      for (const k of stored) draft.delete(k);
      select(SECTIONS[0]!.id);
      note(true, `Deleted ${group}.`);
      await reload();
    } catch (e) {
      note(false, `Delete failed: ${(e as Error).message}`);
    }
  })();
});

$('btn-add-key').addEventListener('click', () => {
  const label = $<HTMLInputElement>('add-name').value.trim();
  const field = $<HTMLInputElement>('add-field').value.trim();
  if (!label || !field) return note(false, 'Enter a display name and a key name.');
  const key = `${current}.${field}`;
  if (!EXTRA_KEY.test(key)) return note(false, `Key names are group.subject.field — this group is ${current}, so type the two parts after it (e.g. login.id).`);
  if (existing.has(key) || (pendingRows.get(current) ?? []).some((p) => p.key === key)) {
    return note(false, `${key} is already in this group.`);
  }
  pendingRows.set(current, [...(pendingRows.get(current) ?? []), { key, type: $<HTMLSelectElement>('add-type').value, label }]);
  closeAddPanel();
  render();
  note(true, `Key ${key} added — it holds no value until you save one.`);
});

// ── 이름 없는 키 ─────────────────────────────────────────────

$('btn-seed').addEventListener('click', () => {
  void (async () => {
    try {
      const r = (await api('/vault/seed-labels', {})) as { seeded?: Array<{ key: string }> };
      const n = r.seeded?.length ?? 0;
      note(true, `Named ${n} ${n === 1 ? 'key' : 'keys'}. Status refreshed.`);
      await reload();
    } catch (e) {
      note(false, `Could not name the keys: ${(e as Error).message}`);
    }
  })();
});

// ── 금고 만들기 (금고 없음 화면) ─────────────────────────────

function setupState(): void {
  const p = $<HTMLInputElement>('setup-pass').value;
  const p2 = $<HTMLInputElement>('setup-pass2').value;
  $('btn-setup').dataset['save'] = p.length >= 8 && p === p2 ? 'on' : 'off';
}
$('setup-pass').addEventListener('input', setupState);
$('setup-pass2').addEventListener('input', setupState);

$('btn-setup').addEventListener('click', () => {
  const msg = $('setup-msg');
  const p = $<HTMLInputElement>('setup-pass').value;
  const p2 = $<HTMLInputElement>('setup-pass2').value;
  if (p.length < 8) { msg.hidden = false; msg.textContent = 'Use at least 8 characters.'; return; }
  if (p !== p2) { msg.hidden = false; msg.textContent = 'The two entries do not match.'; return; }
  msg.hidden = true;
  void (async () => {
    try {
      await api('/vault/create', { passphrase: p });
      $<HTMLInputElement>('setup-pass').value = '';
      $<HTMLInputElement>('setup-pass2').value = '';
      setupState();
      const span = ttlSpan();
      note(true, span === null ? 'Vault created — it is open now.' : `Vault created — it stays open for ${span}.`);
      await reload();
    } catch (e) {
      msg.hidden = false;
      msg.textContent = `The vault was not created: ${(e as Error).message}`;
    }
  })();
});

// ── 저장 ─────────────────────────────────────────────────────

$('btn-save').addEventListener('click', () => {
  if (vault !== 'open') return;
  const pending = enteredRows();
  if (pending.length === 0) return note(false, 'Nothing entered in this group.');
  // 형식이 틀린 게 하나라도 있으면 보내지 않는다 — 반쯤 저장된 상태를 만들지 않는다
  const bad = checkFields(pending.filter((r) => r.field).map((r) => ({ field: r.field!, value: valueOf(r.key) })));
  if (bad.length > 0) return note(false, `Nothing was saved. Expected format — ${bad.join(', ')}. The write is all-or-nothing, so fix it and save again.`);
  // 금고가 열려 있으면 바로 저장한다 (FWL-068) — 서버가 메모리의 패스프레이즈로 쓴다. 다시 묻지 않는다
  void saveGroup().catch((e: Error) => { note(false, e.message); });
});

async function saveGroup(): Promise<void> {
  const group = current;
  const pending = enteredRows();
  // 한 요청으로 보낸다 — 서버가 복호화·재암호화를 한 번만 하고, 전부 저장되거나 아무것도 저장되지 않는다
  const entries = pending.map((r) => ({ key: r.key, type: r.type, value: valueOf(r.key), grant: r.grant, label: r.label }));
  await api('/vault/set', { entries });
  const saved = new Set(entries.map((e) => e.key));
  for (const key of saved) { draft.delete(key); grantDraft.delete(key); }
  const left = (pendingRows.get(group) ?? []).filter((p) => !saved.has(p.key));
  if (left.length > 0) pendingRows.set(group, left); else pendingRows.delete(group);
  newGroups.delete(group);
  note(true, `Saved ${entries.length} ${entries.length === 1 ? 'key' : 'keys'} in ${titleOf(group)} — ${[...saved].join(', ')}. Status refreshed.`);
  await reload();
}

// ── Test Mode · 초기화 ───────────────────────────────────────

$('btn-test').addEventListener('click', () => { openDialog(testOn ? 'testOff' : 'testOn'); });
$('btn-reset').addEventListener('click', () => { openDialog('wipe'); });
$('btn-extend').addEventListener('click', () => { openDialog('extend'); });
for (const btn of document.querySelectorAll<HTMLButtonElement>('.btn-unlock')) {
  btn.addEventListener('click', () => { openDialog('unlock'); });
}

async function setTestMode(on: boolean): Promise<void> {
  const r = (await api('/admin/test-mode', { on })) as { on?: boolean };
  testOn = r.on === true;
  render();
  note(true, testOn ? 'Test Mode on — payment PINs are not typed.' : 'Test Mode off — payments are live.');
}

async function resetVault(): Promise<void> {
  await api('/vault/reset', {});
  existing = new Map();
  pendingRows.clear();
  newGroups.clear();
  draft.clear();
  grantDraft.clear();
  held.clear();
  current = SECTIONS[0]!.id;
  note(true, 'The vault and every value in it are gone. Set a new master password to start again.');
  await reload();
}

async function unlockVault(passphrase: string): Promise<void> {
  const r = await api('/vault/unlock', { passphrase });
  note(true, `Vault open for ${fmtRemain(Number(r['ttlMs'] ?? 0))}. Status refreshed.`);
  await reload();
}

function createGroup(name: string): void {
  const g = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (g === '') throw new Error('Enter a group name.');
  newGroups.add(g);
  current = g;
  render();
  $('add-panel').hidden = false;
  $('btn-add-open').hidden = true;
  note(true, `Key group ${g} created — add its first key below.`);
}

// ── 대화상자 (하나를 돌려 쓴다) ──────────────────────────────

function openDialog(kind: Dlg): void {
  dlg = kind;
  const span = ttlSpan();
  const needsPass = kind === 'unlock' || kind === 'extend';
  let title = '';
  let body = '';
  let action = '';
  if (kind === 'unlock') {
    title = 'Open the vault';
    body = span === null
      ? 'The vault stays open until it locks itself. Agents can fill only while it is open.'
      : `The vault stays open for ${span}, then locks itself. Agents can fill only while it is open.`;
    action = 'Open vault';
  } else if (kind === 'extend') {
    title = 'Extend the session';
    body = span === null
      ? `Resets the timer. The current session has ${fmtRemain(ttlMs)} left.`
      : `Resets the timer to a fresh ${span} from now. The current session has ${fmtRemain(ttlMs)} left.`;
    action = span === null ? 'Extend' : `Extend ${span}`;
  } else if (kind === 'group') {
    title = 'New key group';
    body = 'A group is the first part of every key inside it — example-shop holds example-shop.login.id. Nothing is written to the vault until its first key is saved.';
    action = 'Create group';
  } else if (kind === 'testOn') {
    title = 'Turn on Test Mode?';
    body = 'Payments stop going through: PINs are checked against their grant but never typed, and any key you hold back is left out of the run entirely.';
    action = 'Turn on';
  } else if (kind === 'testOff') {
    title = 'Leave Test Mode?';
    body = 'The next run pays for real. Every key fills for real, including the ones you were holding back.';
    action = 'Go live';
  } else if (kind === 'grantOff') {
    title = 'Stop requiring a pay grant?';
    body = `Any session will be able to fill ${grantOffRow?.label ?? 'this key'} without a pay grant from the calling service. Turning it back on takes one click.`;
    action = 'Turn it off';
  } else {
    title = 'Reset the vault?';
    body = 'Every registered key and its value is destroyed, along with the master password. You will set a new one before anything can be registered again. This cannot be undone.';
    action = 'Reset vault';
  }
  $('dlg-title').textContent = title;
  $('dlg-body').textContent = body;
  $('dlg-submit').textContent = action;
  $('dlg-submit').classList.toggle('danger', kind === 'wipe' || kind === 'grantOff');
  $('dlg-icon-pass').hidden = !needsPass;
  $('dlg-icon-test').hidden = !(kind === 'testOn' || kind === 'testOff');
  $('dlg-icon-group').hidden = kind !== 'group';
  $('dlg-pass-wrap').hidden = !needsPass;
  $('dlg-group-wrap').hidden = kind !== 'group';
  $('dlg-error').hidden = true;
  $<HTMLInputElement>('dlg-pass').value = '';
  $<HTMLInputElement>('dlg-group').value = '';
  $('dialog').hidden = false;
  ($(needsPass ? 'dlg-pass' : kind === 'group' ? 'dlg-group' : 'dlg-submit') as HTMLElement).focus();
}

function closeDialog(): void {
  dlg = null;
  grantOffRow = null;
  $('dialog').hidden = true;
  $<HTMLInputElement>('dlg-pass').value = '';
  $<HTMLInputElement>('dlg-group').value = '';
}

function dlgError(text: string): void {
  const p = $('dlg-error');
  p.hidden = false;
  p.textContent = text;
}

function submitDialog(): void {
  const kind = dlg;
  if (kind === null) return;
  const pass = $<HTMLInputElement>('dlg-pass').value;
  if (kind === 'group') {
    try {
      createGroup($<HTMLInputElement>('dlg-group').value);
      closeDialog();
    } catch (e) {
      dlgError((e as Error).message);
    }
    return;
  }
  if (kind === 'grantOff') {
    const r = grantOffRow;
    closeDialog();
    if (r !== null) void applyGrant(r, false);
    return;
  }
  const run = kind === 'unlock' || kind === 'extend' ? unlockVault(pass)
    : kind === 'wipe' ? resetVault()
      : setTestMode(kind === 'testOn');
  void run.then(() => { closeDialog(); }).catch((e: Error) => { dlgError(e.message); });
}

$('dlg-submit').addEventListener('click', () => { submitDialog(); });
$('dlg-cancel').addEventListener('click', () => { closeDialog(); });
$('dialog').addEventListener('click', (e) => { if (e.target === $('dialog')) closeDialog(); });
$('dialog-card').addEventListener('click', (e) => { e.stopPropagation(); });
for (const id of ['dlg-pass', 'dlg-group']) {
  $(id).addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); submitDialog(); }
  });
}
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dlg !== null) closeDialog(); });

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
    void reload();
    // TTL 만료·잠김·Test Mode를 레일에 반영한다. 상태가 바뀌었을 때만 목록을 다시 읽는다
    setInterval(() => {
      void (async () => {
        const before = vault;
        await refreshHealth();
        await refreshTestMode();
        if (before !== vault) await reload();
        else render();
      })();
    }, 30_000);
  } else {
    show('view-login');
  }
}

void bootstrap();
