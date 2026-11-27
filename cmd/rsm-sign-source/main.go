package main

import (
	"fmt"
	"os"

	"rsm/internal/upgrade"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "用法: rsm-sign-source <源码 ZIP> <发布私钥路径>")
		os.Exit(2)
	}
	if err := upgrade.SignFile(os.Args[1], os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
