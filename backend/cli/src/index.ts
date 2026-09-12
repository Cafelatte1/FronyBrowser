/**
 * 금고 등록·삭제·목록·unlock.
 *
 *   wallet set <key> --type <card|phone|rrn|email|name|address|text> [--grant] [--label "<name>"]
 *   wallet rm <key>
 *   wallet list
 *   wallet relabel            — 이름이 비어 있는 항목에 기본 이름을 지어 넣는다 (백업을 먼저 만든다, FWL-056)
 *   wallet migrate-keys       — 두 조각이던 옛 키 이름을 `그룹.대상.항목`으로 옮긴다 (백업을 먼저 만든다, FWL-057)
 *   wallet unlock              — 서버의 /vault/unlock 호출 (admin 기기에서만)
 *   wallet handoff             — 재시작 직전에 /vault/handoff 호출: 다음 프로세스가 같은 만료로 unlock을 이어받는다 (FWL-042)
 *   wallet status              — 금고 상태(/health) + TEST MODE 토글 (데이터 디렉터리의 test-mode.json, 서버 머신에서)
 *
 * 값·패스프레이즈는 터미널 숨김 입력으로만 받는다.
 * 금고 파일은 WALLET_DATA_DIR (기본 %LOCALAPPDATA%\Frony\FronyBrowser\data)의 vault.dpapi다.
 * unlock·handoff·status는 WALLET_SERVER와 FRONY_KEY를 쓴다.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ValueType, VaultEntry } from '@wallet/core';
import { defaultDataDir, defaultLabelFor, migrateKeyNames, readTestModeFlag, readVaultFile, seedLabels, writeVaultFile } from '@wallet/core';
import { promptHidden } from './prompt.js';

const TYPES = ['card', 'phone', 'rrn', 'email', 'name', 'address', 'text'] as const;

function vaultPath(): string {
  const dir = defaultDataDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, 'vault.dpapi');
}

function usage(): never {
  console.error(
    'usage: wallet set <key> --type <t> [--grant] [--label "<name>"] | wallet rm <key> | wallet list | wallet relabel | wallet migrate-keys | wallet unlock | wallet status',
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
    await openOrInit(path, passphrase); // 열리는지 먼저 확인 — 틀린 비밀번호는 여기서 끝난다
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

  usage();
}

main().catch(() => {
  // 예외 메시지를 그대로 찍지 않는다 (규칙 5)
  console.error('실패했습니다 (자세한 내용은 표시하지 않음).');
  process.exit(1);
});
