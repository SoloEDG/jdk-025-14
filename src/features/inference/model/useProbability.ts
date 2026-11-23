import { useEffect, useRef, useState } from "react";
import type {
  FlagPolicy,
  ProbabilityResult,
  PublicBoard,
  SolverMode,
} from "../../../shared/types";
import { analyzeProbability } from "../lib/probability";

export interface InferenceState {
  result: ProbabilityResult | null;
  /** 公开信息已变化、新结果尚未返回时为 true（旧结果标记为失效） */
  computing: boolean;
  revision: number;
}

/**
 * 异步概率推断调度。
 *
 * - 每次公开信息（棋盘）或设置变化都生成新的 revision，并使旧结果失效；
 * - 计算放进宏任务，不阻塞玩家继续操作地图；
 * - 晚返回的结果携带旧 revision，会被直接丢弃，绝不覆盖更新的局面；
 * - 新开局（棋盘身份变化）立即清空旧结果，避免上一局概率残留。
 */
export function useProbability(
  board: PublicBoard,
  policy: FlagPolicy,
  mode: SolverMode,
  boardKey: string,
): InferenceState {
  const [state, setState] = useState<InferenceState>({
    result: null,
    computing: false,
    revision: 0,
  });
  const revisionRef = useRef(0);
  const lastBoardKey = useRef(boardKey);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    // 新的一局：丢弃上一局一切推断结果
    if (lastBoardKey.current !== boardKey) {
      lastBoardKey.current = boardKey;
      revisionRef.current = 0;
      setState({ result: null, computing: false, revision: 0 });
    }

    revisionRef.current += 1;
    const revision = revisionRef.current;

    // 先把现有结果标记为失效（stale），UI 仍可查看但不可用于一键探索
    setState((prev) => ({
      result: prev.result ? { ...prev.result, stale: true } : null,
      computing: true,
      revision,
    }));

    // 合并同一帧内的多次变化，避免连续操作时反复求解
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      // 宏任务中计算；期间玩家可继续操作
      const result = analyzeProbability({ board, policy, mode, revision });
      // 晚到结果：revision 落后则丢弃，绝不覆盖新局
      if (revision !== revisionRef.current || lastBoardKey.current !== boardKey)
        return;
      setState({ result, computing: false, revision });
    }, 60);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [board, policy, mode, boardKey]);

  return state;
}
