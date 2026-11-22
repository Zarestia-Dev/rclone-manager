package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
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

func TestIsConfigEncryptedRejectsAnUnknownVersion(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "rclone.conf")
	config.SetConfigPath(configPath)
	if err := os.WriteFile(configPath, []byte("# comment\n\nRCLONE_ENCRYPT_V1:\nabc"), 0600); err != nil {
		t.Fatalf("failed to write test config: %v", err)
	}
	if _, err := rcIsConfigEncrypted(context.Background(), rc.Params{}); err == nil ||
		!strings.Contains(err.Error(), "unsupported configuration encryption") {
		t.Errorf("expected an unsupported-encryption error, got %v", err)
	}
}

// writeEncryptedConfig writes a config encrypted with password the way rclone does, and
// leaves no key active.
func writeEncryptedConfig(t *testing.T, password string) {
	t.Helper()
	configPath := filepath.Join(t.TempDir(), "rclone.conf")
	config.SetConfigPath(configPath)
	if err := config.SetConfigPassword(password); err != nil {
		t.Fatalf("SetConfigPassword failed: %v", err)
	}
	var encrypted bytes.Buffer
	err := config.Encrypt(strings.NewReader("[photos]\ntype = local\n"), &encrypted)
	config.ClearConfigPassword()
	if err != nil {
		t.Fatalf("Encrypt failed: %v", err)
	}
	if err := os.WriteFile(configPath, encrypted.Bytes(), 0600); err != nil {
		t.Fatalf("failed to write encrypted config: %v", err)
	}
	t.Cleanup(config.ClearConfigPassword)
}

func TestValidateConfigPasswordUnlocksOnlyWithTheRightPassword(t *testing.T) {
	writeEncryptedConfig(t, "correct horse")

	if _, err := rcValidateConfigPassword(context.Background(), rc.Params{"password": "wrong"}); err == nil ||
		!strings.Contains(err.Error(), "wrong password") {
		t.Fatalf("expected a wrong-password error, got %v", err)
	}
	if config.IsEncrypted() {
		t.Fatal("a wrong password must not leave a key active")
	}

	res, err := rcValidateConfigPassword(context.Background(), rc.Params{"password": "correct horse"})
	if err != nil || res["valid"] != true {
		t.Fatalf("expected the right password to validate, got %v, %v", res, err)
	}
	if !config.IsEncrypted() {
		t.Fatal("the right password must become the active key")
	}
}

func TestValidateConfigPasswordKeepsTheActiveKeyOnAWrongPassword(t *testing.T) {
	writeEncryptedConfig(t, "correct horse")
	if _, err := rcValidateConfigPassword(context.Background(), rc.Params{"password": "correct horse"}); err != nil {
		t.Fatalf("unlock failed: %v", err)
	}

	// The app asks for the password again while the config is unlocked, and gets a typo.
	if _, err := rcValidateConfigPassword(context.Background(), rc.Params{"password": "correct hors"}); err == nil {
		t.Fatal("expected the typo to fail")
	}
	if !config.IsEncrypted() {
		t.Fatal("a wrong password while unlocked must keep the active key")
	}
}

func TestValidateConfigPasswordRejectsAPlainConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "rclone.conf")
	config.SetConfigPath(configPath)
	if err := os.WriteFile(configPath, []byte("[photos]\ntype = local\n"), 0600); err != nil {
		t.Fatalf("failed to write test config: %v", err)
	}
	if _, err := rcValidateConfigPassword(context.Background(), rc.Params{"password": "any"}); err == nil ||
		!strings.Contains(err.Error(), "not encrypted") {
		t.Errorf("expected a not-encrypted error, got %v", err)
	}
}

func TestValidateConfigPasswordEmpty(t *testing.T) {
	_, err := rcValidateConfigPassword(context.Background(), rc.Params{"password": ""})
	if err == nil {
		t.Error("expected error for empty password, got nil")
	}
}
