/**
 * 프레임 트리 직렬화 (8.2).
 *
 * input/textarea의 value는 어떤 노드에도 실리지 않는다 (규칙 1).
 * vault로 채웠든 아니든, 어느 페이지든 예외 없다 — 호출자는 자기가 입력한
 * 것을 되읽을 이유가 없다.
 *
 * `SafeSnapshot`을 만드는 코드는 이 파일 하나뿐이다.
 *
 * 슬라이스 (FWL-043): `ref` 서브트리만, 또는 `filter: 'interactive'`(클릭·입력 대상만)로 출력을 줄인다.
 * 어느 쪽이든 수집·번호 매기기는 전문과 같다 — 페이지 전체를 문서 순서로 훑어 모든 요소에 ref를 주고,
 * 출력할 줄만 고른다. 그래서 DOM이 같으면 슬라이스와 전문의 ref index가 같다 (gen은 호출마다 오른다).
 */

import type { Ref, SafeSnapshot, SnapshotBody, SnapshotOptions } from '@wallet/core';
import type { ElementHandle, Frame, Page } from 'patchright';
import type { RefTable } from './refs.js';

/** 브랜딩 지점. 이 함수 밖에서 SafeSnapshot을 만들지 않는다 */
export function serialize(body: SnapshotBody): SafeSnapshot {
  return body as SafeSnapshot;
}

/**
 * 값을 담을 수 있는 요소 — 규칙 1의 경계선이다. 브라우저에서 사람이 글자를 쳐 넣을 수 있는 곳은
 * 이 셋뿐이라(select는 고르는 것), `fill`이 넣은 값은 정의상 전부 이 안에 있다.
 * 스냅샷은 이 안의 텍스트를 읽지 않고, page_image는 이 요소들을 마스크로 덮는다 (FWL-062).
 */
export const FIELD_SELECTOR = 'input,textarea,select,[contenteditable]';

/** filter: 'interactive'에서 남는 role — 클릭·입력 대상. heading·img·text 줄은 빠진다 */
const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'clickable']);

/**
 * 페이지 안에서 실행된다. 요소의 role·accessible name과 본문 텍스트를 한 번에 모은다 —
 * 어떤 경로로도 `.value`를 읽지 않는다 (규칙 1의 실제 방어 지점).
 * root(요소 또는 null)를 받아 각 요소가 그 안에 있는지(inside)만 표시한다 — 수집 범위는 항상 문서 전체다.
 * 텍스트가 같은 함수 안에 있는 이유 (FWL-059): 어떤 요소가 이름을 가져갔는지 알아야
 * 그 안의 텍스트를 건너뛸 수 있다. 두 번 evaluate 하면 그 집합을 넘길 방법이 없다.
 */
