/**
 * 유일한 소비자 입구 — MCP streamable-http.
 *
 * 도구 목록 = handlers 화이트리스트 − vault_unlock (admin은 CLI 전용, 8.4).
 * 모든 도구 응답은 egress.scrub()을 통과한 JSON 텍스트다 (규칙 3).
 *
 * 에이전트가 읽는 문자열(instructions·description·describe)은 영어이며 특정 소비 서비스·사이트·PG를
 * 이름으로 부르지 않는다 (FWL-039) — 이 서버는 서비스 중립 보안 브라우저 인프라다. instructions는
 * 이 서버의 툴 순서까지만 말한다. grant 발급 시점·구매 절차는 호출한 서비스의 몫이다 — 두 서버가
 * 같은 절차를 각자 서술하면 드리프트한다. 통합 테스트(mcp.test.ts)가 한글·서비스명 유입을 막는다.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Audit, PageImage, Ref, Result, SessionId, Vault } from '@wallet/core';
import { z } from 'zod';
import { scrub } from '../egress.js';
import { egressContext } from '../egress-context.js';
import type { Caller, Handlers } from '../handlers/impl.js';

export type McpDeps = {
  readonly handlers: Handlers;
  readonly vault: Vault;
  readonly audit: Audit;
};

export const INSTRUCTIONS = `FronyBrowser is a secure browser. It fills personal data (card numbers, login passwords, payment PINs) from a server-side vault by key name: you send "{{vault:key}}" placeholders and never see, receive, or need the value.

Responses: every tool returns JSON, either { "ok": true, ... } or { "ok": false, "error": { "code", "message", "retriable" } }. "retriable": true (stale_ref, element_not_actionable, session_limit, lease_conflict, navigation_failed, timeout) means the same call may succeed later; after stale_ref take a new page_tree first. These codes need a human and must not be retried — report the code to the user and stop: vault_locked (the operator runs "wallet unlock"), keypad_unresolved (the secure keypad's markup changed), grant_required / grant_invalid (the pay grant is missing, expired, already used, or for another session), key_held (the operator held this key back from test runs).

Values never come back: page_tree omits input values, fill responses carry only the key name and length, and any vault value a page echoes is replaced by [REDACTED:key]. page_image is the one exception, and it matters: the fields themselves are masked in the picture, but a value the site prints on the page — a delivery name, phone or address — is in the image exactly as it looks on screen. Treat an image as carrying personal data even though the text around it does not.

Sessions: one session is bound to one exact origin and holds an exclusive lease on it. A session expires after a period without activity (15 minutes unless the operator configured otherwise); every action extends it. Calling session_begin again for an origin your own earlier session still holds replaces that session; lease_conflict means another client holds it. A stored login for the origin, if any, is injected at session_begin and reported as storedLogin; it may have expired, so check the login state on the page either way. A logged-out session is normal — log in yourself with the login keys the calling service names: the site's own {{vault:<site>.login.id}} / .password, or a shared identity group such as {{vault:google.login.id}} / .password when the site signs in through a provider (vault_list shows which exist). End with session_end(loggedIn=true) so the login is stored for the next session; a sign-in through Google, Naver, Kakao or Apple made on the way is stored with it, on its own, and is present in every later session on any site, so the provider usually does not ask again — if it does, sign in as before. That same call also records the browser/headless combination you used, so a later session_begin that omits browser and headless reopens the origin the way that worked instead of falling back to the bundled default. Naming a combination always wins over that record. A session never changes its origin: navigate accepts any URL on the session's site (its subdomains included), and a click that lands on another site leaves the session bound where it began. If you do not know a site's origin, find it with your own search tool first; if you must discover it by browsing, do that in a separate session on the search engine, read the destination's origin from session_status after clicking through, end that session without loggedIn, and begin a new one on the origin you found. Tool order within this server: session_begin → page_tree → click / fill / select / scroll / navigate / wait (page_tree again whenever the page changes) → session_end. page_image is for seeing the page rather than reading it, and carries no refs — acting on what you see still goes through page_tree. When a click opens a new tab, that tab becomes the current page on its own; session_status lists the open pages and page_switch goes back to one of them. Grant issuance and the order of the caller's own steps follow the calling service's instructions; this server only verifies grants.`;

const sessionId = z.string().describe('Session id returned by session_begin.');
const ref = z.string().describe('Element ref from the latest page_tree, e.g. "7:e42". Not a CSS selector; refs expire on the next page_tree.');

export function buildMcpServer(deps: McpDeps, caller: Caller): McpServer {
  const server = new McpServer({ name: 'FronyBrowser', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  function out<T>(handler: string, result: Result<T>, url: string | null = null) {
    const scrubbed = scrub(result, egressContext(deps.vault, deps.audit, handler, url));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(scrubbed) }],
      isError: !(scrubbed as { ok: boolean }).ok,
    };
  }

  /**
   * 이미지 응답 (FWL-062) — 규칙 3의 유일한 예외다.
   *
   * PNG 바이트는 `scrub()`을 통과할 수 없다. 평문 매칭은 픽셀 안의 값을 못 찾고, base64를 대신
   * 넣으면 카드 뒷 4자리 같은 짧은 변형이 270KB 문자열 어딘가와 반드시 우연히 맞아 이미지를 망가뜨린다.
   * 그래서 메타데이터만 스크러버에 넣고 바이트는 별도 콘텐츠 블록으로 내보낸다.
   * 입력창은 촬영 시점에 이미 덮여 있고(규칙 1), 사이트가 화면에 표시한 값은 가려지지 않는다.
   */
  function outImage(handler: string, result: Result<{ image: PageImage }>, url: string | null = null) {
    if (!result.ok) return out(handler, result, url);
    const { png, ...meta } = result.image;
    const scrubbed = scrub({ ok: true as const, image: meta }, egressContext(deps.vault, deps.audit, handler, url));
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(scrubbed) },
        { type: 'image' as const, data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
      ],
    };
  }

  server.registerTool(
    'session_begin',
    {
      description:
        'Open a browser session bound to one exact origin (session = one origin). The origin\'s exclusive lease and stored login session are fixed here; browser/headless are chosen by you and fixed for the session; omit both and an origin that has logged in before reopens the way it worked. Your navigate calls must stay inside this origin (redirects the page performs itself, e.g. to a payment or login provider, are allowed). The response carries storedLogin: true when a stored login context was injected (it may have expired — verify on the page), false when this origin has none yet (go straight to the login page and use the vault login keys); neither is an error. vault_locked needs a human (operator runs "wallet unlock") — report and stop.',
      inputSchema: {
        origin: z.string().describe('Exact origin of the target site, e.g. "https://shop.example" — scheme and host only, no path, no wildcard.'),
        kind: z.string().optional().describe('Target kind. Omit for the browser (the only kind in this build).'),
        browser: z.enum(['chromium', 'chrome']).optional().describe('Browser engine. "chromium" (default) is the bundled test build; "chrome" is the installed Google Chrome, for sites whose bot detection rejects chromium. Fails with browser_unavailable if Chrome is not installed. Omit this and headless on an origin that has logged in before to reopen it exactly as it worked.'),
        headless: z.boolean().optional().describe('Default true. false opens a visible window (needed by some bot-protected sites); fails with browser_unavailable when no desktop session is available. Fixed per session. A bot manager usually blocks by serving an ordinary-looking page rather than an error, so a wrong value here does not show up in any response — check the page itself before concluding a site is empty or broken.'),
        traceId: z.string().optional().describe('Opaque correlation id from the calling service, recorded verbatim in the audit log for joining. No personal data.'),
        onApproval: z.enum(['wait', 'fail_fast']).optional().describe('Reserved for the approval channel; not active in this version (recorded only).'),
      },
    },
    async (args) => out('session_begin', await deps.handlers.session_begin(caller, args)),
  );

  server.registerTool(
    'session_list',
    {
      description:
        'Sessions owned by this client: id, creation time, remaining TTL, target origin, browser engine and headless flag. Use it to recover a session whose id you lost.',
      inputSchema: {},
    },
    async () => out('session_list', await deps.handlers.session_list(caller)),
  );

  server.registerTool(
    'session_status',
    {
      description: 'URL of the current page, the list of open pages ({ index, url, current } — url without query string), page_tree generation, remaining TTL and the held origin lease of one session. A newly opened tab becomes the current page by itself; use page_switch only to go back to another listed page.',
      inputSchema: { sessionId },
    },
    async ({ sessionId: sid }) =>
      out('session_status', await deps.handlers.session_status(caller, sid as SessionId)),
  );

  server.registerTool(
    'page_switch',
    {
      description:
        'Make one of the open pages listed by session_status the current page, e.g. to return to the page you were on after a click opened an ad in a new tab. Refs of the page you leave go stale; take a new page_tree. stale_ref means the index no longer exists — read session_status again. The next tab the site opens becomes current again by itself. There is no tool to close a tab; session_end closes them all.',
      inputSchema: { sessionId, index: z.number().int().min(0).describe('index from session_status.pages.') },
    },
    async ({ sessionId: sid, index }) => out('page_switch', await deps.handlers.page_switch(caller, sid as SessionId, index)),
  );

  server.registerTool(
    'session_end',
    {
      description:
        'Close the session and release its origin lease. Always call it when you are done — a session that merely expires does not save login cookies. Pass loggedIn=true only if the site\'s logged-in marker was visible when you finished; only then is the login stored — the first time this creates the origin\'s stored login, later times refresh it. Pass false if you saw a login form or a blocked / Access Denied page.',
      inputSchema: {
        sessionId,
        loggedIn: z.boolean().optional().describe('true only when the logged-in marker was visible at the end; false or omitted otherwise.'),
      },
    },
    async ({ sessionId: sid, loggedIn }) =>
      out('session_end', await deps.handlers.session_end(caller, sid as SessionId, loggedIn)),
  );

  server.registerTool(
    'page_tree',
    {
      description:
        'Element tree (role / name / ref) of the current page, all frames included. By default the tree is lean: it leaves out only decoration and what another line already says — decorative images (no name, inside a link or button, or the same name as the element next to them), footer / legal regions, and text that an element line already carries as its name. Body text itself is kept, so an inline error, a stock notice or the result of a click shows up as a text line. A run of identical unnamed elements (a secure keypad) is folded into one line "×N [ref=first..last]" — every ref in that range is valid. Pass raw: true to keep what the default drops — images, footer regions and the unfolded runs; refs are the same in both modes. A name is cut at 60 characters and the cut is marked "…"; if the cut drops a price, that price is appended, so a product card still shows what it costs. Text an element line already carries as its name is never repeated as a text line, in either mode, so that cut name is as much of it as any mode will give you. The current page follows the browser: when a click opens a new tab, that tab becomes the current page for every later call. Role "clickable" marks an element with no proper role that only has a click handler (e.g. a cursor:pointer div); when a button or link with the same label exists, prefer that one. Links to the same origin carry href=<path> (query string removed), usable with navigate. Input values are never included. Taking a new page_tree invalidates every earlier ref (stale_ref). To narrow further pass filter: "interactive" (buttons, links, fields and clickables only) or ref: <ref> (only that element\'s subtree).',
      inputSchema: {
        sessionId,
        ref: ref.optional().describe('Return only this element\'s subtree. Must come from the latest page_tree.'),
        filter: z.enum(['interactive']).optional().describe('"interactive": only buttons, links, form fields, ARIA widgets and clickables.'),
        raw: z.boolean().optional().describe('true: the complete tree with nothing left out (images, footer, text already shown as an element name, no folding).'),
      },
    },
    async ({ sessionId: sid, ref: r, filter, raw }) =>
      out('page_tree', await deps.handlers.page_tree(caller, sid as SessionId, {
        ...(r === undefined ? {} : { ref: r as Ref }),
        ...(filter === undefined ? {} : { filter }),
        ...(raw === undefined ? {} : { raw }),
      })),
  );

  server.registerTool(
    'page_image',
    {
      description:
        'A picture of what is on screen right now — the viewport of the current page, as a PNG scaled to a 1024px long edge, which still reads cleanly and costs well under half of a full-resolution shot. Reach for it when the layout, an image or a captcha carries meaning the element tree cannot: page_tree is cheaper and is the only source of refs. Every input, textarea, select and contenteditable is covered with a solid box, in every frame, so a value you filled is never in the picture. Everything else is captured as it renders, including personal data the site itself puts on screen — a delivery name, phone or address that is visible will be in the image. Use scroll first to bring the part you want into view.',
      inputSchema: { sessionId },
    },
    async ({ sessionId: sid }) => outImage('page_image', await deps.handlers.page_image(caller, sid as SessionId)),
  );

  server.registerTool(
    'navigate',
    {
      description:
        'Go to a URL on the current site — the session origin or any subdomain of it, same scheme (origin_not_permitted otherwise); redirects the page performs by itself are not restricted.',
      inputSchema: { sessionId, url: z.string().describe('Absolute URL inside the session origin.') },
    },
    async ({ sessionId: sid, url }) => out('navigate', await deps.handlers.navigate(caller, sid as SessionId, url), url),
  );

  server.registerTool(
    'fill',
    {
      description:
        'Type into a field. Put "{{vault:key}}" placeholders in the value; the server substitutes the real value, which never appears in any response. Available keys: vault_list. For a secure keypad (payment PINs) pass keypad and point ref at any element inside the keypad frame, e.g. its heading — the server presses the digit keys itself and reports keypad_unresolved if it cannot read the keypad. Never click digit keys yourself. Keys registered with the grant flag additionally need grant.',
      inputSchema: {
        sessionId,
        ref,
        value: z.string().describe('Text to type; may contain "{{vault:key}}" placeholders. A keypad key must be the whole value.'),
        grant: z
          .string()
          .optional()
          .describe('Pay grant token issued by the trusted grant issuer that shares this server\'s grant key. Required only for keys registered with the grant flag (payment PINs, card passwords). Valid 5 minutes, single use, bound to this session.'),
        keypad: z
          .union([
            z.object({ digitSelector: z.string() }),
            z.object({ keySelector: z.string(), cellSelector: z.string(), resolver: z.literal('sprite-template'), template: z.string().regex(/^[a-z0-9-]+$/).optional() }),
          ])
          .optional()
          .describe('Secure keypad mode: the server presses one key per digit instead of typing. digitSelector is a CSS selector with "{digit}" as the placeholder for the digit; the sprite form is for keypads whose digits are background images, and its optional template names a glyph template the operator registered on this server for that site (omit it for the built-in one). The value must be exactly one "{{vault:key}}" holding digits only.'),
      },
    },
    async ({ sessionId: sid, ref: r, value, grant, keypad }) =>
      out('fill', await deps.handlers.fill(caller, sid as SessionId, r as Ref, value, grant, keypad)),
  );

  server.registerTool(
    'click',
    {
      description: 'Click an element.',
      inputSchema: { sessionId, ref },
    },
    async ({ sessionId: sid, ref: r }) => out('click', await deps.handlers.click(caller, sid as SessionId, r as Ref)),
  );

  server.registerTool(
    'select',
    {
      description: 'Choose an option in a select box.',
      inputSchema: { sessionId, ref, option: z.string().describe('Option value or visible label.') },
    },
    async ({ sessionId: sid, ref: r, option }) =>
      out('select', await deps.handlers.select(caller, sid as SessionId, r as Ref, option)),
  );

  server.registerTool(
    'scroll',
    {
      description:
        'Scroll until the element is in view. It moves whatever scroll container the element sits in, so it also reaches inside a modal or a side panel, where scrolling the window would do nothing. Refs stay valid — scrolling starts no new page_tree generation, so you can keep using the refs you already have.',
      inputSchema: { sessionId, ref },
    },
    async ({ sessionId: sid, ref: r }) => out('scroll', await deps.handlers.scroll(caller, sid as SessionId, r as Ref)),
  );

  server.registerTool(
    'wait',
    {
      description: 'Wait until an element is visible.',
      inputSchema: { sessionId, ref, timeoutMs: z.number().describe('Milliseconds to wait, clamped to 1–30000.') },
    },
    async ({ sessionId: sid, ref: r, timeoutMs }) =>
      out('wait', await deps.handlers.wait(caller, sid as SessionId, r as Ref, timeoutMs)),
  );

  server.registerTool(
    'vault_list',
    { description: 'Names, types and labels of the keys registered in the vault, each with a grant flag saying whether fill needs a pay grant for it. Values and their lengths are never returned.', inputSchema: {} },
    async () => out('vault_list', await deps.handlers.vault_list(caller)),
  );

  return server;
}
