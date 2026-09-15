/**
 * 금고 등록·삭제·목록·unlock.
 *
 *   wallet set <group.subject.field> --type <card|phone|rrn|email|name|address|text> [--grant] [--label "<name>"]
 *   wallet rm <group.subject.field>
 *   wallet list
 *   wallet relabel            — 이름이 비어 있는 항목에 기본 이름을 지어 넣는다 (백업을 먼저 만든다, FWL-056)
 *   wallet relabel <group.subject.field> "<name>" — 그 항목의 이름만 바꾼다 (값은 다시 받지 않는다)
 *   wallet migrate-keys       — 두 조각이던 옛 키 이름을 `그룹.대상.항목`으로 옮긴다 (백업을 먼저 만든다, FWL-057)
 *   wallet unlock              — 서버의 /vault/unlock 호출 (admin 기기에서만)
 *   wallet handoff             — 재시작 직전에 /vault/handoff 호출: 다음 프로세스가 같은 만료로 unlock을 이어받는다 (FWL-042)
 *   wallet status              — 금고 상태(/health) + TEST MODE 토글 (데이터 디렉터리의 test-mode.json, 서버 머신에서)
 *   wallet keypad-template <sprite.png> --cells <w>x<h> --order <row/row/..> --out <name>
 *                              — 스프라이트 키패드의 글리프 템플릿을 데이터 디렉터리의 keypads/<name>.json에 만든다 (FWL-073).
 *                                order는 스프라이트 셀 순서대로 보이는 숫자를 줄마다 슬래시로 나눈 것 (예: 8035/7426/19)
 *
 * 값·패스프레이즈는 터미널 숨김 입력으로만 받는다.
 * 금고 파일은 WALLET_DATA_DIR (기본 %LOCALAPPDATA%\Frony\FronyBrowser\data)의 vault.dpapi다.
 * unlock·handoff·status는 WALLET_SERVER와 FRONY_KEY를 쓴다.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ValueType, VaultEntry } from '@wallet/core';
import { KeypadUnresolvedError, TEMPLATE_NAME, buildGlyphSet, cropGlyph, decodePng, defaultDataDir, defaultLabelFor, migrateKeyNames, readTestModeFlag, readVaultFile, seedLabels, writeVaultFile } from '@wallet/core';
import { promptHidden } from './prompt.js';

const TYPES = ['card', 'phone', 'rrn', 'email', 'name', 'address', 'text'] as const;
/** 키 이름은 `그룹.대상.항목` 세 조각 고정 (FWL-057) — 서버의 admin 핸들러와 같은 식이다 */
const KEY_NAME = /^[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+$/;

function vaultPath(): string {
  const dir = defaultDataDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, 'vault.dpapi');
}

function usage(): never {
  console.error(
    'usage: wallet set <group.subject.field> --type <t> [--grant] [--label "<name>"] | wallet rm <group.subject.field> | wallet list | wallet relabel [<group.subject.field> "<name>"] | wallet migrate-keys | wallet unlock | wallet handoff | wallet status | wallet keypad-template <sprite.png> --cells <w>x<h> --order <row/row/..> --out <name>',
  );
  console.error(`  types: ${TYPES.join(' ')}`);
  process.exit(2);
}

function serverEnv(): { server: string; apiKey: string } {
  const server = process.env['WALLET_SERVER'];
  const apiKey = process.env['FRONY_KEY'];
  if (!server || !apiKey) {
    console.error('WALLET_SERVER와 FRONY_KEY 환경변수가 필요합니다.');
    process.exit(2);
  }
  return { server, apiKey };
}

