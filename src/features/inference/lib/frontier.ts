import type { FlagPolicy, PublicBoard } from "../../../shared/types";
import { neighbors } from "../../../shared/geometry";

/** 一条数字线索：vars 中的未知格共需承载 remaining 个危险 */
export interface FrontierConstraint {
  cells: number[];
  remaining: number;
  source: number[];
}

export interface Frontier {
  /** 参与约束的边界格（出现在至少一条数字线索中） */
  frontierCells: number[];
  /** 未接触任何数字、也未被确认的暗区格 */
  darkCells: number[];
  constraints: FrontierConstraint[];
  /** 扣除已确认危险（与假设旗标）后，仍需在未知格中分配的危险数 */
  minesRemaining: number;
  /** 已被视作确定危险的格（爆炸 / 探针确认 / 假设模式下的旗标） */
  fixedMines: number[];
}

function isKnownMine(
  board: PublicBoard,
  id: number,
  policy: FlagPolicy,
): boolean {
  const c = board.cells[id];
  return (
    c.exploded ||
    c.intel === "danger" ||
    (policy === "assume" && c.mark === "flag")
  );
}

function isExcludedSafe(
  board: PublicBoard,
  id: number,
  policy: FlagPolicy,
): boolean {
  const c = board.cells[id];
  if (c.revealed) return true;
  if (c.intel === "safe") return true;
  if (policy === "assume" && c.mark === "flag") return true;
  return false;
}

/**
 * 依据当前公开信息构建边界模型。
 * 危险与玩家旗标严格分开：旗标只在 assume 策略下作为假设计入，
 * ignore 策略下旗标格回到未知变量参与求解。
 */
export function buildFrontier(
  board: PublicBoard,
  policy: FlagPolicy,
): Frontier {
  const constraints: FrontierConstraint[] = [];
  const touched = new Set<number>();
  const fixedMines: number[] = [];
  const fixedMineSet = new Set<number>();

  for (const c of board.cells) {
    if (c.adjacent === null) continue;
    const around = neighbors(c.id, board.width, board.height);
    let known = 0;
    const unknown: number[] = [];
    for (const id of around) {
      if (isKnownMine(board, id, policy)) {
        known++;
        if (!fixedMineSet.has(id)) {
          fixedMineSet.add(id);
          fixedMines.push(id);
        }
      } else if (!isExcludedSafe(board, id, policy)) {
        unknown.push(id);
        touched.add(id);
      }
    }
    constraints.push({
      cells: [...new Set(unknown)],
      remaining: c.adjacent - known,
      source: [c.id],
    });
  }

  const darkCells: number[] = [];
  for (const c of board.cells) {
    if (c.revealed) continue;
    if (isExcludedSafe(board, c.id, policy)) continue;
    if (fixedMineSet.has(c.id)) continue;
    if (!touched.has(c.id)) darkCells.push(c.id);
  }

  const minesRemaining = board.mines - fixedMineSet.size;

  return {
    frontierCells: [...touched],
    darkCells,
    constraints,
    minesRemaining,
    fixedMines,
  };
}

/** 并查集：把共享未知格的约束合并为相互关联的边界组 */
class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    let cur = x;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur];
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

export interface FrontierComponent {
  /** 组内变量在全局 frontierCells 中的下标 */
  vars: number[];
  /** 组内约束（cells 已转换为组内局部下标） */
  constraints: { cells: number[]; remaining: number; source: number[] }[];
}

/** 按约束间的变量交叠关系把边界拆成独立连通组，各组可独立求解后再全局合成 */
export function splitComponents(frontier: Frontier): FrontierComponent[] {
  const { frontierCells, constraints } = frontier;
  const globalIndex = new Map<number, number>();
  frontierCells.forEach((id, i) => globalIndex.set(id, i));

  // 只保留含变量的约束
  const active = constraints
    .map((c) => ({
      remaining: c.remaining,
      source: c.source,
      vars: [...new Set(c.cells.map((id) => globalIndex.get(id)!))],
    }))
    .filter((c) => c.vars.length > 0);

  const uf = new UnionFind(active.length);
  // 记录每个变量出现在哪些约束里，用于合并
  const varToConstraints = new Map<number, number[]>();
  active.forEach((c, ci) => {
    for (const v of c.vars) {
      const list = varToConstraints.get(v);
      if (list) {
        for (const other of list) uf.union(other, ci);
      }
      varToConstraints.set(v, [...(varToConstraints.get(v) ?? []), ci]);
    }
  });

  const groups = new Map<number, number[]>();
  active.forEach((_, ci) => {
    const root = uf.find(ci);
    groups.set(root, [...(groups.get(root) ?? []), ci]);
  });

  const components: FrontierComponent[] = [];
  for (const cis of groups.values()) {
    const varSet = new Set<number>();
    for (const ci of cis) for (const v of active[ci].vars) varSet.add(v);
    const vars = [...varSet].sort((a, b) => a - b);
    const local = new Map<number, number>();
    vars.forEach((g, i) => local.set(g, i));
    const compConstraints = cis.map((ci) => ({
      cells: active[ci].vars.map((g) => local.get(g)!),
      remaining: active[ci].remaining,
      source: active[ci].source,
    }));
    components.push({ vars, constraints: compConstraints });
  }
  return components;
}

/**
 * 轻量可行性检查：判断一组约束在给定赋值前缀下是否仍可满足。
 * 用于矛盾定位，不做完整枚举。
 */
export function feasibleAssignment(
  size: number,
  constraints: { cells: number[]; remaining: number }[],
  prefix: (0 | 1 | null)[],
): boolean {
  const assign = [...prefix];
  const dfs = (idx: number): boolean => {
    if (idx === size) {
      for (const c of constraints) {
        const sum = c.cells.reduce((s, v) => s + (assign[v] ?? 0), 0);
        if (sum !== c.remaining) return false;
      }
      return true;
    }
    // 剪枝：检查每条约束的可行区间
    for (const c of constraints) {
      let fixed = 0;
      let open = 0;
      for (const v of c.cells) {
        if (assign[v] === null) open++;
        else fixed += assign[v]!;
      }
      if (fixed > c.remaining || fixed + open < c.remaining) return false;
    }
    for (const value of [0, 1] as const) {
      assign[idx] = value;
      if (dfs(idx + 1)) {
        assign[idx] = null;
        return true;
      }
    }
    assign[idx] = null;
    return false;
  };
  return dfs(0);
}
