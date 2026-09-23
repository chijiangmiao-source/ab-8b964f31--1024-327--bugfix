/**
 * verify 一次性服务的规定场景断言（由 esbuild 打包为 Node ESM 后执行）。
 * 覆盖：
 *   1. 吸收律场景的最小割集；
 *   2. 共享子门的事件归属；
 *   3. 任一门规范化后超过 2000 个割集的超限场景；
 *   4. 八组双事件树 1024 个九事件割集（含门定义重排）。
 * 任一断言失败即以非零退出码结束进程。
 */
import { analyze } from '../src/core/engine';
import { audit } from '../src/core/pipeline';
import type { ParsedModel } from '../src/core/types';

let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}`, detail ?? '');
  }
}

function buildModel(events: string[], lines: string[], top: string): ParsedModel {
  const gates = lines.map((line, i) => {
    const [name, type, ...inputs] = line.trim().split(/\s+/);
    return { name, type: type as 'AND' | 'OR', inputs, line: i + 1 };
  });
  return { events, gates, top };
}

const names = (cuts: string[][]): string[] => cuts.map((c) => [...c].sort().join('*'));

// ---- 场景 1：吸收律 ----
// TOP = G1 OR G2，G1=A OR B，G2=A AND B；{A,B} 是 {A}、{B} 的真超集，必须被吸收。
console.log('[scenario 1] absorption: A∨B∨(A∧B) => {A},{B}');
{
  const r = audit('A\nB\n', 'G1 OR A B\nG2 AND A B\nTOP OR G1 G2\n', 'TOP');
  check('状态为 complete', r.status === 'complete', r);
  if (r.status === 'complete') {
    check('最小割集恰为 {A},{B}', JSON.stringify(names(r.cutsets)) === JSON.stringify(['A', 'B']), names(r.cutsets));
  }
}

// ---- 场景 2：共享子门的事件归属 ----
// S 被 L、R 共享；T=(S∧A)∨(S∧B)。割集 {A},{B}，X 未接入任何门。
console.log('[scenario 2] shared sub-gate classification');
{
  const r = analyze(
    buildModel(
      ['A', 'B', 'X'],
      ['S OR A B', 'L AND S A', 'R AND S B', 'T OR L R'],
      'T'
    )
  );
  check('状态为 complete', r.status === 'complete', r);
  if (r.status === 'complete') {
    check('A=可选', r.classification.A === 'optional', r.classification);
    check('B=可选', r.classification.B === 'optional', r.classification);
    check('X=无关', r.classification.X === 'irrelevant', r.classification);
    check('割集为 {A},{B}', JSON.stringify(names(r.cutsets)) === JSON.stringify(['A', 'B']), names(r.cutsets));
    check('共享门 S 仅规范化一次（计数=2）', r.gateCounts.S === 2, r.gateCounts);
  }
}

// ---- 场景 3：complexity_limit ----
// 7 个三选一组相与 => 3^7 = 2187 > 2000；必须报告 complexity_limit 且不得产出完整结论。
console.log('[scenario 3] complexity_limit at 3^7=2187 > 2000');
{
  const events: string[] = [];
  const lines: string[] = [];
  for (let g = 0; g < 7; g += 1) {
    const members = [`e${g}_0`, `e${g}_1`, `e${g}_2`];
    events.push(...members);
    lines.push(`GRP${g} OR ${members.join(' ')}`);
  }
  lines.push('BIG AND GRP0 GRP1 GRP2 GRP3 GRP4 GRP5 GRP6');
  const r = analyze(buildModel(events, lines, 'BIG'));
  check('状态为 complexity_limit', r.status === 'complexity_limit', r);
  if (r.status === 'complexity_limit') {
    check('定位到超限门 BIG', r.gate === 'BIG', r);
    check('上限为 2000', r.limit === 2000, r);
    check('未输出任何割集（不冒充完整结论）', !('cutsets' in r), r);
  }
  // 边界：恰好 2000（4*5*10*10）必须完整
  const sizes = [4, 5, 10, 10];
  const ev2: string[] = [];
  const ln2: string[] = [];
  sizes.forEach((s, gi) => {
    const members = Array.from({ length: s }, (_, k) => `h${gi}_${k}`);
    ev2.push(...members);
    ln2.push(`GRP${gi} OR ${members.join(' ')}`);
  });
  ln2.push('BIG AND GRP0 GRP1 GRP2 GRP3');
  const r2 = analyze(buildModel(ev2, ln2, 'BIG'));
  check('恰好 2000 时完整输出 2000 个割集', r2.status === 'complete' && r2.cutsets.length === 2000, r2.status);
}

// ---- 场景 4：八组双事件审计树（1024 = 8 × 2^7 个九事件割集） ----
// ORi=Ai∨Bi，ANDi=Ai∧Bi，BOTH=OR(AND0..AND7)，TOP=AND(OR0..OR7, BOTH)。
// 回归缺陷：错误的“固定位投影”剪枝会把真实不同的状态当重复丢弃，
// 只返回 327 个割集并把 A0 误判为必现；且结论不得随门定义行序变化。
console.log('[scenario 4] eight paired groups: 8 × 2^7 = 1024 nine-event cutsets');
{
  type Line = { name: string; type: 'AND' | 'OR'; inputs: string[] };
  const lines: Line[] = [];
  for (let i = 0; i < 8; i += 1) {
    lines.push({ name: `OR${i}`, type: 'OR', inputs: [`A${i}`, `B${i}`] });
    lines.push({ name: `AND${i}`, type: 'AND', inputs: [`A${i}`, `B${i}`] });
  }
  lines.push({ name: 'BOTH', type: 'OR', inputs: Array.from({ length: 8 }, (_, i) => `AND${i}`) });
  lines.push({ name: 'TOP', type: 'AND', inputs: [...Array.from({ length: 8 }, (_, i) => `OR${i}`), 'BOTH'] });

  const events = [...Array.from({ length: 8 }, (_, i) => `A${i}`), ...Array.from({ length: 8 }, (_, i) => `B${i}`)];
  const orderings: Record<string, Line[]> = {
    原始顺序: lines,
    全部逆序: [...lines].reverse(),
    顶门前置: [lines[lines.length - 1], lines[lines.length - 2], ...lines.slice(0, -2)]
  };

  for (const [label, ordered] of Object.entries(orderings)) {
    const r = analyze(buildModel(events, ordered.map((l) => `${l.name} ${l.type} ${l.inputs.join(' ')}`), 'TOP'));
    check(`[${label}] 状态为 complete`, r.status === 'complete', r);
    if (r.status !== 'complete') continue;

    check(`[${label}] 割集数为 1024`, r.cutsets.length === 1024, r.cutsets.length);
    const joined = r.cutsets.map((c) => c.join('*'));
    check(`[${label}] 割集两两不同`, new Set(joined).size === joined.length);
    const nineEvents = r.cutsets.every((c) => c.length === 9);
    check(`[${label}] 每个割集恰含 9 个事件`, nineEvents);

    // 结构：每组至少一个事件，恰有一组 A、B 同在。
    let structureOk = true;
    for (const c of r.cutsets) {
      const set = new Set(c);
      let doubles = 0;
      for (let g = 0; g < 8; g += 1) {
        const hasA = set.has(`A${g}`);
        const hasB = set.has(`B${g}`);
        if (!hasA && !hasB) structureOk = false;
        if (hasA && hasB) doubles += 1;
      }
      if (doubles !== 1) structureOk = false;
    }
    check(`[${label}] 恰有一组双现、其余组各选一`, structureOk);

    let rolesOk = true;
    for (let i = 0; i < 8; i += 1) {
      if (r.classification[`A${i}`] !== 'optional' || r.classification[`B${i}`] !== 'optional') rolesOk = false;
    }
    check(`[${label}] 16 个事件全部可选`, rolesOk, r.classification);

    let countsOk = r.gateCounts.BOTH === 8 && r.gateCounts.TOP === 1024;
    for (let i = 0; i < 8; i += 1) {
      if (r.gateCounts[`OR${i}`] !== 2 || r.gateCounts[`AND${i}`] !== 1) countsOk = false;
    }
    check(`[${label}] 各门计数：单组 OR=2、AND=1、BOTH=8、TOP=1024`, countsOk, r.gateCounts);
  }
}

if (failures > 0) {
  console.error(`\nVERIFY SCENARIOS FAILED: ${failures}`);
  process.exit(1);
}
console.log('\nALL VERIFY SCENARIOS PASSED');