const COLLECT = `
((root, wantText) => {
  const SELECTOR = 'h1,h2,h3,h4,a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],img[alt]';
  // 정식 role이 없는 클릭 대상 (FWL-029) — <div class="cursor-pointer"> 팝업처럼 핸들러가 위임돼
  // 속성으로는 알 수 없는 버튼. 속성이 있거나 computed cursor:pointer이면서 텍스트가 있는 요소를 "clickable"로 준다
  const CLICK_ATTR = '[onclick],[tabindex]:not([tabindex="-1"])';
  const SKIP_TAG = new Set(['HTML', 'BODY', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'svg', 'path']);
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      if (t === 'hidden') return null;
      return 'textbox';
    }
    return null;
  };
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  // 폼 필드 자식을 제거한 사본에서 텍스트를 읽는다 — label이 textarea를 감싸면
  // textContent가 그 값(자식 텍스트 노드)까지 끌고 온다 (규칙 1)
  // contenteditable도 같이 턴다 — 그 안에 타이핑된 금고 값이 요소 이름으로 새어나간다
  const safeText = (el) => {
    // querySelectorAll은 자손만 잡는다 — 요소 자신이 contenteditable이면 여기서 끊어야 한다
    if (el.isContentEditable) return '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll('${FIELD_SELECTOR}').forEach((f) => f.remove());
    return copy.textContent;
  };
  // 요소 텍스트에서 온 이름 (FWL-059). 상품 카드 하나가 통째로 <a>라서 60자에서 자르면
  // 에이전트가 결제할 금액을 못 본다 — 잘려 나간 쪽에 가격이 있으면 끝에 붙인다.
  // 여러 개면 마지막 것: 정가 다음에 할인가가 오므로 그게 실제로 낼 금액이다
  const textName = (el) => {
    const full = (safeText(el) || '').replace(/\\s+/g, ' ').trim();
    if (full.length <= 60) return full;
    const cut = full.slice(0, 60);
    const prices = full.match(/\\d[\\d,]*\\s*원/g);
    const last = prices ? prices[prices.length - 1] : null;
    return last && cut.indexOf(last) === -1 ? cut + '… ' + last : cut + '…';
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    if (el.labels && el.labels.length > 0) return clean(safeText(el.labels[0]));
    const ph = el.getAttribute('placeholder');
    if (ph) return clean(ph);
    const alt = el.getAttribute('alt');
    if (alt) return clean(alt);
    const title = el.getAttribute('title');
    if (title) return clean(title);
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return '';
    return textName(el);
  };
  // 선택 상태 — 불리언만 (규칙 1은 value를 금한다, checked는 값이 아니다). 상태가 없는 요소는 null
  const stateOf = (el, role) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && (role === 'radio' || role === 'checkbox')) return !!el.checked;
    if (role === 'radio' || role === 'checkbox' || role === 'switch' || role === 'tab') {
      const v = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected') ?? el.getAttribute('aria-pressed');
      return v === 'true' ? true : v === 'false' ? false : null;
    }
    return null;
  };
  // 링크의 같은 origin 경로 — origin과 쿼리스트링을 뗀 pathname만 (쿼리에 토큰이 실릴 수 있다). 다른 origin·javascript:는 null
  const hrefOf = (el) => {
    if (el.tagName !== 'A') return null;
    try {
      const u = new URL(el.getAttribute('href') || '', location.href);
      if (u.origin !== location.origin || !u.pathname || u.pathname === location.pathname) return null;
      return u.pathname.slice(0, 80);
    } catch {
      return null;
    }
  };
  // 숨긴 native 라디오/체크박스 + 보이는 label 패턴(결제수단 선택 UI): input은 안 보여도 label이 보이면
  // label을 클릭 대상으로 노출한다 — 이름은 label, 상태는 input
  const labelTargetOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input') return null;
    const t = (el.getAttribute('type') || '').toLowerCase();
    if (t !== 'radio' && t !== 'checkbox') return null;
    const label = el.labels && el.labels.length > 0 ? el.labels[0] : null;
    return label && visible(label) ? label : null;
  };
  const hits = new Set(document.querySelectorAll(SELECTOR));
  // 자손에 정식 대상이 있는 컨테이너는 clickable이 아니다 — 카드 전체에 cursor:pointer가 걸려 있어도 안의 버튼이 대상이다
  const wraps = new Set();
  for (const h of hits) for (let p = h.parentElement; p && !wraps.has(p); p = p.parentElement) wraps.add(p);
  const accepted = new Set();
  const insideAccepted = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (accepted.has(p)) return true;
    return false;
  };
  const isClickable = (el) => {
    if (hits.has(el) || wraps.has(el) || SKIP_TAG.has(el.tagName)) return false;
    if (!/\\S/.test(el.textContent)) return false;
    if (el.parentElement && el.parentElement.closest(SELECTOR)) return false; // 정식 버튼 안의 텍스트
    if (insideAccepted(el)) return false; // 바깥쪽 clickable 하나만 — cursor는 자식에게 상속된다
    if (!visible(el)) return false;
    if (!el.matches(CLICK_ATTR) && getComputedStyle(el).cursor !== 'pointer') return false;
    return clean(safeText(el)) !== '';
  };
  const inside = (el) => (root ? root === el || root.contains(el) : true);
  // 푸터·법적 고지 영역 — lean 출력이 뺀다. 헤더는 건드리지 않는다 (로그인 표식이 거기 있다)
  const inFooter = (el) => !!el.closest('footer,[role="contentinfo"],#footer,.footer');
  // 링크·버튼 안의 이미지 — 그 링크·버튼 줄이 이미 카드를 대표한다 (상품 카드의 썸네일·적립 배지). lean이 뺀다
  const inAction = (el) => !!el.parentElement?.closest('a,button,[role="button"],[role="link"]');
  const meta = [];
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const hit = hits.has(el);
    if (!hit && !isClickable(el)) continue;
    const role = hit ? roleOf(el) : 'clickable';
    if (!role) continue;
    if (!hit) accepted.add(el);
    if (visible(el)) {
      out.push(el);
      meta.push({ role, name: nameOf(el), checked: stateOf(el, role), href: hrefOf(el), inside: inside(el), footer: inFooter(el), inAction: role === 'img' && inAction(el) });
      continue;
    }
    const label = labelTargetOf(el);
    if (!label) continue;
    out.push(label);
    meta.push({ role, name: clean(safeText(label)), checked: stateOf(el, role), href: null, inside: inside(el) || inside(label), footer: inFooter(label), inAction: false });
  }
  if (!wantText) return { els: out, meta, texts: [] };
  // 이름을 가져간 요소 — 그 안의 텍스트는 이미 요소 줄로 나왔으니 다시 내지 않는다.
  // 태그(A·BUTTON)로 자르던 것을 실제로 이름이 붙은 요소로 바꾼 것이다: heading·label·clickable div는
  // 태그로는 안 잡혀 제목과 라벨이 두 번씩 나왔다. 이름의 출처인 label도 같이 넣는다
  const named = new Set();
  for (let i = 0; i < out.length; i++) {
    if (meta[i].name === '') continue;
    named.add(out[i]);
    const ls = out[i].labels;
    if (ls) for (const l of ls) named.add(l);
  }
  // 본문 텍스트. input·textarea·select 내부의 텍스트 노드는 걷지 않는다 —
  // textarea의 자식 텍스트 노드는 곧 그 값이다 (innerText를 쓰지 않는 이유).
  // contenteditable 안의 텍스트도 같은 이유로 걷지 않는다 — 입력창 역할을 하는 요소의 내용이다 (규칙 1).
  // root가 있으면 그 아래만 걷는다 (슬라이스).
  const SKIP_TEXT = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE', 'NOSCRIPT']);
  const texts = [];
  const walker = document.createTreeWalker(root ?? document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && texts.length < 120) {
    const node = walker.currentNode;
    const p = node.parentElement;
    if (!p) continue;
    let skip = false;
    for (let el = p; el; el = el.parentElement) {
      if (SKIP_TEXT.has(el.tagName) || el.isContentEditable || named.has(el)) { skip = true; break; }
    }
    if (skip) continue;
    const s = getComputedStyle(p);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    const text = node.textContent.replace(/\\s+/g, ' ').trim();
    if (text.length >= 2) texts.push({ t: text.slice(0, 120), footer: !!p.closest('footer,[role="contentinfo"],#footer,.footer') });
  }
  return { els: out, meta, texts };
})
`;

