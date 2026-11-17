// 打开「协作」视图，展开第一个产物 diff，截图（演示用）
// 用法: node scripts/shot-artifacts.mjs [url] [out]
const { chromium } = await import("file:///D:/campus-copilot/node_modules/playwright-core/index.mjs");

const url = process.argv[2] ?? "http://127.0.0.1:4319";
const out = process.argv[3] ?? "D:/foreman/docs/orch-artifacts.png";

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "networkidle" });
await page.click('.view[data-view="orch"]');
await page.waitForTimeout(1200);

const rows = await page.$$eval(".art summary", (els) => els.length);
if (rows) await page.click(".art summary");
await page.waitForTimeout(500);
await page.screenshot({ path: out });
console.log("art rows =", rows, "->", out);
await browser.close();
