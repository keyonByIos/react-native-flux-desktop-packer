// sea.js —— Node SEA「单文件」打包（flux-pack 的 sea 模式）。
// 对外产物 = 单个品牌化 exe（重命名+注入图标的 node.exe，内含全部 JS）。运行期由内嵌 bootstrap
// 把「原生 .node + icudtl.dat + app bundle + assets 资源树」自解压到隐藏目录
// (%LOCALAPPDATA%\<AppName>\run-<stamp>\)，再用 createRequire 正常加载 app —— 磁盘上不再出现
// 可读的 dist/**/*.js 源码树，任务管理器也只看到 <AppName>.exe（无 node.exe 子进程）。
//
// 关键约束（Phase 0 spike 已验证）：
//  1) app bundle 不能当 SEA main：main 作用域的 require 是 embedderRequire，require(.node) 会抛
//     ERR_UNKNOWN_BUILTIN_MODULE。→ main 只放 bootstrap；app 作为 asset 落盘后用 createRequire 加载。
//  2) sea.getRawAsset 返回 ArrayBuffer → 必须 Buffer.from。
//  3) @napi-rs/canvas 认 NAPI_RS_NATIVE_LIBRARY_PATH（绝对路径优先）；自研 rnfd 走 Module._resolveFilename 钩子。
//  4) skia 需 icudtl.dat 与其同目录；demos 经 process.cwd()/assets 取图 → 解压后 chdir 到 run 根。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { step, ok, warn, ensureDir, dirSize, fmtMB } = require('./util');
const { buildAppBundle, resolveEsbuild } = require('./bundle');
const { brandRuntime } = require('./brand');
const { renderIconPngs } = require('./icon');

const PKG_ROOT = path.join(__dirname, '..');

function resolvePostject(projectRoot) {
  const cand = [projectRoot, PKG_ROOT].filter(Boolean);
  try {
    return require(require.resolve('postject', { paths: cand })).inject;
  } catch {
    /* not here */
  }
  try {
    return require('postject').inject;
  } catch {
    return null;
  }
}

// 在若干 node_modules 根里找第一个匹配相对路径的文件
function findFirst(root, relParts) {
  const p = path.join(root, ...relParts);
  return fs.existsSync(p) ? p : null;
}

// 递归列目录内所有文件（相对 base）
function walkFiles(base, rel = '') {
  const out = [];
  const abs = path.join(base, rel);
  let items;
  try {
    items = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const r = rel ? path.join(rel, it.name) : it.name;
    if (it.isDirectory()) out.push(...walkFiles(base, r));
    else if (it.isFile()) out.push(r);
  }
  return out;
}

/**
 * 收集需内嵌为 SEA assets 的原生/数据文件。
 * 通用发现：node_modules 下所有 react-native-flux-desktop* 包根的 *.win32-x64-msvc.node
 * ——覆盖主包 + 各原生扩展分支包（ffi / webview / 未来新增），不再逐包硬编码。
 * @returns {{natives:{base:string,abs:string}[],rnfdBase:string,skia:string,icu:string}}
 */
function locateNatives(projectRoot) {
  const nm = path.join(projectRoot, 'node_modules');
  // @napi-rs/canvas 平台包：命名特殊（skia.node + icudtl.dat 同目录），单独处理
  const canvasPkg = path.join(nm, '@napi-rs', 'canvas-win32-x64-msvc');
  const skia = findFirst(canvasPkg, ['skia.win32-x64-msvc.node']);
  const icu = findFirst(canvasPkg, ['icudtl.dat']);
  // 通用扫 flux 系原生 .node（主包与所有扩展分支包一视同仁）
  const natives = [];
  let dirs = [];
  try { dirs = fs.readdirSync(nm); } catch { dirs = []; }
  for (const d of dirs) {
    if (!d.startsWith('react-native-flux-desktop')) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(nm, d)); } catch { continue; }
    for (const f of files) {
      if (/\.win32-x64-msvc\.node$/.test(f)) natives.push({ base: f, abs: path.join(nm, d, f) });
    }
  }
  const rnfdBase = 'react-native-flux-desktop.win32-x64-msvc.node';
  const miss = [];
  if (!natives.some((n) => n.base === rnfdBase)) miss.push(rnfdBase);
  if (!skia) miss.push('skia.win32-x64-msvc.node');
  if (!icu) miss.push('icudtl.dat');
  if (miss.length) throw new Error(`未找到原生依赖：${miss.join(', ')}\n（sea 模式需在项目 node_modules 里存在这些 .node/dat）`);
  return { natives, rnfdBase, skia, icu };
}

