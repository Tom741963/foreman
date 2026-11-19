/**
 * 附件：把用户拖进来的文件存到本地，抽成 agent 能读的东西。
 *
 * 为什么不让 agent 自己去读：
 * - 图片：Codex 有 --image，DSH 能用自己的工具打开，所以只给它路径；
 * - PDF/Word：实测让 agent 自己解析会卡死（十分钟不返回），所以这里先抽成文本；
 * - 文本类：直接内联，省得它再开一次文件。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

export type AttachmentKind = "image" | "text" | "document" | "video" | "other";

export type Attachment = {
  id: string;
  name: string;
  /** 相对工作目录的路径，写进 prompt 给 agent 用 */
  rel: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  /** 抽出来的文本（document / text 有，图片没有） */
  text?: string;
  /** 抽不出来时给用户看的原因 */
  note?: string;
};

const ROOT = process.env.FOREMAN_ATTACH ?? path.join("D:\\foreman", "attachments");
const MAX_TEXT = 12_000; // 内联进 prompt 的字数上限
const MAX_INLINE_BYTES = 400_000;
const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
const TEXT_EXT = [
  ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".log", ".yml", ".yaml",
  ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".c", ".h", ".cpp", ".go", ".rs",
  ".html", ".css", ".sql", ".sh", ".ps1", ".toml", ".ini", ".xml",
];
const VIDEO_EXT = [".mp4", ".mov", ".mkv", ".webm", ".avi"];

export function attachmentsRoot(): string {
  return ROOT;
}

function safeName(name: string): string {
  const base = path.basename(name).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
  return base || "file";
}

function kindOf(name: string): AttachmentKind {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.includes(ext)) return "image";
  if (TEXT_EXT.includes(ext)) return "text";
  if (ext === ".docx" || ext === ".pdf") return "document";
  if (VIDEO_EXT.includes(ext)) return "video";
  return "other";
}

/** 存文件：attachments/<threadKey>/<短哈希>-<原名> */
export function saveAttachment(input: {
  threadKey: string;
  name: string;
  mime?: string;
  base64: string;
}): Attachment {
  const dir = path.join(ROOT, input.threadKey.replace(/[^a-zA-Z0-9_-]/g, "") || "local");
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.from(input.base64, "base64");
  const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 8);
  const name = safeName(input.name);
  const abs = path.join(dir, `${hash}-${name}`);
  fs.writeFileSync(abs, buf);
  return {
    id: hash,
    name,
    rel: path.relative(process.cwd(), abs).split(path.sep).join("/"),
    kind: kindOf(name),
    mime: input.mime || guessMime(name),
    size: buf.byteLength,
  };
}

function guessMime(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}

/** 把附件补全成可以喂给模型的样子（抽文本 / 记原因） */
export async function prepareAttachment(a: Attachment): Promise<Attachment> {
  const abs = path.resolve(process.cwd(), a.rel);
  if (a.kind === "image") return a;
  if (a.kind === "video") {
    return { ...a, note: "视频还不能直接看：需要先抽帧（v1.1）" };
  }
  if (a.kind === "text") {
    try {
      const raw = fs.readFileSync(abs);
      if (raw.byteLength > MAX_INLINE_BYTES) {
        return { ...a, note: `文件太大（${Math.round(raw.byteLength / 1024)} KB），没有内联` };
      }
      const text = raw.toString("utf8").slice(0, MAX_TEXT);
      return { ...a, text };
    } catch (err) {
      return { ...a, note: `读不出来：${(err as Error).message}` };
    }
  }
  if (path.extname(a.name).toLowerCase() === ".docx") {
    try {
      const text = extractDocx(fs.readFileSync(abs)).slice(0, MAX_TEXT);
      return text.trim()
        ? { ...a, text }
        : { ...a, note: "这个 docx 里没抽到文字（可能是图片或空文档）" };
    } catch (err) {
      return { ...a, note: `docx 解析失败：${(err as Error).message}` };
    }
  }
  if (path.extname(a.name).toLowerCase() === ".pdf") {
    return extractPdf(a, abs);
  }
  return { ...a, note: "这种格式还不支持，转成文本/Word/PDF 或图片吧" };
}

