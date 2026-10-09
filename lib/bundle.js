// bundle.js —— 用 esbuild 把应用入口（dist/App.js，纯 CommonJS）连同全部纯 JS 依赖
// 打成单个 minified bundle。原生 addon(.node) 与 yoga wasm 之外的一切都被内联；
// .node / 平台专属包标为 external，交由 SEA bootstrap 落盘后正常 require。
// esbuild 作为 packer 的可选依赖：消费方或 packer 自身 node_modules 均可解析；缺失则抛清晰错误。
const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');

// external 名单：SEA main 作用域外（bootstrap 用 createRequire 加载 bundle）时，
// 这些 require 保持原样，运行时由 bootstrap 的解析钩子/环境重定向到自解压目录。
const EXTERNALS = [
  'node:sea',
  '*.node',
  // 自研库的原生绑定（按平台分包名，运行时只会用到 win32-x64）
  'react-native-flux-desktop-win32-x64-msvc',
  'react-native-flux-desktop-win32-ia32-msvc',
  'react-native-flux-desktop-win32-arm64-msvc',
  'react-native-flux-desktop-darwin-x64',
  'react-native-flux-desktop-darwin-arm64',
  'react-native-flux-desktop-linux-*',
  'react-native-flux-desktop-android-*',
  'react-native-flux-desktop-freebsd-*',
  // @napi-rs/canvas 的平台预编译包（skia .node 由 bootstrap 经 env 指向解压副本）
  '@napi-rs/canvas-win32-x64-msvc',
  '@napi-rs/canvas-win32-x64-gnu',
  '@napi-rs/canvas-win32-arm64-msvc',
  '@napi-rs/canvas-win32-ia32-msvc',
  '@napi-rs/canvas-darwin-x64',
  '@napi-rs/canvas-darwin-arm64',
  '@napi-rs/canvas-linux-x64-gnu',
  '@napi-rs/canvas-linux-x64-musl',
  '@napi-rs/canvas-linux-arm64-gnu',
  '@napi-rs/canvas-linux-arm64-musl',
  '@napi-rs/canvas-android-arm64',
  '@napi-rs/canvas-android-arm-eabi',
  // 可选大二进制：缺失时运行时自动降级（波形），不内联避免体积膨胀/解析失败
  'ffmpeg-static',
];

function resolveEsbuild(projectRoot) {
  const cand = [projectRoot, PKG_ROOT].filter(Boolean);
  try {
    return require(require.resolve('esbuild', { paths: cand }));
  } catch {
    /* not here */
  }
  try {
    return require('esbuild');
  } catch {
    return null;
  }
}

/**
 * 打包入口为单个 CJS bundle。
 * @returns {Promise<{outfile:string,size:number}>}
 */
async function buildAppBundle({ projectRoot, entryAbs, outfile, minify = true, extraExternals = [] }) {
  const esbuild = resolveEsbuild(projectRoot);
  if (!esbuild) {
    throw new Error('未安装 esbuild（sea 模式所需）。在 packer 目录执行：npm i esbuild postject');
  }
  if (!fs.existsSync(entryAbs)) {
    throw new Error(`入口不存在，无法打包：${entryAbs}`);
  }
  await esbuild.build({
    absWorkingDir: projectRoot,
    entryPoints: [entryAbs],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    minify,
    target: 'node20',
    legalComments: 'none',
    logLevel: 'warning',
    outfile,
    external: EXTERNALS.concat(extraExternals),
  });
  return { outfile, size: fs.statSync(outfile).size };
}

module.exports = { buildAppBundle, resolveEsbuild, EXTERNALS };
