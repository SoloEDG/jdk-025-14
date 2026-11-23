import type { CellProbability, SolverMode } from "../../../shared/types";
import type { Frontier, FrontierComponent } from "./frontier";
import {
  drawAssignment,
  drawFromExact,
  makeRng,
  type ComponentSolution,
} from "./componentSolver";

export interface GlobalSynthesis {
  cells: CellProbability[];
  exact: boolean;
  layoutCount: number;
  /** 实际可行的总危险预算区间 [min, max]；若与 minesRemaining 矛盾则 infeasible */
  feasible: boolean;
  budgetMin: number;
  budgetMax: number;
}

/** Wilson 95% 置信区间，用于抽样比例估计 */
export function wilsonInterval(
  successes: number,
  n: number,
): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n)) / denom;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

const ratio = (num: bigint, den: bigint): number => {
  if (den === 0n) return 0;
  const safe = BigInt(Number.MAX_SAFE_INTEGER);
  if (num <= safe && den <= safe) return Number(num) / Number(den);
  // 大整数退化为 12 位缩放除法
  return Number((num * 1_000_000_000_000n) / den) / 1e12;
};

/**
 * 精确合成：所有组都是完整枚举时，用 BigInt DP 把各组的
 * “按组内危险数分层计数”卷起来，再按总危险预算过滤，
 * 最后把暗区组合数 C(dark, budget-frontierMines) 计入权重。
 */
