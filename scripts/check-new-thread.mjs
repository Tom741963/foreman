// 验证「新建对话」：点 + 新对话 → 发一句 → 应该多出一个线程
import { chromium } from "file:///D:/campus-copilot/node_modules/playwright-core/index.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:4319";
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(base, { waitUntil: "networkidle" });
await page.click('.view[data-view="chat"]');
const before = await page.$$eval("#threadPick option", (o) => o.length);

await page.click("#newThread");
const afterNew = await page.$$eval("#threadPick option", (o) => o.length);

await page.fill("#task", "新建对话测试：用五个字回答我。");
await page.click(".send");
await page.waitForFunction(
  () => document.querySelectorAll("#chatList .msg.assistant").length >= 1,
  { timeout: 90000 },
);
const bubbles = await page.$$eval("#chatList .msg", (n) => n.length);
await page.waitForTimeout(1500);
await page.screenshot({ path: "D:/foreman/docs/chat-new.png" });
const after = await page.$$eval("#threadPick option", (o) => o.length);
const last = await page.$$eval("#chatList .msg-body", (n) => n.at(-1)?.textContent ?? "");

console.log(JSON.stringify({ before, afterNew, after, bubbles, last, errors }, null, 2));
await browser.close();
