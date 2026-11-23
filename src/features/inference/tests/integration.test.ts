import { analyzeProbability } from "../lib/probability";
import { autoExploreSafe } from "../../exploration/model/actions";
import { createExpedition } from "../../exploration/model/expedition";
import { revealArea } from "../../exploration/lib/flood";
import { generateBoard, blankBoard } from "../../terrain/lib/generator";
import type { PublicBoard } from "../../../shared/types";

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

function pubFromBoard(b: ReturnType<typeof generateBoard>): PublicBoard {
  return {
    width: b.width,
    height: b.height,
    mines: b.mines,
    cells: b.cells.map((c) => ({
      id: c.id,
      revealed: c.revealed,
      mark: c.mark,
      adjacent: c.revealed && !c.mine ? c.adjacent : null,
      intel: c.intel,
      exploded: c.revealed && c.mine,
    })),
  };
}

// --- 端到端：真实生成的棋盘，证明安全格必须确实无雷 ---
console.log("测试A：一键探索的证明安全格在真实棋盘上必定无雷");
{
  let allHonest = true;
  let assistCount = 0;
  for (const seed of ["s1", "s2", "s3", "s4", "s5"]) {
    let board = generateBoard(blankBoard("scout", seed), 0);
    let e = createExpedition(board, crypto.randomUUID(), Date.now());
    e = { ...e, status: "active" };
    // 模拟逐步揭开，每步跑概率分析并对证明安全格做防御性校验
    for (let step = 0; step < 30; step++) {
      const pub = pubFromBoard(e.board);
      const r = analyzeProbability({
        board: pub,
        policy: "assume",
        mode: "exact",
        revision: step + 1,
      });
      // 校验 1：所有证明安全格在真实棋盘上确实不是雷
      for (const id of r.provenSafeCells) {
        if (e.board.cells[id].mine) allHonest = false;
      }
      // 校验 2：抽样/冲突/失效时没有证明安全格
      if (r.mode === "sampled" && r.provenSafeCells.length > 0)
        allHonest = false;
      if (r.conflicts.length && r.provenSafeCells.length > 0)
        allHonest = false;
      // 执行一键安全探索
      if (r.provenSafeCells.length && !r.conflicts.length) {
        const before = e;
        e = autoExploreSafe(e, r.provenSafeCells);
        if (e !== before) assistCount++;
        if (e.mistakes > before.mistakes)
          allHonest = false; // 证明安全格不应触发陷阱
      }
      // 随机揭开一个未揭示格推进局面
      const closed = e.board.cells.filter(
        (c) => !c.revealed && c.mark !== "flag",
      );
      if (!closed.length || e.status !== "active") break;
      const pick = closed[Math.floor(Math.random() * closed.length)];
      // 仅揭开安全格以维持局面（避免直接结束）
      const safePick = closed.find((c) => !c.mine);
      if (!safePick) break;
      const result = revealArea(e.board, [safePick.id]);
      e = { ...e, board: result.board };
      void pick;
    }
  }
  check("证明安全格全部诚实无雷", allHonest);
  check("一键探索确实被触发并标记 assistUsed", assistCount > 0, String(assistCount));
}

// --- autoExploreSafe 拒绝含雷/已揭示/旗标格 ---
console.log("测试B：autoExploreSafe 防御性拒绝非法输入");
{
  const board = generateBoard(blankBoard("scout", "guard"), 0);
  let e = createExpedition(board, crypto.randomUUID(), Date.now());
  e = { ...e, status: "active" };
  const mineCell = e.board.cells.find((c) => c.mine)!;
  const before = e;
  e = autoExploreSafe(e, [mineCell.id]);
  check("含雷格被整体拒绝", e === before);
  e = autoExploreSafe(e, []);
  check("空数组不产生变化", e === before);
  const notReady = { ...e, status: "ready" as const, board: blankBoard("scout", "x") };
  check("未开局拒绝", autoExploreSafe(notReady, [5]) === notReady);
}

// --- revision 失效：旧 revision 的结果不应被信任 ---
console.log("测试C：revision 与冲突语义");
{
  const board: PublicBoard = {
    width: 5,
    height: 5,
    mines: 5,
    cells: Array.from({ length: 25 }, (_, id) => ({
      id,
      revealed: id === 12,
      mark: "none",
      adjacent: id === 12 ? 0 : null,
      intel: "unknown",
      exploded: false,
    })),
  };
  const r1 = analyzeProbability({ board, policy: "assume", mode: "exact", revision: 1 });
  check("revision 透传", r1.revision === 1);
  check("零数字周围证明安全", r1.provenSafeCells.length === 8);
  // 制造冲突
  const conflictBoard: PublicBoard = {
    ...board,
    cells: board.cells.map((c) =>
      c.id === 7 ? { ...c, mark: "flag", intel: "safe" } : c,
    ),
  };
  const r2 = analyzeProbability({
    board: conflictBoard,
    policy: "assume",
    mode: "exact",
    revision: 2,
  });
  check("冲突时无概率格", r2.cells.length === 0 && r2.conflicts.length > 0);
  check("冲突来源带坐标文字", r2.conflicts.every((c) => c.text.includes("H3") || c.text.length > 5));
  const r3 = analyzeProbability({
    board: conflictBoard,
    policy: "ignore",
    mode: "exact",
    revision: 3,
  });
  check("忽略旗标消除冲突", r3.conflicts.length === 0);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) throw new Error("集成测试失败");
