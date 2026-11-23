import type { SolverMode } from "../../../shared/types";
import type { FrontierComponent } from "./frontier";

/** 单组求解结果：按“组内危险数 k”统计布局数与每格危险次数 */
export interface ComponentSolution {
  size: number;
  /** counts[k] = 组内恰好 k 个危险的可行布局数量 */
  counts: bigint[];
  /** dangerCount[k][varLocal] = 该 k 层下该局部变量为危险的布局数 */
  dangerCount: bigint[][];
  exact: boolean;
  /** 抽样模式下有效样本数；精确模式为总布局数（number 形式，超界时为 -1） */
  samples: number;
  /**
   * 精确且布局数受限时，保存全部可行布局，每个元素是一张“危险格局部下标”表。
   * 存在即可做严格均匀抽样；超大组被截断时为 undefined。
   */
  layouts?: number[][];
}

/** 精确模式下每组允许枚举并保存的布局上限，超过则降级抽样 */
export const EXACT_LAYOUT_LIMIT = 200_000;
/** 抽样目标样本数（估计模式，含全局合成重采样） */
export const SAMPLE_TARGET = 800;

interface LocalConstraint {
  cells: number[];
  remaining: number;
}

/**
 * 快速估计可行解数量的上界，用于决定是否值得完整枚举。
 * 用动态规划统计“忽略约束间耦合、仅按单条约束容量”的宽松上界，
 * 取 2^自由变量 与各约束组合上界的最小值。估算本身是 O(size·约束数)。
 */
export function estimateSolutionBound(comp: FrontierComponent): bigint {
  const size = comp.vars.length;
  let bound = 1n << BigInt(Math.min(size, 60));
  for (const c of comp.constraints) {
    // 单条约束：从 n 个变量选 remaining 个
    let ways = 1n;
    const n = c.cells.length;
    const k = Math.min(c.remaining, n - c.remaining);
    if (k < 0) return 0n;
    for (let i = 0; i < k; i++) {
      ways = (ways * BigInt(n - i)) / BigInt(i + 1);
      if (ways > bound) break;
    }
    if (ways < bound) bound = ways;
  }
  return bound;
}

/**
 * 对单个连通组做完整枚举。
 * DFS 逐变量赋值，每条线索维护剩余需求，带上下界剪枝。
 * 返回按组内危险数分层的精确计数（BigInt 防溢出）；
 * 布局数不超过 layoutLimit 时同时保存全部可行布局，供严格均匀抽样。
 */
