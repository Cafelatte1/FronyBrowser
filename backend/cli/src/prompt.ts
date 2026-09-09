/**
 * 터미널 숨김 입력. 패스프레이즈·값은 인자·환경변수로 받지 않는다 —
 * 프로세스 목록과 셸 히스토리에 남는다.
 */

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export function promptHidden(question: string): Promise<string> {
  return new Promise((resolvePrompt, reject) => {
    let muted = false;
    const mutable = new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        if (!muted) process.stderr.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: mutable, terminal: true });
    mutable.write(question);
    muted = true;
    rl.question('', (answer) => {
      muted = false;
      mutable.write('\n');
      rl.close();
      resolvePrompt(answer);
    });
    rl.on('error', reject);
  });
}
