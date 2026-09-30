// 通用自解压启动器（由 react-native-flux-desktop-packer 构建时注入参数）。
// 把整个运行目录（node.exe + dist + 原生插件 + node_modules）作为 payload.zip 内嵌进本 exe。
// 双击时解压到 %LOCALAPPDATA%\<AppName>\app-<hash>\（按内容哈希缓存，命中即秒开），
// 再从缓存目录用 node.exe 跑入口 JS。对外只需这一个 exe，可放任意位置、免装 Node。
//
// 构建期经 -ldflags "-X main.Entry=... -X main.AppName=..." 注入：
//
//	Entry   缓存根下的相对入口 JS 路径（如 dist\Gallery.js）
//	AppName 应用名（用于缓存目录 %LOCALAPPDATA%\<AppName>\）
//	ExeName 出错弹框标题（一般 = 产物 exe 名）
//
// GUI 子系统编译（-H windowsgui），HideWindow 隐藏 node 控制台；出错弹框提示。
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// payload 由构建期 go:embed 注入的 payload.zip（真实负载在 launcher-build 目录，
// launcher/ 下同名为满足 go:embed 静态检查的占位空 zip，构建时不会被使用）。
//
//go:embed payload.zip
var payload []byte

// 构建期注入的默认值；留空则回落到通用默认。
var (
	Entry   = "dist\\main.js"
	AppName = "Flux"
	ExeName = "Flux"
)

var (
	user32  = syscall.NewLazyDLL("user32.dll")
	msgBoxW = user32.NewProc("MessageBoxW")
)

func showFatal(title, msg string) {
	tp, _ := syscall.UTF16PtrFromString(title)
	mp, _ := syscall.UTF16PtrFromString(msg)
	msgBoxW.Call(0, uintptr(unsafe.Pointer(mp)), uintptr(unsafe.Pointer(tp)), 0x10) // MB_ICONERROR
	os.Exit(1)
}

// 按内嵌负载哈希定缓存目录，内容变了自动重解
func cacheDir() (string, error) {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.Getenv("TEMP")
	}
	if base == "" {
		h, _ := os.UserHomeDir()
		base = filepath.Join(h, ".cache")
	}
	sum := sha256.Sum256(payload)
	tag := hex.EncodeToString(sum[:])[:12]
	app := sanitize(AppName)
	if app == "" {
		app = "Flux"
	}
	return filepath.Join(base, app, "app-"+tag), nil
}

// 去掉文件系统/注册表不友好的字符，用于目录名
func sanitize(s string) string {
	repl := strings.NewReplacer(" ", "-", "/", "-", "\\", "-", ":", "-", "*", "-", "?-", "\"-", "<", "-", ">", "-", "|", "-")
	return strings.TrimSpace(repl.Replace(s))
}

// 解压到临时目录再原子 rename，避免半解压损坏；含 zip-slip 防护
func extractTo(dest string) error {
	zr, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return err
	}
	tmp := dest + ".tmp"
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	prefix := filepath.Clean(tmp) + string(os.PathSeparator)
	for _, f := range zr.File {
		target := filepath.Join(tmp, f.Name)
		if filepath.Clean(target) != filepath.Clean(tmp) && !strings.HasPrefix(filepath.Clean(target), prefix) {
			return fmt.Errorf("非法压缩包路径: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			_ = os.MkdirAll(target, 0o755)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			rc.Close()
			return err
		}
		_, cpErr := io.Copy(out, rc)
		out.Close()
		rc.Close()
		if cpErr != nil {
			return cpErr
		}
	}
	_ = os.RemoveAll(dest)
	return os.Rename(tmp, dest)
}

func main() {
	if len(payload) == 0 {
		showFatal(ExeName, "内嵌负载为空（构建未打包 payload.zip）")
	}
	dest, err := cacheDir()
	if err != nil {
		showFatal(ExeName, "无法确定缓存目录:\n"+err.Error())
	}
	ready := filepath.Join(dest, ".ready")
	if _, err := os.Stat(ready); err != nil {
		if err := extractTo(dest); err != nil {
			showFatal(ExeName, "首次解压失败:\n"+err.Error())
		}
		_ = os.WriteFile(ready, []byte("ok"), 0o644)
	}

	node := filepath.Join(dest, "node.exe")
	entry := filepath.Join(dest, Entry)
	if _, err := os.Stat(node); err != nil {
		showFatal(ExeName, "解压后缺少 node.exe:\n"+node)
	}
	if _, err := os.Stat(entry); err != nil {
		showFatal(ExeName, "解压后缺少入口:\n"+entry)
	}

	args := append([]string{entry}, os.Args[1:]...)
	cmd := exec.Command(node, args...)
	cmd.Dir = dest // cwd=缓存根，资源按 process.cwd 相对解析；插件 __dirname 约束天然满足
	// 关键：置 FLUX_PACKAGED=1，让库的 db.ts dataDir() 走 %APPDATA% 分支，
	// 而非 dev 分支去写不存在的 src/。再透传 FLUX_APP_DIR=<AppName>（已 sanitize，与缓存目录同源），
	// 使数据/日志落到按应用隔离的 %APPDATA%\<AppName>\，避免同框架多项目撞车。继承原环境再追加。
	dataAppName := sanitize(AppName)
	if dataAppName == "" {
		dataAppName = "Flux"
	}
	cmd.Env = append(os.Environ(), "FLUX_PACKAGED=1", "FLUX_APP_DIR="+dataAppName)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		showFatal(ExeName, "启动失败:\n"+err.Error())
	}
	_ = cmd.Wait()
}
