/**
 * 금고 등록 admin 핸들러 — MCP 미노출, /admin/* 내부 경로 전용 (8.4).
 *
 * 값은 요청으로 들어오기만 하고 어떤 응답에도 실리지 않는다 (이름·타입·길이·라벨만).
 * 파일 쓰기는 서버 프로세스가 수행한다 — DPAPI가 계정 종속이므로 값을 등록한
 * 계정과 서버 실행 계정이 같아야 한다는 제약은 그대로다.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Audit, Cipher, Result, Vault, VaultEntry, ValueType } from '@wallet/core';
import { VaultLockedError, defaultLabelFor, fail, migrateKeyNames, overviewVaultFile, readVaultFile, seedLabels, writeVaultFile } from '@wallet/core';
import type { Caller } from './impl.js';

/** 키 이름은 `그룹.대상.항목` 세 조각 고정 (FWL-057) — 검사는 서버가 한다. 콘솔·CLI 규칙과 같은 식이다 */
const KEY_NAME = /^[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+$/;
const LABEL_MAX = 60;
const VALUE_TYPES: ReadonlySet<string> = new Set([
  'card', 'phone', 'rrn', 'email', 'name', 'address', 'text',
]);

export type VaultAdminDeps = {
  readonly vaultFile: string;
  /** 로그인 세션 파일 디렉터리 — reset이 금고와 함께 지운다 (FWL-056) */
  readonly sessionsDir: string;
  /** 파일을 바꾼 뒤 메모리 갱신용 — 갱신 없이는 스크러버가 새 값을 모른다 */
  readonly vault: Vault;
  readonly audit: Audit;
  readonly cipher?: Cipher;
};

/** 저장할 이름을 정한다: 보낸 값 > 이미 붙어 있던 이름 > 키에서 지어낸 기본값 */
function labelOf(existing: ReadonlyMap<string, VaultEntry>, key: string, label?: string): string {
  if (label !== undefined) return label.trim();
  const current = existing.get(key)?.label;
  return current !== undefined && current !== '' ? current : defaultLabelFor(key);
}

export function createVaultAdmin(deps: VaultAdminDeps) {
  const { vaultFile, sessionsDir, vault, audit } = deps;
  const cipher = deps.cipher;
  /** 이 프로세스가 마지막으로 쓴 금고 파일의 mtime — 서버 밖에서(CLI가) 고쳤는지 가리는 기준 */
  let knownMtimeMs = 0;

  function mtimeNow(): number {
    try {
      return statSync(vaultFile).mtimeMs;
    } catch {
      return 0;
    }
  }

  function log(caller: Caller, evt: 'vault_set' | 'vault_rm', key: string | null, ok: boolean, len?: number) {
    audit.append({
      evt,
      sid: null,
      client: caller.client,
      traceId: null,
      origin: null,
      key,
      ok,
      ...(len !== undefined ? { len } : {}),
    });
  }

  /** 열려 있으면 메모리에서 — DPAPI 호출 하나가 PowerShell 프로세스 하나다 (FWL-058) */
  function entriesNow(passphrase: string): Map<string, VaultEntry> {
    if (vault.locked) return readVaultFile(vaultFile, passphrase, cipher);
    // 열린 금고에 다른 패스프레이즈로 쓰면 파일이 그 암호로 통째로 재암호화된다 — 쓰기 전에 막는다
    if (vault.currentPassphrase() !== passphrase) throw new VaultLockedError();
    // 서버 밖에서(CLI가) 파일을 고쳤으면 메모리가 낡았다 — 그대로 재암호화하면 그 쓰기가 조용히 사라진다
    if (mtimeNow() !== knownMtimeMs) return readVaultFile(vaultFile, passphrase, cipher);
    return new Map(vault.live());
  }

  return {
    async set(
      caller: Caller,
      passphrase: string,
      key: string,
      type: string,
      value: string,
      grant = false,
      label?: string,
    ): Promise<Result<{ key: string; type: ValueType; len: number; grant: boolean; label: string }>> {
      const r = await this.setMany(caller, passphrase, [{ key, type, value, grant, ...(label !== undefined ? { label } : {}) }]);
      if (!r.ok) return r;
      const first = r.keys[0] as { key: string; type: ValueType; len: number; grant: boolean; label: string };
      return { ok: true, ...first };
    },

    /** 여러 키를 한 번에 — 전부 검증한 뒤 복호화·재암호화 한 번. 하나라도 틀리면 아무것도 쓰지 않는다 */
    async setMany(
      caller: Caller,
      passphrase: string,
      items: ReadonlyArray<{ key: string; type: string; value: string; grant?: boolean; label?: string }>,
    ): Promise<Result<{ keys: Array<{ key: string; type: ValueType; len: number; grant: boolean; label: string }> }>> {
      if (items.length === 0) return fail('bad_request', 'no entries');
      for (const { key, type, value, grant, label } of items) {
        if (!KEY_NAME.test(key)) return fail('bad_request', 'key must be group.subject.field');
        if (!VALUE_TYPES.has(type)) return fail('bad_request', 'invalid type');
        if (value.length === 0) return fail('bad_request', 'empty value');
        if (grant !== undefined && typeof grant !== 'boolean') return fail('bad_request', 'invalid grant');
        if (label !== undefined && (typeof label !== 'string' || label.trim().length === 0 || label.trim().length > LABEL_MAX)) {
          return fail('bad_request', 'invalid label');
        }
      }
      const entries: Array<readonly [string, VaultEntry]> = [];
      try {
        // 이미 붙어 있는 이름을 지우지 않으려면 현재 항목을 먼저 읽어야 한다
        const existing = existsSync(vaultFile) ? entriesNow(passphrase) : new Map<string, VaultEntry>();
        for (const { key, type, value, grant, label } of items) {
          entries.push([key, { type: type as ValueType, value, grant: grant === true, label: labelOf(existing, key, label) }]);
        }
        for (const [key, entry] of entries) existing.set(key, entry);
        writeVaultFile(vaultFile, passphrase, existing, cipher);
        knownMtimeMs = mtimeNow();
        vault.applyWrite(existing);
      } catch {
        // 패스프레이즈 오류·계정 불일치를 구분해 주지 않는다
        for (const { key } of items) log(caller, 'vault_set', key, false);
        return fail('vault_locked', 'wrong passphrase or account mismatch');
      }
      for (const { key, value } of items) log(caller, 'vault_set', key, true, value.length);
      return { ok: true, keys: entries.map(([key, e]) => ({ key, type: e.type, len: e.value.length, grant: e.grant, label: e.label })) };
    },

    /** 값을 다시 받지 않고 grant 플래그만 바꾼다 (FWL-056). 없는 키는 key_not_found */
    async grant(caller: Caller, passphrase: string, key: string, grant: boolean): Promise<Result<{ key: string; grant: boolean }>> {
      try {
        const entries = entriesNow(passphrase);
        const current = entries.get(key);
        if (current === undefined) return fail('key_not_found', 'not in vault');
        entries.set(key, { ...current, grant });
        writeVaultFile(vaultFile, passphrase, entries, cipher);
        knownMtimeMs = mtimeNow();
        vault.applyWrite(entries);
      } catch {
        log(caller, 'vault_set', key, false);
        return fail('vault_locked', 'wrong passphrase or account mismatch');
      }
      log(caller, 'vault_set', key, true);
      return { ok: true, key, grant };
    },

    /** 이름 없는 항목에 이름을 지어 넣는다. 백업을 먼저 만든다 (FWL-056) */
    async seedLabels(caller: Caller, passphrase: string): Promise<Result<{ seeded: Array<{ key: string; label: string }> }>> {
      let result: ReturnType<typeof seedLabels>;
      try {
        result = seedLabels(vaultFile, passphrase, cipher);
        knownMtimeMs = mtimeNow();
        vault.applyWrite(result.entries);
      } catch {
        return fail('vault_locked', 'wrong passphrase or account mismatch');
      }
      // 백업 경로는 서버 쪽 파일 경로라 응답에 싣지 않는다 — 운영자는 서버 로그에서 본다
      if (result.backup !== '') console.log(`금고 라벨 시딩 — 백업: ${result.backup}`);
      for (const { key } of result.seeded) log(caller, 'vault_set', key, true);
      return { ok: true, seeded: [...result.seeded] };
    },

    /** 두 조각이던 옛 키 이름을 `그룹.대상.항목`으로 옮긴다 (FWL-057). 백업을 먼저 만든다 */
    async migrateKeys(caller: Caller, passphrase: string): Promise<Result<{ moved: Array<{ from: string; to: string }> }>> {
      let result: ReturnType<typeof migrateKeyNames>;
      try {
        result = migrateKeyNames(vaultFile, passphrase, cipher);
        knownMtimeMs = mtimeNow();
        vault.applyWrite(result.entries);
      } catch {
        return fail('vault_locked', 'wrong passphrase or account mismatch');
      }
      if (result.backup !== '') console.log(`금고 키 이름 마이그레이션 — 백업: ${result.backup}`);
      for (const { from, to } of result.moved) {
        log(caller, 'vault_rm', from, true);
        log(caller, 'vault_set', to, true);
      }
      return { ok: true, moved: [...result.moved] };
    },

    /** 금고 파일을 새로 만든다 (FWL-056). 이미 있으면 already_exists — 덮어쓰면 값이 통째로 사라진다 */
    async create(caller: Caller, passphrase: string): Promise<Result<unknown>> {
      if (existsSync(vaultFile)) return fail('already_exists', 'vault already exists');
      try {
        writeVaultFile(vaultFile, passphrase, new Map(), cipher);
        knownMtimeMs = mtimeNow();
        await vault.unlock(passphrase);
      } catch {
        log(caller, 'vault_set', null, false);
        return fail('vault_locked', 'wrong passphrase or account mismatch');
      }
      log(caller, 'vault_set', null, true);
      return { ok: true };
    },

    /**
     * 마스터 비밀번호를 잊었을 때의 초기화 (FWL-056). 패스프레이즈를 받지 않는다 — 열 수 없는 금고를 버리는 일이다.
     * 로그인 세션 파일도 같은 패스프레이즈로 암호화돼 있어 남겨 두면 읽을 수 없는 파일만 쌓인다.
     */
    async reset(caller: Caller): Promise<Result<unknown>> {
      rmSync(vaultFile, { force: true });
      if (existsSync(sessionsDir)) {
        for (const file of readdirSync(sessionsDir)) rmSync(join(sessionsDir, file), { force: true, recursive: true });
      }
      vault.lock();
      log(caller, 'vault_rm', null, true);
      return { ok: true };
    },

    async rm(caller: Caller, passphrase: string, key: string): Promise<Result<{ key: string }>> {
      let removed: boolean;
      try {
        const entries = entriesNow(passphrase);
        removed = entries.delete(key);
        if (removed) {
          writeVaultFile(vaultFile, passphrase, entries, cipher);
          knownMtimeMs = mtimeNow();
          vault.applyWrite(entries);
        }
      } catch {
        log(caller, 'vault_rm', key, false);
        return fail('vault_locked', 'wrong passphrase or account mismatch');
      }
      if (!removed) return fail('key_not_found', 'not in vault');
      log(caller, 'vault_rm', key, true);
      return { ok: true, key };
    },

    /**
     * 지목한 키들을 한 번에 지운다 (FWL-056). 복호화·재암호화는 한 번.
     * 그룹 이름이 아니라 키 목록을 받는다 — 확인한 목록과 지우는 목록이 같아야 한다
     */
    async rmKeys(caller: Caller, passphrase: string, keys: ReadonlyArray<string>): Promise<Result<{ removed: string[] }>> {
      if (keys.length === 0) return fail('bad_request', 'no keys');
      let removed: string[];
      try {
        const entries = entriesNow(passphrase);
        removed = keys.filter((k) => entries.delete(k));
        if (removed.length > 0) {
          writeVaultFile(vaultFile, passphrase, entries, cipher);
          knownMtimeMs = mtimeNow();
          vault.applyWrite(entries);
        }
      } catch {
        log(caller, 'vault_rm', null, false);
        return fail('vault_locked', 'wrong passphrase or account mismatch');
      }
      if (removed.length === 0) return fail('key_not_found', 'none of those keys are in the vault');
      for (const key of removed) log(caller, 'vault_rm', key, true);
      return { ok: true, removed };
    },

    async overview(
      _caller: Caller,
      passphrase: string,
    ): Promise<Result<{ keys: Array<{ name: string; type: ValueType; len: number; grant: boolean; label: string }> }>> {
      try {
        // 열려 있으면 메모리에서 — 목록을 보려고 파일을 다시 복호화하지 않는다 (FWL-058)
        return { ok: true, keys: vault.locked ? overviewVaultFile(vaultFile, passphrase, cipher) : [...vault.list()] };
      } catch {
        return fail('vault_locked', 'wrong passphrase or account mismatch');
      }
    },
  };
}

export type VaultAdmin = ReturnType<typeof createVaultAdmin>;
