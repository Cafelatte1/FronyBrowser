/**
 * 규칙 1의 회귀 테스트 — 삭제하거나 skip하지 않는다.
 *
 * 로컬 http 서버 2개로 cross-origin iframe(PG 결제창 모사)을 구성해
 * 프레임 origin 판정까지 실브라우저로 검증한다.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Ref, SessionId } from '@wallet/core';
import { decodePng } from '@wallet/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserPool, createPlaywrightTarget, TargetError } from '@wallet/app';

const SECRET = 'SECRET-PREFILLED-VALUE-98765';
const CARD_TYPED = '1111222233334444';

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

let pgServer: Server;
let shopServer: Server;
const pool = createBrowserPool();
const target = createPlaywrightTarget(pool);
const sid = 's_test' as SessionId;

beforeAll(async () => {
  pgServer = await serve(`
    <h2>카드 결제</h2>
    <label>카드번호 <input id="card" autocomplete="cc-number"></label>
    <button>결제하기</button>
  `);
  shopServer = await serve(`
    <h1>주문서</h1>
    <label>받는분 <input id="name" value="${SECRET}"></label>
    <label>메모 <textarea id="memo">${SECRET}</textarea></label>
    <div contenteditable="true"><p>${SECRET}</p></div>
    <div class="order-total"><span class="price">총 결제금액 15,000원</span></div>
    <fieldset id="pay-method">
      <input type="radio" name="pm" id="pm-cash" style="display:none"><label for="pm-cash">포인트 충전결제</label>
      <input type="radio" name="pm" id="pm-simplepay" style="display:none" checked><label for="pm-simplepay">간편결제 계좌·카드</label>
      <div role="radio" aria-checked="false" tabindex="0">다른 결제수단</div>
    </fieldset>
    <iframe title="결제" src="${originOf(pgServer)}/pay"></iframe>
    <div id="popup" style="cursor:pointer"><span>추가금액 없이</span> 구매하기</div>
    <div style="cursor:pointer"><button>카드 안의 버튼</button> 카드 설명</div>
    <div id="popup-status"></div>
    <div id="card-select" style="cursor:pointer">카드를 선택해주세요<ul><li>신한카드</li><li>KB국민카드</li><li>BC카드(페이북)</li><li>현대카드</li><li>롯데카드</li><li>하나카드</li><li>삼성카드</li><li>우리카드</li><li>씨티카드</li><li>NH카드</li><li>카카오뱅크카드</li></ul></div>
    <div role="button" tabindex="0" id="cart-area">장바구니 영역 <button>장바구니 담기</button> <button>바로구매</button></div>
    <a href="/vp/products/1?token=abc" target="_blank">상세 보기</a>
    <a href="${originOf(pgServer)}/outside">외부 링크</a>
    <label>비밀번호 <input id="pw" type="password"></label>
    <label>비밀번호 확인 <input id="pw2" type="password" disabled></label>
    <label>읽기전용 <input id="ro" readonly></label>
    <button disabled>가입하기</button>
    <a href="/goods/1">상품A</a><img alt="상품A" src="data:,"><img alt="" src="data:,">
    <a href="/goods/2">상품B<img alt="최대 500원 적립" src="data:,"></a><img alt="배송 아이콘" src="data:,">
    <div id="scrollbox" style="height:60px;overflow:auto" onscroll="document.getElementById('scroll-status').textContent='컨테이너 스크롤됨'"><div style="height:400px"></div><button>깊은 버튼</button></div>
    <div id="scroll-status"></div>
    <div><button></button><button></button><button></button></div>
    <a href="/goods/3">긴이름 상품 <span>정말 아주 길고 긴 상품 설명이 이어지는 카드입니다 넉넉하게 담아 두고 드세요</span> 24,900원 32% 16,900원</a>
    <p>배송은 보통 이틀 걸립니다</p>
    <footer><a href="/terms">이용약관</a><p>사업자등록번호 000-00-00000</p></footer>
    <script>
      // keyup에 걸린 규칙 검사 — Playwright fill()로는 절대 안 풀리고 실제 타이핑으로만 풀린다 (FWL-075)
      document.getElementById('pw').addEventListener('keyup', (e) => { document.getElementById('pw2').disabled = e.target.value.length < 4; });
      document.addEventListener('click', (e) => {
        if (e.target.closest('#popup')) document.getElementById('popup-status').textContent = '팝업 통과';
      });
    </script>
  `);
  await target.open(sid, { origin: originOf(shopServer), kind: 'browser', browser: 'chromium', headless: true });
  await target.act(sid, { kind: 'navigate', url: `${originOf(shopServer)}/checkout` });
}, 60_000);

afterAll(async () => {
  await target.close(sid);
  await pool.shutdown();
  pgServer?.close();
  shopServer?.close();
});

function refOf(tree: string, role: string, name: string): Ref {
  const line = tree.split('\n').find((l) => l.includes(`${role} "${name}"`));
  const m = line?.match(/\[ref=([^\]]+)\]/);
  if (!m) throw new Error(`ref not found for ${role} "${name}"`);
  return m[1] as Ref;
}

describe('snapshot — 규칙 1', () => {
  it('미리 채워진 input/textarea 값이 스냅샷에 없다', async () => {
    const snap = await target.snapshot(sid);
    expect(snap.tree).not.toContain(SECRET);
    expect(snap.tree).toContain('- heading "주문서"');
    expect(snap.tree).toContain('textbox "받는분'); // 요소 자체는 보인다
  }, 30_000);

  it('contenteditable 안의 텍스트도 없다 — 입력창 역할을 하는 요소의 내용이다', async () => {
    const snap = await target.snapshot(sid);
    expect(snap.tree).not.toContain(SECRET);
  }, 30_000);

  it('본문 텍스트(금액)는 보인다 — expect 대조의 전제', async () => {
    const snap = await target.snapshot(sid);
    expect(snap.tree).toContain('총 결제금액 15,000원');
  }, 30_000);

  it('iframe 노드에 자식 프레임 origin이 표기되고, 그 안의 요소가 잡힌다', async () => {
    const snap = await target.snapshot(sid);
    expect(snap.tree).toContain(`- iframe "결제" origin=${originOf(pgServer)}`);
    expect(snap.tree).toContain('textbox "카드번호');
  }, 30_000);

  it('숨긴 native 라디오는 label로 노출되고 [checked] 상태가 보인다, label 클릭으로 전환된다 (FWL-031)', async () => {
    let snap = await target.snapshot(sid);
    expect(snap.tree).toContain('- radio "간편결제 계좌·카드" [checked] [ref=');
    expect(snap.tree).toContain('- radio "포인트 충전결제" [unchecked] [ref=');
    expect(snap.tree).toContain('- radio "다른 결제수단" [unchecked] [ref='); // aria-checked
    await target.act(sid, { kind: 'click', ref: refOf(snap.tree, 'radio', '포인트 충전결제') });
    snap = await target.snapshot(sid);
    expect(snap.tree).toContain('- radio "포인트 충전결제" [checked] [ref=');
    expect(snap.tree).toContain('- radio "간편결제 계좌·카드" [unchecked] [ref=');
  }, 30_000);

  it('속성 없는 cursor:pointer div가 clickable로 잡히고 click이 동작한다 (FWL-029)', async () => {
    let snap = await target.snapshot(sid);
    const clickables = snap.tree.split('\n').filter((l) => l.includes('- clickable "'));
    // 바깥 div 하나만 — 안의 span은 따로 잡지 않고, 정식 버튼을 품은 카드도 잡지 않는다.
    // 드롭다운도 바깥 한 줄뿐이다: 안쪽 항목은 ref 슬라이스에서만 풀린다 (FWL-077)
    expect(clickables).toEqual([
      expect.stringContaining('- clickable "추가금액 없이 구매하기" [ref='),
      expect.stringContaining('- clickable "카드를 선택해주세요신한카드'),
    ]);
    expect(snap.tree).toContain('- button "카드 안의 버튼" [ref=');
    await target.act(sid, { kind: 'click', ref: refOf(snap.tree, 'clickable', '추가금액 없이 구매하기') });
    snap = await target.snapshot(sid);
    expect(snap.tree).toContain('- text "팝업 통과"'); // 클릭 결과는 기본 출력에 있어야 한다 (FWL-059)
  }, 30_000);

  it('disabled·readonly가 트리에 보이고, 실제 타이핑이 keyup 검사를 통과시켜 다음 칸을 연다 (FWL-075)', async () => {
    let snap = await target.snapshot(sid);
    expect(snap.tree).toContain('- textbox "비밀번호 확인" [disabled] [ref=');
    expect(snap.tree).toContain('- textbox "읽기전용" [readonly] [ref=');
    expect(snap.tree).toContain('- button "가입하기" [disabled] [ref=');
    await target.act(sid, { kind: 'fill', ref: refOf(snap.tree, 'textbox', '비밀번호'), value: 'abcd1234' });
    snap = await target.snapshot(sid);
    expect(snap.tree).toContain('- textbox "비밀번호 확인" [ref=');
    expect(snap.tree).not.toContain('- textbox "비밀번호 확인" [disabled]');
    await target.act(sid, { kind: 'fill', ref: refOf(snap.tree, 'textbox', '비밀번호 확인'), value: 'abcd1234' });
    // 다시 채우면 덧붙지 않고 바꾼다 — 타이핑 전에 비운다
    await target.act(sid, { kind: 'fill', ref: refOf(snap.tree, 'textbox', '비밀번호'), value: 'xy' });
    snap = await target.snapshot(sid);
    expect(snap.tree).toContain('- textbox "비밀번호 확인" [disabled] [ref='); // 2자 → 다시 잠긴다 = 값이 교체됐다
  }, 30_000);

  it('접힌 클릭 대상이 삼킨 목록은 ref 슬라이스에서 항목마다 줄과 ref로 풀린다 (FWL-077)', async () => {
    const refFrom = (tree: string, needle: string): Ref => {
      const m = tree.split(/\r?\n/).find((l) => l.includes(needle))?.match(/\[ref=([^\]]+)\]/);
      if (!m) throw new Error(`ref not found: ${needle}`);
      return m[1] as Ref;
    };
    // 기본 트리: 항목 열한 개가 부모 한 줄의 이름으로 이어붙고, 60자에서 잘려 뒤쪽 항목은 이름만으로 확인이 안 된다
    const snap = await target.snapshot(sid);
    const swallowed = snap.tree.split(/\r?\n/).find((l) => l.includes('카드를 선택해주세요'));
    expect(swallowed).toContain('- clickable "카드를 선택해주세요신한카드KB국민카드');
    expect(swallowed).toContain('…');
    expect(snap.tree).not.toContain('"카카오뱅크카드"');

    // raw로도 안 풀린다 — raw는 수집이 아니라 출력만 바꾼다. 수집에서 빠진 항목은 어떤 모드로도 안 나온다
    const rawSnap = await target.snapshot(sid, { raw: true });
    expect(rawSnap.tree).not.toContain('"카카오뱅크카드"');

    const latest = await target.snapshot(sid);
    const sliced = await target.snapshot(sid, { ref: refFrom(latest.tree, '카드를 선택해주세요') });
    expect(sliced.tree).toContain('- clickable "신한카드"');
    expect(sliced.tree).toContain('- clickable "카카오뱅크카드"');
    const refs = [...sliced.tree.matchAll(/\[ref=([^\]]+)\]/g)].map((m) => m[1]);
    expect(new Set(refs).size).toBe(refs.length); // 항목마다 제 ref다
  }, 30_000);

  it('fill 이후에도 값은 스냅샷에 나타나지 않는다', async () => {
    let snap = await target.snapshot(sid);
    const cardRef = refOf(snap.tree, 'textbox', '카드번호');
    await target.act(sid, { kind: 'fill', ref: cardRef, value: CARD_TYPED });
    snap = await target.snapshot(sid);
    expect(snap.tree).not.toContain(CARD_TYPED);
    expect(snap.tree).not.toContain('4444');
  }, 30_000);
});

describe('originOf — 규칙 4', () => {
  it('카드 필드의 origin은 최상위가 아니라 PG 프레임이다', async () => {
    const snap = await target.snapshot(sid);
    const cardRef = refOf(snap.tree, 'textbox', '카드번호');
    const nameRef = refOf(snap.tree, 'textbox', '받는분');
    expect(await target.originOf(sid, cardRef)).toBe(originOf(pgServer));
    expect(await target.originOf(sid, nameRef)).toBe(originOf(shopServer));
  }, 30_000);
});

describe('ref 세대 — 8.1', () => {
  it('새 스냅샷 후 옛 ref는 stale_ref로 실패한다', async () => {
    const snap = await target.snapshot(sid);
    const oldRef = refOf(snap.tree, 'button', '결제하기');
    await target.snapshot(sid); // 세대 교체
    await expect(target.act(sid, { kind: 'click', ref: oldRef })).rejects.toMatchObject({
      code: 'stale_ref',
    });
  }, 30_000);

  it('없는 세션은 session_not_found', async () => {
    await expect(target.snapshot('s_nope' as SessionId)).rejects.toBeInstanceOf(TargetError);
  });
});

describe('status — 세션 상태 조회 (FWL-008)', () => {
  it('현재 URL·페이지 수·스냅샷 세대를 준다', async () => {
    const before = await target.status(sid);
    expect(before.url).toContain(originOf(shopServer));
    expect(before.pages).toEqual([{ index: 0, url: `${originOf(shopServer)}/checkout`, current: true }]);
    await target.snapshot(sid);
    const after = await target.status(sid);
    expect(after.snapshotGen).toBe(before.snapshotGen + 1);
  }, 30_000);
});

describe('extract — 표시 텍스트 읽기', () => {
  it('셀렉터로 표시 텍스트를 읽는다', async () => {
    expect(await target.extract(sid, '.order-total .price')).toBe('총 결제금액 15,000원');
  }, 30_000);

  it('없는 셀렉터는 null', async () => {
    expect(await target.extract(sid, '.does-not-exist')).toBeNull();
  }, 30_000);
});

describe('snapshot 슬라이스 (FWL-043) — 번호는 전문과 같고 출력만 준다', () => {
  const refOf = (tree: string, label: string): string => {
    const line = tree.split('\n').find((l) => l.includes(`"${label}" [ref=`));
    if (!line) throw new Error(`no ref for ${label}`);
    return line.slice(line.indexOf('[ref=') + 5, line.indexOf(']', line.indexOf('[ref=')));
  };
  const indexOf = (ref: string): string => ref.split(':')[1] as string;

  it('filter interactive — heading·img·text 줄이 빠지고, 같은 버튼의 index가 전문과 같다', async () => {
    const full = await target.snapshot(sid);
    const lean = await target.snapshot(sid, { filter: 'interactive' });
    expect(lean.tree.split('\n').length).toBeLessThan(full.tree.split('\n').length);
    expect(lean.tree).not.toContain('- heading');
    expect(lean.tree).not.toContain('- text "');
    expect(lean.tree).toContain('button "장바구니 담기"');
    expect(indexOf(refOf(lean.tree, '장바구니 담기'))).toBe(indexOf(refOf(full.tree, '장바구니 담기')));
    expect(indexOf(refOf(lean.tree, '결제하기'))).toBe(indexOf(refOf(full.tree, '결제하기'))); // iframe 안도 같은 번호
    expect(lean.gen).toBe(full.gen + 1);
  }, 30_000);

  it('ref 서브트리 — 그 아래만 주고, 번호는 전문과 같다', async () => {
    const full = await target.snapshot(sid);
    const area = refOf(full.tree, '장바구니 영역 장바구니 담기 바로구매');
    const part = await target.snapshot(sid, { ref: area as Ref });
    expect(part.tree).toContain('button "장바구니 담기"');
    expect(part.tree).toContain('button "바로구매"');
    expect(part.tree).not.toContain('주문서');
    expect(part.tree).not.toContain('결제하기');
    expect(indexOf(refOf(part.tree, '바로구매'))).toBe(indexOf(refOf(full.tree, '바로구매')));
    // 슬라이스도 새 세대다 — 전문의 ref는 stale
    await expect(target.act(sid, { kind: 'click', ref: area as Ref })).rejects.toMatchObject({ code: 'stale_ref' });
  }, 30_000);

  it('지난 세대의 ref로 슬라이스하면 stale_ref', async () => {
    const full = await target.snapshot(sid);
    const area = refOf(full.tree, '장바구니 영역 장바구니 담기 바로구매');
    await target.snapshot(sid);
    await expect(target.snapshot(sid, { ref: area as Ref })).rejects.toMatchObject({ code: 'stale_ref' });
  }, 30_000);

  it('같은 origin 링크는 href=경로(쿼리 제거), 다른 origin 링크는 href 없음', async () => {
    const snap = await target.snapshot(sid);
    expect(snap.tree).toMatch(/link "상세 보기" \[ref=[^\]]+\] href=\/vp\/products\/1$/m);
    expect(snap.tree).toMatch(/link "외부 링크" \[ref=[^\]]+\]$/m);
    expect(snap.tree).not.toContain('token=abc');
  }, 30_000);
});

describe('새 탭 자동 추적 (FWL-043)', () => {
  it('click이 새 탭을 열면 그 탭이 현재 페이지가 된다 — click url·status·snapshot 모두, 옛 ref는 stale', async () => {
    const before = await target.snapshot(sid);
    const link = before.tree.match(/link "상세 보기" \[ref=([^\]]+)\]/)?.[1] as Ref;
    const r = await target.act(sid, { kind: 'click', ref: link });
    expect(r.url).toContain('/vp/products/1');
    const st = await target.status(sid);
    expect(st.url).toContain('/vp/products/1');
    expect(st.pages?.map((p) => p.current)).toEqual([false, true]);
    expect(st.pages?.[1]?.url).toBe(`${originOf(shopServer)}/vp/products/1`); // 쿼리스트링 없음
    await expect(target.act(sid, { kind: 'click', ref: link })).rejects.toMatchObject({ code: 'stale_ref' });
    const after = await target.snapshot(sid);
    expect(after.url).toContain('/vp/products/1');
    expect(after.pages).toBe(2);
    expect(after.tree).toContain('button "장바구니 담기"'); // 새 탭의 DOM이 준비된 뒤 찍힌다
  }, 30_000);

  it('page_switch로 원래 탭에 돌아오면 골라둔 상태가 그대로이고 새 snapshot의 ref가 유효하다; 다음 새 탭은 다시 auto-follow', async () => {
    await expect(target.switchPage(sid, 9)).rejects.toMatchObject({ code: 'stale_ref' });
    await target.switchPage(sid, 0);
    const st = await target.status(sid);
    expect(st.url).toContain('/checkout');
    expect(st.pages?.[0]?.current).toBe(true);
    const snap = await target.snapshot(sid);
    expect(snap.url).toContain('/checkout');
    expect(snap.tree).toMatch(/radio "[^"]+" \[checked\]/); // 원래 탭의 라디오 선택 상태 그대로
    const link = snap.tree.match(/link "상세 보기" \[ref=([^\]]+)\]/)?.[1] as Ref;
    const r = await target.act(sid, { kind: 'click', ref: link }); // 유효한 ref로 다시 새 탭
    expect(r.url).toContain('/vp/products/1');
    const st2 = await target.status(sid);
    expect(st2.pages?.map((p) => p.current)).toEqual([false, false, true]);
  }, 30_000);
});

describe('lean 기본 출력 (FWL-044, FWL-059) — 장식과 중복만 빼고, 남는 ref는 raw와 같다', () => {
  const refOf2 = (tree: string, label: string): string => {
    const line = tree.split('\n').find((l) => l.includes(`"${label}" [ref=`));
    if (!line) throw new Error(`no ref for ${label}`);
    return line.slice(line.indexOf('[ref=') + 5, line.indexOf(']', line.indexOf('[ref=')));
  };
  const idx = (ref: string): string => ref.split(':')[1] as string;

  it('이름 없는 img·인접 요소와 같은 이름의 img·푸터가 빠지고, 빈 이름 연속은 ×N으로 접힌다', async () => {
    const lean = await target.snapshot(sid);
    const raw = await target.snapshot(sid, { raw: true });
    expect(lean.tree.split('\n').length).toBeLessThan(raw.tree.split('\n').length);
    expect(lean.tree).not.toContain('- img "" [ref=');
    expect(lean.tree).not.toContain('- img "상품A"');
    expect(lean.tree).not.toContain('최대 500원 적립'); // 링크 안의 배지 img
    expect(lean.tree).toContain('- img "배송 아이콘"'); // 링크 밖의, 이름이 유일한 img는 남는다
    expect(lean.tree).toContain('- link "상품A" [ref=');
    expect(lean.tree).not.toContain('이용약관');
    expect(lean.tree).not.toContain('사업자등록번호');
    expect(lean.tree).toContain('배송은 보통 이틀'); // 본문은 남는다 — 가격만 남기던 규칙은 FWL-059에서 없앴다
    expect(lean.tree).toContain('- text "총 결제금액 15,000원"');
    expect(lean.tree).toMatch(/- button "" ×3 \[ref=\d+:e\d+\.\.\d+:e\d+\]/);
    expect(lean.tree).toContain('- heading "주문서"'); // 헤더·본문 요소는 그대로
    // raw에는 전부 있다
    expect(raw.tree).toContain('- img "상품A"');
    expect(raw.tree).toContain('- img "최대 500원 적립"');
    expect(raw.tree).toContain('이용약관');
    expect(raw.tree).toContain('배송은 보통 이틀');
    expect(raw.tree).not.toContain('×3');
  }, 30_000);

  it('같은 요소의 ref index가 lean과 raw에서 같다 — 접힌 범위의 ref도 raw의 것과 일치한다', async () => {
    const lean = await target.snapshot(sid);
    const raw = await target.snapshot(sid, { raw: true });
    for (const label of ['상품A', '장바구니 담기', '결제하기', '상세 보기']) {
      expect(idx(refOf2(lean.tree, label))).toBe(idx(refOf2(raw.tree, label)));
    }
    const fold = lean.tree.match(/- button "" ×3 \[ref=(\d+:e\d+)\.\.(\d+:e\d+)\]/);
    const rawEmpty = raw.tree.match(/- button "" \[ref=(\d+:e\d+)\]/g)?.map((l) => l.slice(l.indexOf('[ref=') + 5, -1)) ?? [];
    expect(rawEmpty).toHaveLength(3);
    expect(idx(fold?.[1] as string)).toBe(idx(rawEmpty[0] as string));
    expect(idx(fold?.[2] as string)).toBe(idx(rawEmpty[2] as string));
    // 접힌 범위 안의 ref는 전부 유효하다
    await expect(target.act(sid, { kind: 'click', ref: (lean.gen + 1 === raw.gen ? rawEmpty[1] : fold?.[1]) as Ref })).resolves.toBeDefined();
  }, 30_000);

  it('이미 요소 이름으로 나온 텍스트는 본문 줄로 다시 내지 않는다 (FWL-059)', async () => {
    const lean = await target.snapshot(sid);
    expect(lean.tree).toContain('- heading "주문서"');
    expect(lean.tree).not.toContain('- text "주문서"'); // heading 이름과 같은 텍스트
    expect(lean.tree).not.toContain('- text "포인트 충전결제"'); // label이 radio의 이름이 됐다
    expect(lean.tree).not.toContain('- text "추가금액 없이"'); // clickable 이름 안의 조각
    expect(lean.tree).toContain('- text "카드 설명"'); // 어떤 이름에도 안 들어간 본문은 남는다
    const interactive = await target.snapshot(sid, { filter: 'interactive' });
    expect(interactive.tree).not.toContain('- img');
    expect(interactive.tree).not.toContain('- text "');
    expect(interactive.tree).not.toContain('이용약관');
  }, 30_000);

  it('60자에서 잘린 이름에 결제가가 붙는다 (FWL-059)', async () => {
    const lean = await target.snapshot(sid);
    const line = lean.tree.split('\n').find((l) => l.includes('- link "긴이름 상품'));
    expect(line).toContain('… 16,900원'); // 잘려 나간 쪽에 있던 실제 결제가
    expect(line).not.toContain('32%'); // 그 사이 텍스트는 실제로 잘렸다
  }, 30_000);
});

describe('scroll (FWL-061)', () => {
  it('요소를 품은 스크롤 컨테이너를 움직이고, 기존 ref를 무효화하지 않는다', async () => {
    const before = await target.snapshot(sid);
    expect(before.tree).not.toContain('컨테이너 스크롤됨');
    const deep = refOf(before.tree, 'button', '깊은 버튼');
    const cart = refOf(before.tree, 'button', '장바구니 담기');

    await target.act(sid, { kind: 'scroll', ref: deep });

    // 스크롤은 세대를 올리지 않는다 — 스크롤 전에 받은 ref가 그대로 듣는다 (여기서 새 스냅샷을 찍으면 확인이 안 된다)
    await expect(target.act(sid, { kind: 'click', ref: cart })).resolves.toBeDefined();

    // onscroll이 컨테이너에 걸려 있다 — 창이 아니라 그 div가 움직였다는 증거다
    const after = await target.snapshot(sid);
    expect(after.tree).toContain('컨테이너 스크롤됨');
  }, 30_000);
});

/**
 * page_image (FWL-062). 별도 픽스처를 쓰는 이유: 마스크 박스를 픽셀 좌표로 확인해야 해서
 * 입력창과 iframe의 위치를 고정해야 한다.
 */
