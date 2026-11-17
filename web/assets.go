// Package web 内嵌前端构建产物（web/dist），供 Go 服务以单二进制方式提供页面。
//
// 构建约定：先执行 pnpm build 生成 web/dist，再编译 Go 程序；发行剧本按此顺序处理。
// 开发模式由 Vite 提供页面并代理 /api，不经过本包。
package web

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed dist
var distFS embed.FS

// FS 返回以 web/dist 为根的只读文件系统（index.html 位于根目录）。
// 由 cmd/rsm 传给 internal/server 作为静态资源来源。
func FS() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		// dist 由构建流程保证存在；这里只会在构建产物损坏时触发。
		panic("web: 无法读取内嵌前端资源: " + err.Error())
	}
	return sub
}

// Handler 返回 SPA 静态资源处理器：命中文件则直接返回，未命中回退 index.html。
// 该处理器不处理 /api 或 /healthz，调用方应先注册这些路由。
func Handler() http.Handler {
	root := FS()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" || name == "." {
			name = "index.html"
		}
		if info, err := fs.Stat(root, name); err != nil || info.IsDir() {
			name = "index.html"
		}
		data, err := fs.ReadFile(root, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
	})
}
