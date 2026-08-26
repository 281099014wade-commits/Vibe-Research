/**
 * electron-builder 打包前的闸门 —— **它自己把载荷装配一遍**。
 *
 * 🔴 **真踩过两次，都是同一个形状："成功地打进了上一版"**：
 *    ① 改完 `paths.ts` 只跑 typecheck 就直接 electron-builder，打进去的是上一版 `main.cjs`，
 *       装机版报了一个源码里已经不存在的错，而仓库里怎么看都是对的；
 *    ② 闸门若只检查「payload 里那几个文件在不在」，上一次装配的整棵旧载荷照样能过关 ——
 *       外壳是新的、载荷是旧的，两边都"成功"。
 *    ⇒ 不做新鲜度判断（判什么算新鲜本身就会写错），直接**重装配**。多花一两分钟，换掉整类问题。
 *
 * 要跳过验证里的真实取数（比如没网），设 `VRA_PACK_SKIP_VERIFY=1`。
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const SHELL = path.resolve(__dirname, "..");

module.exports = async function beforePack() {
  process.stdout.write("  • 重新编译外壳主进程\n");
  execFileSync(path.join(SHELL, "node_modules", ".bin", "esbuild"), [
    "src/main.ts", "--bundle", "--platform=node", "--target=node22",
    "--format=cjs", "--external:electron", "--outfile=dist/main.cjs",
  ], { cwd: SHELL, stdio: "inherit" });

  process.stdout.write("  • 重新装配载荷（界面会重新构建）\n");
  const args = ["scripts/assemble.mjs"];
  if (process.env.VRA_PACK_SKIP_VERIFY === "1") args.push("--skip-verify");
  execFileSync(process.execPath, args, { cwd: SHELL, stdio: "inherit" });
};
