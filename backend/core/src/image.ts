/**
 * page_image 축소 (FWL-066).
 *
 * 1920×1080 한 장은 읽는 쪽에서 긴 변 1568로 캡되어도 약 1,844토큰이다. 실측(2026-09-13, 검색 결과
 * 페이지 한 장을 세 크기로 직접 읽어 비교): 긴 변 1024면 가격·필터 개수·총 건수·정렬 옵션까지 전부
 * 읽히고 786토큰이다. 640은 307토큰이지만 같은 그림에서 2,640원이 1,640원으로 읽혔다 — 쇼핑 에이전트가
 * 화면에서 반드시 읽어야 하는 단 하나가 가격인데 자릿수가 틀렸고, 흐려서 못 읽는 것과 달리 조용히 틀린다.
 *
 * 박스 필터인 이유: 단색 영역의 색이 정확히 보존된다. 입력창 마스크(규칙 1)가 큰 단색 사각형이라
 * 축소를 거쳐도 경계 픽셀만 섞이고 안쪽은 그대로다 — 가려진 것이 축소 때문에 비쳐 나오지 않는다.
 */

import { PNG } from 'pngjs';

export type FittedPng = {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
};

/** 긴 변을 maxEdge 이하로 줄인 PNG. 이미 그보다 작으면 원본 바이트를 그대로 돌려준다 */
export function fitPng(bytes: Uint8Array, maxEdge: number): FittedPng {
  const src = PNG.sync.read(Buffer.from(bytes));
  const longest = Math.max(src.width, src.height);
  if (longest <= maxEdge) return { png: bytes, width: src.width, height: src.height };

  const scale = maxEdge / longest;
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const dst = new PNG({ width, height });
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(src.height, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(src.width, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let j = y0; j < y1; j++) {
        for (let i = x0; i < x1; i++) {
          const o = (j * src.width + i) << 2;
          r += src.data[o]!;
          g += src.data[o + 1]!;
          b += src.data[o + 2]!;
          a += src.data[o + 3]!;
          n++;
        }
      }
      const o = (y * width + x) << 2;
      dst.data[o] = Math.round(r / n);
      dst.data[o + 1] = Math.round(g / n);
      dst.data[o + 2] = Math.round(b / n);
      dst.data[o + 3] = Math.round(a / n);
    }
  }
  return { png: PNG.sync.write(dst), width, height };
}
