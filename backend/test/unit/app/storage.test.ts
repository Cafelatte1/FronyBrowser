/**
 * storageState 코덱 — merge(주입용 병합)·persist(origin별 재저장) 규칙.
 * DPAPI는 가짜 cipher로 대체한다 (실왕복은 dpapi.test.ts).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeCipher } from '../../helpers/fakes.js';
import {
  baseDomain,
  hasStorageState,
  mergeStorageStates,
  persistStorageStates,
  readStorageState,
  writeStorageState,
} from '@wallet/app';


const root = mkdtempSync(join(tmpdir(), 'wallet-storage-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function dirFor(name: string): string {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
}

const cookie = (name: string, domain: string, value = 'v') => ({
  name, value, domain, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax',
});

describe('baseDomain', () => {
  it('일반 도메인은 마지막 2레벨, 한국형 SLD는 3레벨', () => {
    expect(baseDomain('www.shop-a.example')).toBe('shop-a.example');
    expect(baseDomain('shop-b.example')).toBe('shop-b.example');
    expect(baseDomain('shop.auction.co.kr')).toBe('auction.co.kr');
    expect(baseDomain('127.0.0.1')).toBe('0.1'); // IP는 파일명과 정확 일치로만 쓰인다
  });
});

describe('merge — 시작 시 타겟 origin 것만 병합 (FWL-017)', () => {
  it('같은 baseDomain의 파일들을 합치고 (name,domain,path) 중복은 마지막 것만 남긴다', () => {
    const dir = dirFor('merge');
    writeStorageState(dir, 'https://a.com', 'pp', { cookies: [cookie('sid', 'a.com', 'old'), cookie('x', 'a.com')] }, fakeCipher);
    writeStorageState(dir, 'https://m.a.com', 'pp', { cookies: [cookie('sid', 'a.com', 'new')] }, fakeCipher);
    const merged = mergeStorageStates(dir, 'pp', 'https://a.com', fakeCipher) as { cookies: Array<{ name: string; value: string }> };
    expect(merged.cookies).toHaveLength(2);
    expect(merged.cookies.find((c) => c.name === 'sid')?.value).toBe('new');
  });

  it('다른 사이트의 시딩은 실리지 않는다 — 사이트 B 세션에 사이트 A 쿠키가 들어갈 이유가 없다', () => {
    const dir = dirFor('merge-isolate');
    writeStorageState(dir, 'https://www.shop-a.example', 'pp', { cookies: [cookie('cp', 'shop-a.example')] }, fakeCipher);
    // 사이트 B 시딩 파일 안의 소셜 로그인 쿠키(소셜 로그인)는 사이트 B 세션의 일부다 — 함께 실린다
    writeStorageState(dir, 'https://www.shop-b.example', 'pp', { cookies: [cookie('ku', 'shop-b.example'), cookie('nid', 'social.example')] }, fakeCipher);
    const shopB = mergeStorageStates(dir, 'pp', 'https://www.shop-b.example', fakeCipher) as { cookies: Array<{ name: string }> };
    expect(shopB.cookies.map((c) => c.name).sort()).toEqual(['ku', 'nid']);
    expect(mergeStorageStates(dir, 'pp', 'https://www.nowhere.com', fakeCipher)).toBeUndefined();
  });

  it('디렉토리가 없거나 비면 undefined', () => {
    expect(mergeStorageStates(join(root, 'nope'), 'pp', 'https://a.com', fakeCipher)).toBeUndefined();
    expect(mergeStorageStates(dirFor('empty'), 'pp', 'https://a.com', fakeCipher)).toBeUndefined();
  });

  it('틀린 패스프레이즈는 던진다 — 조용히 빈 세션으로 열지 않는다', () => {
    const dir = dirFor('wrongpp');
    writeStorageState(dir, 'https://a.com', 'pp', { cookies: [cookie('sid', 'a.com')] }, fakeCipher);
    expect(() => mergeStorageStates(dir, 'wrong', 'https://a.com', fakeCipher)).toThrow();
  });
});

describe('persist — 종료 시 origin별 재저장', () => {
  it('저장된 로그인이 없는 세션 origin은 첫 저장으로 파일을 만든다 — 다른 도메인 쿠키는 제외 (FWL-045)', () => {
    const dir = join(dirFor('persist-first'), 'sessions'); // 디렉터리도 아직 없다
    const updated = persistStorageStates(
      dir, 'pp',
      { cookies: [cookie('sid', '.shop-a.example', 'fresh'), cookie('tracker', 'ads.example.net')] },
      fakeCipher, undefined, 'https://www.shop-a.example',
    );
    expect(updated).toEqual(['www.shop-a.example']);
    const saved = readStorageState(dir, 'https://www.shop-a.example', 'pp', fakeCipher) as { cookies: Array<{ name: string }> };
    expect(saved.cookies.map((c) => c.name)).toEqual(['sid']);
    expect(existsSync(join(dir, 'ads.example.net.dpapi'))).toBe(false);
  });

  it('세션 origin의 쿠키가 하나도 없으면 파일을 만들지 않고, 같은 baseDomain 파일이 있으면 그 파일만 갱신한다 (FWL-045)', () => {
    const dir = dirFor('persist-first-none');
    expect(persistStorageStates(dir, 'pp', { cookies: [cookie('x', 'other.net')] }, fakeCipher, undefined, 'https://www.shop-a.example')).toEqual([]);
    expect(existsSync(join(dir, 'www.shop-a.example.dpapi'))).toBe(false);
    writeStorageState(dir, 'https://login.shop-a.example', 'pp', { cookies: [cookie('sid', '.shop-a.example', 'old')] }, fakeCipher);
    const updated = persistStorageStates(dir, 'pp', { cookies: [cookie('sid', '.shop-a.example', 'new')] }, fakeCipher, undefined, 'https://www.shop-a.example');
    expect(updated).toEqual(['login.shop-a.example']);
    expect(existsSync(join(dir, 'www.shop-a.example.dpapi'))).toBe(false); // 두 번째 파일을 만들지 않는다
  });

  it('시딩 파일이 있는 host에만, baseDomain이 일치하는 쿠키만 저장한다', () => {
    const dir = dirFor('persist');
    writeStorageState(dir, 'https://www.shop-a.example', 'pp', { cookies: [cookie('sid', '.shop-a.example', 'old')] }, fakeCipher);
    const updated = persistStorageStates(
      dir, 'pp',
      {
        cookies: [
          cookie('sid', '.shop-a.example', 'rotated'),
          cookie('login', 'login.shop-a.example', 'sub'), // 서브도메인도 같은 baseDomain
          cookie('tracker', 'ads.example.net'), // 무관 — 저장 안 됨
        ],
      },
      fakeCipher,
    );
    expect(updated).toEqual(['www.shop-a.example']);
    const saved = readStorageState(dir, 'https://www.shop-a.example', 'pp', fakeCipher) as {
      cookies: Array<{ name: string; value: string }>;
    };
    expect(saved.cookies.map((c) => c.name).sort()).toEqual(['login', 'sid']);
    expect(saved.cookies.find((c) => c.name === 'sid')?.value).toBe('rotated');
    expect(existsSync(join(dir, 'ads.example.net.dpapi'))).toBe(false); // 새 파일을 만들지 않는다
  });

  it('해당 host 쿠키가 하나도 없으면 기존 시딩을 덮지 않는다', () => {
    const dir = dirFor('nooverwrite');
    writeStorageState(dir, 'https://shop-b.example', 'pp', { cookies: [cookie('sid', 'shop-b.example', 'keep')] }, fakeCipher);
    const updated = persistStorageStates(dir, 'pp', { cookies: [cookie('x', 'other.com')] }, fakeCipher);
    expect(updated).toEqual([]);
    const saved = readStorageState(dir, 'https://shop-b.example', 'pp', fakeCipher) as {
      cookies: Array<{ value: string }>;
    };
    expect(saved.cookies[0]?.value).toBe('keep');
  });
});

describe('persist 가드 — 시딩본보다 빈약해지면 덮어쓰지 않는다 (FWL-025)', () => {
  const many = (n: number, domain: string, prefix: string, value = 'v') =>
    Array.from({ length: n }, (_, i) => cookie(`${prefix}${i}`, domain, value));

  /** 시딩본: 봇 매니저 쿠키 포함 10개 */
  function seed(name: string): string {
    const dir = dirFor(name);
    writeStorageState(
      dir, 'https://www.shop-a.example', 'pp',
      { cookies: [cookie('bot_token', '.shop-a.example', 'seeded'), ...many(9, '.shop-a.example', 'c', 'seeded')] },
      fakeCipher,
    );
    return dir;
  }

  const savedCookies = (dir: string) =>
    (readStorageState(dir, 'https://www.shop-a.example', 'pp', fakeCipher) as {
      cookies: Array<{ name: string; value: string }>;
    }).cookies;

  it('쿠키 수가 절반 미만으로 줄면 건너뛰고 shrunk로 알린다', () => {
    const dir = seed('guard-shrunk');
    const skips: Array<[string, string]> = [];
    const updated = persistStorageStates(
      dir, 'pp',
      { cookies: [cookie('bot_token', '.shop-a.example', 'blocked'), ...many(3, '.shop-a.example', 'c', 'blocked')] },
      fakeCipher,
      (host, reason) => skips.push([host, reason]),
    );
    expect(updated).toEqual([]);
    expect(skips).toEqual([['www.shop-a.example', 'shrunk']]);
    expect(savedCookies(dir)).toHaveLength(10);
    expect(savedCookies(dir).every((c) => c.value === 'seeded')).toBe(true);
  });

  it('쿠키가 늘었으면 정상 재저장한다', () => {
    const dir = seed('guard-ok');
    const skips: Array<[string, string]> = [];
    const updated = persistStorageStates(
      dir, 'pp',
      { cookies: [cookie('bot_token', '.shop-a.example', 'rotated'), ...many(10, '.shop-a.example', 'c', 'rotated')] },
      fakeCipher,
      (host, reason) => skips.push([host, reason]),
    );
    expect(updated).toEqual(['www.shop-a.example']);
    expect(skips).toEqual([]);
    expect(savedCookies(dir)).toHaveLength(11);
    expect(savedCookies(dir).find((c) => c.name === 'bot_token')?.value).toBe('rotated');
  });

  it('기존 파일을 복호화할 수 없으면 비교 근거가 없으므로 그대로 쓴다', () => {
    const dir = dirFor('guard-undecryptable');
    writeFileSync(join(dir, 'www.shop-a.example.dpapi'), 'not-a-real-blob');
    const skips: Array<[string, string]> = [];
    const updated = persistStorageStates(
      dir, 'pp',
      { cookies: [cookie('sid', '.shop-a.example', 'fresh')] },
      fakeCipher,
      (host, reason) => skips.push([host, reason]),
    );
    expect(updated).toEqual(['www.shop-a.example']);
    expect(skips).toEqual([]);
    expect(savedCookies(dir)[0]?.value).toBe('fresh');
  });
});

