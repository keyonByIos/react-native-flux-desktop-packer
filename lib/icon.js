// icon.js —— 把 app.json.icon 指的 PNG 编成 exe 资源（.syso）。
// 流程：@napi-rs/canvas（从消费方 node_modules 解析）缩放多尺寸 → 写 winres/ + winres.json → go-winres make。
// 任一前置缺失（无图标文件 / 无 canvas / 无 go-winres）都优雅降级返回 null，让打包继续（exe 用默认图标）。
const fs = require('fs');
const path = require('path');
const { ensureDir, which, run, warn, ok } = require('./util');
const { fourPart } = require('./config');

async function buildIconSyso({ projectRoot, iconRel, outDir, name, version, description }) {
  if (!iconRel) {
    warn('app.json 未配置 icon，跳过图标（exe 使用默认图标）');
    return null;
  }
  const iconPath = path.isAbsolute(iconRel) ? iconRel : path.join(projectRoot, iconRel);
  if (!fs.existsSync(iconPath)) {
    warn(`图标文件不存在：${iconPath}（跳过图标）`);
    return null;
  }

  // 从消费方项目解析 @napi-rs/canvas（packer 自身不依赖它）
  let canvas;
  try {
    const modPath = require.resolve('@napi-rs/canvas', { paths: [projectRoot] });
    canvas = require(modPath);
  } catch {
    warn('消费方未安装 @napi-rs/canvas，无法缩放图标（跳过图标）');
    return null;
  }

  const goWinres = which(path.join(process.env.USERPROFILE || '', 'go', 'bin', 'go-winres.exe')) || which('go-winres');
  if (!goWinres) {
    warn('未找到 go-winres（go install github.com/tc-hib/go-winres@latest），跳过图标');
    return null;
  }

  ensureDir(outDir);
  const winresDir = path.join(outDir, 'winres');
  ensureDir(winresDir);
  const SIZES = [16, 24, 32, 48, 64, 128, 256];
  const img = await canvas.loadImage(iconPath);
  const files = [];
  for (const s of SIZES) {
    const c = canvas.createCanvas(s, s);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, s, s);
    const fname = `icon-${s}x${s}.png`;
    fs.writeFileSync(path.join(winresDir, fname), c.toBuffer('image/png'));
    files.push(fname);
  }

  const v = fourPart(version);
  const json = {
    RT_GROUP_ICON: { APP: { '0000': files } },
    RT_VERSION: {
      '#1': {
        '0000': {
          fixed: { file_version: v, product_version: v },
          info: {
            '0409': {
              FileDescription: description,
              ProductName: name,
              OriginalFilename: name + '.exe',
              FileVersion: v,
              ProductVersion: v,
              InternalName: name,
            },
          },
        },
      },
    },
  };
  const jsonPath = path.join(winresDir, 'winres.json');
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));

  // go-winres make → 产出 rsrc_windows_amd64.syso 于 outDir
  run(goWinres, ['make', '--in', jsonPath, '--out', path.join(outDir, 'rsrc'), '--arch', 'amd64'], { stdio: 'ignore' });
  const syso = path.join(outDir, 'rsrc_windows_amd64.syso');
  if (!fs.existsSync(syso)) {
    warn('go-winres 未产出 .syso（跳过图标）');
    return null;
  }
  ok(`图标已编入资源：${path.basename(syso)}`);
  return syso;
}

module.exports = { buildIconSyso };
