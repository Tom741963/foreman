/**
 * 探针：确认两个 agent 的本地记录都能读出来。
 * 用法：node scripts/probe.ts [条数]
 */
import { codexAvailable, recentTurns, recentEvents as codexEvents } from "../src/adapters/codex.ts";
import { dshAvailable, listSessions, recentEvents as dshEvents } from "../src/adapters/dsh.ts";

const limit = Number(process.argv[2] ?? 12);

function stamp(ts: number): string {
  if (!ts) return "--:--:--";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

console.log("Codex 可用:", codexAvailable(), "| DSH 可用:", dshAvailable());
console.log("DSH 会话数:", listSessions().length);

const turns = recentTurns(5);
console.log("\n== Codex 最近 turn ==");
for (const t of turns) {
  const mins = t.durationMs ? (t.durationMs / 60000).toFixed(1) + " 分钟" : "-";
  console.log(`${stamp(t.startedAt)}  ${t.status.padEnd(10)} ${mins}`);
}

const merged = [
  ...codexEvents(limit).map((e) => ({ ...e, agent: "codex" as const })),
  ...dshEvents(limit).map((e) => ({ ...e, agent: "dsh" as const })),
].sort((a, b) => a.ts - b.ts);

console.log(`\n== 合并活动流（最近 ${merged.length} 条） ==`);
for (const e of merged) {
  console.log(`${stamp(e.ts)}  ${e.agent.padEnd(5)} ${e.kind.padEnd(13)} ${e.text.slice(0, 90)}`);
}
