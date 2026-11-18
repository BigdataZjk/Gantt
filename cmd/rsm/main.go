package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"rsm/internal/server"
	"rsm/internal/store"
	webassets "rsm/web"
)

var version = "0.1.3-dev"

type config struct {
	Addr string `json:"addr"`
}

func main() {
	if e := run(); e != nil {
		slog.Error("RSM stopped", "error", e.Error())
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "version") {
		fmt.Println(version)
		return nil
	}
	command := "serve"
	args := os.Args[1:]
	if len(args) > 0 && len(args[0]) > 0 && args[0][0] != '-' {
		command = args[0]
		args = args[1:]
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	userHome, _ := os.UserHomeDir()
	defaultHome := os.Getenv("RSM_HOME")
	if defaultHome == "" {
		defaultHome = filepath.Join(userHome, "RSM")
	}
	home := flags.String("home", defaultHome, "RSM 运行资料目录")
	addr := flags.String("addr", os.Getenv("RSM_ADDR"), "监听地址，默认0.0.0.0:1111")
	output := flags.String("output", "", "备份输出路径")
	input := flags.String("input", "", "备份输入路径")
	if e := flags.Parse(args); e != nil {
		return e
	}
	if flags.NArg() != 0 {
		return errors.New("无法识别额外参数")
	}
	absolute, e := filepath.Abs(*home)
	if e != nil {
		return e
	}
	*home = absolute
	switch command {
	case "verify-backup":
		if *input == "" {
			return errors.New("需要 --input 备份文件")
		}
		m, e := store.VerifyBackup(context.Background(), *input)
		if e != nil {
			return e
		}
		return json.NewEncoder(os.Stdout).Encode(m)
	case "restore":
		if *input == "" {
			return errors.New("需要 --input 备份文件")
		}
		unlock, e := store.Lock(*home)
		if e != nil {
			return e
		}
		defer unlock()
		return store.RestoreBackup(context.Background(), *home, *input, version)
	case "backup":
		if *output == "" {
			return errors.New("需要 --output 备份路径")
		}
		if _, e = os.Stat(filepath.Join(*home, "data", "rsm.db")); e != nil {
			return errors.New("尚无可备份的数据库")
		}
		db, e := store.Open(*home)
		if e != nil {
			return e
		}
		defer db.Close()
		m, e := db.Backup(context.Background(), *output, version)
		if e != nil {
			return e
		}
		return json.NewEncoder(os.Stdout).Encode(m)
	case "serve":
		return serve(*home, *addr)
	default:
		return fmt.Errorf("未知命令：%s", command)
	}
}
func serve(home, addr string) error {
	unlock, e := store.Lock(home)
	if e != nil {
		return e
	}
	defer unlock()
	cfg := config{Addr: "0.0.0.0:1111"}
	path := filepath.Join(home, "config.json")
	existing := false
	if b, e := os.ReadFile(path); e == nil {
		existing = true
		if e = json.Unmarshal(b, &cfg); e != nil {
			return errors.New("config.json 无效")
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	if addr != "" {
		cfg.Addr = addr
	}
	if cfg.Addr == "" {
		cfg.Addr = "0.0.0.0:1111"
	}
	if _, _, e = net.SplitHostPort(cfg.Addr); e != nil {
		return errors.New("监听地址须为IP:端口格式")
	}
	listener, e := net.Listen("tcp", cfg.Addr)
	if e != nil {
		return fmt.Errorf("无法监听 %s：%w", cfg.Addr, e)
	}
	defer listener.Close()
	db, e := store.Open(home)
	if e != nil {
		return e
	}
	defer db.Close()
	if !existing {
		b, _ := json.MarshalIndent(cfg, "", "  ")
		if e = os.WriteFile(path, b, 0600); e != nil {
			return e
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	app := server.New(db, webassets.FS(), version)
	maintenanceDone := make(chan struct{})
	go func() {
		defer close(maintenanceDone)
		app.RunLogMaintenance(ctx)
	}()
	defer func() { stop(); <-maintenanceDone }()
	srv := &http.Server{Handler: app, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 75 * time.Second, MaxHeaderBytes: 1 << 20, BaseContext: func(net.Listener) context.Context { return ctx }}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(listener) }()
	slog.Info("RSM ready", "version", version, "address", listener.Addr().String(), "home", home)
	select {
	case e := <-done:
		if errors.Is(e, http.ErrServerClosed) {
			return nil
		}
		return e
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutdown)
	}
}