function synthesizeExact(
  frontier: Frontier,
  components: FrontierComponent[],
  solutions: ComponentSolution[],
): GlobalSynthesis {
  const allExact = solutions.every((s) => s.exact);
  const darkCount = frontier.darkCells.length;
  const budget = frontier.minesRemaining;

  // 每组支持的危险数范围
  const ranges = solutions.map((s) => {
    const ks: number[] = [];
    s.counts.forEach((c, k) => {
      if (c > 0n) ks.push(k);
    });
    return { min: ks[0] ?? 0, max: ks[ks.length - 1] ?? 0, ks };
  });
  const minFrontier = ranges.reduce((sum, r) => sum + r.min, 0);
  const maxFrontier = ranges.reduce((sum, r) => sum + r.max, 0);
  const budgetMin = minFrontier;
  const budgetMax = maxFrontier + darkCount;

  if (!allExact || budget < minFrontier || budget > budgetMax) {
    return {
      cells: [],
      exact: false,
      layoutCount: 0,
      feasible: budget >= minFrontier && budget <= budgetMax,
      budgetMin,
      budgetMax,
    };
  }

  // 暗区组合数表 darkWays[n] = C(darkCount, n)
  const darkWays: bigint[] = new Array(darkCount + 1).fill(0n);
  let comb = 1n;
  for (let n = 0; n <= darkCount; n++) {
    darkWays[n] = comb;
    comb = (comb * BigInt(darkCount - n)) / BigInt(n + 1);
  }

  // DP：按组卷积。dp[k] = 边界格恰好 k 个危险的布局数
  let dp: bigint[] = [1n];
  // 记录每个前缀的 DP，用于回溯各组在全局权重下的条件分布
  const prefixDp: bigint[][] = [[1n]];
  for (const s of solutions) {
    const next = new Array(dp.length + s.size).fill(0n);
    for (let k = 0; k < dp.length; k++) {
      if (dp[k] === 0n) continue;
      for (let add = 0; add < s.counts.length; add++) {
        if (s.counts[add] > 0n) next[k + add] += dp[k] * s.counts[add];
      }
    }
    dp = next;
    prefixDp.push([...dp]);
  }

  // 总权重：边界 k 个危险时，暗区需放 budget-k 个
  const totalWeightAt = (k: number): bigint => {
    const darkMines = budget - k;
    if (darkMines < 0 || darkMines > darkCount) return 0n;
    return dp[k] * darkWays[darkMines];
  };
  let grandTotal = 0n;
  for (let k = 0; k < dp.length; k++) grandTotal += totalWeightAt(k);

  const cells: CellProbability[] = [];
  if (grandTotal === 0n) {
    return { cells, exact: true, layoutCount: 0, feasible: false, budgetMin, budgetMax };
  }

  // 反向 DP，用于计算每组各危险数在全局预算下的权重
  const suffixDp: bigint[][] = new Array(solutions.length + 1);
  suffixDp[solutions.length] = [1n];
  for (let ci = solutions.length - 1; ci >= 0; ci--) {
    const s = solutions[ci];
    const prev = suffixDp[ci + 1];
    const next = new Array(prev.length + s.size).fill(0n);
    for (let k = 0; k < prev.length; k++) {
      if (prev[k] === 0n) continue;
      for (let add = 0; add < s.counts.length; add++) {
        if (s.counts[add] > 0n) next[k + add] += prev[k] * s.counts[add];
      }
    }
    suffixDp[ci] = next;
  }

  // 每个边界格的危险概率
  solutions.forEach((s, ci) => {
    const comp = components[ci];
    const pre = prefixDp[ci];
    const suf = suffixDp[ci + 1];
    // weightK[add] = 该组取 add 个危险时的全局布局权重
    const weightK = new Array(s.size + 1).fill(0n);
    for (let add = 0; add <= s.size; add++) {
      if (s.counts[add] === 0n) continue;
      let w = 0n;
      for (let pk = 0; pk < pre.length; pk++) {
        if (pre[pk] === 0n) continue;
        const rest = budget - pk - add;
        // 剩余组 + 暗区共需 rest
        for (let sk = 0; sk < suf.length; sk++) {
          const darkMines = rest - sk;
          if (darkMines < 0 || darkMines > darkCount) continue;
          if (suf[sk] === 0n) continue;
          w += pre[pk] * s.counts[add] * suf[sk] * darkWays[darkMines];
        }
      }
      weightK[add] = w;
    }
    for (let local = 0; local < s.size; local++) {
      let dangerWeight = 0n;
      for (let add = 0; add <= s.size; add++) {
        if (weightK[add] === 0n) continue;
        // 该层下此格危险的布局占比 = dangerCount[add][local] / counts[add]
        dangerWeight +=
          (weightK[add] * s.dangerCount[add][local]) / s.counts[add];
      }
      const p = ratio(dangerWeight, grandTotal);
      cells.push({
        cell: frontier.frontierCells[comp.vars[local]],
        p,
        low: p,
        high: p,
        provenSafe: p === 0,
        provenDanger: p === 1,
        zone: "frontier",
      });
    }
  });

  // 暗区格：在“暗区分到 d 个危险”的全局权重下，每格危险概率 = E[d]/darkCount
  let expectedDarkMinesNum = 0n; // 用加权和，最后除以 (grandTotal*darkCount)
  let darkLayoutTotal = 0n;
  for (let k = 0; k < dp.length; k++) {
    const darkMines = budget - k;
    if (darkMines < 0 || darkMines > darkCount) continue;
    const w = dp[k] * darkWays[darkMines];
    darkLayoutTotal += w;
    expectedDarkMinesNum += w * BigInt(darkMines);
  }
  const darkP =
    darkCount === 0
      ? 0
      : ratio(expectedDarkMinesNum, darkLayoutTotal * BigInt(darkCount));
  for (const id of frontier.darkCells) {
    cells.push({
      cell: id,
      p: darkP,
      low: darkP,
      high: darkP,
      provenSafe: darkP === 0,
      provenDanger: darkP === 1,
      zone: "dark",
    });
  }

  return {
    cells,
    exact: true,
    layoutCount: Number(grandTotal > BigInt(Number.MAX_SAFE_INTEGER) ? -1 : grandTotal),
    feasible: true,
    budgetMin,
    budgetMax,
  };
}

/**
 * 抽样合成：
 * 1) 每个连通组用随机 DFS 抽一份完整可行布局；
 * 2) 边界雷数 k 必须满足暗区可放 budget-k 个雷，否则拒绝重抽；
 * 3) 接受概率按暗区组合数 C(dark, budget-k) 校正，使样本符合
 *    “所有满足全部数字与总雷数的完整布局等概率”这一全局分布；
 * 4) 接受后在暗区均匀抽对应数量的危险格。
 * 抽样结果只给点估计与 Wilson 区间，永不产生“证明零风险”。
 */