// 判定一个包目录内（递归）是否存在 .node。不递归进嵌套 node_modules（其依赖作为顶层包单独处理）。
function pkgHasNodeFile(dir, depth = 0) {
  if (depth > 8) return false;
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const it of items) {
    if (it.name === 'node_modules') continue;
    const a = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (pkgHasNodeFile(a, depth + 1)) return true;
    } else if (/\.node$/.test(it.name)) {
      return true;
    }
  }
  return false;
}

// 列出 node_modules 下所有包（含 @scope/*），返回 [{name, absDir}]。
function listInstalledPackages(nm) {
  const out = [];
  let top;
  try {
    top = fs.readdirSync(nm, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of top) {
    if (!it.isDirectory() || it.name.startsWith('.')) continue;
    const abs = path.join(nm, it.name);
    if (it.name.startsWith('@')) {
      let subs;
      try {
        subs = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        subs = [];
      }
      for (const s of subs) {
        if (s.isDirectory() && fs.existsSync(path.join(abs, s.name, 'package.json'))) {
          out.push({ name: it.name + '/' + s.name, absDir: path.join(abs, s.name) });
        }
      }
    } else if (fs.existsSync(path.join(abs, 'package.json'))) {
      out.push({ name: it.name, absDir: abs });
    }
  }
  return out;
}

/**
 * 收集需在 sea 下「整包原样落盘」的第三方原生包（node-pty / 未来 mysql/redis/better-sqlite3…）。
 * 自动扫描 node_modules 下含 .node 的包 + cfg.nativePackages 强制纳入，剔 cfg.skipNative；
 * 已特殊处理的 rnfd 系与 @napi-rs/canvas 不走本通道。再沿 runtime dependencies 求闭包，
 * 确保被外置包的纯 JS 依赖也在磁盘上可解析。
 * @returns {{name:string, absDir:string, native:boolean}[]} native=true 者需标为 esbuild external
 */
function collectNativePackages(projectRoot, cfg) {
  const nm = path.join(projectRoot, 'node_modules');
  const extra = (cfg && Array.isArray(cfg.nativePackages) && cfg.nativePackages) || [];
  const skip = new Set((cfg && Array.isArray(cfg.skipNative) && cfg.skipNative) || []);
  const isSpecial = (name) =>
    name.startsWith('react-native-flux-desktop') || name === '@napi-rs/canvas' || name.startsWith('@napi-rs/canvas-');
  // @types/* 为纯 TypeScript 声明包：运行时无 require，闭包不该把它拉进来（且个别 .d.ts 内嵌 SEA fuse 串会污染 blob）
  const isTypeOnly = (name) => name.startsWith('@types/');

  const all = listInstalledPackages(nm);
  const byName = new Map(all.map((p) => [p.name, p]));

  // 1) 命中的原生包（自动扫描 或 显式纳入）
  const nativeNames = new Set();
  for (const p of all) {
    if (isSpecial(p.name) || isTypeOnly(p.name) || skip.has(p.name)) continue;
    if (extra.includes(p.name) || pkgHasNodeFile(p.absDir)) nativeNames.add(p.name);
  }
  // 显式纳入但 node_modules 里找不到的 → 告警（配置错误早暴露）
  for (const e of extra) {
    if (!byName.has(e)) warn(`nativePackages 声明的包不在 node_modules：${e}（已忽略）`);
  }

  // 2) 沿 runtime deps 求闭包（仅纳入顶层能解析到的）
  const closure = new Map(); // name -> {name, absDir, native}
  const queue = [];
  for (const n of nativeNames) {
    const p = byName.get(n);
    if (p) {
      closure.set(n, { name: n, absDir: p.absDir, native: true });
      queue.push(n);
    }
  }
  while (queue.length) {
    const name = queue.shift();
    const p = byName.get(name);
    if (!p) continue;
    let deps = [];
    try {
      deps = Object.keys(JSON.parse(fs.readFileSync(path.join(p.absDir, 'package.json'), 'utf8')).dependencies || {});
    } catch {
      deps = [];
    }
    for (const d of deps) {
      if (isSpecial(d) || isTypeOnly(d) || skip.has(d) || closure.has(d)) continue;
      const dp = byName.get(d);
      if (dp) {
        closure.set(d, { name: d, absDir: dp.absDir, native: false });
        queue.push(d);
      }
    }
  }
  return [...closure.values()];
}

/** 第三方原生包落盘时的逐文件裁剪：只留 win32-x64 二进制 + 运行时 JS，剔除其它平台与非运行时文件。 */
function nativeAssetFilter(relIn) {
  const rel = '/' + relIn.split(path.sep).join('/');
  const base = rel.split('/').pop();
  // 声明文件运行时无用（纯类型），一律剔除——既瘦身，又避免个别 .d.ts 内嵌串（如 @types/node/sea.d.ts 的 SEA fuse）污染 blob
  if (/\.d\.ts$/.test(base)) return false;
  // 其它平台原生产物（win32-x64 之外）一律丢弃
  const pm = /\/prebuilds\/([^/]+)\//.exec(rel);
  if (pm && pm[1] !== 'win32-x64') return false;
  if (/\/prebuilds\/(darwin|linux|freebsd|android|sunos|aix|win32-arm64|win32-ia32)\b/.test(rel)) return false;
  if (base && /-(darwin|linux|freebsd|android)-(x64|arm64|ia32|arm-eabi|arm64-v8a)/.test(base)) return false;
  if (base && /-win32-(arm64|ia32)/.test(base)) return false;
  // 明确的构建/非运行时目录（不含 src：某些包 main 指向 src）
  if (/\/(deps|test|tests|examples|example|\.github|typings)\//.test(rel)) return false;
  if (/\/third_party\//.test(rel)) return false;
  // 非运行时扩展
  if (/\.(pdb|map|cc|cpp|c|h|hpp|ts|tsx|md|yml|yaml|gyp|gypi|editorconfig)$/.test(base)) return false;
  if (/\.(test|spec)\.js$/.test(base)) return false;
  if (base === 'binding.gyp') return false;
  return true;
}


// 生成 bootstrap.cjs 源码（SEA main）。manifest 以 JSON 字面量注入。
function makeBootstrap(manifest) {
  return `// 自动生成：react-native-flux-desktop-packer sea bootstrap（请勿手改）
const sea = require('node:sea');
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');
const MANIFEST = ${JSON.stringify(manifest)};
const get = (k) => { const a = sea.getRawAsset(k); return a ? Buffer.from(a) : null; };
const APPDIR = process.env.FLUX_SEA_APP || MANIFEST.appName;
const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), APPDIR, 'run-' + MANIFEST.stamp);
fs.mkdirSync(dir, { recursive: true });

// 1) 原生 + 资源树：按 stamp 幂等自解压
const marker = path.join(dir, '.extracted');
if (!fs.existsSync(marker)) {
  for (const r of MANIFEST.resources) {
    const buf = get(r.key);
    if (!buf || !buf.length) continue;
    const target = path.join(dir, r.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
  }
  fs.writeFileSync(marker, MANIFEST.stamp);
}

// 2) app bundle：单个不透明 blob，仅在内容变化时重写
const appPath = path.join(dir, 'app.cjs');
const appBuf = get(MANIFEST.appKey);
const appMarker = path.join(dir, '.app');
const sig = appBuf.length + ':' + MANIFEST.stamp;
if (!fs.existsSync(appMarker) || fs.readFileSync(appMarker).toString() !== sig) {
  fs.writeFileSync(appPath, appBuf);
  fs.writeFileSync(appMarker, sig);
}

// 3) @napi-rs/canvas：绝对路径直指解压后的 skia（最高优先级）
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path.join(dir, MANIFEST.skiaRel);

// 4) 自研原生（主包 + 各扩展分支包 ffi/webview/…）：相对 .node 与 bare 平台包名一律重定向到 dir。
//    通用规则，新增扩展包无需改此处——只要它的 .node 被 locateNatives 收集进 MANIFEST.natives。
const NATIVE_LIST = MANIFEST.natives || [];
const NATIVE_SET = new Set(NATIVE_LIST);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request) {
  if (typeof request === 'string') {
    for (let i = 0; i < NATIVE_LIST.length; i++) {
      if (request.indexOf(NATIVE_LIST[i]) >= 0) return path.join(dir, NATIVE_LIST[i]);
    }
    const m = /^(react-native-flux-desktop(?:-[a-z0-9]+)*?)-win32-x64-msvc$/.exec(request);
    if (m) {
      const file = m[1] + '.win32-x64-msvc.node';
      if (NATIVE_SET.has(file)) return path.join(dir, file);
    }
  }
  return origResolve.apply(this, arguments);
};

// 5) 数据/日志隔离 + cwd（demos 经 process.cwd()/assets 取图）
process.env.FLUX_PACKAGED = '1';
if (MANIFEST.appDirEnv) process.env.FLUX_APP_DIR = MANIFEST.appDirEnv;
try { process.chdir(dir); } catch (e) {}

// 6) 用 createRequire 正常加载 app（普通 require，绕开 embedderRequire）
//    GUI 子系统无控制台：启动期任何抛错（如可选原生 .node 加载失败）都会静默闪退，
//    故兜底把堆栈写到 LOCALAPPDATA 下 APPDIR 的 startup-error.log，便于诊断“双击打不开”。
try {
  Module.createRequire(path.join(dir, 'boot.js'))(appPath);
} catch (err) {
  try {
    const errLog = path.join(process.env.LOCALAPPDATA || os.tmpdir(), APPDIR, 'startup-error.log');
    fs.mkdirSync(path.dirname(errLog), { recursive: true });
    fs.writeFileSync(errLog, '[' + new Date().toISOString() + '] stamp=' + MANIFEST.stamp + '\\n' + ((err && err.stack) || err) + '\\n', 'utf8');
  } catch (e2) {}
  throw err;
}
`;
}

// 把 PE 子系统由控制台(3)改为 GUI(2)：node.exe 是控制台子系统，双击会闪一个黑框。
// 启动器旧路靠 go 的 -H windowsgui 隐框；SEA 无启动器，故直接改 exe 的 OptionalHeader.Subsystem。
// PE 头(=e_lfanew) 后：4 字节签名 + 20 字节 COFF File Header + Optional Header；Subsystem 在 optional
// header 偏移 68（PE32/PE32+ 同）→ 绝对 peOff + 4 + 20 + 68 = peOff + 92。
function toGuiSubsystem(exePath) {
  try {
    const fd = fs.openSync(exePath, 'r+');
    const mz = Buffer.alloc(2);
    fs.readSync(fd, mz, 0, 2, 0);
    if (mz.toString('latin1') !== 'MZ') { fs.closeSync(fd); return false; }
    const ptr = Buffer.alloc(4);
    fs.readSync(fd, ptr, 0, 4, 0x3c);
    const peOff = ptr.readUInt32LE(0);
    const sig = Buffer.alloc(4);
    fs.readSync(fd, sig, 0, 4, peOff);
    if (sig.toString('latin1') !== 'PE\0\0') { fs.closeSync(fd); return false; }
    const subOff = peOff + 4 + 20 + 68;
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, subOff);
    const cur = buf.readUInt16LE(0);
    let done = false;
    if (cur === 3) { // IMAGE_SUBSYSTEM_WINDOWS_CUI -> GUI
      buf.writeUInt16LE(2, 0);
      fs.writeSync(fd, buf, 0, 2, subOff);
      done = true;
    }
    fs.closeSync(fd);
    return done;
  } catch (e) {
    warn(`GUI 子系统切换失败（忽略，仍会有控制台窗口）：${e.message}`);
    return false;
  }
}

/**
 * 执行 sea 模式打包。
 * @param {object} a { projectRoot, cfg, work, outAbs, exeBase, fileBase, entryAbs, assetsDirRel }
 * @returns {Promise<string>} 产物 exe 路径
 */
async function packSea(a) {
  const { projectRoot, cfg, work, outAbs, fileBase, entryAbs } = a;
  if (!resolveEsbuild(projectRoot)) throw new Error('sea 模式需要 esbuild：在 packer 目录 `npm i esbuild postject`');
  const postject = resolvePostject(projectRoot);
  if (!postject) throw new Error('sea 模式需要 postject：在 packer 目录 `npm i esbuild postject`');

  const seaDir = path.join(work, 'sea');
  ensureDir(seaDir);

  // 第三方原生包（node-pty 等）：须在 bundle 前算出，以便把它们的 JS 标为 external（不内联），
  // 并在下面作为整包 assets 落盘。collectNativePackages 只依赖 node_modules，与 bundle 无耦合。
  const nativePkgs = collectNativePackages(projectRoot, cfg);
  const nativeExternals = nativePkgs.filter((p) => p.native).map((p) => p.name);
  if (nativeExternals.length) ok(`第三方原生包（external + 整包落盘）：${nativeExternals.join(', ')}`);

  // ---- 1) bundle app ----
  step('[s1/4] esbuild 打包应用为单 bundle');
  const bundle = path.join(seaDir, 'app.cjs');
  const r = await buildAppBundle({ projectRoot, entryAbs, outfile: bundle, extraExternals: nativeExternals });
  ok(`app bundle：${fmtMB(r.size)}（全部 JS 已内联，无 dist 源码树）`);

  // ---- 2) 收集 assets（原生 + 数据 + 资源树）+ stamp ----
  step('[s2/4] 收集原生/资源并生成 bootstrap');
  const nat = locateNatives(projectRoot);
  const resources = [];
  const assetsMap = {};
  let idx = 0;
  const addRes = (key, rel, abs) => {
    resources.push({ key, rel });
    assetsMap[key] = abs;
  };
  // 通用内嵌所有 flux 原生 .node（主包 + ffi + webview + 未来扩展），按文件名落盘到 dir 根
  for (const n of nat.natives) addRes('nat' + idx++, n.base, n.abs);
  ok(`flux 原生绑定：${nat.natives.map((n) => n.base).join(', ')}`);
  addRes('skia', 'skia.win32-x64-msvc.node', nat.skia);
  addRes('icu', 'icudtl.dat', nat.icu);
  // 目标原生库（app.json.pack.nativeLibs / app.nativeLibs）：按相对路径内嵌，运行期 ffi.open(相对) 命中 cwd。
  const nativeLibs = Array.isArray(cfg.nativeLibs) ? cfg.nativeLibs : [];
  let nlCount = 0;
  for (const rel of nativeLibs) {
    const abs = path.join(projectRoot, rel);
    if (!fs.existsSync(abs)) {
      warn(`nativeLibs 跳过（不存在）：${rel}`);
      continue;
    }
    addRes('nl' + idx++, rel.split('/').join(path.sep), abs);
    nlCount++;
  }
  if (nlCount) ok(`目标原生库随包：${nlCount} 个`);

  // 第三方原生包整包落盘：把闭包内每个包目录（经平台/非运行时裁剪）以 node_modules/<name>/... 相对路径
  // 内嵌为 assets，运行期解压到 <run-dir>/node_modules/ → createRequire 天然解析，其相对 .node 与兄弟 DLL 自洽。
  const shippedNativeFiles = [];
  const shippedNodeByPkg = new Map();
  for (const p of nativePkgs) {
    let count = 0;
    let nodeCount = 0;
    for (const rel of walkFiles(p.absDir)) {
      const relFull = path.join('node_modules', p.name, rel);
      if (!nativeAssetFilter(relFull)) continue;
      const absFile = path.join(p.absDir, rel);
      addRes('np' + idx++, relFull, absFile);
      shippedNativeFiles.push(absFile);
      count++;
      if (/\.node$/.test(rel)) nodeCount++;
    }
    shippedNodeByPkg.set(p.name, nodeCount);
    ok(`第三方原生包落盘：node_modules/${p.name}（${count} 文件${p.native ? '' : '，JS 依赖'}）`);
  }
  // 验证守卫：仅当包源码内确有 .node（真原生包）却被裁剪到无一个 .node 落盘时，才告警（防「外置了却没落盘」）。
  // 白名单强制外置的纯 JS 包（sequelize/mysql2 等本就无 .node）属正常，不误报。
  for (const p of nativePkgs) {
    if (p.native && !shippedNodeByPkg.get(p.name) && pkgHasNodeFile(p.absDir)) {
      warn(`第三方原生包 ${p.name} 已标 external，但裁剪后无 .node 落盘——运行期可能加载失败（检查其 .node 是否放在被裁剪的目录）`);
    }
  }

  // app.json：应用运行时从 cwd 读它取 name/description/version/icon（如 App.tsx 里
  // readFileSync(process.cwd()/app.json)）。sea 下 cwd=解压目录，故须把 app.json 也展到根，
  // 否则读不到会回退成默认 name:'App'（窗口标题/托盘 tooltip 都变 'App'）。
  const appJsonAbs = path.join(projectRoot, 'app.json');
  if (fs.existsSync(appJsonAbs)) addRes('appjson', 'app.json', appJsonAbs);
  else warn('未找到 app.json，运行时窗口标题等将回退默认（name:App）');

  const assetsBase = path.join(projectRoot, a.assetsDirRel || 'assets');
  if (fs.existsSync(assetsBase)) {
    for (const rel of walkFiles(assetsBase)) {
      const key = 'a' + idx++;
      addRes(key, path.join(a.assetsDirRel || 'assets', rel), path.join(assetsBase, rel));
    }
    ok(`资源文件：${idx} 个（来自 ${a.assetsDirRel || 'assets'}/）`);
  } else {
    warn(`无 ${a.assetsDirRel || 'assets'} 目录，跳过资源内嵌`);
  }

  // stamp：内容变化才重解压（含 app.json，改名字/描述也能刷新）
  const ajSig = fs.existsSync(appJsonAbs) ? (() => { const s = fs.statSync(appJsonAbs); return s.size + ':' + Math.round(s.mtimeMs); })() : 'none';
  const nativeFiles = nat.natives.map((n) => n.abs)
    .concat([nat.skia, nat.icu])
    .concat(nativeLibs.map((r) => path.join(projectRoot, r)).filter((p) => fs.existsSync(p)))
    .concat(shippedNativeFiles);
  const sigSrc = nativeFiles.map((p) => { const s = fs.statSync(p); return s.size + ':' + Math.round(s.mtimeMs); }).join('|') + '|' + ajSig + '|' + r.size;
  const stamp = crypto.createHash('md5').update(sigSrc).digest('hex').slice(0, 12);

  const appDirEnv = cfg.safeAppName || 'Flux';
  const manifest = {
    stamp,
    appName: appDirEnv,
    appDirEnv,
    appKey: 'app',
    skiaRel: 'skia.win32-x64-msvc.node',
    natives: nat.natives.map((n) => n.base),
    resources,
  };
  const bootstrapPath = path.join(seaDir, 'bootstrap.cjs');
  fs.writeFileSync(bootstrapPath, makeBootstrap(manifest), 'utf8');
  assetsMap[manifest.appKey] = bundle; // app 作为 asset

  // ---- 3) 生成 blob ----
  step('[s3/4] 生成 SEA blob');
  const blob = path.join(seaDir, 'sea.blob');
  const config = { main: bootstrapPath, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, assets: assetsMap };
  const cfgPath = path.join(seaDir, 'sea-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
  execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit', cwd: seaDir });
  ok(`blob：${fmtMB(fs.statSync(blob).size)}（含 JS + ${Object.keys(assetsMap).length} 项内嵌资产）`);

  // ---- 4) exe：品牌 → 注入 → GUI 子系统 ----
  // 顺序要点：rcedit 在「已注入 SEA blob 的大 exe」上会卡死（实测普通 node.exe 副本仅数百毫秒），
  // 故先在纯净的 node.exe 副本上写图标/版本资源，再 postject 注入 SEA 负载，最后补 GUI 子系统字节。
  step('[s4/4] 组装 exe（品牌 → SEA 注入 → GUI 子系统）');
  ensureDir(outAbs);
  const finalExe = path.join(outAbs, fileBase + '.exe');
  const exe = path.join(seaDir, fileBase + '.exe');
  if (fs.existsSync(exe)) fs.unlinkSync(exe);
  fs.copyFileSync(process.execPath, exe);

  // 4a) 品牌（图标 + FileDescription）——在 postject 之前，失败仅告警不阻断。
  try {
    const gen = await renderIconPngs({ projectRoot, iconRel: cfg.icon, outDir: path.join(seaDir, 'png') });
    await brandRuntime(exe, {
      projectRoot,
      iconPngPaths: gen ? gen.abs : [],
      name: cfg.name,
      description: cfg.description,
      version: cfg.version,
    });
  } catch (e) {
    if (e && e.brandFatal) throw e; // FileDescription 回读不达标 → 硬失败，不静默出货
    warn(`品牌注入跳过（不影响运行）：${e.message}`);
  }

  // 4b) 注入 SEA 负载（rcedit 已改写资源段，postject 追加 NODE_SEA_BLOB 节，二者共存）。
  await postject(exe, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    macFailsafe: false,
    kind: 'node-sea',
  });
  ok(`已注入 SEA 负载 → ${path.basename(exe)}`);

  // 4c) GUI 子系统补丁（双击不弹控制台窗口）——须在 postject 之后，避免注入回写覆盖字节补丁。
  if (toGuiSubsystem(exe)) ok('已切为 GUI 子系统（双击不弹控制台窗口）');
  fs.copyFileSync(exe, finalExe);
  ok(`产物：${finalExe}（${fmtMB(fs.statSync(finalExe).size)}）`);
  return finalExe;
}

module.exports = { packSea, makeBootstrap, locateNatives, walkFiles, collectNativePackages, nativeAssetFilter };
