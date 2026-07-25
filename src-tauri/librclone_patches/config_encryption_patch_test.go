package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/rc"
)

func TestIsConfigEncrypted(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "rclone.conf")

	// Set config path for test
	config.SetConfigPath(configPath)

	// Non-existent file
	res, err := rcIsConfigEncrypted(context.Background(), rc.Params{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res["encrypted"] != false {
		t.Errorf("expected encrypted=false for missing file, got %v", res["encrypted"])
	}

	// Plain unencrypted file
	err = os.WriteFile(configPath, []byte("[myremote]\ntype = drive\n"), 0600)
	if err != nil {
		t.Fatalf("failed to write test config: %v", err)
	}

	res, err = rcIsConfigEncrypted(context.Background(), rc.Params{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res["encrypted"] != false {
		t.Errorf("expected encrypted=false for plain file, got %v", res["encrypted"])
	}

	// Encrypted file
	err = os.WriteFile(configPath, []byte("RCLONE_ENCRYPT_V0:\nsomebase64ciphertext"), 0600)
	if err != nil {
		t.Fatalf("failed to write test encrypted config: %v", err)
	}

	res, err = rcIsConfigEncrypted(context.Background(), rc.Params{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res["encrypted"] != true {
		t.Errorf("expected encrypted=true, got %v", res["encrypted"])
	}
}

func TestValidateConfigPasswordEmpty(t *testing.T) {
	_, err := rcValidateConfigPassword(context.Background(), rc.Params{"password": ""})
	if err == nil {
		t.Error("expected error for empty password, got nil")
	}
}
