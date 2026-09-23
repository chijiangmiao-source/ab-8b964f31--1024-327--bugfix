import type {
  Analysis,
  CompleteAnalysis,
  EventRole,
  Gate,
  LimitedAnalysis,
  ParsedModel
} from './types';

export const MAX_CUTSETS_PER_GATE = 2000;

/** 基本事件最多 30 个，用 30 位掩码（位 0..29），子集判断退化为位运算。 */
type Mask = number;

class LimitHit {
  constructor(readonly gate: string, readonly line: number) {}
}

export function bitCount(m: Mask): number {
  let x = m;
  let n = 0;
  while (x) {
    n += 1;
    x &= x - 1;
  }
  return n;
}

function containsAny(kept: Mask[], m: Mask): boolean {
  for (const k of kept) {
    if ((m & k) === k) return true;
  }
  return false;
}

/** kept 中是否存在 m 的子集；枚举 m 的子掩码与线性扫描择优。 */
function keptHasSubset(m: Mask, kept: Mask[], keptSet: Set<Mask>): boolean {
  if (kept.length === 0) return false;
  if (2 ** (bitCount(m) - 1) < kept.length) {
    for (let s = (m - 1) & m; s; s = (s - 1) & m) {
      if (keptSet.has(s)) return true;
    }
    return false;
  }
  return containsAny(kept, m);
}

/**
 * OR 归并：各子门割集本身就是候选，求极小族。
 * 按基数升序保留——更晚的集合不可能吸收更早的集合，
 * 因此保留数量只增不减，越过上限即可可靠地判定截断。
 */
function minimizeOr(children: Mask[][], limit: number): Mask[] {
  const buckets: Mask[][] = Array.from({ length: 31 }, () => []);
  const seen = new Set<Mask>();
  for (const fam of children) {
    for (const m of fam) {
      if (!seen.has(m)) {
        seen.add(m);
        buckets[bitCount(m)].push(m);
      }
    }
  }

  const kept: Mask[] = [];
  const keptSet = new Set<Mask>();
  for (let size = 0; size <= 30; size += 1) {
    for (const m of buckets[size]) {
      if (keptHasSubset(m, kept, keptSet)) continue;
      kept.push(m);
      keptSet.add(m);
      if (kept.length > limit) throw new LimitHit('', 0);
    }
  }
  return kept;
}

/**
 * AND 归并：候选割集 = 从每个子门各取一个割集后的并集，再取极小族。
 *
 * 不能按输入逐个折叠并在中间结果上判上限——后续合取支可能使族大幅坍缩
 * （例如 2187 个组合再与“全部事件”单割集相与，最终只剩 1 个）。
 *
 * 这里按最终并集基数 s 从小到大做组合 DFS：基数更大的候选不可能吸收更小的
 * 候选，因此处理完 s 后，大小 ≤s 的极小割集已全部确定，保留集此后只增不减，
 * 越过上限即可靠地判定为门最终族的真实超限。
 *
 * 正确性要点：
 *  - 同一 (子门序号, 当前并集) 的后续可选分支完全相同，可按精确状态去重；
 *    但绝不能把“前缀已出现、后缀可能位中也存在”的位当作已定局位——后缀的
 *    某次取值可以不覆盖它，投影去重会错误删除这类合法分支。
 *  - minAchievable 给出从某状态出发可达的最小最终基数（精确值），用于在给定
 *    目标基数 s 时剪枝，并经记忆化在各基数轮与各状态间复用。
 */
function minimizeAnd(children: Mask[][], limit: number): Mask[] {
  if (children.length === 1) return children[0];
  // 防御：合法模型里门至少有一个输入，归一化族不可能为空。
  const fams = children
    .filter((fam) => fam.length > 0)
    .map((fam) => [...fam].sort((a, b) => bitCount(a) - bitCount(b)))
    // 分支数少的子门先展开，尽早用极小割集与定界剪枝后续分支；
    // 排序只影响性能，使结果与门定义/输入书写顺序无关。
    .sort((a, b) => a.length - b.length);
  if (fams.length === 0) return [];
  if (fams.length === 1) return fams[0];

  const k = fams.length;
  const kept: Mask[] = [];
  const keptSet = new Set<Mask>();

  // 后缀所有取值的位并集，仅用于推算最终基数上界。
  const suffixPossible = new Array<number>(k + 1).fill(0);
  for (let i = k - 1; i >= 0; i -= 1) {
    suffixPossible[i] = suffixPossible[i + 1] | fams[i].reduce((u, m) => u | m, 0);
  }
  const maxSize = bitCount(suffixPossible[0]);

  // key = idx * 2^30 + union；idx ≤ 门输入数（≤80），union < 2^30，
  // 远小于 2^53，键值互不重叠且为安全整数。
  const KEY_BASE = 2 ** 30;
  // 仅缓存“在某 cutoff 之下求得的精确最小值”；值 ≥cutoff 时只代表下界，不缓存。
  const minMemo = new Map<number, number>();

  /**
   * 从 (idx, union) 出发可达的最小最终基数；若该最小值 ≥ cutoff 可直接返回 cutoff。
   * 并集基数单调不减，故分支定界不会低估：初始 cutoff 取不可达上界时即为精确值。
   */
  const minAchievable = (idx: number, union: Mask, cutoff: number): number => {
    if (bitCount(union) >= cutoff) return cutoff;
    if (idx === k) return bitCount(union);
    const key = idx * KEY_BASE + union;
    const cached = minMemo.get(key);
    if (cached !== undefined) return cached >= cutoff ? cutoff : cached;

    let best = cutoff;
    for (const part of fams[idx]) {
      const v = minAchievable(idx + 1, union | part, best);
      if (v < best) {
        best = v;
        // 基数不可能低于当前并集基数，已达理论最优。
        if (best === bitCount(union)) break;
      }
    }
    if (best < cutoff) minMemo.set(key, best);
    return best;
  };

  const globalMin = minAchievable(0, 0, maxSize + 1);
  for (let size = globalMin; size <= maxSize; size += 1) {
    const candidates = new Set<Mask>();
    // 仅按精确 (序号, 并集) 去重，避免等价路径指数重复。
    const visited = new Set<number>();

    const dfs = (idx: number, union: Mask): void => {
      // 已含更小的极小割集：后续并集只会更大，整条分支被吸收。
      if (keptHasSubset(union, kept, keptSet)) return;
      if (bitCount(union) > size) return;
      // 该状态下最优可能仍超过目标基数：本轮无解。
      if (minAchievable(idx, union, size + 1) > size) return;

      const key = idx * KEY_BASE + union;
      if (visited.has(key)) return;
      visited.add(key);

      if (idx === k) {
        if (bitCount(union) === size && !keptHasSubset(union, kept, keptSet)) {
          candidates.add(union);
        }
        return;
      }
      for (const part of fams[idx]) {
        dfs(idx + 1, union | part);
      }
    };

    dfs(0, 0);
    for (const c of candidates) {
      kept.push(c);
      keptSet.add(c);
      if (kept.length > limit) throw new LimitHit('', 0);
    }
  }
  return kept;
}

