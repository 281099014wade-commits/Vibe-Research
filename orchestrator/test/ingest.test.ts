import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts"; // 测试文件也是入口:插件要先注册
import { IngestError, MAX_FILES, ingestFiles } from "../src/ingest.ts";
import { listRecords } from "../src/ledger.ts";

// ⚠️ fileURLToPath 而不是 new URL(...).pathname —— 仓库路径含中文时 pathname 是百分号编码的
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Cap {
  opts?: Record<string, unknown>;
  inputs?: unknown;
  schema?: unknown;
}

/** 假 Codex:记录 startThread 选项与本轮输入,回放预设 JSON */
function fakeCodex(reply: string, cap?: Cap) {
  return () =>
    ({
      startThread(opts: Record<string, unknown>) {
        if (cap) cap.opts = opts;
        return {
          id: "t-fake",
          runStreamed(input: unknown, turnOpts?: { outputSchema?: unknown }) {
            if (cap) {
              cap.inputs = input;
              cap.schema = turnOpts?.outputSchema;
            }
            return Promise.resolve({
              events: (async function* () {
                yield { type: "item.completed", item: { type: "agent_message", text: reply } };
              })(),
            });
          },
        };
      },
    }) as never;
}

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "vra-ingest-"));
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64"); // PNG 魔数,够当"一张图"
const OK_REPLY = JSON.stringify({
  drafts: [
    { source_file: "01_a.csv", fields: { symbol: "300308", shares: 100, cost: 846 }, uncertain: ["cost:截图模糊"] },
  ],
  warnings: ["第二张图看不清"],
});

test("转写线程与对话同样的硬约束:只读沙箱 / 不联网 / 不联网搜索", async () => {
  const cap: Cap = {};
  await ingestFiles(
    { repoRoot: REPO, dataRoot: tmp() },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("代码,数量\n300308,100") }] },
    fakeCodex(OK_REPLY, cap),
  );
  const o = cap.opts!;
  // 🔴 转写要是能写文件 / 能联网,它就能"自己去补数据" —— 那正是取数纪律要挡的
  assert.equal(o.sandboxMode, "read-only");
  assert.equal(o.networkAccessEnabled, false);
  assert.equal(o.webSearchMode, "disabled");
  assert.equal(o.approvalPolicy, "never");
});

test("🔴 只产草稿,绝不写台账 —— 转写认错一个数字,落库后没人分得清是机器填的", async () => {
  const root = tmp();
  const r = await ingestFiles(
    { repoRoot: REPO, dataRoot: root },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] },
    fakeCodex(OK_REPLY),
  );
  assert.equal(r.drafts.length, 1);
  assert.equal(listRecords(root, "position").length, 0, "台账必须一条都没多");
  // 草稿不带信封字段:id/kind/created_at 只有真正落库时才由 Core 给
  for (const k of ["id", "kind", "created_at", "updated_at"]) {
    assert.ok(!(k in r.drafts[0]!.fields), `草稿不该自带 ${k}`);
  }
});

test("图片走 local_image 传给模型,文本文件写进提示词让它自己读", async () => {
  const cap: Cap = {};
  await ingestFiles(
    { repoRoot: REPO, dataRoot: tmp() },
    {
      kind: "position",
      files: [
        { name: "shot.png", content_base64: PNG },
        { name: "rows.csv", content_base64: b64("a,b") },
      ],
    },
    fakeCodex(OK_REPLY, cap),
  );
  const inputs = cap.inputs as { type: string; text?: string; path?: string }[];
  assert.ok(Array.isArray(inputs));
  const imgs = inputs.filter((i) => i.type === "local_image");
  assert.equal(imgs.length, 1, "一张图 → 一个 local_image");
  assert.ok(fs.existsSync(imgs[0]!.path!), "图片要真的落在盘上,模型才读得到");
  const text = inputs.find((i) => i.type === "text")!.text!;
  assert.ok(text.includes("rows.csv"), "文本文件名要写进提示词");
  assert.ok(cap.schema, "必须强制结构化产出,否则解析全靠运气");
});

test("字段说明来自契约而不是写死 —— 垂类改字段,提示词自动跟着变", async () => {
  const cap: Cap = {};
  await ingestFiles(
    { repoRoot: REPO, dataRoot: tmp() },
    { kind: "criterion", files: [{ name: "a.txt", content_base64: b64("x") }] },
    fakeCodex(JSON.stringify({ drafts: [], warnings: [] }), cap),
  );
  const text = (cap.inputs as { type: string; text?: string }[]).find((i) => i.type === "text")!.text!;
  // criterion 的枚举字段:提示词里要出现它的取值,否则模型只能瞎填
  assert.ok(text.includes("decision_point") && text.includes("falsifier"), "枚举取值要出现在提示词里");
  assert.ok(text.includes("statement"), "必填字段要点名");
});

