/**
 * 금고 등록 페이지. backend 코드를 import하지 않는다 — HTTP API로만 통신
 * (금고 코드가 클라이언트 번들에 딸려 나가는 경로 차단).
 *
 * 값은 보내기만 하고 되돌아오지 않는다. 등록 여부는 /vault/list의
 * 이름·타입·길이로만 판정한다.
 */

import { EXTRA_KEY, SCHEMA_KEYS, SECTIONS, checkFields, type FieldDef, type KeyInfo } from './schema.js';
import { fmtRemain } from './format.js';
/** 현재 화면의 입력칸 — 저장 버튼 하나가 전부 훑는다 */
const inputs = new Map<string, { field: FieldDef; input: HTMLInputElement }>();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const passphrase = (): string => $<HTMLInputElement>('pass').value;

function token(): string | null {
  return sessionStorage.getItem('wallet-wsess');
}

function show(id: 'view-login' | 'view-main'): void {
  $('view-login').hidden = id !== 'view-login';
  $('view-main').hidden = id !== 'view-main';
}

// 메인 화면 메시지(#msg)는 우상단 토스트다 — 페이지가 길어 하단 알림은 스크롤해야 보인다. 성공은 4초, 실패는 10초 뒤 사라진다
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
function note(el: string, ok: boolean, text: string): void {
  const m = $(el);
  m.hidden = false;
  m.className = `msg ${ok ? 'ok' : 'err'}`;
  m.textContent = text;
  if (el !== 'msg') return;
  clearTimeout(toastTimers.get(el));
  toastTimers.set(el, setTimeout(() => { m.hidden = true; }, ok ? 4_000 : 10_000));
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
    throw new Error('로그인이 만료됐다 — 다시 로그인');
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
    if (res.ok && json?.ok && json.token) {
      sessionStorage.setItem('wallet-wsess', json.token);
      $<HTMLInputElement>('login-pass').value = '';
      show('view-main');
      void refreshHealth();
      void refreshDryRun();
      return;
    }
    if (res.status === 429) {
      note('login-msg', false, `잠금 상태 — ${json?.retryAfterSeconds ?? '?'}초 후 재시도`);
    } else {
      const left = json?.attemptsLeft !== undefined ? ` (남은 시도 ${json.attemptsLeft}회)` : '';
      note('login-msg', false, `로그인 실패${left}`);
    }
  })();
});

$('btn-logout').addEventListener('click', () => {
  sessionStorage.removeItem('wallet-wsess');
  show('view-login');
});

// ── 등록 현황 ─────────────────────────────────────────────────

async function refreshHealth(): Promise<void> {
  try {
    const r = (await (await fetch('/health')).json()) as {
      vaultLocked?: boolean; vaultExists?: boolean; vaultTtlMs?: number;
    };
    const exists = r.vaultExists !== false;
    // unlock은 CLI(wallet unlock) 또는 아래 "서버 금고 열기" 버튼 — 같은 /vault/unlock이다. 헤더는 상태만 보여준다
    $('vault-state').textContent = !exists
      ? '보관함 미생성 · 첫 저장 시 마스터 비밀번호 확정'
      : r.vaultLocked
        ? '서버 보관함: 잠김 (등록은 가능 · 에이전트는 사용 불가)'
        : `서버 보관함: 열림 · ${fmtRemain(r.vaultTtlMs ?? 0)} 남음`;
  } catch {
    $('vault-state').textContent = '서버 연결 안 됨';
  }
}

// ── dry-run 토글 ─────────────────────────────────────────────
// 켜져 있으면 결제 비밀번호(require_grant 키) fill이 grant 검증까지만 하고 입력하지 않는다.
// 실결제 없이 E2E를 돌리는 스위치 — 켜진 채 두면 실주행이 조용히 결제 없이 끝나므로 배지를 크게 띄운다

function renderDryRun(on: boolean): void {
  $('dry-badge').hidden = !on;
  const btn = $<HTMLButtonElement>('btn-dry');
  btn.hidden = false;
  btn.textContent = on ? 'DRY RUN 끄기' : 'DRY RUN 켜기';
  btn.className = on ? 'danger' : 'ghost';
}