// 문자열 그대로 evaluate 하면 결과(함수)가 직렬화되지 않아 undefined가 온다 — 런타임 함수로 감싸 인자를 넘긴다.
// 페이지 안에서 도는 본문은 위 문자열 그대로다 (규칙 1의 방어 지점은 바뀌지 않는다)
type PageFn = (arg: unknown) => unknown;
const collect = new Function('arg', `return (${COLLECT})(arg.root, arg.wantText)`) as PageFn;

function originOfFrame(frame: Frame): string {
  try {
    return new URL(frame.url()).origin;
  } catch {
    return 'null';
  }
}

type Scope = {
  /** 서브트리 슬라이스의 루트. 이 프레임 안의 요소일 때만 root를 넘긴다 */
  readonly root: ElementHandle | null;
  readonly rootFrame: Frame | null;
  readonly interactiveOnly: boolean;
};

type ElLine = {
  readonly kind: 'el';
  readonly depth: number;
  readonly role: string;
  readonly name: string;
  readonly checked: boolean | null;
  readonly href: string | null;
  readonly ref: Ref;
  readonly footer: boolean;
  /** 링크·버튼 안의 img — lean이 뺀다 */
  readonly inAction: boolean;
};

/** 출력 한 줄. 문자열로 만들기 전 단계 — lean 규칙이 여기서 고른다 */
type Line =
  | ElLine
  | { readonly kind: 'text'; readonly depth: number; readonly text: string; readonly footer: boolean }
  | { readonly kind: 'iframe'; readonly depth: number; readonly label: string; readonly origin: string };