test("文件名是不可信输入:路径穿越要被净化,原名只作为出处留在草稿里", async () => {
  const root = tmp();
  const cap: Cap = {};
  await ingestFiles(
    { repoRoot: REPO, dataRoot: root },
    { kind: "position", files: [{ name: "../../../../etc/passwd.txt", content_base64: b64("x") }] },
    fakeCodex(
      JSON.stringify({ drafts: [{ source_file: "01_passwd.txt", fields: {}, uncertain: [] }], warnings: [] }),
      cap,
    ),
  );
  const dir = String(cap.opts!.workingDirectory);
  assert.ok(dir.startsWith(path.resolve(root) + path.sep), "暂存目录必须在数据根内");
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.ok(!files[0]!.includes(".."), `落盘名不许含 ..:${files[0]}`);
  assert.ok(!fs.existsSync(path.join(root, "..", "passwd.txt")), "不许写到数据根之外");
});

test("类型白名单:pdf / xlsx 明确拒绝,并说清为什么(半成品比不支持更糟)", async () => {
  const root = tmp();
  for (const name of ["a.pdf", "b.xlsx", "c.exe", "d"]) {
    await assert.rejects(
      () =>
        ingestFiles(
          { repoRoot: REPO, dataRoot: root },
          { kind: "position", files: [{ name, content_base64: b64("x") }] },
          fakeCodex(OK_REPLY),
        ),
      (e: unknown) => e instanceof IngestError && e.code === "unsupported_type",
      `应拒绝 ${name}`,
    );
  }
});

test("体积与数量上限;空文件与非法种类当场拒绝", async () => {
  const root = tmp();
  const one = { name: "a.txt", content_base64: b64("x") };
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [] }, fakeCodex(OK_REPLY)),
    (e: unknown) => e instanceof IngestError && e.code === "no_files",
  );
  await assert.rejects(
    () =>
      ingestFiles(
        { repoRoot: REPO, dataRoot: root },
        { kind: "position", files: Array.from({ length: MAX_FILES + 1 }, () => one) },
        fakeCodex(OK_REPLY),
      ),
    (e: unknown) => e instanceof IngestError && e.code === "too_many_files",
  );
  await assert.rejects(
    () =>
      ingestFiles(
        { repoRoot: REPO, dataRoot: root },
        { kind: "position", files: [{ name: "a.txt", content_base64: "" }] },
        fakeCodex(OK_REPLY),
      ),
    (e: unknown) => e instanceof IngestError && e.code === "bad_content",
  );
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "nosuch", files: [one] }, fakeCodex(OK_REPLY)),
    (e: unknown) => e instanceof IngestError && e.code === "unknown_kind",
  );
});

test("产出解析不了就报错,不许'尽力还原' —— 半份草稿会被当成全部", async () => {
  const root = tmp();
  for (const bad of ["不是 JSON", '{"warnings":[]}', '{"drafts":{"not":"array"},"warnings":[]}']) {
    await assert.rejects(
      () =>
        ingestFiles(
          { repoRoot: REPO, dataRoot: root },
          { kind: "position", files: [{ name: "a.txt", content_base64: b64("x") }] },
          fakeCodex(bad),
        ),
      (e: unknown) => e instanceof IngestError && e.code === "bad_output",
      `应判 bad_output:${bad.slice(0, 30)}`,
    );
  }
});

test("草稿里的出处换回用户原来的文件名(他认得的是那个)", async () => {
  const r = await ingestFiles(
    { repoRoot: REPO, dataRoot: tmp() },
    { kind: "position", files: [{ name: "我的持仓截图.png", content_base64: PNG }] },
    fakeCodex(
      JSON.stringify({ drafts: [{ source_file: "01_我的持仓截图.png", fields: {}, uncertain: [] }], warnings: [] }),
    ),
  );
  assert.equal(r.drafts[0]!.source_file, "我的持仓截图.png");
});

test("🔴 产出解析必须严格:非法结构不许被'修'成草稿(半份草稿会被当成全部)", async () => {
  const root = tmp();
  const cases: [string, string][] = [
    ['{"drafts":[null],"warnings":[]}', "草稿不是对象"],
    ['{"drafts":[{"fields":{}, "uncertain":[]}],"warnings":[]}', "缺 source_file"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":"x","uncertain":[]}],"warnings":[]}', "fields 不是对象"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":{},"uncertain":"x"}],"warnings":[]}', "uncertain 不是数组"],
    // 🔴 最要命的一条:模型自己说"这几处没看清",非法结构被抹平后**这条信息整个消失**
    ['{"drafts":[{"source_file":"01_a.csv","fields":{},"uncertain":[1]}],"warnings":[]}', "uncertain 有非字符串"],
    ['{"drafts":[],"warnings":"failed"}', "warnings 不是数组"],
    ['[]', "顶层不是对象"],
  ];
  for (const [reply, why] of cases) {
    await assert.rejects(
      () =>
        ingestFiles(
          { repoRoot: REPO, dataRoot: root },
          { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] },
          fakeCodex(reply),
        ),
      (e: unknown) => e instanceof IngestError && e.code === "bad_output",
      `应判 bad_output(${why})`,
    );
  }
});

