/**
 * npm 배포용 번들 (FWL-084).
 *
 * @wallet/core·app·api·cli는 비공개 워크스페이스로 남는다 — 넷을 따로 올리면 npm에 `@wallet`
 * org가 필요하고 릴리스마다 네 버전을 맞춰야 한다. 대신 워크스페이스 코드만 한 파일로 접고
 * 런타임 의존성 넷은 external로 둔다: 배포물은 파일 두 개 + dependencies 넷이 된다.
 *
 * 출력 경로가 저장소의 깊이와 같아야 한다 — main.ts가 GUI를 `../../../frontend/dist`로 찾으므로
 * backend/api/dist/ 밖으로 내보내면 그 줄을 고쳐야 한다.
 *
 * minify하지 않는다. 값이 새지 않는다는 주장이 이 저장소의 존재 이유이고, 배포물을 읽어서
 * 확인할 수 있어야 그 주장이 검증 가능하다.
 */

import { build } from 'esbuild';

/** 번들에 접지 않는 런타임 의존성 — 배포 package.json의 dependencies와 같은 목록이어야 한다 */
const external = [
  'patchright',
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/*',
  'zod',
  'pngjs',
];

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['backend/api/src/main.ts'], outfile: 'backend/api/dist/server.js' });
await build({ ...common, entryPoints: ['backend/cli/src/index.ts'], outfile: 'backend/cli/dist/cli.js' });
