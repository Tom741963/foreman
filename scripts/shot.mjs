// 用系统 Edge 截图，方便快速看界面效果（不装浏览器）
// 用法: node scripts/shot.mjs [url] [out] [view]
//   view: events(默认) | chat
const { chromium } = await import("file:///D:/campus-copilot/node_modules/playwright-core/index.mjs");

const url = process.argv[2] ?? "http://127.0.0.1:4319";
const out = process.argv[3] ?? "D:/foreman/docs/screenshot.png";
const view = process.argv[4] ?? "events";

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: "networkidle" });
if (view === "chat" || view === "orch") {
  await page.click(`.view[data-view="${view}"]`);
}
await page.waitForTimeout(3500);
await page.screenshot({ path: out });
console.log("shot ->", out);
console.log("console errors:", errors.length ? errors.join(" | ") : "none");
await browser.close();
