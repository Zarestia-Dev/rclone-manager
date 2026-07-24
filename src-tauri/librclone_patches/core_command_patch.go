package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/rclone/rclone/cmd"
	_ "github.com/rclone/rclone/cmd/all"
	"github.com/rclone/rclone/fs/accounting"
	"github.com/rclone/rclone/fs/rc"
)

var coreCmdMu sync.Mutex

func init() {
	rc.Add(rc.Call{
		Path:          "core/command",
		Fn:            rcRunCoreCommand,
		NeedsRequest:  true,
		NeedsResponse: true,
		Title:         "Run a rclone terminal command in-process over FFI.",
		Help:          "Executes rclone CLI commands in-process when running under librclone.",
	})
}

func rcRunCoreCommand(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	command, err := in.GetString("command")
	if err != nil {
		command = ""
	}

	var opt = map[string]string{}
	_ = in.GetStructMissingOK("opt", &opt)

	var arg = []string{}
	_ = in.GetStructMissingOK("arg", &arg)

	var allArgs []string
	if command != "" {
		allArgs = append(allArgs, command)
	}
	allArgs = append(allArgs, arg...)

	for key, value := range opt {
		if len(key) == 1 {
			allArgs = append(allArgs, "-"+key)
		} else {
			allArgs = append(allArgs, "--"+key)
		}
		if value != "" {
			allArgs = append(allArgs, value)
		}
	}

	coreCmdMu.Lock()
	defer coreCmdMu.Unlock()

	accounting.GlobalStats().ResetErrors()

	r, w, pipeErr := os.Pipe()
	var oldStdout, oldStderr *os.File
	if pipeErr == nil {
		oldStdout = os.Stdout
		oldStderr = os.Stderr
		os.Stdout = w
		os.Stderr = w
	}

	cmd.Root.SetArgs(allArgs)

	var execErr error
	var hasError bool

	func() {
		defer func() {
			if rec := recover(); rec != nil {
				recStr := fmt.Sprintf("%v", rec)
				// Intercept os.Exit(0) / exitcode.Success cleanly
				if strings.Contains(recStr, "os.Exit(0)") || strings.Contains(recStr, "exit status 0") {
					hasError = false
					execErr = nil
				} else {
					hasError = true
					execErr = fmt.Errorf("%s", recStr)
				}
			}
		}()
		execErr = cmd.Root.ExecuteContext(ctx)
		if execErr != nil {
			hasError = true
		}
	}()

	var outputStr string
	if pipeErr == nil {
		w.Close()
		os.Stdout = oldStdout
		os.Stderr = oldStderr

		var pipeBuf bytes.Buffer
		_, _ = io.Copy(&pipeBuf, r)
		r.Close()
		outputStr = pipeBuf.String()
	}

	if execErr != nil && outputStr == "" {
		outputStr = execErr.Error()
	}

	return rc.Params{
		"result": outputStr,
		"error":  hasError,
	}, nil
}
