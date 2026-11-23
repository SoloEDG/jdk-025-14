export type Difficulty = "scout" | "scholar" | "legend";
export type Mode = "reveal" | "mark" | "probe" | "flare";
export type Status = "ready" | "active" | "won" | "lost" | "extracted";
export type Mark = "none" | "flag" | "question";
export type RelicId = "sun" | "vessel" | "tablet";
/** 旗标如何参与概率推断：作为确定假设，或仅作忽略 */
export type FlagPolicy = "assume" | "ignore";
/** 求解方式：完整枚举（精确）或抽样（估计） */
export type SolverMode = "exact" | "sampled";
export interface Cell {
  id: number;
  mine: boolean;
  adjacent: number;
  revealed: boolean;
  mark: Mark;
  intel: "unknown" | "safe" | "danger";
  relic: RelicId | null;
  terrain: "moss" | "stone" | "water";
}
export interface Board {
  width: number;
  height: number;
  mines: number;
  seed: string;
  difficulty: Difficulty;
  generated: boolean;
  cells: Cell[];
}
export interface ActionEntry {
  id: number;
  kind: "reveal" | "mark" | "probe" | "flare" | "hit" | "shield" | "extract";
  cell: number | null;
  message: string;
  second: number;
}
export interface Expedition {
  id: string;
  board: Board;
  status: Status;
  mode: Mode;
  lives: number;
  shield: boolean;
  tools: { probe: number; flare: number; shield: number };
  used: number;
  mistakes: number;
  elapsed: number;
  paused: boolean;
  actions: ActionEntry[];
  nextAction: number;
  selected: number | null;
  startedAt: number;
  /** 是否使用过基于概率地图的一键安全探索 */
  assistUsed?: boolean;
}
export interface Report {
  id: string;
  seed: string;
  difficulty: Difficulty;
  outcome: Status;
  safe: number;
  totalSafe: number;
  relics: RelicId[];
  score: number;
  seconds: number;
  used: number;
  mistakes: number;
  endedAt: number;
  /** 本局是否使用过概率辅助（一键安全探索） */
  assistUsed?: boolean;
}
export interface Archive {
  reports: Report[];
  discoveries: Partial<Record<RelicId, number>>;
  totalScore: number;
}
export interface GameDocument {
  version: 1;
  expedition: Expedition;
  archive: Archive;
}
export interface PublicCell {
  id: number;
  revealed: boolean;
  mark: Mark;
  adjacent: number | null;
  intel: Cell["intel"];
  exploded: boolean;
}
export interface PublicBoard {
  width: number;
  height: number;
  mines: number;
  cells: PublicCell[];
}
/** 冲突来源：直接指出哪个数字格与哪些已知信息矛盾 */
export interface ConflictInfo {
  /** 触发冲突的数字格 */
  source: number;
  /** 参与冲突的未知格 / 旗标格 */
  cells: number[];
  /** 数字声明的剩余危险与可行区间 */
  declared: number;
  min: number;
  max: number;
  text: string;
}
/** 单格概率结果 */
export interface CellProbability {
  cell: number;
  /** 危险概率 0..1 */
  p: number;
  /** 抽样模式下的 95% 置信区间下界/上界；精确模式与 p 相等 */
  low: number;
  high: number;
  /** 仅当被完整枚举证明为 0 时为 true，抽样的极小值不算 */
  provenSafe: boolean;
  /** 被完整枚举证明为 1 */
  provenDanger: boolean;
  /** 区域：边界（被数字约束）或暗区（未接触任何数字） */
  zone: "frontier" | "dark";
}
/** 概率地图求解结果 */
export interface ProbabilityResult {
  /** 版本号：每次公开信息变化都会递增，晚到的旧结果靠它作废 */
  revision: number;
  mode: SolverMode;
  flagPolicy: FlagPolicy;
  cells: CellProbability[];
  /** 剩余需要在未知格中分配的危险总数（扣除已确认危险与假设旗标） */
  minesRemaining: number;
  /** 参与约束的边界格数 */
  frontierCount: number;
  /** 未接触任何数字的暗区格数 */
  darkCount: number;
  /** 完整枚举到的可行布局数（精确模式）；抽样模式为有效样本数 */
  layoutCount: number;
  conflicts: ConflictInfo[];
  /** 求解耗时（毫秒） */
  elapsedMs: number;
  /** 被证明零风险、可用于一键安全探索的格 */
  provenSafeCells: number[];
  /** 仍在计算中（旧结果已失效、新结果未返回） */
  stale?: boolean;
}
export interface InferenceSettings {
  flagPolicy: FlagPolicy;
  /** 是否在地图上叠加概率热力 */
  showHeatmap: boolean;
}
export interface Workspace {
  doc: GameDocument;
  notice: string;
}