describe('hasStorageState — 시딩된 origin인가 (FWL-023)', () => {
  it('같은 baseDomain의 .dpapi 파일이 있으면 true — 내용은 보지 않는다 (금고가 잠겨 있어도 판정한다)', () => {
    const dir = dirFor('has');
    expect(hasStorageState(dir, 'https://www.shop-b.example')).toBe(false);
    writeFileSync(join(dir, 'www.shop-b.example.dpapi'), 'not-a-real-blob');
    expect(hasStorageState(dir, 'https://www.shop-b.example')).toBe(true);
    expect(hasStorageState(dir, 'https://shop-b.example')).toBe(true); // 서브도메인이 달라도 같은 baseDomain
    expect(hasStorageState(dir, 'https://www.shop-a.example')).toBe(false);
    expect(hasStorageState(join(root, 'has-none'), 'https://www.shop-b.example')).toBe(false); // 디렉토리 자체가 없음
  });

  it('_n 접미사는 무시하고, .dpapi가 아닌 파일은 세지 않는다', () => {
    const dir = dirFor('has-suffix');
    writeFileSync(join(dir, 'www.shop-a.example_1.dpapi'), 'x');
    writeFileSync(join(dir, 'www.example.com.txt'), 'x');
    expect(hasStorageState(dir, 'https://www.shop-a.example')).toBe(true);
    expect(hasStorageState(dir, 'https://www.example.com')).toBe(false);
  });
});