async function openOrInit(path: string, passphrase: string): Promise<Map<string, VaultEntry>> {
  if (!existsSync(path)) return new Map();
  try {
    return readVaultFile(path, passphrase);
  } catch {
    // 계정 불일치·패스프레이즈 오류를 구분해 주지 않는다
    console.error('보관함을 열 수 없습니다 — 마스터 비밀번호 또는 Windows 계정을 확인하세요.');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [cmd, key, ...rest] = process.argv.slice(2);
  const path = vaultPath();

  if (cmd === 'set') {
    if (!key) usage();
    const typeIdx = rest.indexOf('--type');
    const type = typeIdx >= 0 ? rest[typeIdx + 1] : undefined;
    if (!type || !(TYPES as readonly string[]).includes(type)) usage();
    if (!KEY_NAME.test(key)) {
      console.error(`키 이름은 그룹.대상.항목 세 조각이어야 합니다 (소문자·숫자·하이픈): ${key}`);
      process.exit(1);
    }
    const grant = rest.includes('--grant');
    const labelIdx = rest.indexOf('--label');
    const labelArg = labelIdx >= 0 ? rest[labelIdx + 1]?.trim() : undefined;
    if (labelIdx >= 0 && !labelArg) usage();

    const passphrase = await promptHidden('마스터 비밀번호: ');
    const value = await promptHidden(`value for ${key}: `);
    if (value.length === 0) {
      console.error('빈 값은 등록하지 않습니다.');
      process.exit(1);
    }
    const entries = await openOrInit(path, passphrase);
    // 이름은 보낸 값 > 이미 붙어 있던 이름 > 키에서 지어낸 기본값 순 (FWL-056)
    const label = labelArg || entries.get(key)?.label || defaultLabelFor(key);
    entries.set(key, { type: type as ValueType, value, grant, label });
    writeVaultFile(path, passphrase, entries);
    console.log(`ok: ${label} · ${key} (${type}${grant ? ', grant' : ''}) 저장됨 — 값 길이 ${value.length}`);
    return;
  }

  if (cmd === 'rm') {
    if (!key) usage();
    const passphrase = await promptHidden('마스터 비밀번호: ');
    const entries = await openOrInit(path, passphrase);
    if (!entries.delete(key)) {
      console.error(`없는 키: ${key}`);
      process.exit(1);
    }
    writeVaultFile(path, passphrase, entries);
    console.log(`ok: ${key} 삭제됨`);
    return;
  }

  if (cmd === 'list') {
    const passphrase = await promptHidden('마스터 비밀번호: ');
    const entries = await openOrInit(path, passphrase);
    if (entries.size === 0) {
      console.log('(비어 있음)');
      return;
    }
    for (const [name, e] of entries) console.log(`${e.label}\t${name}\t${e.type}${e.grant ? ' grant' : ''}\tlen=${e.value.length}`);
    return;
  }

  if (cmd === 'relabel') {
    const passphrase = await promptHidden('마스터 비밀번호: ');
    const entries = await openOrInit(path, passphrase); // 열리는지 먼저 확인 — 틀린 비밀번호는 여기서 끝난다
    // 키를 지목하면 그 항목의 이름만 바꾼다 — 값은 다시 받지 않는다.
    // 표시용 이름 하나 고치자고 카드번호를 또 치게 하는 건, 값이 손을 타는 기회만 늘린다
    if (key) {
      const label = rest[0]?.trim();
      if (!label) usage();
      const entry = entries.get(key);
      if (!entry) {
        console.error(`없는 키: ${key}`);
        process.exit(1);
      }
      entries.set(key, { ...entry, label });
      writeVaultFile(path, passphrase, entries);
      console.log(`ok: ${key} → ${label}`);
      return;
    }
    const { backup, seeded } = seedLabels(path, passphrase);
    if (seeded.length === 0) {
      console.log('이름을 채울 항목이 없습니다.');
      return;
    }
    console.log(`백업: ${backup}`);
    for (const { key: k, label } of seeded) console.log(`${k} → ${label}`);
    return;
  }

  if (cmd === 'migrate-keys') {
    const passphrase = await promptHidden('마스터 비밀번호: ');
    await openOrInit(path, passphrase); // 열리는지 먼저 확인 — 틀린 비밀번호는 여기서 끝난다
    const { backup, moved } = migrateKeyNames(path, passphrase);
    if (moved.length === 0) {
      console.log('옮길 키가 없습니다.');
      return;
    }
    console.log(`백업: ${backup}`);
    for (const { from, to } of moved) console.log(`${from} → ${to}`);
    return;
  }

  if (cmd === 'unlock') {
    const { server, apiKey } = serverEnv();
    const passphrase = await promptHidden('마스터 비밀번호: ');
    const res = await fetch(`${server}/vault/unlock`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    });
    const body = (await res.json()) as { ok?: boolean; ttlMs?: number };
    if (res.ok && body.ok) {
      const h = Math.round((body.ttlMs ?? 0) / 3_600_000 * 10) / 10;
      console.log(`ok: 보관함이 열렸습니다 (${h >= 1 ? `${h}시간` : `${Math.round((body.ttlMs ?? 0) / 60_000)}분`} 후 자동 lock)`);
    } else {
      console.error(`실패 (${res.status}) — 마스터 비밀번호·admin 권한·서버 상태를 확인하세요.`);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'handoff') {
    const { server, apiKey } = serverEnv();
    const res = await fetch(`${server}/vault/handoff`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` } });
    const body = (await res.json()) as { ok?: boolean; remainingMs?: number };
    if (res.ok && body.ok) {
      console.log(`ok: unlock 인계 파일을 남겼습니다 (${Math.round((body.remainingMs ?? 0) / 60_000)}분 남음). 10분 안에 재시작하세요`);
    } else {
      console.error(`실패 (${res.status}) — 보관함이 잠겨 있거나 admin 권한이 없습니다. 재시작 뒤 wallet unlock이 필요합니다`);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'status') {
    // Test Mode는 /health에 없다(에이전트가 읽는 경로). 서버 머신에서 데이터 디렉터리의 파일을 직접 읽는다 (FWL-035)
    if (readTestModeFlag(join(defaultDataDir(), 'test-mode.json')).on) {
      console.warn('★ TEST MODE 켜짐 — grant 키는 입력하지 않는다. 실주행 전에 관리 UI에서 끈다');
    } else {
      console.log('test mode: off');
    }
    const server = process.env['WALLET_SERVER'];
    if (server) {
      const h = (await (await fetch(`${server}/health`)).json()) as { vaultLocked?: boolean; vaultExists?: boolean; vaultTtlMs?: number };
      console.log(`vault: ${!h.vaultExists ? 'no file' : h.vaultLocked ? 'locked' : `unlocked (${Math.round((h.vaultTtlMs ?? 0) / 60_000)}m left)`}`);
    }
    return;
  }

  if (cmd === 'keypad-template') {
    // 사이트의 스프라이트 PNG 한 장으로 글리프 템플릿을 만든다 (FWL-073). 스프라이트는 글꼴이지 값이 아니라 평문으로 둔다
    if (!key) usage();
    const arg = (name: string): string | undefined => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const cellsArg = arg('--cells');
    const order = arg('--order');
    const out = arg('--out');
    const m = cellsArg ? /^(\d+)x(\d+)$/.exec(cellsArg) : null;
    if (!m || !order || !out) usage();
    if (!TEMPLATE_NAME.test(out)) {
      console.error(`템플릿 이름은 소문자·숫자·하이픈만: ${out}`);
      process.exit(1);
    }
    const rows = order.split('/');
    const digits = rows.join('');
    const cols = (rows[0] as string).length;
    const w = Number(m[1]);
    const h = Number(m[2]);
    const cells = Array.from({ length: digits.length }, (_, i) => ({ x: (i % cols) * w, y: Math.floor(i / cols) * h, w, h }));
    let glyphs;
    try {
      glyphs = buildGlyphSet(readFileSync(key), cells, digits);
    } catch (e) {
      if (e instanceof KeypadUnresolvedError) {
        console.error(`템플릿을 만들 수 없습니다 (${e.reason}) — 셀 크기와 순서를 확인하세요. 열 자리가 한 번씩, 셀마다 글리프 하나여야 합니다`);
        process.exit(1);
      }
      throw e;
    }
    // 격자가 틀려도 잘린 글리프끼리는 서로 달라 만들어지긴 한다 — 셀을 1px 안쪽으로 줄였을 때 글리프가 달라지면 가장자리에 닿은 것이니 알린다
    const png = decodePng(readFileSync(key));
    const clipped = cells
      .map((c, i) => (JSON.stringify(cropGlyph(png, c)) !== JSON.stringify(cropGlyph(png, { x: c.x + 1, y: c.y + 1, w: c.w - 2, h: c.h - 2 })) ? digits[i] : null))
      .filter((d) => d !== null);
    if (clipped.length > 0) console.warn(`경고: 숫자 ${clipped.join(' ')}의 글리프가 셀 가장자리에 닿습니다 — 셀 크기나 순서가 틀렸을 수 있습니다`);
    const dir = join(defaultDataDir(), 'keypads');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${out}.json`);
    writeFileSync(file, JSON.stringify(glyphs), 'utf8');
    console.log(`ok: ${file} — fill의 keypad에 template: "${out}"을 더하면 이 템플릿으로 판독합니다`);
    return;
  }

  usage();
}

main().catch(() => {
  // 예외 메시지를 그대로 찍지 않는다 (규칙 5)
  console.error('실패했습니다 (자세한 내용은 표시하지 않음).');
  process.exit(1);
});
