package main

import (
	"context"

	_ "github.com/rclone/rclone/cmd/all"
	"github.com/rclone/rclone/fs"
)

func init() {
	// Disable interactive prompts and password asking globally for in-process librclone FFI
	fs.GetConfig(context.Background()).AskPassword = false
	fs.GetConfig(context.Background()).AutoConfirm = true
}
