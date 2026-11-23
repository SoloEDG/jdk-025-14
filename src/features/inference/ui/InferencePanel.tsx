import {
  ScanSearch,
  Lightbulb,
  TriangleAlert,
  ArrowUpRight,
  FlaskConical,
  Crosshair,
  ShieldCheck,
  Loader2,
  Flag,
  EyeOff,
} from "lucide-react";
import type {
  Expedition,
  FlagPolicy,
  ProbabilityResult,
} from "../../../shared/types";
import { coordinate } from "../../../shared/geometry";

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

export function InferencePanel({
  result,
  computing,
  expedition: e,
  flagPolicy,
  showHeatmap,
  onFlagPolicy,
  onToggleHeatmap,
  onAutoExplore,
  onLocate,
}: {
  result: ProbabilityResult | null;
  computing: boolean;
  expedition: Expedition;
  flagPolicy: FlagPolicy;
  showHeatmap: boolean;
  onFlagPolicy: (p: FlagPolicy) => void;
  onToggleHeatmap: () => void;
  onAutoExplore: (cells: number[]) => void;
  onLocate: (id: number) => void;
}) {
  const hasClues = e.board.cells.some((c) => c.revealed && !c.mine);
  const conflicts = result?.conflicts ?? [];
  const hasConflict = conflicts.length > 0;
  const isEstimate = result?.mode === "sampled";
  const safeCells = result?.provenSafeCells ?? [];
  const canAuto =
    !hasConflict &&
    !computing &&
    !!result &&
    !result.stale &&
    result.mode === "exact" &&
    safeCells.length > 0;

  // 最危险的几个可操作格（排除已揭示/旗标）
  const risky = result
    ? [...result.cells]
        .filter((c) => {
          const cell = e.board.cells[c.cell];
          return cell && !cell.revealed && cell.mark !== "flag";
        })
        .sort((a, b) => b.p - a.p)
        .slice(0, 3)
    : [];
  const safest = result
    ? [...result.cells]
        .filter((c) => {
          const cell = e.board.cells[c.cell];
          return cell && !cell.revealed && cell.mark !== "flag";
        })
        .sort((a, b) => a.p - b.p)
        .slice(0, 3)
    : [];

  return (
    <section className="inference-panel">
      <div className="panel-heading">
        <ScanSearch size={15} />
        <h2>推断笔记</h2>
        <span>PROBABILITY MAP</span>
      </div>

      {/* 旗标策略：危险与玩家旗标分开处理 */}
      <div className="flag-policy" role="group" aria-label="旗标处理方式">
        <button
          className={flagPolicy === "assume" ? "active" : ""}
          aria-pressed={flagPolicy === "assume"}
          onClick={() => onFlagPolicy("assume")}
          title="把你的旗标当作确定危险的假设参与计算"
        >
          <Flag size={11} />
          旗标作假设
        </button>
        <button
          className={flagPolicy === "ignore" ? "active" : ""}
          aria-pressed={flagPolicy === "ignore"}
          onClick={() => onFlagPolicy("ignore")}
          title="忽略全部旗标，仅依据数字与探针结论推断"
        >
          <EyeOff size={11} />
          忽略旗标
        </button>
      </div>

      <div className={"logic-status " + (hasConflict ? "conflict" : "")}>
        {computing ? (
          <Loader2 size={16} className="spin" />
        ) : hasConflict ? (
          <TriangleAlert size={16} />
        ) : (
          <Lightbulb size={16} />
        )}
        <p>{statusText(e, hasClues, computing, hasConflict, result)}</p>
      </div>

      {/* 冲突来源：指出具体数字格，而不是显示一片零风险 */}
      {hasConflict && (
        <div className="conflict-list">
          {conflicts.slice(0, 3).map((c, i) => (
            <button
              key={i}
              className="conflict-item"
              onClick={() => c.source >= 0 && onLocate(c.source)}
            >
              <TriangleAlert size={12} />
              <span>{c.text}</span>
              {c.source >= 0 && <ArrowUpRight size={11} />}
            </button>
          ))}
        </div>
      )}

      {!hasConflict && result && result.cells.length > 0 && (
        <>
          <div className="logic-counts">
            <div>
              <b>{String(result.frontierCount).padStart(2, "0")}</b>
              <span>边界格</span>
            </div>
            <div>
              <b>{String(result.darkCount).padStart(2, "0")}</b>
              <span>暗区格</span>
            </div>
            <div>
              <b>{String(result.minesRemaining).padStart(2, "0")}</b>
              <span>剩余危险</span>
            </div>
          </div>

          {/* 精确结论 vs 估计区间，明确区分 */}
          <div className={"solver-badge " + (isEstimate ? "estimate" : "exact")}>
            {isEstimate ? (
              <>
                <FlaskConical size={12} />
                <span>
                  抽样估计 · {result.layoutCount.toLocaleString()} 样本 ·
                  区间为 95% 置信，不能证明零风险
                </span>
              </>
            ) : (
              <>
                <Crosshair size={12} />
                <span>
                  完整枚举 · 精确值
                  {result.layoutCount < 0
                    ? " · 布局数较多"
                    : ` · ${result.layoutCount.toLocaleString()} 种可行布局`}
                </span>
              </>
            )}
          </div>

          <div className="prob-lists">
            <div className="prob-col">
              <small>最低风险</small>
              {safest.map((c) => (
                <button
                  key={"s" + c.cell}
                  className="prob-row safe"
                  onClick={() => onLocate(c.cell)}
                >
                  <span>{coordinate(c.cell, e.board.width)}</span>
                  <ProbValue c={c} estimate={isEstimate} />
                </button>
              ))}
            </div>
            <div className="prob-col">
              <small>最高风险</small>
              {risky.map((c) => (
                <button
                  key={"r" + c.cell}
                  className="prob-row danger"
                  onClick={() => onLocate(c.cell)}
                >
                  <span>{coordinate(c.cell, e.board.width)}</span>
                  <ProbValue c={c} estimate={isEstimate} />
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <button
        className={"outline-button " + (showHeatmap ? "active" : "")}
        aria-pressed={showHeatmap}
        onClick={onToggleHeatmap}
      >
        <ScanSearch size={13} />
        {showHeatmap ? "隐藏概率热力图" : "叠加概率热力图"}
      </button>

      <button
        className="primary auto-explore"
        disabled={!canAuto}
        title={
          canAuto
            ? `自动揭开 ${safeCells.length} 个被证明零风险的格`
            : "只有完整枚举证明零风险的格才能一键探索"
        }
        onClick={() => canAuto && onAutoExplore(safeCells)}
      >
        <ShieldCheck size={14} />
        一键安全探索
        {safeCells.length > 0 && <em>×{safeCells.length}</em>}
      </button>

      <p className="logic-caution">
        <TriangleAlert size={11} />
        {isEstimate
          ? "当前为抽样估计，低概率不等于安全；只有被证明的零风险才会进入一键探索。"
          : "推断只使用公开数字、探针与你的旗标假设，不会读取暗格答案。"}
      </p>
    </section>
  );
}

function ProbValue({
  c,
  estimate,
}: {
  c: NonNullable<ProbabilityResult["cells"]>[number];
  estimate: boolean;
}) {
  if (estimate) {
    return (
      <span className="prob-num">
        {pct(c.p)}
        <i>
          {pct(c.low)}–{pct(c.high)}
        </i>
      </span>
    );
  }
  return (
    <span className="prob-num">
      {pct(c.p)}
      {c.provenSafe && <i>证明安全</i>}
      {c.provenDanger && <i>确定危险</i>}
    </span>
  );
}

function statusText(
  e: Expedition,
  hasClues: boolean,
  computing: boolean,
  hasConflict: boolean,
  result: ProbabilityResult | null,
): string {
  if (e.status === "ready" || !hasClues)
    return "第一步始终安全；揭开数字后开始生成概率地图。";
  if (computing) return "正在结合剩余危险总数求解边界分组，地图仍可操作。";
  if (hasConflict)
    return "现有信息互相矛盾，已在下方列出具体冲突来源；修正后才会给出概率。";
  if (!result || result.stale) return "公开信息已更新，旧概率正在失效重算。";
  if (result.provenSafeCells.length)
    return `找到 ${result.provenSafeCells.length} 个被证明零风险的格，可一键安全探索。`;
  return "没有被证明的安全格，概率仅作参考，必要时使用道具。";
}