test("🔴 扩展名是用户给的,内容也得对得上 —— 否则 PDF 改名叫 .txt 就绕开了'不收 PDF'", async () => {
  const root = tmp();
  const PDF = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1").toString("base64");
  const bad: [string, string][] = [
    ["shot.png", b64("这根本不是 PNG")],              // 二进制伪装成图片
    ["shot.webp", PNG],                                // 图片格式对不上扩展名
    ["notes.txt", Buffer.from([0x00, 0x01, 0x02]).toString("base64")], // NUL = 二进制
    ["notes.txt", PDF],                                // 正是"改个名混进来"那一类
    ["notes.md", Buffer.from([0xff, 0xfe, 0x41]).toString("base64")],  // 非法 UTF-8
  ];
  for (const [name, content] of bad) {
    await assert.rejects(
      () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name, content_base64: content }] }, fakeCodex(OK_REPLY)),
      (e: unknown) => e instanceof IngestError && e.code === "content_mismatch",
      `应拒绝 ${name}`,
    );
  }
  // 真图片 / 真文本照过(不是把门一律关死)
  await ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "ok.png", content_base64: PNG }] }, fakeCodex(OK_REPLY));
  await ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "ok.csv", content_base64: b64("代码,数量\n300308,100") }] }, fakeCodex(OK_REPLY));
});

test("超大 base64 在**解码之前**就被拒(解码本身要扫一遍、要分配内存)", async () => {
  const root = tmp();
  // 🔴 这里的输入是刻意挑的:30 MB 全是非 base64 字符。
  //    Node 的解码器会跳过非法字符 ⇒ **解码后是 0 字节**。
  //    - 有前置长度校验:先看编码长度 30 MB > 上限 → file_too_large
  //    - 没有前置校验  :解码完得到 0 字节 → bad_content
  //    两条路给出**不同的错误码**,这条断言才真的在测"检查发生在解码之前"。
  //    ⚠️ 换成 "A".repeat(30MB) 是测不出来的:它解码后 22.5 MB,两条路都会报 file_too_large
  //       —— 断言看着对,其实把变异放过去了(第一版就是这么写的)。
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "a.txt", content_base64: "!".repeat(30 * 1024 * 1024) }] }, fakeCodex(OK_REPLY)),
    (e: unknown) => e instanceof IngestError && e.code === "file_too_large",
  );
  // 正常的超大文件也照样拒(这条走的是解码后的那道)
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "a.txt", content_base64: Buffer.alloc(9 * 1024 * 1024, 0x41).toString("base64") }] }, fakeCodex(OK_REPLY)),
    (e: unknown) => e instanceof IngestError && e.code === "file_too_large",
  );
});

test("🔴 失败时暂存目录要清掉 —— 里面是用户的私密截图,而调用方拿不到 batch 路径", async () => {
  const root = tmp();
  const importDir = path.join(root, "import");
  // 第一个文件合法、第二个类型不对:第一个已经落盘了
  await assert.rejects(
    () =>
      ingestFiles(
        { repoRoot: REPO, dataRoot: root },
        { kind: "position", files: [{ name: "a.txt", content_base64: b64("私密内容") }, { name: "b.pdf", content_base64: b64("x") }] },
        fakeCodex(OK_REPLY),
      ),
    (e: unknown) => e instanceof IngestError && e.code === "unsupported_type",
  );
  assert.deepEqual(fs.existsSync(importDir) ? fs.readdirSync(importDir) : [], [], "失败后不许有残留批次");

  // 转写阶段失败同样要清
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "a.txt", content_base64: b64("私密内容") }] }, fakeCodex("不是 JSON")),
    (e: unknown) => e instanceof IngestError && e.code === "bad_output",
  );
  assert.deepEqual(fs.existsSync(importDir) ? fs.readdirSync(importDir) : [], [], "转写失败后同样不许有残留");

  // 成功则保留原件:草稿要逐条确认,人得能回去核对
  const r = await ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] }, fakeCodex(OK_REPLY));
  assert.ok(fs.existsSync(path.join(root, r.dir)), "成功的批次要留着");
});
