package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/rc"
	"golang.org/x/crypto/nacl/secretbox"
)

func init() {
	rc.Add(rc.Call{
		Path:  "config/isencrypted",
		Fn:    rcIsConfigEncrypted,
		Title: "Check if the config file is encrypted on disk.",
		Help: `
Returns a JSON object:
- encrypted: true/false
`,
	})

	rc.Add(rc.Call{
		Path:  "config/encrypt",
		Fn:    rcConfigEncrypt,
		Title: "Encrypt the config file with a password.",
		Help: `
Takes:
- password: the password to encrypt with.
`,
	})

	rc.Add(rc.Call{
		Path:  "config/decrypt",
		Fn:    rcConfigDecrypt,
		Title: "Decrypt the config file (remove password).",
		Help: `
`,
	})

	rc.Add(rc.Call{
		Path:  "config/validatepassword",
		Fn:    rcValidateConfigPassword,
		Title: "Validate a password against the encrypted config file.",
		Help: `
Validates a candidate password against the encrypted config file by performing
a real try-decrypt (secretbox.Open) — without calling LoadedData(), which would
panic inside an RC job on failure. Sets the password as the active in-memory key
on success so no separate unlock call is required.

Parameters:
- password: candidate password string

Returns:
- valid: true on success
- error on wrong password or I/O failure
`,
	})
}

func rcIsConfigEncrypted(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	path := config.GetConfigPath()
	if path == "" {
		return rc.Params{"encrypted": false}, nil
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return rc.Params{"encrypted": false}, nil
		}
		return nil, err
	}
	defer f.Close()

	reader := bufio.NewReader(f)
	for {
		line, _, err := reader.ReadLine()
		if err != nil {
			if err == io.EOF {
				break
			}
			return nil, err
		}
		l := strings.TrimSpace(string(line))
		if len(l) == 0 || strings.HasPrefix(l, ";") || strings.HasPrefix(l, "#") {
			continue
		}
		if l == "RCLONE_ENCRYPT_V0:" {
			return rc.Params{"encrypted": true}, nil
		}
		break
	}
	return rc.Params{"encrypted": false}, nil
}

func rcConfigEncrypt(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	password, err := in.GetString("password")
	if err != nil {
		return nil, err
	}
	err = config.SetConfigPassword(password)
	if err != nil {
		return nil, err
	}
	config.SaveConfig()
	return rc.Params{}, nil
}

func rcConfigDecrypt(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	// Config must already be unlocked in memory — prevents use on a locked config.
	if !config.IsEncrypted() {
		return nil, errors.New("config is not currently unlocked or is not encrypted")
	}
	// Require the current password as explicit confirmation before removing encryption.
	password, err := in.GetString("password")
	if err != nil {
		return nil, err
	}
	if err = config.SetConfigPassword(password); err != nil {
		return nil, err
	}
	config.ClearConfigPassword()
	config.SaveConfig()
	return rc.Params{}, nil
}

// rcValidateConfigPassword validates a password against the encrypted config file
// by performing a real try-decrypt with secretbox. This avoids calling LoadedData()
// which would panic inside an RC job on a wrong/missing password.
// It does NOT modify the in-memory config state — it only reads the file.
func rcValidateConfigPassword(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	password, err := in.GetString("password")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(password) == "" {
		return nil, errors.New("password must not be empty")
	}

	configPath := config.GetConfigPath()
	if configPath == "" {
		return nil, errors.New("no config file path set")
	}

	f, err := os.Open(configPath)
	if err != nil {
		return nil, fmt.Errorf("cannot open config file: %w", err)
	}
	defer f.Close()

	// Scan past comments/blanks to find the encryption header.
	reader := bufio.NewReader(f)
	encryptedFound := false
	for {
		line, _, readErr := reader.ReadLine()
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return nil, fmt.Errorf("error reading config file: %w", readErr)
		}
		l := strings.TrimSpace(string(line))
		if len(l) == 0 || strings.HasPrefix(l, ";") || strings.HasPrefix(l, "#") {
			continue
		}
		if l == "RCLONE_ENCRYPT_V0:" {
			encryptedFound = true
			break
		}
		// First non-blank non-comment line is not the magic — file is not encrypted.
		return nil, errors.New("config file is not encrypted")
	}
	if !encryptedFound {
		return nil, errors.New("config file is not encrypted")
	}

	// Derive the key the same way rclone does: SHA256 of "[password][rclone-config]".
	h := sha256.New()
	h.Write([]byte("[" + password + "][rclone-config]"))
	var key [32]byte
	copy(key[:], h.Sum(nil))

	// The remaining content (after the header line) is base64-encoded ciphertext.
	dec := base64.NewDecoder(base64.StdEncoding, reader)
	box, readErr := io.ReadAll(dec)
	if readErr != nil {
		return nil, fmt.Errorf("failed to decode ciphertext: %w", readErr)
	}
	if len(box) < 24+secretbox.Overhead {
		return nil, errors.New("config ciphertext too short — file may be corrupt")
	}

	// Try to open the secretbox (nonce is first 24 bytes).
	var nonce [24]byte
	copy(nonce[:], box[:24])
	_, ok := secretbox.Open(nil, box[24:], &nonce, &key)
	if !ok {
		return nil, errors.New("wrong password: decryption failed")
	}

	// Password is correct — also set it as the active in-memory key so the
	// caller can proceed to use the config without a separate unlock call.
	if setErr := config.SetConfigPassword(password); setErr != nil {
		return nil, fmt.Errorf("password correct but failed to activate: %w", setErr)
	}

	return rc.Params{"valid": true}, nil
}
