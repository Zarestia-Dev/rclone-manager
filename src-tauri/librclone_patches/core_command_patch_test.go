package main

import (
	"context"
	"strings"
	"testing"

	"github.com/rclone/rclone/fs/rc"
)

func TestCoreCommandOverrideVersion(t *testing.T) {
	res, err := rcRunCoreCommand(context.Background(), rc.Params{
		"command": "version",
	})
	if err != nil {
		t.Fatalf("rcRunCoreCommand failed: %v", err)
	}

	out, ok := res["result"].(string)
	if !ok {
		t.Fatalf("expected string result, got %T", res["result"])
	}

	if !strings.Contains(out, "rclone") {
		t.Errorf("expected output to contain 'rclone', got %q", out)
	}

	if res["error"] != false {
		t.Errorf("expected error=false, got %v (output: %q)", res["error"], out)
	}
}

func TestCoreCommandOverrideObscure(t *testing.T) {
	res, err := rcRunCoreCommand(context.Background(), rc.Params{
		"command": "obscure",
		"arg":     []string{"mysecretpassword"},
	})
	if err != nil {
		t.Fatalf("rcRunCoreCommand failed: %v", err)
	}

	out, ok := res["result"].(string)
	if !ok {
		t.Fatalf("expected string result, got %T", res["result"])
	}

	if res["error"] != false {
		t.Errorf("expected error=false, got %v (output: %q)", res["error"], out)
	}
}

func TestCoreCommandOverrideArchiveHelp(t *testing.T) {
	res, err := rcRunCoreCommand(context.Background(), rc.Params{
		"command": "archive",
		"arg":     []string{"--help"},
	})
	if err != nil {
		t.Fatalf("rcRunCoreCommand failed: %v", err)
	}

	out, ok := res["result"].(string)
	if !ok {
		t.Fatalf("expected string result, got %T", res["result"])
	}

	if !strings.Contains(strings.ToLower(out), "archive") {
		t.Errorf("expected output to contain 'archive', got %q", out)
	}
}

func TestCoreCommandOverrideCryptCheckHelp(t *testing.T) {
	res, err := rcRunCoreCommand(context.Background(), rc.Params{
		"command": "cryptcheck",
		"arg":     []string{"--help"},
	})
	if err != nil {
		t.Fatalf("rcRunCoreCommand failed: %v", err)
	}

	out, ok := res["result"].(string)
	if !ok {
		t.Fatalf("expected string result, got %T", res["result"])
	}

	if !strings.Contains(strings.ToLower(out), "cryptcheck") {
		t.Errorf("expected output to contain 'cryptcheck', got %q", out)
	}
}
