import { analyzeProbability } from "../lib/probability";
import type { PublicBoard } from "../../../shared/types";

function makeBoard(
  w: number,
  h: number,
  mines: number,
  cells: {
    id: number;
    revealed?: boolean;
    adjacent?: number | null;
    mark?: "none" | "flag" | "question";
    intel?: "unknown" | "safe" | "danger";
    exploded?: boolean;
  }[],
): PublicBoard {
  return {
    width: w,
    height: h,
    mines,
    cells: Array.from({ length: w * h }, (_, id) => {
      const c = cells.find((x) => x.id === id);
      return {
        id,
        revealed: c?.revealed ?? false,
        mark: c?.mark ?? "none",
        adjacent: c?.revealed ? (c?.adjacent ?? 0) : null,
        intel: c?.intel ?? "unknown",
        exploded: c?.exploded ?? false,
      };
    }),
  };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

// --- 测试 1：经典 1-1 边界 + 暗区，验证概率与暗区权重 ---
// 10x10，14 雷。揭示 (0,0)=1，其邻居 1.. 中无已知雷。
{
  console.log("测试1：单线索 + 暗区权重");
  // 格 0 揭示为 1，邻居为 1,10,11
  const board = makeBoard(10, 10, 14, [
    { id: 0, revealed: true, adjacent: 1 },
  ]);
  const r = analyzeProbability({
    board,
    policy: "assume",
    mode: "exact",
    revision: 1,
  });
  check("无冲突", r.conflicts.length === 0, JSON.stringify(r.conflicts));
  check("精确模式", r.mode === "exact");
  check("边界格数=3", r.frontierCount === 3, String(r.frontierCount));
  check("暗区格数=96", r.darkCount === 96, String(r.darkCount));
  // 三边界格等概率
  const p1 = r.cells.find((c) => c.cell === 1)!;
  const p10 = r.cells.find((c) => c.cell === 10)!;
  check("边界格概率相等", Math.abs(p1.p - p10.p) < 1e-9);
  // 边界概率应高于暗区（条件期望）
  const dark = r.cells.find((c) => c.zone === "dark")!;
  check("边界概率 > 暗区概率", p1.p > dark.p, `${p1.p} vs ${dark.p}`);
  // 手工核算：数字格 0 强制边界恰好 1 雷
  //   3 个边界格选 1 个 = 3 种布局，每种暗区放 13 雷
  //   总权重 = 3*C(96,13)；每边界格危险权重 = 1*C(96,13) → 1/3
  const C = (n: number, k: number): number => {
    let num = 1;
    let den = 1;
    for (let i = 0; i < k; i++) {
      num *= n - i;
      den *= i + 1;
    }
    return num / den;
  };
  const total = 3 * C(96, 13);
  const expected = C(96, 13) / total;
  check(
    "边界概率手工吻合",
    Math.abs(p1.p - expected) < 1e-6,
    `got ${p1.p} want ${expected}`,
  );
  // 暗区：边界固定 1 雷，剩余 13 雷全在 96 个暗区格 → 每格 13/96
  const eDark = 13 / 96;
  check(
    "暗区概率手工吻合",
    Math.abs(dark.p - eDark) < 1e-6,
    `got ${dark.p} want ${eDark}`,
  );
  check("暗区不是等概率于边界", Math.abs(dark.p - p1.p) > 1e-6);
}

// --- 测试 2：可证明安全/危险 ---
{
  console.log("测试2：证明零风险与确定危险");
  // 格 4(中心) 揭示为 0 → 邻居全安全
  const board = makeBoard(5, 5, 5, [
    { id: 12, revealed: true, adjacent: 0 },
  ]);
  const r = analyzeProbability({
    board,
    policy: "assume",
    mode: "exact",
    revision: 2,
  });
  const safeNeighbors = [6, 7, 8, 11, 13, 16, 17, 18];
  for (const id of safeNeighbors) {
    const c = r.cells.find((x) => x.cell === id);
    check(`格${id}证明安全`, !!c?.provenSafe && c.p === 0);
  }
  check(
    "provenSafeCells 包含全部零风险邻居",
    safeNeighbors.every((id) => r.provenSafeCells.includes(id)),
  );

  // 格 12 揭示为 2，且两个邻居插旗 → 其余邻居证明安全
  const board2 = makeBoard(5, 5, 5, [
    { id: 12, revealed: true, adjacent: 2 },
    { id: 7, mark: "flag" },
    { id: 11, mark: "flag" },
  ]);
  const r2 = analyzeProbability({
    board: board2,
    policy: "assume",
    mode: "exact",
    revision: 3,
  });
  const otherNeighbors = [6, 8, 13, 16, 17, 18];
  for (const id of otherNeighbors) {
    const c = r2.cells.find((x) => x.cell === id);
    check(`旗标假设下格${id}证明安全`, !!c?.provenSafe && c.p === 0);
  }
  // 忽略旗标后这些格不再被证明安全
  const r3 = analyzeProbability({
    board: board2,
    policy: "ignore",
    mode: "exact",
    revision: 4,
  });
  const c6 = r3.cells.find((x) => x.cell === 6);
  check("忽略旗标后不再无条件证明安全", !c6?.provenSafe);
}

// --- 测试 3：旗标与探针矛盾 → 具体冲突，而不是一片零风险 ---
{
  console.log("测试3：冲突来源具体化");
  const board = makeBoard(5, 5, 5, [
    { id: 12, revealed: true, adjacent: 1 },
    { id: 7, mark: "flag", intel: "safe" },
  ]);
  const r = analyzeProbability({
    board,
    policy: "assume",
    mode: "exact",
    revision: 5,
  });
  check("存在冲突", r.conflicts.length > 0);
  check(
    "冲突指向具体格7",
    r.conflicts.some((c) => c.cells.includes(7)),
  );
  check("冲突带文字说明", r.conflicts.every((c) => c.text.length > 0));
  check("冲突时不输出概率地图", r.cells.length === 0);
  // 忽略旗标后冲突消失
  const r2 = analyzeProbability({
    board,
    policy: "ignore",
    mode: "exact",
    revision: 6,
  });
  check("忽略旗标后无冲突", r2.conflicts.length === 0);
}

// --- 测试 4：数字越界矛盾 ---
{
  console.log("测试4：数字不可能满足");
  // 格 0 角落揭示为 3，但只有 3 个邻居；让其中一个已确认安全（探针）
  const board = makeBoard(5, 5, 5, [
    { id: 0, revealed: true, adjacent: 3 },
    { id: 1, intel: "safe" },
  ]);
  const r = analyzeProbability({
    board,
    policy: "assume",
    mode: "exact",
    revision: 7,
  });
  check("检测到越界冲突", r.conflicts.length > 0);
  check(
    "冲突来源是数字格0",
    r.conflicts.some((c) => c.source === 0),
  );
}

// --- 测试 5：两组独立边界，验证不把组内等概率当全图等概率 ---
{
  console.log("测试5：分离边界组的差异化概率");
  // 左上 格0=1（邻居1,10,11）；右下区域格 99 附近
  const board = makeBoard(10, 10, 14, [
    { id: 0, revealed: true, adjacent: 1 },
    { id: 99, revealed: true, adjacent: 2 },
  ]);
  const r = analyzeProbability({
    board,
    policy: "assume",
    mode: "exact",
    revision: 8,
  });
  check("无冲突", r.conflicts.length === 0, JSON.stringify(r.conflicts));
  const g1 = r.cells.find((c) => c.cell === 1)!;
  const g2 = r.cells.find((c) => c.cell === 98)!; // 99 的邻居
  check("两组概率不同", Math.abs(g1.p - g2.p) > 1e-9, `${g1.p} vs ${g2.p}`);
  check("概率和在合理范围", r.cells.every((c) => c.p >= 0 && c.p <= 1));
}

// --- 测试 6：抽样模式给出区间，且不宣称证明安全 ---
{
  console.log("测试6：抽样估计与区间");
  const board = makeBoard(10, 10, 14, [
    { id: 0, revealed: true, adjacent: 1 },
  ]);
  const r = analyzeProbability({
    board,
    policy: "assume",
    mode: "sampled",
    revision: 9,
  });
  check("抽样模式", r.mode === "sampled");
  check("无冲突", r.conflicts.length === 0);
  const c1 = r.cells.find((c) => c.cell === 1)!;
  check("区间包含点估计", c1.low <= c1.p + 1e-9 && c1.p <= c1.high + 1e-9);
  check("抽样不证明安全", r.provenSafeCells.length === 0);
  check("所有格未标记 provenSafe", r.cells.every((c) => !c.provenSafe));
  // 抽样估计应接近精确值
  const exact = analyzeProbability({
    board,
    policy: "assume",
    mode: "exact",
    revision: 10,
  });
  const e1 = exact.cells.find((c) => c.cell === 1)!;
  check(
    "抽样接近精确值（5%内）",
    Math.abs(c1.p - e1.p) < 0.05,
    `sampled ${c1.p} exact ${e1.p}`,
  );
}

// --- 测试 7：已确认危险（爆炸/探针）正确计入剩余总数 ---
{
  console.log("测试7：剩余危险总数扣减");
  const board = makeBoard(5, 5, 5, [
    { id: 0, revealed: true, adjacent: 1 },
    { id: 1, intel: "danger" },
  ]);
  const r = analyzeProbability({
    board,
    policy: "assume",
    mode: "exact",
    revision: 11,
  });
  check("剩余危险=4", r.minesRemaining === 4, String(r.minesRemaining));
  // 格 1 已是确认危险，不应出现在概率格中
  check("确认危险不在概率格", !r.cells.some((c) => c.cell === 1));
  // 5 宽棋盘格 0 的邻居为 1,5,6；雷已在 1，故 5、6 证明安全
  check("格5证明安全", r.cells.find((c) => c.cell === 5)?.provenSafe === true);
  check("格6证明安全", r.cells.find((c) => c.cell === 6)?.provenSafe === true);
}

// --- 测试 8：大边界触发精确→抽样降级 ---
{
  console.log("测试8：大边界降级抽样");
  // 构造一条长蛇形已揭示带，产生大边界
  const cells: {
    id: number;
    revealed?: boolean;
    adjacent?: number | null;
    mark?: "none" | "flag" | "question";
    intel?: "unknown" | "safe" | "danger";
    exploded?: boolean;
  }[] = [];
  for (let y = 0; y < 10; y++) {
    cells.push({ id: y * 12 + 2, revealed: true, adjacent: 1 });
  }
  const board = makeBoard(12, 12, 27, cells);
  const r = analyzeProbability({
    board,
    policy: "assume",
    mode: "exact",
    revision: 12,
  });
  check("有结果输出", r.cells.length > 0);
  // 不强制降级（取决于规模），但必须自洽
  check("概率合法", r.cells.every((c) => c.p >= 0 && c.p <= 1));
  console.log(`   （模式=${r.mode}，布局/样本=${r.layoutCount}，耗时=${r.elapsedMs}ms）`);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) throw new Error("概率引擎测试失败");
