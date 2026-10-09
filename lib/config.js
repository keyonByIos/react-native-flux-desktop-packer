// config.js —— 读取并规整 app.json（消费方项目根）。缺字段回落内置默认，缺文件直接抛清晰错误。
// app.json 约定字段：
//   name        应用名（窗口标题 / exe 文件名 / 缓存目录名）
//   description 描述（写进 exe 版本资源 FileDescription）
//   version     版本号（写进 exe 版本资源）
//   icon        图标 PNG 路径（相对项目根；缺失则 exe 用默认图标，不阻断打包）
//   output      打包产物目录（相对项目根或绝对；默认 "build"）
//   main        编译后入口 JS（相对项目根；缺省回落 package.json 的 main）
const fs = require('fs');
const path = require('path');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadConfig(projectRoot) {
  const appJsonPath = path.join(projectRoot, 'app.json');
  if (!fs.existsSync(appJsonPath)) {
    throw new Error(`未找到 app.json：${appJsonPath}\n（打包器需要在项目根放一个 app.json，至少含 name 字段）`);
  }
  const app = readJson(appJsonPath);
  if (!app.name || typeof app.name !== 'string') {
    throw new Error('app.json 缺少必填字段 name（应用名）');
  }

  // package.json 的 main 作为入口兜底
  let pkgMain;
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      pkgMain = readJson(pkgPath).main;
    } catch {
      /* ignore */
    }
  }

  const main = app.main || pkgMain;
  if (!main || typeof main !== 'string') {
    throw new Error('无法确定入口 JS：请在 app.json 加 "main"（或在 package.json 写 "main"）');
  }

  const version = typeof app.version === 'string' ? app.version : '0.0.0';
  const output = app.output || 'build';

  // 打包模式：app.pack.mode = "folder"(默认，Go 启动器 + 解压明文 dist) | "sea"(Node SEA 单文件)
  const packObj = app.pack && typeof app.pack === 'object' ? app.pack : {};
  const packMode = packObj.mode === 'sea' ? 'sea' : 'folder';
  // 资源目录（相对项目根），sea 模式内嵌进 exe、运行时解压到 cwd；folder 模式整目录拷贝
  const assetsDirRel = typeof packObj.assets === 'string' ? packObj.assets : 'assets';

  const cfg = {
    projectRoot,
    name: app.name,
    description: typeof app.description === 'string' ? app.description : app.name,
    version,
    icon: typeof app.icon === 'string' ? app.icon : null,
    outputAbs: path.isAbsolute(output) ? output : path.join(projectRoot, output),
    outputRel: output,
    packMode,
    assetsDirRel,
    // 归一化入口为平台分隔（Go 里用 dist\\Gallery.js）
    mainRel: main.split('/').join(path.sep),
    // 数据/缓存目录用的应用名（与启动器 sanitize 同规则：空格/斜杠等转 '-'）
    safeAppName: sanitizeDirName(app.name) || 'Flux',
    appJson: app,
  };

  // 打包前一致性校验（尽早失败，避免装完半个负载才报入口问题）：
  // 入口产物必须存在且非陈旧——曾踩「app.json 指向历史遗留 dist/Gallery.js，文件在但早于源码，打包成功却跑错/旧产物」。
  validateEntry(cfg, projectRoot);

  return cfg;
}

// 入口产物校验：① 存在（不存在=配置错或未编译）；② 非陈旧（产物 mtime 不早于任何源码文件，否则=改了源码没重编）。
// 二者均为硬错，因为一个旧/错的入口正是本次要拦的事故；报错信息直接给出修复动作（重编 + 校正 main）。
function validateEntry(cfg, projectRoot) {
  const entryAbs = path.join(projectRoot, cfg.mainRel);
  if (!fs.existsSync(entryAbs)) {
    throw new Error(
      `入口产物不存在：${cfg.mainRel}\n` +
        `（app.json/package.json 的 main 指向的文件缺失；请先在项目内编译出产物，例如 npm run build，再确认 main 指向当前入口）`
    );
  }
  if (!fs.statSync(entryAbs).isFile()) {
    throw new Error(`入口不是一个文件：${cfg.mainRel}`);
  }
  const entryMtime = fs.statSync(entryAbs).mtimeMs;
  const newest = newestSourceMtime(projectRoot);
  if (newest && newest.mtimeMs > entryMtime) {
    const rel = path.relative(projectRoot, newest.file);
    throw new Error(
      `入口产物疑似陈旧：${cfg.mainRel}（改于 ${new Date(entryMtime).toISOString()}）早于源码 ${rel}（改于 ${new Date(newest.mtimeMs).toISOString()}）。\n` +
        `（产物没重编译，或 main 指向了历史遗留文件；请先 npm run build 重新产出，再核对 app.json 的 main）`
    );
  }
}

// 扫描项目源码（排除 node_modules/dist/output/.flux-pack 等产物与构建目录），返回修改时间最新的源文件。
// 只计 .ts/.tsx（本栈为 TS→JS 管线，dist 由它们编译而来）；不计根级 .js 配置（metro/babel 等），
// 否则打包器自身触碰配置文件会造成假陈旧。
function newestSourceMtime(projectRoot) {
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'output', 'target', 'release', 'assets', '.git', '.flux-pack']);
  const SRC_EXT = new Set(['.ts', '.tsx']);
  let best = null;
  const walk = (dir) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (SKIP_DIRS.has(it.name) || it.name.startsWith('.')) continue;
        walk(abs);
      } else if (SRC_EXT.has(path.extname(it.name))) {
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (!best || st.mtimeMs > best.mtimeMs) best = { file: abs, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(projectRoot);
  return best;
}

// 版本号补成 4 段（winres fixed file_version 需 a.b.c.d）
function fourPart(v) {
  const parts = String(v)
    .replace(/^v/, '')
    .split(/[.\-+]/)
    .filter((s) => /^\d+$/.test(s))
    .map((s) => String(parseInt(s, 10) & 0xffff));
  while (parts.length < 4) parts.push('0');
  return parts.slice(0, 4).join('.');
}

// exe / 目录名净化：去非法字符、空格转 '-'
function safeName(s) {
  return String(s)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .trim();
}

// 数据/缓存目录名净化（对齐 launcher main.go 的 sanitize：空格、/ \ : * ? " < > | 一律转 '-'）
function sanitizeDirName(s) {
  return String(s)
    .replace(/[ /\\:*?"<>|]/g, '-')
    .trim();
}

module.exports = { loadConfig, fourPart, safeName, sanitizeDirName, validateEntry, newestSourceMtime };
