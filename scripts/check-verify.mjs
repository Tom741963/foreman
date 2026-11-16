// 验收解析的单元检查
const m = await import("file:///D:/foreman/src/orchestrator.ts");

const fail = m.parseVerification('{"pass":false,"summary":"文件没写","issues":[{"step":2,"problem":"missing file"}]}');
const fenced = m.parseVerification("```json\n{\"pass\":true,\"summary\":\"ok\",\"issues\":[]}\n```");
const junk = m.parseVerification("根本不是 JSON");

console.log(JSON.stringify({ fail, fenced, junk }, null, 1));