/** docx 就是个 zip，直接把 word/document.xml 里的 <w:t> 抠出来，零依赖 */
export function extractDocx(buf: Buffer): string {
  const xml = readZipEntry(buf, "word/document.xml");
  if (!xml) throw new Error("找不到 word/document.xml");
  const flow = xml
    .replace(/<w:p[ >]/g, "\n<w:p ")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n");
  const parts: string[] = [];
  const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flow))) {
    if (m[0] === "\n") {
      parts.push("\n");
      continue;
    }
    parts.push(decodeXml(m[1]));
  }
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 最小 zip 读取：只处理 stored / deflate，够读 docx */
function readZipEntry(buf: Buffer, want: string): string | null {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (name === want) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      return method === 0 ? data.toString("utf8") : zlib.inflateRawSync(data).toString("utf8");
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** PDF：优先用本机装了的 pdfjs-dist；没装就明确告诉用户怎么办 */
async function extractPdf(a: Attachment, abs: string): Promise<Attachment> {
  try {
    // 先用本仓库装的；没有就试试本机其它工作副本（装了才生效，没装也不影响别的格式）
    const candidates = [
      "pdfjs-dist/legacy/build/pdf.mjs",
      "file:///D:/campus-copilot/node_modules/pdfjs-dist/legacy/build/pdf.mjs",
    ];
    let mod: any = null;
    for (const spec of candidates) {
      mod = await import(spec).catch(() => null);
      if (mod) break;
    }
    if (!mod) return { ...a, note: "PDF 需要 pdfjs-dist：在 D:\\foreman 下执行 npm i pdfjs-dist 后重启" };
    const data = new Uint8Array(fs.readFileSync(abs));
    const doc = await mod.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
    const pages: string[] = [];
    for (let p = 1; p <= Math.min(doc.numPages, 40); p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const line = content.items.map((it: any) => it.str ?? "").join(" ").replace(/\s+/g, " ");
      pages.push(`[第 ${p} 页] ${line}`);
    }
    const text = pages.join("\n").slice(0, MAX_TEXT);
    return text.trim()
      ? { ...a, text }
      : { ...a, note: "PDF 里没有可复制的文字（可能是扫描件）" };
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/Cannot find (module|package)/i.test(msg)) {
      return { ...a, note: "PDF 需要 pdfjs-dist：在 D:\\foreman 下执行 npm i pdfjs-dist 后重启" };
    }
    return { ...a, note: `PDF 解析失败：${msg.slice(0, 120)}` };
  }
}

/** 把附件清单拼成 prompt 里的一段 */
export function attachmentsBlock(list: Attachment[]): string {
  if (!list.length) return "";
  const lines: string[] = ["本轮附件（都在工作目录里）："];
  for (const a of list) {
    const size = a.size >= 1024 ? `${Math.round(a.size / 1024)} KB` : `${a.size} B`;
    if (a.kind === "image") {
      lines.push(`- 图片 ${a.rel}（${size}）：用你的看图能力直接看，必要时可以再打开细节。`);
    } else if (a.kind === "video") {
      lines.push(`- 视频 ${a.rel}（${size}）：${a.note ?? "暂时只给了路径"}`);
    } else if (a.text) {
      lines.push(`- 文档 ${a.name}（${a.rel}，${size}）全文如下：`);
      lines.push("```");
      lines.push(a.text);
      lines.push("```");
    } else {
      lines.push(`- 文件 ${a.rel}（${size}）：${a.note ?? "内容没能抽取，需要时自己打开看"}`);
    }
  }
  return lines.join("\n");
}
