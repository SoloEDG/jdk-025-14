import type {
  CellProbability,
  ConflictInfo,
  FlagPolicy,
  ProbabilityResult,
  PublicBoard,
  SolverMode,
} from "../../../shared/types";
import {
  buildFrontier,
  splitComponents,
  feasibleAssignment,
  type Frontier,
} from "./frontier";
import { solveComponent } from "./componentSolver";
import { synthesize } from "./global";

export interface ProbabilityRequest {
  board: PublicBoard;
  policy: FlagPolicy;
  mode: SolverMode;
  revision: number;
}

/** 检测单条线索自身的越界矛盾，并给出具体来源 */
function detectConstraintConflicts(
  board: PublicBoard,
  frontier: Frontier,
): ConflictInfo[] {
  const conflicts: ConflictInfo[] = [];
  for (const c of frontier.constraints) {
    const unknownCount = c.cells.length;
    if (c.remaining < 0) {
      conflicts.push({
        source: c.source[0],
        cells: c.cells,
        declared: c.remaining,
        min: 0,
        max: unknownCount,
        text: `数字格 ${labelOf(board, c.source[0])} 周围已确认/假设的危险多于其数字，至少多出 ${-c.remaining} 个。`,
      });
    } else if (c.remaining > unknownCount) {
      conflicts.push({
        source: c.source[0],
        cells: c.cells,
        declared: c.remaining,
        min: 0,
        max: unknownCount,
        text: `数字格 ${labelOf(board, c.source[0])} 还需 ${c.remaining} 个危险，但周围只剩 ${unknownCount} 个未知格。`,
      });
    }
  }
  return conflicts;
}

/** 旗标与探针直接确认互相矛盾时，指出具体格 */
function detectIntelFlagConflicts(
  board: PublicBoard,
  policy: FlagPolicy,
): ConflictInfo[] {
  if (policy !== "assume") return [];
  const conflicts: ConflictInfo[] = [];
  for (const c of board.cells) {
    if (c.mark === "flag" && c.intel === "safe") {
      conflicts.push({
        source: c.id,
        cells: [c.id],
        declared: 1,
        min: 0,
        max: 0,
        text: `${labelOf(board, c.id)} 被探针确认安全，却插着危险旗标；可切换“忽略旗标”继续推断。`,
      });
    }
  }
  return conflicts;
}

/** 对不可满足的连通组定位冲突线索 */
function locateComponentConflict(
  board: PublicBoard,
  frontier: Frontier,
  componentIndex: { vars: number[]; constraints: { cells: number[]; remaining: number; source: number[] }[] },
): ConflictInfo[] {
  const result: ConflictInfo[] = [];
  const size = componentIndex.vars.length;
  const prefix: (0 | 1 | null)[] = new Array(size).fill(null);
  if (feasibleAssignment(size, componentIndex.constraints, prefix))
    return result;
  // 逐条移除线索测试，找到移除后即可满足的关键线索
  for (const c of componentIndex.constraints) {
    const rest = componentIndex.constraints.filter((x) => x !== c);
    if (feasibleAssignment(size, rest, prefix)) {
      const globalCells = c.cells.map(
        (local) => frontier.frontierCells[componentIndex.vars[local]],
      );
      result.push({
        source: c.source[0],
        cells: globalCells,
        declared: c.remaining,
        min: 0,
        max: c.cells.length,
        text: `数字格 ${labelOf(board, c.source[0])} 的约束与相邻线索无法同时成立，请核对其周围旗标与探针结论。`,
      });
    }
  }
  if (!result.length && componentIndex.constraints.length) {
    const c = componentIndex.constraints[0];
    result.push({
      source: c.source[0],
      cells: c.cells.map(
        (local) => frontier.frontierCells[componentIndex.vars[local]],
      ),
      declared: c.remaining,
      min: 0,
      max: c.cells.length,
      text: "这一组边界线索互相矛盾，未找到任何可行布局。",
    });
  }
  return result;
}

function labelOf(board: PublicBoard, id: number): string {
  const x = String.fromCharCode(65 + (id % board.width));
  const y = Math.floor(id / board.width) + 1;
  return `${x}${y}`;
}

