// 截一张「思考过程」展开后的对话视图
const { chromium } = await import("file:///D:/campus-copilot/node_modules/playwright-core/index.mjs");

const url = process.argv[2] ?? "http://127.0.0.1:4319";
const out = process.argv[3] ?? "D:/foreman/docs/think.png";

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: "networkidle" });
await page.click('.view[data-view="chat"]');
await page.waitForSelector("#chatList details.think", { timeout: 15000 });
await page.click("#chatList details.think summary");
await page.waitForTimeout(600);
await page.screenshot({ path: out });
console.log("shot ->", out, "errors:", errors.length ? errors.join(" | ") : "none");
await browser.close();