/**
 * 프레임 하나를 훑는다. `emit`이 false여도 요소는 전부 refs에 넣는다 — 번호가 전문과 같아야 하기 때문이다.
 * 루트 프레임에서는 요소별 inside로, 자식 프레임은 iframe 요소가 루트 안인지로 출력 여부를 정한다
 */
async function renderFrame(frame: Frame, refs: RefTable, depth: number, lines: Line[], scope: Scope, emit: boolean): Promise<void> {
  const isRootFrame = scope.rootFrame === frame;
  const root = isRootFrame ? scope.root : null;

  const collected = await frame.evaluateHandle(collect, { root, wantText: emit && !scope.interactiveOnly } as unknown);
  const texts = (await (await collected.getProperty('texts')).jsonValue()) as ReadonlyArray<{ t: string; footer: boolean }>;
  const meta = (await (await collected.getProperty('meta')).jsonValue()) as ReadonlyArray<{
    role: string;
    name: string;
    checked: boolean | null;
    href: string | null;
    inside: boolean;
    footer: boolean;
    inAction: boolean;
  }>;
  const elsHandle = await collected.getProperty('els');
  const props = await elsHandle.getProperties();
  const handles = [...props.values()]
    .map((h) => h.asElement())
    .filter((h): h is ElementHandle => h !== null);
  await collected.dispose();
  await elsHandle.dispose();

  for (let i = 0; i < handles.length; i++) {
    const m = meta[i];
    const handle = handles[i];
    if (!m || !handle) continue;
    const ref = refs.put({ handle, role: m.role, name: m.name });
    if (!emit || !m.inside) continue;
    if (scope.interactiveOnly && !INTERACTIVE_ROLES.has(m.role)) continue;
    lines.push({ kind: 'el', depth, role: m.role, name: m.name, checked: m.checked, href: m.href, ref, footer: m.footer, inAction: m.inAction });
  }

  for (const { t, footer } of texts) lines.push({ kind: 'text', depth, text: t, footer });

  for (const child of frame.childFrames()) {
    let label = '';
    let childEmit = emit;
    try {
      const fe = await child.frameElement();
      label = await fe.evaluate(
        (el) => (el.getAttribute('title') || el.getAttribute('name') || '').slice(0, 60),
      );
      if (emit && root) childEmit = await root.evaluate((r, el) => r.contains(el), fe);
      await fe.dispose();
    } catch {
      // 프레임이 사이에 떨어져 나간 경우 — 스냅샷에서 제외
      continue;
    }
    if (childEmit) lines.push({ kind: 'iframe', depth, label, origin: originOfFrame(child) });
    await renderFrame(child, refs, depth + 1, lines, scope, childEmit);
  }
}

/** 같은 role·빈 이름이 이만큼 이어지면 한 줄로 접는다 (보안 키패드 모양). ref는 전부 유효하다 */
const FOLD_MIN = 3;

