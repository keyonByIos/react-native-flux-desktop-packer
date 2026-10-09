// brand.js —— 给「运行时 exe（原 node.exe）」注入应用图标 + 版本字符串。
// 动机：任务管理器里真正吃内存的进程是启动器 spawn 的运行时 exe，它显示的名字/图标取自「该 exe 主模块的文件名 +
// 内嵌版本资源(FileDescription) + 内嵌图标」，与启动器图标、App 内窗口图标都无关。仅改文件名可去掉 “node.exe”
// 字样，但 Win11 分组视图的友好名与图标仍是 Node 的——要彻底换成品牌，须改写该 exe 的资源（rcedit，Electron 同款）。
// 本模块全程优雅降级：未装 rcedit / 无图标 → 跳过注入（改名仍生效），绝不阻断打包。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { warn, ok } = require('./util');

const PKG_ROOT = path.join(__dirname, '..');

/** 把多尺寸 PNG 打包成 .ico（Vista 起图标条目可用 PNG 负载；rcedit/Windows 接受）。 */
function buildIcoFromPngs(pngPaths, outIco) {
  const entries = pngPaths.map((p) => fs.readFileSync(p));
  const dims = entries.map((b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) })); // PNG IHDR
  const n = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type=icon
  header.writeUInt16LE(n, 4);
  const dir = Buffer.alloc(16 * n);
  let offset = 6 + dir.length;
  const parts = [header, dir];
  entries.forEach((buf, i) => {
    const base = i * 16;
    const { w, h } = dims[i];
    dir.writeUInt8(w >= 256 ? 0 : w, base + 0);
    dir.writeUInt8(h >= 256 ? 0 : h, base + 1);
    dir.writeUInt8(0, base + 2); // 颜色数
    dir.writeUInt8(0, base + 3); // 保留
    dir.writeUInt16LE(1, base + 4); // 平面
    dir.writeUInt16LE(32, base + 6); // 位深
    dir.writeUInt32LE(buf.length, base + 8); // 数据大小
    dir.writeUInt32LE(offset, base + 12); // 数据偏移
    offset += buf.length;
    parts.push(buf);
  });
  fs.writeFileSync(outIco, Buffer.concat(parts));
  return outIco;
}

/** 解析 rcedit（消费方或 packer 自身 node_modules 均可）；找不到返回 null。 */
function resolveRcedit(projectRoot) {
  const cand = [projectRoot, PKG_ROOT].filter(Boolean);
  try {
    return require(require.resolve('rcedit', { paths: cand }));
  } catch {
    /* not here */
  }
  try {
    return require('rcedit');
  } catch {
    return null;
  }
}

/** 解析 rcedit 自带的可执行 exe（x64 优先）；找不到返回 null。 */
function resolveRceditBin(projectRoot) {
  const cand = [projectRoot, PKG_ROOT].filter(Boolean);
  let dir = null;
  try {
    dir = path.dirname(require.resolve('rcedit', { paths: cand }));
  } catch {
    try {
      dir = path.dirname(require.resolve('rcedit'));
    } catch {
      return null;
    }
  }
  const binDir = path.join(dir, '..', 'bin');
  const x64 = path.join(binDir, 'rcedit-x64.exe');
  if (fs.existsSync(x64)) return x64;
  const x86 = path.join(binDir, 'rcedit.exe');
  return fs.existsSync(x86) ? x86 : null;
}

/**
 * 就地给 exePath 注入图标 + 版本字符串。直接 spawnSync rcedit 自带 exe 并设硬超时——
 * 规避 rcedit 的 JS 异步包装在本环境下不返回的问题；任何失败均优雅跳过（不抛、不阻断）。
 */
async function brandRuntime(exePath, { projectRoot, iconPngPaths, name, description, version }) {
  const bin = resolveRceditBin(projectRoot);
  if (!bin) {
    warn('未安装可用的 rcedit（在 packer 里 `npm i rcedit`），跳过 exe 图标/描述注入（改名仍生效）');
    return false;
  }
  let ico = null;
  if (Array.isArray(iconPngPaths) && iconPngPaths.length) {
    ico = path.join(path.dirname(exePath), '__brand__.ico');
    try {
      buildIcoFromPngs(iconPngPaths, ico);
    } catch (e) {
      warn(`生成 .ico 失败（仅改版本字符串）：${e.message}`);
      ico = null;
    }
  }
  const args = [exePath];
  const push = (k, v) => {
    if (v != null && v !== '') args.push('--set-version-string', k, String(v));
  };
  // FileDescription 会被 Windows 当作任务栏/Alt-Tab 的「应用友好名」——必须是简短可读名，用 name。
  // description（常为整句产品描述）不适合放这里，否则任务栏会显示一长串文案。
  // 注意：任务管理器分组视图里进程那行的名字正取自 FileDescription，不设则沿用 node.exe 的「Node.js JavaScript Runtime」。
  push('FileDescription', name);
  push('ProductName', name);
  push('OriginalFilename', name + '.exe');
  push('InternalName', name);
  const v = version != null ? String(version).replace(/^v/, '') : '';
  if (/^\d+(\.\d+){0,3}$/.test(v)) {
    args.push('--set-file-version', v, '--set-product-version', v);
  }
  if (ico) args.push('--set-icon', ico);
  try {
    const r = cp.spawnSync(bin, args, { windowsHide: true, encoding: 'utf8', timeout: 60000 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(String(r.stderr || r.stdout || '').trim() || 'exit ' + r.status);
    ok(`exe 已注入品牌：${path.basename(exePath)}${ico ? ' + 图标' : ''}`);
    return true;
  } catch (e) {
    warn(`rcedit 注入失败（忽略）：${(e && e.message) || e}`);
    return false;
  } finally {
    if (ico) {
      try {
        fs.unlinkSync(ico);
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { brandRuntime, buildIcoFromPngs, resolveRcedit, resolveRceditBin };