/** 概率地图分析主入口 */
export function analyzeProbability(req: ProbabilityRequest): ProbabilityResult {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { board, policy, mode, revision } = req;

  const base: Omit<ProbabilityResult, "cells"> = {
    revision,
    mode,
    flagPolicy: policy,
    minesRemaining: 0,
    frontierCount: 0,
    darkCount: 0,
    layoutCount: 0,
    conflicts: [],
    elapsedMs: 0,
    provenSafeCells: [],
  };

  // 开局未生成地图：没有任何公开线索，全部雷数仍待分配
  if (!board.cells.some((c) => c.adjacent !== null)) {
    return finish(
      { ...base, minesRemaining: board.mines, darkCount: board.cells.length },
      [],
      started,
    );
  }

  const frontier = buildFrontier(board, policy);
  const conflicts = [
    ...detectConstraintConflicts(board, frontier),
    ...detectIntelFlagConflicts(board, policy),
  ];

  const components = splitComponents(frontier);

  // 逐组求解：无论最终模式，都先尝试精确枚举——典型组规模很小，
  // 精确结果既能给出严格均匀的布局表，又能检测可满足性；
  // 仅当某组布局空间超限才退回随机抽样（此时结果标注为估计）。
  const solutions = components.map((comp, i) =>
    solveComponent(comp, "exact", revision * 7919 + i + 1),
  );
  const anySampled = solutions.some((s) => !s.exact);
  for (let i = 0; i < components.length; i++) {
    const total = solutions[i].counts.reduce((a, b) => a + b, 0n);
    if (total === 0n) {
      conflicts.push(...locateComponentConflict(board, frontier, components[i]));
    }
  }

  // 危险总数预算矛盾：只有全部组都精确枚举时，极值才可信；
  // 抽样组的分层计数不完整，极值检查会误报，改由抽样可行性兜底。
  if (!anySampled) {
    const minFrontier = solutions.reduce((sum, s) => {
      let first = s.counts.findIndex((c) => c > 0n);
      if (first < 0) first = 0;
      return sum + first;
    }, 0);
    const maxFrontier = solutions.reduce((sum, s) => {
      let last = 0;
      s.counts.forEach((c, k) => {
        if (c > 0n) last = k;
      });
      return sum + last;
    }, 0);
    const budgetMax = maxFrontier + frontier.darkCells.length;
    if (
      frontier.minesRemaining < minFrontier ||
      frontier.minesRemaining > budgetMax
    ) {
      conflicts.push({
        source: -1,
        cells: [...frontier.frontierCells, ...frontier.darkCells],
        declared: frontier.minesRemaining,
        min: minFrontier,
        max: budgetMax,
        text:
          frontier.minesRemaining < minFrontier
            ? `剩余危险总数 ${frontier.minesRemaining} 少于边界线索强制要求的 ${minFrontier} 个，旗标或已确认危险计数有误。`
            : `剩余危险总数 ${frontier.minesRemaining} 超过全部未知格最多容纳的 ${budgetMax} 个。`,
      });
    }
  }

  let cells: CellProbability[] = [];
  let layoutCount = 0;
  let provenSafeCells: number[] = [];
  if (!conflicts.length) {
    // 全部组都能完整枚举才走精确合成；任一组退化为抽样则整体标注估计
    const effectiveMode: SolverMode = anySampled ? "sampled" : "exact";
    const synthesis = synthesize(
      frontier,
      components,
      solutions,
      effectiveMode,
      revision * 104729 + 17,
    );
    if (!synthesis.feasible && !synthesis.exact) {
      conflicts.push({
        source: -1,
        cells: [],
        declared: frontier.minesRemaining,
        min: synthesis.budgetMin,
        max: synthesis.budgetMax,
        text: "抽样未能找到满足剩余危险总数的布局，边界约束可能矛盾。",
      });
    } else {
      cells = synthesis.cells;
      layoutCount = synthesis.layoutCount;
      provenSafeCells = cells
        .filter((c) => c.provenSafe)
        .map((c) => c.cell)
        .sort((a, b) => a - b);
    }
  }

  return finish(
    {
      ...base,
      minesRemaining: frontier.minesRemaining,
      frontierCount: frontier.frontierCells.length,
      darkCount: frontier.darkCells.length,
      conflicts,
      layoutCount,
      provenSafeCells,
    },
    cells,
    started,
  );
}

function finish(
  base: Omit<ProbabilityResult, "cells">,
  cells: CellProbability[],
  started: number,
): ProbabilityResult {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { ...base, cells, elapsedMs: Math.round(now - started) };
}
