import fs from 'node:fs';
import { append, rec } from '../chat/harness';

/** The approved claude-feel-2.html turn, in the real transcript format. */
export function mockupTurn(file: string, cwd: string) {
  const user = rec.userImage('트리 행 높이를 목업처럼 30px로 맞추고, 프로젝트 행은 목업 높이로 맞춰줘');
  const source = user.message.content[1] as { source: { data: string } };
  source.source.data = fs.readFileSync(new URL('./attachment.png', import.meta.url)).toString('base64');
  append(
    file,
    user,
    rec.thinking('목업의 세션 행은 30px, 프로젝트 행은 25px 정도. 먼저 tree.css의 현재 값과 고정 테스트를 확인해야 한다…'),
    rec.use('r1', 'Read', { file_path: `${cwd}/web/src/tree/tree.css` }),
    rec.result('r1', 'css', { timestamp: '2026-10-29T10:00:00.000Z' }),
    rec.use('r2', 'Read', { file_path: `${cwd}/web/tests/tree-rows.spec.ts` }),
    rec.result('r2', 'tests'),
    rec.use('r3', 'Read', { file_path: `${cwd}/web/tests/visual/mockups/v2-8a-groups.html` }),
    rec.result('r3', 'mockup'),
    rec.edit('e1', `${cwd}/web/src/tree/tree.css`, ['-a', '-b', '+c', '+d', '+e', '+f']),
    rec.use('t1', 'Bash', { command: 'npx playwright test tree-rows' }),
    rec.result('t1', '18 passed', { timestamp: '2026-10-29T10:00:42.000Z' }),
    rec.assistant('세션 행은 30px, 프로젝트 행은 목업의 25px로 맞췄어요. 시각 게이트 차이는 **1.6%**(기준 2%)예요.\n\n접힌 그룹 헤더에는 막대를 넣지 않았어요. 10-27 G2 결정의 고정 테스트가 있어서예요. [tree-rows.spec.ts:208](https://example.com/tree-rows.spec.ts#L208)'),
    rec.end(),
  );
}
