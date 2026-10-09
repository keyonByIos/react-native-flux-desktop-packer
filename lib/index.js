// index.js —— react-native-flux-desktop-packer 主流程（Windows）。
// 读 app.json → 组装自包含负载（node.exe + dist + node_modules + assets + app.json）→ 压 payload.zip
// → go-winres 编图标 → go build（go:embed 内嵌负载）产单文件 exe → 落到 app.json.output。
// 前置：本机 Go（缺则回落「便携文件夹 + .cmd」，仍产可运行 app）；图标需 go-winres（缺则默认图标）。
const fs = require('fs');
const path = require('path');
const { step, ok, warn, rmrf, ensureDir, copyTree, dirSize, fmtMB, which, run } = require('./util');
const { loadConfig, safeName } = require('./config');
const { buildIconSyso, renderIconPngs } = require('./icon');
const { brandRuntime } = require('./brand');
const { packSea } = require('./sea');

const PKG_ROOT = path.join(__dirname, '..');
const LAUNCHER_DIR = path.join(PKG_ROOT, 'launcher');

// node_modules 里剔除：非 win32-x64 的 canvas 预编译包 + 可选大二进制（ffmpeg-static，缺失运行时自动降级）
function nodeModulesFilter(abs) {
  const n = abs.split(path.sep).join('/');
  if (/@napi-rs\/canvas-(darwin|linux)-/.test(n)) return false;
  if (/\/@napi-rs\/canvas-(android|freebsd|openbsd|wasm32)-/.test(n)) return false;
  if (/\/ffmpeg-static(\/|$)/.test(n)) return false;
  return true;
}