describe('page_image (FWL-062) — 규칙 1의 경계선을 픽셀에도 긋는다', () => {
  const isid = 's_image' as SessionId;
  let innerServer: Server;
  let outerServer: Server;

  beforeAll(async () => {
    // PG사 프레임 모사 — 카드번호는 늘 cross-origin iframe 안에 있다 (규칙 4)
    innerServer = await serve('<body style="margin:0"><input placeholder="카드번호" style="display:block;width:300px;height:40px;border:0"></body>');
    outerServer = await serve(
      `<body style="margin:0"><input placeholder="받는분" style="display:block;width:300px;height:40px;border:0"><iframe src="${originOf(innerServer)}/" style="display:block;width:400px;height:60px;border:0"></iframe></body>`,
    );
    await target.open(isid, { origin: originOf(outerServer), kind: 'browser', browser: 'chromium', headless: true });
    await target.act(isid, { kind: 'navigate', url: `${originOf(outerServer)}/` });
  }, 60_000);

  afterAll(async () => {
    await target.close(isid).catch(() => {});
    innerServer?.close();
    outerServer?.close();
  });

  it('채운 값은 그림에 남지 않는다 — 최상위와 PG 프레임의 입력창이 모두 덮인다', async () => {
    const snap = await target.snapshot(isid);
    await target.act(isid, { kind: 'fill', ref: refOf(snap.tree, 'textbox', '카드번호'), value: CARD_TYPED });

    const img = await target.image(isid);
    // 최상위 1 + PG 프레임 1. 프레임 순회가 빠지면 1이 되고, 그때 드러나는 게 하필 카드 필드다
    expect(img.masked).toBe(2);

    // 1920 뷰포트를 긴 변 1024로 줄여 내보낸다 (FWL-066) — 좌표도 같은 비율로 줄여서 찍는다
    expect(img.width).toBe(1024);
    const k = img.width / 1920;
    const png = decodePng(img.png);
    const at = (x: number, y: number): string => {
      const i = (Math.round(y * k) * png.width + Math.round(x * k)) * 4;
      return [png.data[i], png.data[i + 1], png.data[i + 2]].join(',');
    };
    expect(at(150, 20)).toBe('255,0,255'); // 최상위 입력창 (0,0)~(300,40)
    expect(at(150, 60)).toBe('255,0,255'); // iframe 안의 카드 입력창 (0,40)~(300,80)
  }, 60_000);
});

