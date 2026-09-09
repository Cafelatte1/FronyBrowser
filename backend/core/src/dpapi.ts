/**
 * Windows DPAPI 래퍼 (사용자 스코프).
 *
 * CRYPTPROTECT_LOCAL_MACHINE은 쓰지 않는다 — 그 머신의 아무 프로세스나
 * 복호화할 수 있어 보호가 사실상 사라진다.
 *
 * 블롭은 암호화한 Windows 계정으로만 복호화된다. cli와 서버가 다른 계정으로
 * 돌면 조용히 실패하므로 서비스 등록 시 계정을 명시해야 한다 (13절).
 *
 * 네이티브 모듈 대신 PowerShell의 ProtectedData를 자식 프로세스로 부른다 —
 * 금고 입출력은 unlock·set 때뿐이라 프로세스 기동 비용(~1초)이 문제되지 않고,
 * 빌드 의존성이 없다. entropy(패스프레이즈 해시)는 인자가 아니라 자식 프로세스
 * 환경변수로 넘긴다 — 프로세스 목록에 노출되지 않는다.
 */

import { spawnSync } from 'node:child_process';

export type DpapiScope = 'protect' | 'unprotect';

function run(op: DpapiScope, data: Buffer, entropy: Buffer): Buffer {
  const method = op === 'protect' ? 'Protect' : 'Unprotect';
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$data=[Convert]::FromBase64String([Console]::In.ReadToEnd())',
    '$entropy=[Convert]::FromBase64String($env:WALLET_DPAPI_ENTROPY)',
    `$out=[Security.Cryptography.ProtectedData]::${method}($data,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');

  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: data.toString('base64'),
    env: { ...process.env, WALLET_DPAPI_ENTROPY: entropy.toString('base64') },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (res.status !== 0 || res.error) {
    // stderr를 그대로 싣지 않는다 (규칙 5) — 복호화 실패 메시지에 데이터 조각이 섞일 수 있다
    throw new Error(`dpapi ${op} failed (details suppressed)`);
  }
  return Buffer.from(res.stdout.trim(), 'base64');
}

export function protect(plaintext: Buffer, entropy: Buffer): Buffer {
  return run('protect', plaintext, entropy);
}

/** 계정이 다르거나 entropy(패스프레이즈)가 틀리면 throw */
export function unprotect(blob: Buffer, entropy: Buffer): Buffer {
  return run('unprotect', blob, entropy);
}