async function pack(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const keepWork = !!options.keep;
  const cfg = loadConfig(projectRoot);
  const exeBase = safeName(cfg.name) || 'App';
  // 产物文件名带版本后缀；但注入的 AppName/ExeName 仍用无版本 exeBase（缓存目录稳定、错误框标题干净）
  const fileBase = `${exeBase}-${safeName(cfg.version)}`;

  console.log('\x1b[1mreact-native-flux-desktop-packer\x1b[0m');
  console.log(`  项目根：${projectRoot}`);
  console.log(`  应用名：${cfg.name}   版本：${cfg.version}`);
  console.log(`  入口　：${cfg.mainRel}`);
  console.log(`  产物到：${cfg.outputAbs}`);
  console.log(`  模式　：${cfg.packMode}`);

  const work = path.join(projectRoot, '.flux-pack');
  const stage = path.join(work, 'stage');
  const zip = path.join(work, 'payload.zip');
  const buildDir = path.join(work, 'launcher-build');
  rmrf(work);

  // ---- sea 模式：Node SEA 单文件（无 dist 明文树）----
  if (cfg.packMode === 'sea') {
    ensureDir(cfg.outputAbs);
    const entryAbs = path.join(projectRoot, cfg.mainRel);
    let exe;
    try {
      exe = await packSea({ projectRoot, cfg, work, outAbs: cfg.outputAbs, exeBase, fileBase, entryAbs, assetsDirRel: cfg.assetsDirRel });
    } finally {
      if (!keepWork) rmrf(work);
      else warn(`保留工作目录：${work}`);
    }
    console.log('\n\x1b[32m✔ 打包完成（sea 单文件）→\x1b[0m ' + exe);
    return { exe };
  }

  ensureDir(stage);

  // ---- 1) 组装载 ----
  step('[1/5] 组装自包含负载');
  const include = Array.isArray(cfg.appJson.pack) ? cfg.appJson.pack : ['dist', 'node_modules', 'assets', 'package.json', 'app.json'];
  for (const item of include) {
    const src = path.join(projectRoot, item);
    if (!fs.existsSync(src)) {
      warn(`跳过（不存在）：${item}`);
      continue;
    }
    const st = fs.lstatSync(src);
    if (item === 'node_modules') {
      copyTree(src, path.join(stage, item), (abs) => nodeModulesFilter(abs));
    } else if (st.isDirectory()) {
      copyTree(src, path.join(stage, item));
    } else {
      ensureDir(path.dirname(path.join(stage, item)));
      fs.copyFileSync(src, path.join(stage, item));
    }
  }
  // 捆绑当前 node.exe，但以应用名落盘（napi ABI 稳定，跨大版本可加载）。
  // 运行时进程改名 → 任务管理器「详细信息」页的名称列不再显示 node.exe（node 不校验自身文件名，改名照常运行）。
  const runtimeName = exeBase + '.exe';
  fs.copyFileSync(process.execPath, path.join(stage, runtimeName));
  ok(`运行时 exe：${runtimeName}（来自 ${process.execPath}）`);

  // 品牌注入：把应用图标 + FileDescription 写进该运行时 exe 的资源，使任务管理器里真正吃内存的那个进程
  // 显示应用名与自定义图标（友好名/图标取自 exe 内嵌资源，与启动器图标、App 内窗口图标无关）。
  // 依赖 rcedit：未装则优雅跳过（改名仍生效），绝不阻断打包。
  try {
    const gen = await renderIconPngs({ projectRoot, iconRel: cfg.icon, outDir: path.join(work, 'rtpng') });
    await brandRuntime(path.join(stage, runtimeName), {
      projectRoot,
      iconPngPaths: gen ? gen.abs : [],
      name: cfg.name,
      description: cfg.description,
      version: cfg.version,
    });
  } catch (e) {
    warn(`运行时 exe 品牌注入异常（忽略）：${e.message}`);
  }

  // 入口存在性校验（相对 stage 根）
  const entryInStage = path.join(stage, cfg.mainRel);
  if (!fs.existsSync(entryInStage)) {
    rmrf(work);
    throw new Error(`入口 JS 不存在：${cfg.mainRel}\n（请先在项目里编译出 dist，例如 npm run build）`);
  }
  ok(`负载体积：${fmtMB(dirSize(stage))}`);

  // ---- 2) 压 payload.zip ----
  step('[2/5] 压缩负载 payload.zip');
  run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${stage}','${zip}',[System.IO.Compression.CompressionLevel]::Optimal,$false)`,
  ], { stdio: 'ignore' });
  ok(`payload.zip = ${fmtMB(fs.statSync(zip).size)}`);

  // ---- 3) 图标 ----
  step('[3/5] 生成 exe 图标资源');
  let syso = null;
  try {
    syso = await buildIconSyso({
      projectRoot,
      iconRel: cfg.icon,
      outDir: work,
      name: cfg.name,
      version: cfg.version,
      description: cfg.description,
    });
  } catch (e) {
    warn(`图标处理失败（忽略，用默认图标）：${e.message}`);
  }

  // ---- 4) go build ----
  step('[4/5] 编译启动器 exe');
  const goExe = which('go');
  ensureDir(cfg.outputAbs);
  let delivered;
  if (!goExe) {
    warn('未检测到 Go，无法产单文件 exe → 回落「便携文件夹 + .cmd」（同样可直接运行）');
    delivered = emitPortableFolder({ stage, outAbs: cfg.outputAbs, exeBase: fileBase, mainRel: cfg.mainRel, runtimeName });
  } else {
    ensureDir(buildDir);
    fs.copyFileSync(path.join(LAUNCHER_DIR, 'main.go'), path.join(buildDir, 'main.go'));
    fs.copyFileSync(path.join(LAUNCHER_DIR, 'go.mod'), path.join(buildDir, 'go.mod'));
    fs.copyFileSync(zip, path.join(buildDir, 'payload.zip'));
    if (syso) fs.copyFileSync(syso, path.join(buildDir, path.basename(syso)));
    const outExe = path.join(buildDir, fileBase + '.exe');
    // 用生成的 .cmd 显式控制引号：go 的 -ldflags 必须是「单个带引号字符串」，
    // 而 Node 直接 spawn go 会把内层引号拆坏。值均用无空格 ASCII（exeBase / mainRel）。
    const ld = `-H windowsgui -X main.Entry=${cfg.mainRel} -X main.AppName=${exeBase} -X main.ExeName=${exeBase} -X main.Runtime=${runtimeName}`;
    const cmdFile = path.join(buildDir, 'build-launcher.cmd');
    const goLine = `"${goExe}" build -trimpath -ldflags "${ld}" -o "${outExe}" .`;
    fs.writeFileSync(cmdFile, ['@echo off', 'cd /d "' + buildDir + '"', goLine, ''].join('\r\n'), 'utf8');
    const r = require('child_process').spawnSync('cmd.exe', ['/c', cmdFile], { cwd: buildDir, windowsHide: true, encoding: 'utf8' });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0) throw new Error('go build 失败（见上方输出）');
    const finalExe = path.join(cfg.outputAbs, fileBase + '.exe');
    fs.copyFileSync(outExe, finalExe);
    ok(`exe = ${fmtMB(fs.statSync(finalExe).size)}`);
    delivered = finalExe;
  }

  // ---- 5) 收尾 ----
  step('[5/5] 完成');
  if (!keepWork) rmrf(work);
  else warn(`保留工作目录：${work}`);
  console.log('\n\x1b[32m✔ 打包完成 →\x1b[0m ' + delivered);
  return { exe: delivered };
}

// 无 Go 时的回落：把 stage 目录整体搬到 output/<name>/，写 run.cmd（置 FLUX_PACKAGED=1）
function emitPortableFolder({ stage, outAbs, exeBase, mainRel, runtimeName }) {
  const dest = path.join(outAbs, exeBase);
  rmrf(dest);
  copyTree(stage, dest);
  const cmd = [
    '@echo off',
    'cd /d "%~dp0"',
    'set FLUX_PACKAGED=1',
    `"%~dp0${runtimeName}" "%~dp0${mainRel}" %*`,
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(dest, 'run.cmd'), cmd, 'utf8');
  return dest;
}

module.exports = { pack };