export function enumerateExact(
  comp: FrontierComponent,
  layoutLimit = EXACT_LAYOUT_LIMIT,
): { solution: ComponentSolution; truncated: boolean } {
  const size = comp.vars.length;
  const constraints: LocalConstraint[] = comp.constraints.map((c) => ({
    cells: c.cells,
    remaining: c.remaining,
  }));

  const counts: bigint[] = new Array(size + 1).fill(0n);
  const dangerCount: bigint[][] = Array.from({ length: size + 1 }, () =>
    new Array(size).fill(0n),
  );
  const layouts: number[][] = [];

  const varConstraints: number[][] = Array.from({ length: size }, () => []);
  constraints.forEach((c, ci) => {
    for (const v of c.cells) varConstraints[v].push(ci);
  });

  const assign = new Array<0 | 1>(size).fill(0);
  const remaining = constraints.map((c) => c.remaining);
  const openCount = constraints.map((c) => c.cells.length);
  let total = 0n;
  let truncated = false;
  // 节点预算：变量越多搜索树越宽，收紧预算让大组尽快放弃精确枚举。
  // 小组（典型游戏局面 ≤ ~20 变量）预算充裕保证完整；大组快速降级抽样。
  const nodeBudget = Math.min(layoutLimit * 8, 60_000 + size * 1_200);
  let nodes = 0;

  const dfs = (idx: number, minesUsed: number): void => {
    if (truncated) return;
    if (++nodes > nodeBudget) {
      truncated = true;
      return;
    }
    if (idx === size) {
      counts[minesUsed] += 1n;
      const mines: number[] = [];
      for (let v = 0; v < size; v++) {
        if (assign[v]) {
          dangerCount[minesUsed][v] += 1n;
          mines.push(v);
        }
      }
      if (layouts.length < layoutLimit) layouts.push(mines);
      total += 1n;
      if (total >= BigInt(layoutLimit)) {
        // 达到上限即提前终止，避免在超大空间里继续枚举
        truncated = true;
      }
      return;
    }
    for (const value of [0, 1] as const) {
      if (value === 1) {
        let ok = true;
        for (const ci of varConstraints[idx]) {
          if (remaining[ci] <= 0) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
      }
      if (value === 1)
        for (const ci of varConstraints[idx]) remaining[ci] -= 1;
      for (const ci of varConstraints[idx]) openCount[ci] -= 1;
      assign[idx] = value;

      let feasible = true;
      for (const ci of varConstraints[idx]) {
        if (remaining[ci] < 0 || remaining[ci] > openCount[ci]) {
          feasible = false;
          break;
        }
      }
      if (feasible) dfs(idx + 1, minesUsed + value);

      assign[idx] = 0;
      for (const ci of varConstraints[idx]) openCount[ci] += 1;
      if (value === 1)
        for (const ci of varConstraints[idx]) remaining[ci] += 1;
    }
  };

  const entryFeasible = constraints.every(
    (c) => c.remaining >= 0 && c.remaining <= c.cells.length,
  );
  if (entryFeasible) dfs(0, 0);

  const exact = !truncated && total > 0n;
  return {
    solution: {
      size,
      counts,
      dangerCount,
      exact,
      samples: exact ? Number(total) : -1,
      // 截断时布局表不完整，不能用于均匀抽样
      layouts: exact ? layouts : undefined,
    },
    truncated,
  };
}

/** 可复现的线性同余随机源，保证同一输入结果稳定 */
export function makeRng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

interface Rng {
  (): number;
}

/**
 * 随机 DFS 抽取一次完整可行赋值（近似均匀，仅用于超大组的估计）。
 * 每个变量随机决定安全/危险的尝试顺序，可行才深入。
 * 返回 null 表示该组无可行布局。
 */
export function drawAssignment(
  comp: FrontierComponent,
  rng: Rng,
): { assign: Uint8Array; mines: number } | null {
  const size = comp.vars.length;
  const constraints: LocalConstraint[] = comp.constraints.map((c) => ({
    cells: c.cells,
    remaining: c.remaining,
  }));
  if (!constraints.every((c) => c.remaining >= 0 && c.remaining <= c.cells.length))
    return null;

  const varConstraints: number[][] = Array.from({ length: size }, () => []);
  constraints.forEach((c, ci) => {
    for (const v of c.cells) varConstraints[v].push(ci);
  });
  const assign = new Uint8Array(size);
  const remaining = constraints.map((c) => c.remaining);
  const openCount = constraints.map((c) => c.cells.length);
  let mines = 0;

  const dfs = (idx: number): boolean => {
    if (idx === size) return true;
    const first: 0 | 1 = rng() < 0.5 ? 0 : 1;
    const choices: (0 | 1)[] = first === 0 ? [0, 1] : [1, 0];
    for (const value of choices) {
      if (value === 1) {
        let ok = true;
        for (const ci of varConstraints[idx])
          if (remaining[ci] <= 0) {
            ok = false;
            break;
          }
        if (!ok) continue;
      }
      if (value === 1)
        for (const ci of varConstraints[idx]) remaining[ci] -= 1;
      for (const ci of varConstraints[idx]) openCount[ci] -= 1;
      assign[idx] = value;
      let feasible = true;
      for (const ci of varConstraints[idx]) {
        if (remaining[ci] < 0 || remaining[ci] > openCount[ci]) {
          feasible = false;
          break;
        }
      }
      if (feasible && dfs(idx + 1)) {
        if (value) mines++;
        return true;
      }
      assign[idx] = 0;
      for (const ci of varConstraints[idx]) openCount[ci] += 1;
      if (value === 1)
        for (const ci of varConstraints[idx]) remaining[ci] += 1;
    }
    return false;
  };

  return dfs(0) ? { assign, mines } : null;
}

/**
 * 抽样求解：反复随机 DFS 抽取可行布局，按组内危险数分层统计。
 * 估计值，不能用于证明零风险。
 */
export function sampleComponent(
  comp: FrontierComponent,
  target = SAMPLE_TARGET,
  seed = 1,
): ComponentSolution {
  const size = comp.vars.length;
  const counts: bigint[] = new Array(size + 1).fill(0n);
  const dangerCount: bigint[][] = Array.from({ length: size + 1 }, () =>
    new Array(size).fill(0n),
  );

  const rng = makeRng(seed);
  let samples = 0;
  let attempts = 0;
  const maxAttempts = target * 40;

  while (samples < target && attempts < maxAttempts) {
    attempts++;
    const draw = drawAssignment(comp, rng);
    if (!draw) break;
    const { assign, mines } = draw;
    counts[mines] += 1n;
    for (let v = 0; v < size; v++) if (assign[v]) dangerCount[mines][v] += 1n;
    samples++;
  }

  return { size, counts, dangerCount, exact: false, samples };
}

/**
 * 从一个已完整枚举的组中抽取**严格均匀**的可行布局：
 * 直接在保存的全部布局里均匀取索引。无布局表（超大组）时返回 null。
 */
export function drawFromExact(
  solution: ComponentSolution,
  rng: () => number,
): { assign: Uint8Array; mines: number } | null {
  if (!solution.layouts || !solution.layouts.length) return null;
  const idx = Math.floor(rng() * solution.layouts.length);
  const minesList = solution.layouts[idx];
  const assign = new Uint8Array(solution.size);
  for (const v of minesList) assign[v] = 1;
  return { assign, mines: minesList.length };
}

/** 对单组选择精确或抽样策略 */
export function solveComponent(
  comp: FrontierComponent,
  prefer: SolverMode,
  seed: number,
): ComponentSolution {
  if (prefer === "exact") {
    // 先用宽松上界快速排除超大空间，避免昂贵的 DFS
    if (estimateSolutionBound(comp) > BigInt(EXACT_LAYOUT_LIMIT)) {
      return sampleComponent(comp, SAMPLE_TARGET, seed);
    }
    const { solution, truncated } = enumerateExact(comp);
    if (!truncated && solution.samples > 0) return solution;
  }
  return sampleComponent(comp, SAMPLE_TARGET, seed);
}
