import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function json(rel: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8")) as Record<string, any>;
}

function readmeBadgeVersion(markdown: string, label: string): string {
  const matches = [...markdown.matchAll(/<img alt="Version" src="https:\/\/img\.shields\.io\/badge\/version-v([^-"\s]+)-F35D2B">/g)];
  assert.equal(matches.length, 1, `${label} 必须且只能有一个版本徽章`);
  return matches[0]![1]!;
}

function latestChangelogVersion(markdown: string): string {
  const unreleased = markdown.match(/^## \[Unreleased\]\s*$([\s\S]*)/m);
  assert.ok(unreleased, "CHANGELOG 缺少 [Unreleased] 节");
  const firstRelease = unreleased[1]!.match(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}\s*$/m);
  assert.ok(firstRelease, "CHANGELOG 的 [Unreleased] 后缺少带日期的发布节");
  return firstRelease[1]!;
}

test("release-facing version metadata stays synchronized", () => {
  const product = String(json("orchestrator/package.json").version);
  const desktop = String(json("desktop/package.json").version);
  const orchestratorLock = json("orchestrator/package-lock.json");
  const desktopLock = json("desktop/package-lock.json");
  const readmeZh = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const readmeEn = fs.readFileSync(path.join(repoRoot, "README_en.md"), "utf8");
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");

  assert.equal(desktop, product, "desktop/package.json 不得与产品版本分叉");
  assert.equal(orchestratorLock.version, product, "orchestrator lockfile 顶层版本未同步");
  assert.equal(orchestratorLock.packages?.[""]?.version, product, "orchestrator lockfile 根包版本未同步");
  assert.equal(desktopLock.version, product, "desktop lockfile 顶层版本未同步");
  assert.equal(desktopLock.packages?.[""]?.version, product, "desktop lockfile 根包版本未同步");
  assert.equal(readmeBadgeVersion(readmeZh, "中文 README"), product, "中文 README 版本徽章未同步");
  assert.equal(readmeBadgeVersion(readmeEn, "英文 README"), product, "英文 README 版本徽章未同步");
  assert.equal(latestChangelogVersion(changelog), product, "package 版本必须等于 CHANGELOG 最新发布节");
});
