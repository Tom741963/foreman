// 端到端：从界面拖三个附件、发出去、等到回答
const { chromium } = await import("file:///D:/campus-copilot/node_modules/playwright-core/index.mjs");

const url = process.argv[2] ?? "http://127.0.0.1:4319";
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERR", e.message.slice(0, 200)));

await page.goto(url, { waitUntil: "networkidle" });
await page.click(".view[data-view='chat']");
await page.click("#newThread");
await page.waitForTimeout(300);
await page.setInputFiles("#filePick", [
  "D:/foreman/attachments/spike/spike.png",
  "D:/foreman/attachments/spike/spike.pdf",
  "D:/foreman/attachments/spike/spike.docx",
]);
await page.waitForFunction(() => document.querySelectorAll(".chip").length >= 3, null, { timeout: 20000 });
await page.fill("#task", "三个附件里各有什么？每份一句话，最后写出 PDF 的结束标记");
await page.click("#send");

const deadline = Date.now() + 120_000;
let text = "";
while (Date.now() < deadline) {
  await page.waitForTimeout(2000);
  text = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll("#chatList .msg.assistant .msg-body")];
    return bubbles.length ? bubbles[bubbles.length - 1].textContent.trim() : "";
  });
  if (text) break;
}
console.log("answer =", text.replace(/\s+/g, " ").slice(0, 400));
console.log("chips after send =", await page.$$eval(".chip", (e) => e.length));
await browser.close();
