/**
 * Mriter DSH 插件：把「歌词 → 创作方向」暴露成 Agent 可调用的工具。
 *
 * 执行两层兜底：
 *   1. 包内二进制   bin/<platform>-<arch>/mriter（自带引擎与数据，无需 Python）
 *   2. 源码兜底     MRITER_HOME（默认 ~/AI_Projects/Mriter）+ python3 -m antimusic.advice
 *
 * 退出码 3 表示题材未判定：不猜，把可选题材原样返回，让 Agent 去问用户。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const name = "dsh-mriter";
const inject = ["tools"];

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM = `${process.platform}-${process.arch}`;

function run(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, argv, { timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => resolve({
        code: err && typeof err.code === "number" ? err.code : (err ? 1 : 0),
        stdout: String(stdout || ""), stderr: String(stderr || ""),
      }));
  });
}

function resolveEngine() {
  const binCandidates = [
    process.env.MRITER_BIN,
    join(HERE, "bin", PLATFORM, "mriter"),
    join(HERE, "bin", "mriter"),
  ].filter(Boolean);
  for (const p of binCandidates) {
    if (p && existsSync(p)) return { kind: "binary", cmd: p, base: [] };
  }
  const repo = process.env.MRITER_HOME || join(homedir(), "AI_Projects", "Mriter");
  if (existsSync(join(repo, "antimusic", "advice.py"))) {
    return { kind: "python", cmd: process.env.PYTHON || "python3", base: ["-m", "antimusic.advice"], cwd: repo };
  }
  return null;
}

async function advice({ lyrics, theme, share }) {
  if (typeof lyrics !== "string" || !lyrics.trim()) throw new Error("lyrics 不能为空");
  const engine = resolveEngine();
  if (!engine) {
    throw new Error(
      "找不到 Mriter 引擎：包内没有本平台的二进制，也未检测到源码仓库。" +
      "设 MRITER_HOME 指向仓库，或设 MRITER_BIN 指向二进制。");
  }
  const dir = mkdtempSync(join(tmpdir(), "mriter-"));
  const lyricPath = join(dir, "lyrics.txt");
  writeFileSync(lyricPath, lyrics, "utf8");

  const argv = [...engine.base, "--lyrics", lyricPath, "--out", dir];
  if (theme) argv.push("--theme", theme);
  if (share) argv.push("--share");

  const r = await run(engine.cmd, argv, engine.cwd ? { cwd: engine.cwd } : {});
  const mdPath = join(dir, "advice.md");
  const report = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";

  if (r.code === 2) {
    return { text: `Mriter 输入错误（退出码 2）：\n${r.stderr || r.stdout}`.trim(), exitCode: 2, outDir: dir };
  }
  if (r.code === 3) {
    const hint = (r.stdout || "").split("\n").find((l) => l.includes("需要回答")) || "题材未判定";
    return {
      text: `Mriter 需要你先确认题材，再继续。\n${hint}\n\n` +
        `拿到题材后，用同一份歌词加 theme 参数重跑（不要自己猜题材）。\n` +
        `（本轮结构部分已生成：${dir}/advice.md）`,
      exitCode: 3, outDir: dir, pending: true,
    };
  }
  if (!report) {
    return { text: `Mriter 未产出报告（退出码 ${r.code}）。\n${r.stderr || r.stdout}`.trim(), exitCode: r.code, outDir: dir };
  }
  return { text: report, exitCode: 0, outDir: dir };
}

const tool = {
  name: "mriter_advice",
  description:
    "音乐创作助手：给定一段歌词，返回一份八节报告——结构扫描、结构性断点、作曲方向（音域/音符预算/长音落点/动机）、" +
    "和声走向候选（带真实语料稀有度，1029 首中文流行）、风格卡（草稿态，逐条标出处）、词堆、编曲提示、盲区。" +
    "用于用户从零开始写歌、卡住时找方向、检查词的韵与格律。**只给方向与材料，不产出完整词曲**。" +
    "如果退出码/返回里提示题材未判定，必须回来问用户选哪个题材（童年怀旧/理想成长/爱情遗憾/城市漂泊），" +
    "拿到答案后用 theme 参数重跑，不要自己猜题材。",
  parameters: {
    type: "object",
    properties: {
      lyrics: { type: "string", description: "歌词全文，逐行给。不要传文件路径。" },
      theme: {
        type: "string",
        enum: ["童年怀旧", "理想成长", "爱情遗憾", "城市漂泊"],
        description: "仅在用户已确认题材时传入；未确认就不要猜。",
      },
      share: { type: "boolean", description: "是否另出一张自包含分享卡（不含歌词原文）。" },
    },
    required: ["lyrics"],
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        text: { type: "string" },
        exitCode: { type: "number" },
        outDir: { type: "string" },
        pending: { type: "boolean" },
      },
      required: ["text"],
    },
    render: (_args, value) => [{ type: "text", text: String((value && value.text) || "") }],
  },
  async execute(args) {
    return advice({ lyrics: args.lyrics, theme: args.theme, share: args.share });
  },
};

const progressionTool = {
  name: "mriter_progression",
  description:
    "查一条和弦走向在 1029 首中文流行语料里的稀有度。支持罗马级数（vi IV V I）、数字简谱（6451）、" +
    "和弦符号（C Am F G，需 key）。返回每千窗频次与分位；不足 4 个和弦时返回 measurable=false，" +
    "**0‰ 要读成「测不了」，不是「罕见」**。",
  parameters: {
    type: "object",
    properties: {
      chords: { type: "string", description: "和弦或级数序列，如 'vi IV V I'、'6451'、'C Am F G'" },
      key: { type: "string", description: "调式主音，和弦符号写法时需要，默认 C" },
    },
    required: ["chords"],
  },
  output: {
    schema: { type: "object", additionalProperties: true,
      properties: { text: { type: "string" } }, required: ["text"] },
    render: (_args, value) => [{ type: "text", text: String((value && value.text) || "") }],
  },
  async execute(args) {
    const engine = resolveEngine();
    if (!engine) return { text: "找不到 Mriter 引擎（设 MRITER_BIN 或 MRITER_HOME）" };
    const argv = [...engine.base, "--progression", String(args.chords || ""), "--key", args.key || "C"];
    const r = await run(engine.cmd, argv, engine.cwd ? { cwd: engine.cwd } : {});
    const raw = (r.stdout || "").trim();
    if (!raw) return { text: `查询失败（退出码 ${r.code}）：${r.stderr || ""}`.trim(), exitCode: r.code };
    try {
      const j = JSON.parse(raw.split("\n").pop());
      if (j.ok === false) return { text: `解析不出：${j.why || ""}`, exitCode: 2 };
      if (j.measurable === false) {
        return { text: `${j.readable}：${j.why}`, exitCode: 0, measurable: false };
      }
      const pct = j.rank_pct === null ? "" : `，分位 ${j.rank_pct}%`;
      return {
        text: `${j.readable}\n每千窗 ${j.per_1000}‰${pct}\n命中 ${j.hits} 次 / ${j.windows} 个窗口`,
        exitCode: 0, measurable: true, per_1000: j.per_1000,
      };
    } catch {
      return { text: raw, exitCode: 0 };
    }
  },
};

function apply(ctx) {
  const tools = ctx.get("tools");
  if (tools === undefined) throw new Error("dsh-mriter 需要 tools 服务");
  if (tools.get(tool.name) === undefined) {
    ctx.effect(() => tools.register(tool));
  }
  if (tools.get(progressionTool.name) === undefined) {
    ctx.effect(() => tools.register(progressionTool));
  }
}

export { apply, inject, name, tool, progressionTool, advice, resolveEngine };
