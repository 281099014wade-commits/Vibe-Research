/** 文件工具:原子写入(临时文件 → fsync → 替换)、sha256、JSON 读写、追加 JSONL。*/
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export function sha256Text(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function atomicWrite(p: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.part`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

export function writeJson(p: string, obj: unknown): void {
  atomicWrite(p, JSON.stringify(obj, null, 2) + "\n");
}

export function readJson<T = unknown>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

export function readJsonIfExists<T = unknown>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  try {
    return readJson<T>(p);
  } catch {
    return null;
  }
}

export function appendJsonl(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, "a");
  try {
    fs.writeSync(fd, JSON.stringify(obj) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function listFiles(dir: string, ext?: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith(".") && (!ext || f.endsWith(ext)))
    .sort()
    .map((f) => path.join(dir, f));
}

export function nowIso(): string {
  // Asia/Shanghai ISO 字符串
  const d = new Date();
  const sh = new Date(d.getTime() + 8 * 3600 * 1000);
  return sh.toISOString().replace("Z", "+08:00");
}

export function ensureDirs(root: string, subs: string[]): void {
  for (const s of subs) fs.mkdirSync(path.join(root, s), { recursive: true });
}