export function analyze(model: ParsedModel): Analysis {
  const eventBit = new Map<string, number>();
  model.events.forEach((e, i) => eventBit.set(e, i));
  const gateByName = new Map<string, Gate>();
  for (const g of model.gates) gateByName.set(g.name, g);

  const memo = new Map<string, Mask[]>();
  const gateCounts: Record<string, number> = {};
  const partialGateCounts: Record<string, number> = {};
  const stack = new Set<string>();

  const normalize = (name: string): Mask[] => {
    const cached = memo.get(name);
    if (cached) return cached;
    if (stack.has(name)) {
      // 调用方负责先做 DAG 校验，此处理论不可达。
      throw new Error(`unexpected cycle at ${name}`);
    }
    const gate = gateByName.get(name);
    if (!gate) throw new Error(`unknown gate ${name}`);
    stack.add(name);

    try {
      // 同一输入（含重复书写的共享门）只参与一次。
      const uniqueInputs = [...new Set(gate.inputs)];
      const children: Mask[][] = uniqueInputs.map((input) => {
        const bit = eventBit.get(input);
        return bit !== undefined ? [1 << bit] : normalize(input);
      });

      const family =
        gate.type === 'AND'
          ? minimizeAnd(children, MAX_CUTSETS_PER_GATE)
          : minimizeOr(children, MAX_CUTSETS_PER_GATE);

      memo.set(name, family);
      gateCounts[name] = family.length;
      partialGateCounts[name] = family.length;
      return family;
    } catch (err) {
      // 基数枚举抛出的 LimitHit 不带门信息；在直接触发的那一帧补上，
      // 嵌套调用已带名时原样上抛，避免被父门名覆盖。
      if (err instanceof LimitHit && err.gate === '') {
        throw new LimitHit(gate.name, gate.line);
      }
      throw err;
    } finally {
      stack.delete(name);
    }
  };

  // 按门定义顺序逐一枚举；共享门经 memo 仅规范化一次，杜绝重复计算。
  for (const g of model.gates) {
    try {
      normalize(g.name);
    } catch (err) {
      if (err instanceof LimitHit) {
        const limited: LimitedAnalysis = {
          status: 'complexity_limit',
          gate: err.gate,
          line: err.line,
          limit: MAX_CUTSETS_PER_GATE,
          partialGateCounts
        };
        return limited;
      }
      throw err;
    }
  }

  const topFamily = memo.get(model.top)!;
  const masksToIds = (m: Mask): string[] => {
    const ids: string[] = [];
    for (let i = 0; i < model.events.length; i += 1) {
      if (m & (1 << i)) ids.push(model.events[i]);
    }
    // 集合内按事件标识排序
    ids.sort();
    return ids;
  };

  let orUnion: Mask = 0;
  let andIntersection: Mask | null = null;
  for (const m of topFamily) {
    orUnion |= m;
    andIntersection = andIntersection === null ? m : andIntersection & m;
  }
  const intersection = andIntersection ?? 0;

  const classification: Record<string, EventRole> = {};
  for (const e of model.events) {
    const bit = 1 << eventBit.get(e)!;
    let role: EventRole;
    if (intersection & bit) role = 'mandatory';
    else if (orUnion & bit) role = 'optional';
    else role = 'irrelevant';
    classification[e] = role;
  }

  // 集合间按事件标识元组字典序排序
  const cutsets = topFamily
    .map(masksToIds)
    .sort((a, b) => {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i += 1) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
      }
      return a.length - b.length;
    });

  const complete: CompleteAnalysis = {
    status: 'complete',
    top: model.top,
    cutsets,
    classification,
    gateCounts
  };
  return complete;
}
