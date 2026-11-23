import { analyzeProbability } from "../lib/probability";
import { buildFrontier, splitComponents } from "../lib/frontier";
import { neighbors } from "../../../shared/geometry";
import type { PublicBoard } from "../../../shared/types";

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function simulateBoard(
  w: number,
  h: number,
  mines: number,
  seed: number,
  revealRatio: number,
): PublicBoard {
  const rand = rng(seed);
  const order = Array.from({ length: w * h }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const mineSet = new Set(order.slice(0, mines));
  const adj = (id: number) =>
    neighbors(id, w, h).filter((n) => mineSet.has(n)).length;
  const revealed = new Set<number>();
  const start = order.find((id) => !mineSet.has(id))!;
  const queue = [start];
  while (queue.length && revealed.size < w * h * revealRatio) {
    const id = queue.shift()!;
    if (revealed.has(id) || mineSet.has(id)) continue;
    revealed.add(id);
    if (adj(id) === 0)
      for (const n of neighbors(id, w, h))
        if (!revealed.has(n) && !mineSet.has(n)) queue.push(n);
  }
  return {
    width: w,
    height: h,
    mines,
    cells: Array.from({ length: w * h }, (_, id) => ({
      id,
      revealed: revealed.has(id),
      mark: "none" as const,
      adjacent: revealed.has(id) ? adj(id) : null,
      intel: "unknown" as const,
      exploded: false,
    })),
  };
}

function bruteForce(board: PublicBoard) {
  const w = board.width;
  const h = board.height;
  const unknown: number[] = [];
  const fixedMine = new Set<number>();
  for (const c of board.cells) {
    if (c.exploded || c.intel === "danger") fixedMine.add(c.id);
    else if (!c.revealed && c.intel !== "safe" && c.mark !== "flag")
      unknown.push(c.id);
  }
  const numbers = board.cells.filter((c) => c.adjacent !== null);
  const hits = new Map<number, number>();
  let total = 0;
  const target = board.mines - fixedMine.size;
  const choose = (start: number, chosen: number[]) => {
    if (chosen.length === target) {
      const mineSet = new Set([...fixedMine, ...chosen]);
      for (const num of numbers) {
        const count = neighbors(num.id, w, h).filter((n) =>
          mineSet.has(n),
        ).length;
        if (count !== num.adjacent) return;
      }
      total++;
      for (const id of chosen) hits.set(id, (hits.get(id) ?? 0) + 1);
      return;
    }
    for (let i = start; i < unknown.length; i++) {
      chosen.push(unknown[i]);
      choose(i + 1, chosen);
      chosen.pop();
    }
  };
  choose(0, []);
  const freq = new Map<number, number>();
  for (const id of unknown) freq.set(id, total ? (hits.get(id) ?? 0) / total : 0);
  return { freq, total };
}

// ---- 小规模暴力对照（6x6，未知格少，枚举空间小）----
console.log("== 小规模暴力枚举对照 ==");
let maxErr = 0;
for (const seed of [11, 22, 33, 44, 55, 66]) {
  const board = simulateBoard(6, 6, 6, seed, 0.45);
  const r = analyzeProbability({
    board,
    policy: "assume",
    mode: "exact",
    revision: seed,
  });
  const bf = bruteForce(board);
  let err = 0;
  for (const c of r.cells) {
    const truth = bf.freq.get(c.cell) ?? 0;
    err = Math.max(err, Math.abs(c.p - truth));
  }
  maxErr = Math.max(maxErr, err);
  console.log(
    `seed=${seed} 冲突=${r.conflicts.length} 暴力布局=${bf.total} 引擎布局=${r.layoutCount} 最大误差=${err.toExponential(2)}`,
  );
}
console.log(maxErr < 1e-9 ? "✓ 精确引擎与暴力枚举完全一致" : "✗ 存在偏差");

// ---- 真实尺寸性能 ----
console.log("\n== 真实尺寸性能 ==");
for (const [name, w, h, mines] of [
  ["苔石回廊", 10, 10, 14],
  ["沉沙祭坛", 12, 12, 27],
  ["日蚀神殿", 14, 12, 38],
] as const) {
  for (const ratio of [0.15, 0.35, 0.6]) {
    const board = simulateBoard(w, h, mines, 99, ratio);
    const frontier = buildFrontier(board, "assume");
    const comps = splitComponents(frontier);
    const sizes = comps.map((c) => c.vars.length).sort((a, b) => b - a);
    const t0 = performance.now();
    const r = analyzeProbability({
      board,
      policy: "assume",
      mode: "exact",
      revision: 1,
    });
    const t1 = performance.now();
    const r2 = analyzeProbability({
      board,
      policy: "assume",
      mode: "sampled",
      revision: 1,
    });
    const t2 = performance.now();
    console.log(
      `${name} 揭开${ratio} | 边界${r.frontierCount} 暗区${r.darkCount} 组${comps.length}(最大${sizes[0] ?? 0}) | 精确:${r.mode} ${(t1 - t0).toFixed(1)}ms 布局${r.layoutCount} | 抽样:${(t2 - t1).toFixed(1)}ms 样本${r2.layoutCount}`,
    );
  }
}

// ---- 精确 vs 抽样偏差 ----
console.log("\n== 大棋盘抽样偏差 ==");
const big = simulateBoard(14, 12, 38, 7, 0.3);
const exact = analyzeProbability({
  board: big,
  policy: "assume",
  mode: "exact",
  revision: 1,
});
const sampled = analyzeProbability({
  board: big,
  policy: "assume",
  mode: "sampled",
  revision: 1,
});
if (exact.mode === "exact") {
  let err = 0;
  let cover = 0;
  let n = 0;
  for (const c of sampled.cells) {
    const e = exact.cells.find((x) => x.cell === c.cell);
    if (!e) continue;
    n++;
    err = Math.max(err, Math.abs(c.p - e.p));
    if (e.p >= c.low - 1e-9 && e.p <= c.high + 1e-9) cover++;
  }
  console.log(`最大点估计误差=${err.toFixed(4)}，95%区间覆盖率=${cover}/${n}`);
} else {
  console.log("该局面精确枚举已超限，抽样为唯一可行方式（符合设计）");
}
