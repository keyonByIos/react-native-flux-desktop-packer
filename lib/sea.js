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
 * @returns {{rnfd:string,skia:string,icu:string}} 绝对路径
 */
function locateNatives(projectRoot) {
  const roots = [path.join(projectRoot, 'node_modules')];
  const pick = (rel) => {
    for (const r of roots) {
      const f = findFirst(r, rel);
      if (f) return f;
    }
    // 兜底：全局扫 node_modules（同名 .node 可能嵌在 pkg 副本里）
    return null;
  };
  const rnfd = pick(['react-native-flux-desktop', 'react-native-flux-desktop.win32-x64-msvc.node']);
  const skia = pick(['@napi-rs', 'canvas-win32-x64-msvc', 'skia.win32-x64-msvc.node']);
  const icu = pick(['@napi-rs', 'canvas-win32-x64-msvc', 'icudtl.dat']);
  const miss = [];
  if (!rnfd) miss.push('react-native-flux-desktop.win32-x64-msvc.node');
  if (!skia) miss.push('skia.win32-x64-msvc.node');
  if (!icu) miss.push('icudtl.dat');
  if (miss.length) throw new Error(`未找到原生依赖：${miss.join(', ')}\n（sea 模式需在项目 node_modules 里存在这些 .node/dat）`);
  return { rnfd, skia, icu };
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

// 4) 自研原生：bare/相对 .node 重定向到 dir（全局钩子，对 createRequire 加载的模块同样生效）
const RNFD = 'react-native-flux-desktop.win32-x64-msvc.node';
const RNFD_ABS = path.join(dir, RNFD);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request) {
  if (typeof request === 'string') {
    if (request === 'react-native-flux-desktop-win32-x64-msvc') return RNFD_ABS;
    if (request.indexOf(RNFD) >= 0) return RNFD_ABS;
  }
  return origResolve.apply(this, arguments);
};

// 5) 数据/日志隔离 + cwd（demos 经 process.cwd()/assets 取图）
process.env.FLUX_PACKAGED = '1';
if (MANIFEST.appDirEnv) process.env.FLUX_APP_DIR = MANIFEST.appDirEnv;
try { process.chdir(dir); } catch (e) {}

// 6) 用 createRequire 正常加载 app（普通 require，绕开 embedderRequire）
Module.createRequire(path.join(dir, 'boot.js'))(appPath);
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

  // ---- 1) bundle app ----
  step('[s1/4] esbuild 打包应用为单 bundle');
  const bundle = path.join(seaDir, 'app.cjs');
  const r = await buildAppBundle({ projectRoot, entryAbs, outfile: bundle });
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
  addRes('rnfd', 'react-native-flux-desktop.win32-x64-msvc.node', nat.rnfd);
  addRes('skia', 'skia.win32-x64-msvc.node', nat.skia);
  addRes('icu', 'icudtl.dat', nat.icu);

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
  const sigSrc = [nat.rnfd, nat.skia, nat.icu].map((p) => { const s = fs.statSync(p); return s.size + ':' + Math.round(s.mtimeMs); }).join('|') + '|' + ajSig + '|' + r.size;
  const stamp = crypto.createHash('md5').update(sigSrc).digest('hex').slice(0, 12);

  const appDirEnv = cfg.safeAppName || 'Flux';
  const manifest = {
    stamp,
    appName: appDirEnv,
    appDirEnv,
    appKey: 'app',
    skiaRel: 'skia.win32-x64-msvc.node',
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

module.exports = { packSea, makeBootstrap, locateNatives, walkFiles };