/**
 * 트리 예산 (FWL-076). 별도 픽스처를 쓰는 이유: 예산을 넘기려면 줄이 수천 개 있어야 한다.
 */
describe('page_tree 예산 (FWL-076) — 잘려도 몇 줄이 남았는지와 이어보는 법이 트리 안에 있다', () => {
  const bsid = 's_big' as SessionId;
  let bigServer: Server;

  beforeAll(async () => {
    const rows = Array.from({ length: 900 }, (_, i) => `<a href="/g/${i}">상품 ${i} 아주 좋은 상품입니다 어서오세요</a>`).join('');
    bigServer = await serve(`<h1>큰 목록</h1>${rows}`);
    await target.open(bsid, { origin: originOf(bigServer), kind: 'browser', browser: 'chromium', headless: true });
    await target.act(bsid, { kind: 'navigate', url: `${originOf(bigServer)}/` });
  }, 60_000);

  afterAll(async () => {
    await target.close(bsid).catch(() => {});
    bigServer?.close();
  });

  it('예산을 넘으면 줄 경계에서 끊고 이어보기 ref를 남긴다 — 이어받으면 끊긴 다음 줄부터 온다', async () => {
    const snap = await target.snapshot(bsid);
    expect(snap.tree.length).toBeLessThanOrEqual(30_000);

    const lastLine = snap.tree.split(/\r?\n/).at(-1) ?? '';
    expect(lastLine).toMatch(/^- … \d+ more lines did not fit — page_tree with after "\d+:e\d+" continues from here$/);

    const after = (/after "([^"]+)"/.exec(lastLine)?.[1] ?? '') as Ref;
    const next = await target.snapshot(bsid, { after });
    // 이어보기의 첫 줄은 끊긴 자리 바로 다음 요소다 — 겹치지도, 건너뛰지도 않는다
    const cutIndex = Number(/e(\d+)/.exec(after)?.[1]);
    const firstIndex = Number(/\[ref=\d+:e(\d+)\]/.exec(next.tree.split(/\r?\n/)[0] ?? '')?.[1]);
    expect(firstIndex).toBe(cutIndex + 1);
  }, 60_000);

  it('예산 안에 드는 페이지는 안내 줄이 붙지 않는다 — 기존 동작 그대로', async () => {
    const snap = await target.snapshot(sid);
    expect(snap.tree).not.toContain('more lines did not fit');
  }, 30_000);
});
