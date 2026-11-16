/** 文本工具：把命令/日志压成一行人能读的摘要 */
export function oneLine(input: string, max = 160): string {
  const s = input.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Codex 的 commandExecution 里塞的是完整 pwsh 调用：
 *   "C:\...\pwsh.exe" -Command "@'
 * 这里把外壳剥掉，只留真正执行的命令。
 */
export function stripShellWrapper(command: string): string {
  const m = command.match(/-Command\s+(.*)$/s);
  const body = m ? m[1] : command;
  return oneLine(body.replace(/^@'|'@$/g, ""), 180);
}
