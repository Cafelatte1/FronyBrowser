/**
 * MCP 클라이언트 — integration(로컬 서버)과 live(실서버) 테스트가 같이 쓴다.
 * 응답 본문은 JSON 문자열 하나이므로 파싱만 해 준다. 값이 섞여 있는지는 호출측이 본문 문자열로 검사한다.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type McpSession = {
  readonly client: Client;
  /** 도구 호출 → 본문 문자열 (스크럽 검사용) */
  text(name: string, args?: Record<string, unknown>): Promise<string>;
  /** 도구 호출 → 파싱된 JSON */
  call<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
};

export async function connectMcp(baseUrl: string, bearer: string): Promise<McpSession> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);

  async function text(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    const t = content.find((c) => c.type === 'text');
    if (!t) throw new Error('no text content');
    return t.text;
  }

  return {
    client,
    text,
    call: async <T,>(name: string, args: Record<string, unknown> = {}) => JSON.parse(await text(name, args)) as T,
    close: () => client.close(),
  };
}
