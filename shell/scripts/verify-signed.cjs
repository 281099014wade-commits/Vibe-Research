/**
 * 签完之后立刻自查：**包里每一个 Mach-O 都真的签上了吗**。
 *
 * 🔴 为什么必须有这一道：`signIgnore` 是一张手写的扩展名表，用来把 14,124 个文件里
 *    那 95% 不是二进制的挑出去（不然一次打包 92 分钟）。这张表**写错一种就会漏签一个二进制**，
 *    而漏签的后果是**公证失败**。
 *
 * ⚠️ **它拦不到"少等 Apple 几十分钟"** —— 实测 electron-builder 的 `afterSign` 是在
 *    **签名与公证都跑完之后**才调的（构建日志顺序：signing → notarization successful → 本钩子）。
 *    第一版的注释写成"能在公证前就炸出来"，是我按名字想当然，与实际执行顺序不符。
 *    它真正的价值是**对发出去的那份包做一次独立复核**：Apple 说通过是一回事，
 *    我们自己数一遍包里每个 Mach-O 都签上了，是另一回事。
 *
 * ⚠️ 判据是**文件内容**（`file` 认 Mach-O），不是扩展名 —— 拿扩展名判就等于用 signIgnore
 *    那张表去验证它自己，一定通过、什么也没查。
 */
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 认 Mach-O：**读文件头四个字节比 magic**，不解析 `file` 的文本输出。
 *
 * 🔴 换掉文本解析是因为它有两个静默失效面（Codex 审计指出，都成立）：
 *    ① `file` 某一批非零退出就 `catch { continue }` ⇒ **整批最多 400 个文件凭空消失**，
 *       而"扫到的太少就报错"那条守卫看不出「109 个只查了 70 个」这种部分丢失；
 *    ② 按第一个冒号切路径，遇到**文件名里带冒号**（POSIX 合法）就切出一条不存在的路径，
 *       同样是静默丢掉。
 *    读 magic 没有子进程、没有分批、没有文本歧义 —— 读不动就抛，不存在"悄悄少查"。
 */
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function machOFiles(root) {
  const out = [];
  const buf = Buffer.alloc(4);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // 链接指向的本体自己会被走到
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      let fd;
      try {
        fd = fs.openSync(p, "r");
        const n = fs.readSync(fd, buf, 0, 4, 0);
        if (n === 4 && MACHO_MAGIC.has(buf.readUInt32BE(0))) out.push(p);
      } catch (e2) {
        // 🔴 **读不动就抛**：这里"跳过"等于把一个可能漏签的二进制悄悄放行
        throw new Error(`读不了 ${p}，无法判断它是不是 Mach-O：${e2 instanceof Error ? e2.message : String(e2)}`);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
  };
  walk(root);
  return out;
}

exports.default = async function verifySigned(context) {
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!fs.existsSync(app)) throw new Error(`没找到 .app：${app}`);

  // 🔴 **`codesign -dv` 把结果写在 stderr，不是 stdout**。
  //    第一版这里读的是 `execFileSync` 的返回值（只有 stdout）⇒ 永远拿到空串 ⇒
  //    正则永远不匹配 ⇒ **每次都"跳过"，还打一句让人放心的话**。
  //    实测那一轮：日志上明明写着 `identityName=Developer ID Application: …`，
  //    这道自查却说"这一份没有用 Developer ID 签" —— 一个静默失效的防线，
  //    正是它本该防的那种东西。
  const desc = (() => {
    // ⚠️ **必须给 `--verbose=2`**：默认详细度不打 `Authority=` 那几行，
    //    于是下面那条正则永远不匹配 —— 与上面那个 bug 是同一类"判据取错了"。
    const r = spawnSync("codesign", ["-dv", "--verbose=2", app], { encoding: "utf8" });
    return `${r.stdout || ""}${r.stderr || ""}`;
  })();

  if (!/Authority=Developer ID Application/.test(desc)) {
    // 🔴 只有**确认它确实没签**才允许跳过。看不懂输出 ≠ 没签 ——
    //    把两者混为一谈就是上面那个 bug 的一般形式。
    const clearlyUnsigned = /code object is not signed at all/.test(desc) || /Signature=adhoc/.test(desc);
    if (!clearlyUnsigned) {
      throw new Error(`看不出这份包签没签（codesign -dv 的输出不认识）。不能当作"没签所以跳过"：\n${desc.slice(0, 400)}`);
    }
    process.stdout.write("  • 跳过签名自查：这一份确实没有签（adhoc / 无签名）\n");
    return;
  }

  const TEAM_ID = (/TeamIdentifier=(\S+)/.exec(desc) || [])[1];
  if (!TEAM_ID) throw new Error(`顶层签名里读不出 TeamIdentifier，无法逐个核对签名归属：\n${desc.slice(0, 300)}`);

  const bins = machOFiles(app);
  // 🔴 空查会"全绿"，那比漏签更糟 —— 先证明扫描本身是有效的
  if (bins.length < 50) {
    throw new Error(`只扫到 ${bins.length} 个 Mach-O，明显不对（应有一百多个）。是扫描逻辑坏了，不是包干净。`);
  }

  // 🔴 **bundle 的主可执行文件不能单独验**：它的签名是随整个 bundle 封的，
  //    单独 `codesign -v` 它必然报 `a sealed resource is missing or invalid`。
  //    要验的是 bundle 本身 —— 上面那次 `codesign -dv` 已经确认它签的是 Developer ID。
  const mainExe = path.join(app, "Contents", "MacOS", context.packager.appInfo.productFilename);

  const bad = [];
  for (const b of bins) {
    if (b === mainExe) continue;
    // 🔴 **只验"有没有有效签名"是不够的**：`codesign -v --strict` 对 **adhoc 签名同样返回成功**。
    //    若 signIgnore 误伤了某个二进制、它保留着上游的 adhoc 签名，这里会判它"已签"，
    //    而它并没有我们的 Developer ID —— 公证照样可能拒。所以还要看它是**谁**签的。
    try {
      execFileSync("codesign", ["-v", "--strict", b], { stdio: "ignore" });
    } catch {
      bad.push(`${path.relative(app, b)}（验签失败）`);
      continue;
    }
    const r = spawnSync("codesign", ["-dv", "--verbose=2", b], { encoding: "utf8" });
    const info = `${r.stdout || ""}${r.stderr || ""}`;
    if (!info.includes(`TeamIdentifier=${TEAM_ID}`) || !/Authority=Developer ID Application/.test(info)) {
      bad.push(`${path.relative(app, b)}（不是本团队的 Developer ID 签的）`);
    }
  }
  // bundle 整体单独验一次(它才是主程序签名的正确判据)
  try {
    execFileSync("codesign", ["-v", "--strict", app], { stdio: "ignore" });
  } catch {
    bad.push("(整个 .app bundle 验签失败)");
  }
  if (bad.length) {
    throw new Error(
      `${bad.length} 个 Mach-O 没签上（signIgnore 误伤了它们，公证一定会失败）：\n  ` +
        bad.slice(0, 25).join("\n  ") +
        (bad.length > 25 ? `\n  …共 ${bad.length} 个` : ""),
    );
  }
  process.stdout.write(`  • 签名自查通过：${bins.length} 个 Mach-O 全部已签\n`);
};