async function refreshDryRun(): Promise<void> {
  try {
    const res = await fetch('/admin/dry-run', { headers: { authorization: `Bearer ${token() ?? ''}` } });
    const r = (await res.json().catch(() => null)) as { ok?: boolean; on?: boolean } | null;
    if (res.ok && r?.ok) renderDryRun(r.on === true);
  } catch {
    /* 헤더 상태일 뿐이다 — 다음 폴링에서 다시 */
  }
}

$('btn-dry').addEventListener('click', () => {
  void (async () => {
    const on = $('dry-badge').hidden; // 지금 꺼져 있으면 켠다
    if (on && !confirm('DRY RUN을 켜면 결제 비밀번호를 입력하지 않는다 — 실주행 전에 반드시 끌 것. 켤까?')) return;
    try {
      const r = (await api('/admin/dry-run', { on })) as { on?: boolean };
      renderDryRun(r.on === true);
      note('msg', true, r.on ? 'DRY RUN 켜짐 — 결제 PIN은 입력되지 않는다' : 'DRY RUN 꺼짐 — 실결제 모드');
    } catch (e) {
      note('msg', false, `dry-run 변경 실패: ${(e as Error).message}`);
    }
  })();
});

function renderSections(existing: Map<string, KeyInfo>): void {
  const root = $('sections');
  root.textContent = '';
  inputs.clear();
  for (const section of SECTIONS) {
    const card = document.createElement('section');
    card.className = 'card';

    const filled = section.fields.filter((f) => existing.has(f.key)).length;
    const summary = document.createElement('span');
    summary.className = 'summary';
    summary.textContent = `${filled}/${section.fields.length} 등록됨`;
    card.appendChild(summary);

    const h = document.createElement('h2');
    h.textContent = section.title;
    card.appendChild(h);

    for (const field of section.fields) card.appendChild(renderField(field, existing.get(field.key)));
    root.appendChild(card);
  }
  renderExtras(existing);
}

function renderField(field: FieldDef, info: KeyInfo | undefined): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.dataset['key'] = field.key;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = field.label;
  if (field.hint) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = field.hint;
    label.appendChild(hint);
  }

  const badge = document.createElement('span');
  badge.className = `badge ${info ? 'filled' : 'empty'}`;
  badge.textContent = info ? `등록됨 · ${info.len}자` : '미등록';

  const input = document.createElement('input');
  // 화면 마스킹은 CVV·카드 비번만 — 나머지는 사람이 확인하며 적도록 평문 표시
  input.type = field.secret ? 'password' : 'text';
  input.autocomplete = 'off';
  input.placeholder = info ? '새 값 입력 시 덮어씀' : '';
  inputs.set(field.key, { field, input });

  const del = document.createElement('button');
  del.className = 'danger';
  del.textContent = '삭제';
  del.hidden = !info;
  del.addEventListener('click', () => {
    void (async () => {
      if (!confirm(`${field.label} 값을 삭제할까?`)) return;
      try {
        await api('/vault/rm', { passphrase: passphrase(), key: field.key });
        note('msg', true, `${field.label} 삭제됨`);
        await refreshList();
      } catch (e) {
        note('msg', false, `삭제 실패: ${(e as Error).message}`);
      }
    })();
  });

  row.append(label, badge, input, del);
  return row;
}

