package main

import (
	"context"
	"encoding/base64"
	"os"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/rc"
)

func TestVfsEndpointsRegistration(t *testing.T) {
	endpoints := []string{
		"vfs/stream/list",
		"vfs/stream/stat",
		"vfs/stream/open",
		"vfs/stream/read",
		"vfs/stream/write",
		"vfs/stream/close",
		"vfs/stream/forget",
	}

	for _, ep := range endpoints {
		if rc.Calls.Get(ep) == nil {
			t.Errorf("expected %s to be registered in rc.Calls", ep)
		}
	}
}

func TestVfsStreamOpenReadWriteClose(t *testing.T) {
	tmpDir := t.TempDir()
	filePath := "test_stream_file.txt"
	content := "Hello VFS Streaming SAF Bridge!\nTesting range reads and writes."

	// 1. Open file for writing
	openWriteRes, err := rcVfsOpen(context.Background(), rc.Params{
		"fs":     tmpDir,
		"remote": filePath,
		"mode":   "w",
	})
	if err != nil {
		t.Fatalf("rcVfsOpen write failed: %v", err)
	}

	handleID, ok := openWriteRes["handle_id"].(int64)
	if !ok || handleID <= 0 {
		t.Fatalf("expected valid handle_id, got %v", openWriteRes["handle_id"])
	}

	// 2. Write content
	b64Data := base64.StdEncoding.EncodeToString([]byte(content))
	writeRes, err := rcVfsWrite(context.Background(), rc.Params{
		"handle_id": handleID,
		"offset":    int64(0),
		"data":      b64Data,
	})
	if err != nil {
		t.Fatalf("rcVfsWrite failed: %v", err)
	}
	bytesWritten, _ := writeRes["bytes_written"].(int)
	if bytesWritten != len(content) {
		t.Errorf("expected %d bytes written, got %d", len(content), bytesWritten)
	}

	// 3. Close write handle
	closeWriteRes, err := rcVfsClose(context.Background(), rc.Params{
		"handle_id": handleID,
	})
	if err != nil || closeWriteRes["success"] != true {
		t.Fatalf("rcVfsClose write handle failed: %v", err)
	}

	// 4. Open file for reading
	openReadRes, err := rcVfsOpen(context.Background(), rc.Params{
		"fs":     tmpDir,
		"remote": filePath,
		"mode":   "r",
	})
	if err != nil {
		t.Fatalf("rcVfsOpen read failed: %v", err)
	}

	readHandleID, ok := openReadRes["handle_id"].(int64)
	if !ok || readHandleID <= 0 {
		t.Fatalf("expected valid read handle_id, got %v", openReadRes["handle_id"])
	}

	size, _ := openReadRes["size"].(int64)
	if size != int64(len(content)) {
		t.Errorf("expected size %d, got %d", len(content), size)
	}

	// 5. Read chunk from offset 0
	readRes, err := rcVfsRead(context.Background(), rc.Params{
		"handle_id": readHandleID,
		"offset":    int64(0),
		"count":     int64(len(content)),
	})
	if err != nil {
		t.Fatalf("rcVfsRead failed: %v", err)
	}

	readDataB64, _ := readRes["data"].(string)
	decodedBytes, err := base64.StdEncoding.DecodeString(readDataB64)
	if err != nil {
		t.Fatalf("failed to decode base64 read data: %v", err)
	}

	if string(decodedBytes) != content {
		t.Errorf("expected read content %q, got %q", content, string(decodedBytes))
	}

	// 6. Close read handle
	closeReadRes, err := rcVfsClose(context.Background(), rc.Params{
		"handle_id": readHandleID,
	})
	if err != nil || closeReadRes["success"] != true {
		t.Fatalf("rcVfsClose read handle failed: %v", err)
	}
}

func TestVfsStreamListAndStat(t *testing.T) {
	tmpDir := t.TempDir()
	_ = os.WriteFile(tmpDir+"/sample1.txt", []byte("sample file 1"), 0644)
	_ = os.WriteFile(tmpDir+"/sample2.txt", []byte("sample file 22"), 0644)

	// 1. Stat file
	statRes, err := rcVfsStat(context.Background(), rc.Params{
		"fs":     tmpDir,
		"remote": "sample1.txt",
	})
	if err != nil {
		t.Fatalf("rcVfsStat failed: %v", err)
	}

	item, ok := statRes["item"].(rc.Params)
	if !ok {
		t.Fatalf("expected item in stat result")
	}
	if item["Name"] != "sample1.txt" {
		t.Errorf("expected Name 'sample1.txt', got %v", item["Name"])
	}

	// 2. List directory
	listRes, err := rcVfsList(context.Background(), rc.Params{
		"fs":     tmpDir,
		"remote": "",
	})
	if err != nil {
		t.Fatalf("rcVfsList failed: %v", err)
	}

	list, ok := listRes["list"].([]rc.Params)
	if !ok || len(list) < 2 {
		t.Fatalf("expected at least 2 entries in list, got %v", listRes)
	}

	// 3. Forget cache
	forgetRes, err := rcVfsForget(context.Background(), rc.Params{
		"fs": tmpDir,
	})
	if err != nil || forgetRes["success"] != true {
		t.Fatalf("rcVfsForget failed: %v", err)
	}
}

func TestVfsDirCacheTimeAndIdleCleanup(t *testing.T) {
	tmpDir := t.TempDir()
	filePath := "idle_test.txt"
	_ = os.WriteFile(tmpDir+"/"+filePath, []byte("idle data"), 0644)

	// Test custom dir_cache_time parameter wiring via vfsOpt
	v, err := getOrCreateVFS(tmpDir, parseConfigOptions(rc.Params{
		"vfsOpt": map[string]interface{}{
			"dir_cache_time": "10m",
		},
	}))
	if err != nil {
		t.Fatalf("getOrCreateVFS with dir_cache_time failed: %v", err)
	}
	if v.Opt.DirCacheTime.String() != "10m0s" {
		t.Errorf("expected DirCacheTime '10m0s', got %v", v.Opt.DirCacheTime.String())
	}

	// Test idle handle cleanup
	openRes, err := rcVfsOpen(context.Background(), rc.Params{
		"fs":     tmpDir,
		"remote": filePath,
		"mode":   "r",
	})
	if err != nil {
		t.Fatalf("rcVfsOpen failed: %v", err)
	}

	handleID := openRes["handle_id"].(int64)

	vfsHandleMutex.Lock()
	entry, ok := vfsHandles[handleID]
	if ok {
		// Simulate handle being untouched for 10 minutes
		entry.lastAccess = entry.lastAccess.Add(-10 * time.Minute)
	}
	vfsHandleMutex.Unlock()

	cleanupIdleHandles(5 * time.Minute)

	vfsHandleMutex.Lock()
	_, stillExists := vfsHandles[handleID]
	vfsHandleMutex.Unlock()

	if stillExists {
		t.Errorf("expected idle handle %d to be cleaned up", handleID)
	}

	// Test nested vfsOpt parsing
	tmpDir2 := t.TempDir()
	v2, err := getOrCreateVFS(tmpDir2, parseConfigOptions(rc.Params{
		"vfsOpt": map[string]interface{}{
			"vfs-dir-cache-time": "15m",
		},
	}))
	if err != nil {
		t.Fatalf("getOrCreateVFS with vfsOpt failed: %v", err)
	}
	if v2.Opt.DirCacheTime.String() != "15m0s" {
		t.Errorf("expected DirCacheTime '15m0s' from vfsOpt, got %v", v2.Opt.DirCacheTime.String())
	}
}

