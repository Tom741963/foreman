// 演示：把一张图和一份 PDF 拖进输入框，截图附件条
// 用法: node scripts/shot-attach.mjs [url] [out]
const { chromium } = await import("file:///D:/campus-copilot/node_modules/playwright-core/index.mjs");

const url = process.argv[2] ?? "http://127.0.0.1:4319";
const out = process.argv[3] ?? "D:/foreman/docs/ui-attach.png";

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "networkidle" });
await page.click('.view[data-view="chat"]');
await page.waitForTimeout(400);

await page.setInputFiles("#filePick", [
  "D:/foreman/attachments/spike/spike.png",
  "D:/foreman/attachments/spike/spike.pdf",
  "D:/foreman/attachments/spike/spike.docx",
]);
await page.waitForSelector(".chip", { timeout: 15000 });
await page.waitForTimeout(600);
await page.fill("#task", "看一下这三个附件，各用一句话说明里面有什么");
await page.screenshot({ path: out });

const chips = await page.$$eval(".chip", (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, " ")));
console.log("chips =", JSON.stringify(chips));
await browser.close();