/**
 * lean (FWL-044, 기본. FWL-059 개정): **증명 가능하게 중복이거나 장식인 줄만** 뺀다.
 * 수집·번호는 건드리지 않으므로 남는 줄의 ref는 raw와 같다.
 *  - 이름 없는 img, 앞뒤 요소와 같은 이름의 img (썸네일 alt = 링크 이름), 링크·버튼 안의 img (카드 배지)
 *  - footer / contentinfo 영역의 요소와 텍스트 (헤더는 그대로 — 로그인 표식)
 * 본문 텍스트는 남긴다. 예전엔 가격처럼 보이는 줄만 남겼는데, 그건 뭐가 중요한지 **추측**한 규칙이었고
 * 클릭 결과·검증 오류·품절 표시가 그 추측에 걸려 사라졌다. 에이전트는 자기가 못 보고 있는 것을
 * 달라고 요청할 수 없어서 opt-in 플래그로는 구제되지 않는다.
 * 이미 어떤 요소의 이름으로 나온 텍스트는 애초에 수집되지 않는다 (COLLECT 안의 named).
 * raw: true면 아무것도 빼지 않는다
 */
function leanLines(all: ReadonlyArray<Line>): Line[] {
  const els = all.filter((l): l is ElLine => l.kind === 'el');
  const sameNameNeighbour = (l: ElLine): boolean => {
    const i = els.indexOf(l);
    const prev = els[i - 1];
    const next = els[i + 1];
    return (prev !== undefined && prev.name === l.name) || (next !== undefined && next.name === l.name);
  };
  return all.filter((l) => {
    if (l.kind === 'iframe') return true;
    if (l.footer) return false;
    if (l.kind === 'text') return true;
    if (l.role === 'img' && (l.name === '' || l.inAction || sameNameNeighbour(l))) return false;
    return true;
  });
}

/** 줄을 문자열로. fold면 같은 role·빈 이름의 연속(≥ FOLD_MIN)을 `×N [ref=first..last]` 한 줄로 접는다 */
function formatLines(lines: ReadonlyArray<Line>, fold: boolean): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as Line;
    const pad = '  '.repeat(l.depth);
    if (l.kind === 'text') {
      out.push(`${pad}- text "${l.text}"`);
      continue;
    }
    if (l.kind === 'iframe') {
      out.push(`${pad}- iframe "${l.label}" origin=${l.origin}`);
      continue;
    }
    if (fold && l.name === '') {
      let j = i;
      while (j + 1 < lines.length) {
        const n = lines[j + 1] as Line;
        if (n.kind !== 'el' || n.role !== l.role || n.name !== '' || n.depth !== l.depth) break;
        j++;
      }
      if (j - i + 1 >= FOLD_MIN) {
        out.push(`${pad}- ${l.role} "" ×${j - i + 1} [ref=${l.ref}..${(lines[j] as ElLine).ref}]`);
        i = j;
        continue;
      }
    }
    const state = l.checked === null ? '' : l.checked ? ' [checked]' : ' [unchecked]';
    const href = l.href === null ? '' : ` href=${l.href}`;
    out.push(`${pad}- ${l.role} "${l.name}"${state} [ref=${l.ref}]${href}`);
  }
  return out.join('\n');
}

/**
 * 새 세대를 열고 페이지 전체(프레임 포함)를 직렬화한다.
 * `root`는 이전 세대에서 해석한 ref의 핸들 — 새 세대를 열기 전에 호출자가 꺼내 둔다
 */
export async function buildSnapshot(
  page: Page,
  refs: RefTable,
  pages: number,
  opts: SnapshotOptions & { readonly root?: { readonly handle: ElementHandle; readonly ref: Ref } } = {},
): Promise<SafeSnapshot> {
  const rootFrame = opts.root ? await opts.root.handle.ownerFrame() : null;
  const gen = refs.newGeneration();
  const lines: Line[] = [];
  const scope: Scope = { root: opts.root?.handle ?? null, rootFrame, interactiveOnly: opts.filter === 'interactive' };
  await renderFrame(page.mainFrame(), refs, 0, lines, scope, true);
  const raw = opts.raw === true;
  const chosen = raw ? lines : leanLines(lines);
  return serialize({ gen, pages, url: page.url(), tree: formatLines(chosen, !raw) });
}
