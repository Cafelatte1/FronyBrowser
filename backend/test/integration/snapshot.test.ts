/**
 * 규칙 1의 회귀 테스트 — 삭제하거나 skip하지 않는다.
 *
 * 로컬 http 서버 2개로 cross-origin iframe(PG 결제창 모사)을 구성해
 * 프레임 origin 판정까지 실브라우저로 검증한다.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Ref, SessionId } from '@wallet/core';
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
    <div role="button" tabindex="0" id="cart-area">장바구니 영역 <button>장바구니 담기</button> <button>바로구매</button></div>
    <a href="/vp/products/1?token=abc" target="_blank">상세 보기</a>
    <a href="${originOf(pgServer)}/outside">외부 링크</a>
    <a href="/goods/1">상품A</a><img alt="상품A" src="data:,"><img alt="" src="data:,">
    <a href="/goods/2">상품B<img alt="최대 500원 적립" src="data:,"></a><img alt="배송 아이콘" src="data:,">
    <div><button></button><button></button><button></button></div>
    <p>배송은 보통 이틀 걸립니다</p>
    <footer><a href="/terms">이용약관</a><p>사업자등록번호 000-00-00000</p></footer>
    <script>
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
    // 바깥 div 하나만 — 안의 span은 따로 잡지 않고, 정식 버튼을 품은 카드도 잡지 않는다
    expect(clickables).toEqual([expect.stringContaining('- clickable "추가금액 없이 구매하기" [ref=')]);
    expect(snap.tree).toContain('- button "카드 안의 버튼" [ref=');
    await target.act(sid, { kind: 'click', ref: refOf(snap.tree, 'clickable', '추가금액 없이 구매하기') });
    snap = await target.snapshot(sid, { text: true });
    expect(snap.tree).toContain('- text "팝업 통과"');
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

describe('lean 기본 출력 (FWL-044) — 액션도 정보도 없는 줄을 빼고, 남는 ref는 raw와 같다', () => {
  const refOf2 = (tree: string, label: string): string => {
    const line = tree.split('\n').find((l) => l.includes(`"${label}" [ref=`));
    if (!line) throw new Error(`no ref for ${label}`);
    return line.slice(line.indexOf('[ref=') + 5, line.indexOf(']', line.indexOf('[ref=')));
  };
  const idx = (ref: string): string => ref.split(':')[1] as string;

  it('이름 없는 img·인접 요소와 같은 이름의 img·푸터·가격 아닌 본문이 빠지고, 빈 이름 연속은 ×N으로 접힌다', async () => {
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
    expect(lean.tree).not.toContain('배송은 보통 이틀');
    expect(lean.tree).toContain('- text "총 결제금액 15,000원"'); // 가격은 남는다
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

  it('text: true면 본문 전부, filter/ref와 조합된다', async () => {
    const withText = await target.snapshot(sid, { text: true });
    expect(withText.tree).toContain('배송은 보통 이틀');
    expect(withText.tree).not.toContain('이용약관'); // 푸터는 text: true여도 빠진다
    const lean = await target.snapshot(sid, { filter: 'interactive' });
    expect(lean.tree).not.toContain('- img');
    expect(lean.tree).not.toContain('이용약관');
  }, 30_000);
});