function synthesizeSampled(
  frontier: Frontier,
  components: FrontierComponent[],
  solutions: ComponentSolution[],
  seed: number,
): GlobalSynthesis {
  const darkCount = frontier.darkCells.length;
  const budget = frontier.minesRemaining;
  const totalSamples = 800;

  // 注意：不能用“各约束 remaining 求和”做预算否决——约束间共享变量，
  // 简单求和会严重高估雷数极值。可行性完全交给实际抽样判定。
  const rng = makeRng(seed);
  // 暗区组合数的对数，用于接受概率（避免阶乘溢出）
  const logC = (n: number, k: number): number => {
    if (k < 0 || k > n) return -Infinity;
    let v = 0;
    const kk = Math.min(k, n - k);
    for (let i = 0; i < kk; i++) v += Math.log((n - i) / (i + 1));
    return v;
  };
  // 归一化接受权重：记录最大 logW 作为 0 点
  const weightLog = (frontierMines: number): number =>
    logC(darkCount, budget - frontierMines);

  const allCells = [...frontier.frontierCells, ...frontier.darkCells];
  const dangerHits = new Map<number, number>();
  allCells.forEach((id) => dangerHits.set(id, 0));

  let accepted = 0;
  let attempts = 0;
  const maxAttempts = totalSamples * 30;
  // 第一遍：收集候选布局及其暗区组合权重（对数空间）
  const candidates: {
    logW: number;
    draws: { assign: Uint8Array; mines: number }[];
    darkMines: number;
  }[] = [];

  while (attempts < maxAttempts && candidates.length < totalSamples * 3) {
    attempts++;
    const draws: { assign: Uint8Array; mines: number }[] = [];
    let frontierMines = 0;
    let abort = false;
    for (let ci = 0; ci < components.length; ci++) {
      // 精确组按精确布局计数无偏抽样；超大组用随机 DFS 近似
      const d = solutions[ci].exact
        ? drawFromExact(solutions[ci], rng)
        : drawAssignment(components[ci], rng);
      if (!d) {
        abort = true;
        break;
      }
      draws.push(d);
      frontierMines += d.mines;
    }
    if (abort) break;
    const darkMines = budget - frontierMines;
    if (darkMines < 0 || darkMines > darkCount) continue;
    const logW = weightLog(frontierMines);
    if (logW === -Infinity) continue;
    candidates.push({ logW, draws, darkMines });
  }

  if (!candidates.length) {
    return {
      cells: [],
      exact: false,
      layoutCount: 0,
      feasible: false,
      budgetMin: 0,
      budgetMax: frontier.frontierCells.length + darkCount,
    };
  }

  // 第二遍：用固定的全局最大对数权重归一化，按权重无偏重采样
  const maxLogW = Math.max(...candidates.map((c) => c.logW));
  const weights = candidates.map((c) => Math.exp(c.logW - maxLogW));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  while (accepted < totalSamples) {
    let target = rng() * weightSum;
    let idx = candidates.length - 1;
    for (let i = 0; i < weights.length; i++) {
      target -= weights[i];
      if (target <= 0) {
        idx = i;
        break;
      }
    }
    const picked = candidates[idx];
    const chosen = new Set<number>();
    picked.draws.forEach((d, ci) => {
      d.assign.forEach((v, local) => {
        if (v)
          chosen.add(frontier.frontierCells[components[ci].vars[local]]);
      });
    });
    // 暗区均匀抽 darkMines 个
    const darkPool = [...frontier.darkCells];
    for (let i = 0; i < picked.darkMines && darkPool.length; i++) {
      const di = Math.floor(rng() * darkPool.length);
      chosen.add(darkPool[di]);
      darkPool.splice(di, 1);
    }
    for (const id of chosen)
      dangerHits.set(id, (dangerHits.get(id) ?? 0) + 1);
    accepted++;
  }

  if (accepted === 0) {
    return {
      cells: [],
      exact: false,
      layoutCount: 0,
      feasible: false,
      budgetMin: 0,
      budgetMax: frontier.frontierCells.length + darkCount,
    };
  }

  const cells: CellProbability[] = allCells.map((id) => {
    const hits = dangerHits.get(id) ?? 0;
    const p = hits / accepted;
    const { low, high } = wilsonInterval(hits, accepted);
    return {
      cell: id,
      p,
      low,
      high,
      provenSafe: false,
      provenDanger: false,
      zone: frontier.darkCells.includes(id) ? "dark" : "frontier",
    };
  });

  return {
    cells,
    exact: false,
    layoutCount: accepted,
    feasible: true,
    budgetMin: 0,
    budgetMax: frontier.frontierCells.length + darkCount,
  };
}

/** 全局合成入口：优先精确，任一组降级或预算不可行时走抽样 */
export function synthesize(
  frontier: Frontier,
  components: FrontierComponent[],
  solutions: ComponentSolution[],
  mode: SolverMode,
  seed: number,
): GlobalSynthesis {
  if (mode === "exact") {
    const exact = synthesizeExact(frontier, components, solutions);
    if (exact.feasible && exact.exact) return exact;
    if (!exact.feasible) return exact;
  }
  return synthesizeSampled(frontier, components, solutions, seed);
}

export { SAMPLE_TARGET } from "./componentSolver";
