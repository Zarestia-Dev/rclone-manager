package main

import (
	"bufio"
	"bytes"
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

// encryptedConfigBody reads the config file past comments and blank lines to its first line,
// as rclone's config.Decrypt does. For an encrypted file it returns the base64 body after the
// RCLONE_ENCRYPT_V0 header; a missing or plain-text file is not encrypted.
func encryptedConfigBody() (body []byte, encrypted bool, err error) {
	path := config.GetConfigPath()
	if path == "" {
		return nil, false, nil
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("cannot read config file: %w", err)
	}
	reader := bufio.NewReader(bytes.NewReader(data))
	for {
		line, _, readErr := reader.ReadLine()
		if readErr == io.EOF {
			return nil, false, nil
		}
		if readErr != nil {
			return nil, false, fmt.Errorf("error reading config file: %w", readErr)
		}
		l := strings.TrimSpace(string(line))
		if len(l) == 0 || strings.HasPrefix(l, ";") || strings.HasPrefix(l, "#") {
			continue
		}
		switch {
		case l == "RCLONE_ENCRYPT_V0:":
			body, err = io.ReadAll(reader)
			return body, true, err
		case strings.HasPrefix(l, "RCLONE_ENCRYPT_V"):
			return nil, false, errors.New("unsupported configuration encryption - update rclone for support")
		default:
			return nil, false, nil
		}
	}
}

func rcIsConfigEncrypted(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	_, encrypted, err := encryptedConfigBody()
	if err != nil {
		return nil, err
	}
	return rc.Params{"encrypted": encrypted}, nil
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
// A wrong password leaves the active key alone, so the check is safe while the config is
// unlocked; config.Decrypt would clear it. A right one becomes the active key.
func rcValidateConfigPassword(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	password, err := in.GetString("password")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(password) == "" {
		return nil, errors.New("password must not be empty")
	}

	body, encrypted, err := encryptedConfigBody()
	if err != nil {
		return nil, err
	}
	if !encrypted {
		return nil, errors.New("config file is not encrypted")
	}

	// Derive the key the same way rclone does: SHA256 of "[password][rclone-config]".
	h := sha256.New()
	h.Write([]byte("[" + password + "][rclone-config]"))
	var key [32]byte
	copy(key[:], h.Sum(nil))

	// The remaining content (after the header line) is base64-encoded ciphertext.
	dec := base64.NewDecoder(base64.StdEncoding, bytes.NewReader(body))
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