function renderExtras(existing: Map<string, KeyInfo>): void {
  const extras = [...existing.values()].filter((k) => !SCHEMA_KEYS.has(k.name));
  const table = $<HTMLTableElement>('extra-keys');
  const tbody = table.querySelector('tbody')!;
  tbody.textContent = '';
  table.hidden = extras.length === 0;
  for (const k of extras) {
    const tr = document.createElement('tr');
    for (const v of [k.name, k.type, String(k.len)]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    const td = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '삭제';
    del.addEventListener('click', () => {
      void (async () => {
        if (!confirm(`${k.name} 삭제?`)) return;
        try {
          await api('/vault/rm', { passphrase: passphrase(), key: k.name });
          await refreshList();
        } catch (e) {
          note('msg', false, `삭제 실패: ${(e as Error).message}`);
        }
      })();
    });
    td.appendChild(del);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

async function refreshList(): Promise<void> {
  const r = (await api('/vault/list', { passphrase: passphrase() })) as unknown as { keys: KeyInfo[] };
  renderSections(new Map(r.keys.map((k) => [k.name, k])));
}

// 불러오기 = 목록 조회 + 서버 금고 unlock (CLI `wallet unlock`과 같은 /vault/unlock). 패스프레이즈는 한 번 입력해서
// 두 요청에 실리고 저장하지 않는다. 목록이 먼저다 — 패스프레이즈가 틀리면 거기서 끝나고 unlock 시도는 없다
$('btn-refresh').addEventListener('click', () => {
  void (async () => {
    if (!passphrase()) throw new Error('마스터 비밀번호를 입력해야 한다');
    await refreshList();
    const r = await api('/vault/unlock', { passphrase: passphrase() });
    await refreshHealth();
    note('msg', true, `등록 현황 갱신됨 · 서버 보관함 열림 (${fmtRemain(Number(r['ttlMs'] ?? 0))} 유지)`);
  })().catch((e: Error) => note('msg', false, `불러오기 실패: ${e.message}`));
});

$('btn-save-all').addEventListener('click', () => {
  void (async () => {
    // 앞뒤 공백은 잘라서 저장한다 — 복사·붙여넣기로 딸려오는 공백이 값의 일부가 되지 않게
    for (const { input } of inputs.values()) input.value = input.value.trim();
    const pending = [...inputs.values()].filter(({ input }) => input.value.length > 0);
    if (pending.length === 0) return note('msg', false, '입력한 항목이 없다');
    // 형식이 틀린 게 하나라도 있으면 아무것도 저장하지 않는다 — 반쯤 저장된 상태를 만들지 않는다
    const bad = checkFields(pending.map(({ field, input }) => ({ field, value: input.value })));
    if (bad.length > 0) return note('msg', false, `형식 확인: ${bad.join(', ')}`);
    // 한 요청으로 보낸다 — 서버가 복호화·재암호화를 한 번만 하고, 전부 저장되거나 아무것도 저장되지 않는다
    try {
      await api('/vault/set', {
        passphrase: passphrase(),
        entries: pending.map(({ field, input }) => ({ key: field.key, type: field.type, value: input.value })),
      });
      for (const { input } of pending) input.value = '';
      note('msg', true, `저장됨: ${pending.map(({ field }) => field.label).join(', ')}`);
    } catch (e) {
      note('msg', false, `저장 실패 (아무것도 저장되지 않음): ${(e as Error).message}`);
    }
    void refreshHealth();
    await refreshList().catch(() => {});
  })();
});

$('btn-free-save').addEventListener('click', () => {
  void (async () => {
    const key = $<HTMLInputElement>('free-key').value.trim();
    const value = $<HTMLInputElement>('free-value').value.trim();
    if (!EXTRA_KEY.test(key)) return note('msg', false, '키 이름은 범위.항목 또는 범위.인스턴스.항목 (예: example-shop.payment.pinnumber)');
    try {
      await api('/vault/set', { passphrase: passphrase(), key, type: $<HTMLSelectElement>('free-type').value, value });
      $<HTMLInputElement>('free-key').value = '';
      $<HTMLInputElement>('free-value').value = '';
      note('msg', true, `${key} 저장됨`);
      void refreshHealth();
      await refreshList();
    } catch (e) {
      note('msg', false, `저장 실패: ${(e as Error).message}`);
    }
  })();
});

// ── 초기화 ───────────────────────────────────────────────────

renderSections(new Map()); // 로그인 전에도 골격은 그려둔다 (전부 미등록 표시)

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
    setInterval(() => { void refreshHealth(); void refreshDryRun(); }, 30_000); // TTL 만료·첫 저장·dry-run을 헤더에 반영
  } else {
    show('view-login');
  }
}

void bootstrap();
