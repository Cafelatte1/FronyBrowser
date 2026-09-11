/**
 * 금고 등록 admin 핸들러 — MCP 미노출, /admin/* 내부 경로 전용 (8.4).
 *
 * 값은 요청으로 들어오기만 하고 어떤 응답에도 실리지 않는다 (이름·타입·길이만).
 * 파일 쓰기는 서버 프로세스가 수행한다 — DPAPI가 계정 종속이므로 값을 등록한
 * 계정과 서버 실행 계정이 같아야 한다는 제약은 그대로다.
 */

import type { Audit, Cipher, Result, Vault, VaultEntry, ValueType } from '@wallet/core';
import { fail, overviewVaultFile, removeVaultEntry, setVaultEntries } from '@wallet/core';
import type { Caller } from './impl.js';

const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VALUE_TYPES: ReadonlySet<string> = new Set([
  'card', 'phone', 'rrn', 'email', 'name', 'address', 'text',
]);

export type VaultAdminDeps = {
  readonly vaultFile: string;
  /** 파일을 바꾼 뒤 메모리 갱신용 — 갱신 없이는 스크러버가 새 값을 모른다 */
  readonly vault: Vault;
  readonly audit: Audit;
  readonly cipher?: Cipher;
};

export function createVaultAdmin(deps: VaultAdminDeps) {
  const { vaultFile, vault, audit } = deps;
  const cipher = deps.cipher;

  function log(caller: Caller, evt: 'vault_set' | 'vault_rm', key: string, ok: boolean, len?: number) {
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

  async function refresh(passphrase: string): Promise<void> {
    // 잠긴 금고를 등록 부수효과로 열지 않는다 — 이미 열려 있을 때만 다시 읽는다
    if (!vault.locked) await vault.unlock(passphrase);
  }

  return {
    async set(
      caller: Caller,
      passphrase: string,
      key: string,
      type: string,
      value: string,
      grant = false,
    ): Promise<Result<{ key: string; type: ValueType; len: number; grant: boolean }>> {
      const r = await this.setMany(caller, passphrase, [{ key, type, value, grant }]);
      if (!r.ok) return r;
      const first = r.keys[0] as { key: string; type: ValueType; len: number; grant: boolean };
      return { ok: true, ...first };
    },

    /** 여러 키를 한 번에 — 전부 검증한 뒤 복호화·재암호화 한 번. 하나라도 틀리면 아무것도 쓰지 않는다 */
    async setMany(
      caller: Caller,
      passphrase: string,
      items: ReadonlyArray<{ key: string; type: string; value: string; grant?: boolean }>,
    ): Promise<Result<{ keys: Array<{ key: string; type: ValueType; len: number; grant: boolean }> }>> {
      if (items.length === 0) return fail('bad_request', 'no entries');
      for (const { key, type, value, grant } of items) {
        if (!KEY_NAME.test(key)) return fail('bad_request', 'invalid key name');
        if (!VALUE_TYPES.has(type)) return fail('bad_request', 'invalid type');
        if (value.length === 0) return fail('bad_request', 'empty value');
        if (grant !== undefined && typeof grant !== 'boolean') return fail('bad_request', 'invalid grant');
      }
      try {
        const entries: Array<readonly [string, VaultEntry]> = items.map(({ key, type, value, grant }) => [key, { type: type as ValueType, value, grant: grant === true }]);
        setVaultEntries(vaultFile, passphrase, entries, cipher);
        await refresh(passphrase);
      } catch {
        // 패스프레이즈 오류·계정 불일치를 구분해 주지 않는다
        for (const { key } of items) log(caller, 'vault_set', key, false);
        return fail('vault_locked', 'wrong passphrase or account mismatch');
      }
      for (const { key, value } of items) log(caller, 'vault_set', key, true, value.length);
      return { ok: true, keys: items.map(({ key, type, value, grant }) => ({ key, type: type as ValueType, len: value.length, grant: grant === true })) };
    },

    async rm(caller: Caller, passphrase: string, key: string): Promise<Result<{ key: string }>> {
      let removed: boolean;
      try {
        removed = removeVaultEntry(vaultFile, passphrase, key, cipher);
        await refresh(passphrase);
      } catch {
        log(caller, 'vault_rm', key, false);
        return fail('vault_locked', 'wrong passphrase or account mismatch');
      }
      if (!removed) return fail('key_not_found', 'not in vault');
      log(caller, 'vault_rm', key, true);
      return { ok: true, key };
    },

    async overview(
      _caller: Caller,
      passphrase: string,
    ): Promise<Result<{ keys: Array<{ name: string; type: ValueType; len: number; grant: boolean }> }>> {
      try {
        return { ok: true, keys: overviewVaultFile(vaultFile, passphrase, cipher) };
      } catch {
        return fail('vault_locked', 'wrong passphrase or account mismatch');
      }
    },
  };
}

export type VaultAdmin = ReturnType<typeof createVaultAdmin>;
