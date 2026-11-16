// 验证「思考过程」实时显示：发一句 → 等到出现思考流再截图 → 等回答结束再截图
const { chromium } = await import("file:///D:/campus-copilot/node_modules/playwright-core/index.mjs");

const url = process.argv[2] ?? "http://127.0.0.1:4319";
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: "networkidle" });
await page.click('.view[data-view="chat"]');
await page.click("#newThread");
await page.fill("#task", "用三步说明：为什么多智能体系统需要一个控制台。");
await page.click(".send");
await page.waitForSelector(".msg.pending", { timeout: 15000 }).catch(() => {});

// 等思考流出现（pending 气泡里的 think-body 有内容）
let liveText = 0;
try {
  await page.waitForFunction(
    () => (document.querySelector(".msg.pending .think-body")?.textContent?.length ?? 0) > 200,
    { timeout: 40000 },
  );
  liveText = await page.$eval(".msg.pending .think-body", (n) => n.textContent.length);
  await page.screenshot({ path: "D:/foreman/docs/think-live.png" });
} catch {
  await page.screenshot({ path: "D:/foreman/docs/think-live.png" });
}

// 等这一轮结束：任务面板里出现「完成」或问答气泡稳定
await page.waitForFunction(() => !document.querySelector(".msg.pending"), { timeout: 150000 }).catch(() => {});
await page.waitForTimeout(1200);
await page.screenshot({ path: "D:/foreman/docs/think.png" });
const hasThink = await page.$$eval("#chatList details.think", (n) => n.length);
const answerLen = await page.$$eval("#chatList .msg.assistant .msg-body", (n) => n.at(-1)?.textContent?.length ?? 0);

console.log(JSON.stringify({ liveText, hasThink, answerLen, errors }, null, 2));
await browser.close();
