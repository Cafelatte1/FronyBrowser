/**
 * page_image 축소 (FWL-066).
 *
 * 가장 중요한 성질은 "단색 영역의 색이 살아남는다"이다 — 입력창 마스크(규칙 1)가 큰 단색 사각형이라,
 * 축소가 색을 섞어 버리면 가려 둔 것이 비쳐 나온다.
 */

import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { fitPng } from '@wallet/core';

/** 왼쪽 절반은 자홍(마스크 색), 오른쪽 절반은 흰색인 그림 */
function twoTone(width: number, height: number): Uint8Array {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) << 2;
      const magenta = x < width / 2;
      png.data[o] = 255;
      png.data[o + 1] = magenta ? 0 : 255;
      png.data[o + 2] = 255;
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function pixelAt(bytes: Uint8Array, x: number, y: number): string {
  const png = PNG.sync.read(Buffer.from(bytes));
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]].join(',');
}

describe('fitPng', () => {
  it('긴 변을 상한까지 줄이고 종횡비를 지킨다', () => {
    const fitted = fitPng(twoTone(1920, 1080), 1024);
    expect(fitted.width).toBe(1024);
    expect(fitted.height).toBe(576); // 1080 * 1024/1920
    expect(PNG.sync.read(Buffer.from(fitted.png)).width).toBe(1024); // 보고한 크기 = 실제 픽셀 수
  });

  it('세로가 긴 그림은 높이가 상한이 된다', () => {
    const fitted = fitPng(twoTone(600, 1200), 1024);
    expect(fitted.height).toBe(1024);
    expect(fitted.width).toBe(512);
  });

  it('이미 상한보다 작으면 원본 바이트를 그대로 돌려준다', () => {
    const original = twoTone(800, 600);
    const fitted = fitPng(original, 1024);
    expect(fitted.png).toBe(original);
    expect([fitted.width, fitted.height]).toEqual([800, 600]);
  });

  it('단색 영역의 색은 정확히 남는다 — 마스크가 축소 때문에 비쳐 나오지 않는다', () => {
    const fitted = fitPng(twoTone(1920, 1080), 1024);
    expect(pixelAt(fitted.png, 100, 288)).toBe('255,0,255'); // 자홍 영역 안쪽
    expect(pixelAt(fitted.png, 900, 288)).toBe('255,255,255'); // 흰 영역 안쪽
  });
});
