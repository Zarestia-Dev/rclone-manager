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

func TestVfsMountUnmountAndIdleCleanup(t *testing.T) {
	tmpDir := t.TempDir()
	filePath := "idle_test.txt"
	_ = os.WriteFile(tmpDir+"/"+filePath, []byte("idle data"), 0644)

	// 1. Mount VFS with vfsOpt
	mountRes, err := rcVfsMount(context.Background(), rc.Params{
		"fs": tmpDir,
		"vfsOpt": map[string]interface{}{
			"DirCacheTime": "10m",
		},
	})
	if err != nil {
		t.Fatalf("rcVfsMount failed: %v", err)
	}
	if mountRes["fs"] != tmpDir {
		t.Errorf("expected fs %q, got %v", tmpDir, mountRes["fs"])
	}

	v, err := getOrCreateVFS(tmpDir)
	if err != nil {
		t.Fatalf("getOrCreateVFS failed: %v", err)
	}
	if v.Opt.DirCacheTime.String() != "10m0s" {
		t.Errorf("expected DirCacheTime '10m0s', got %v", v.Opt.DirCacheTime.String())
	}

	// 2. Open handle and test idle handle cleanup
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

	// 3. Test unmount drops VFS
	unmountRes, err := rcVfsUnmount(context.Background(), rc.Params{
		"fs": tmpDir,
	})
	if err != nil || unmountRes["success"] != true {
		t.Fatalf("rcVfsUnmount failed: %v", err)
	}

	vfsMutex.Lock()
	inst, _ := findMatchingVFS(tmpDir)
	vfsMutex.Unlock()
	if inst != nil {
		t.Errorf("expected VFS instance to be dropped after unmount, but still found")
	}
}

func TestSetCacheDirAndWildcardUnmount(t *testing.T) {
	tmpDir := t.TempDir()
	cacheDir := t.TempDir()

	// 1. Set cache directory via rc
	setRes, err := rcSetCacheDir(context.Background(), rc.Params{
		"path": cacheDir,
	})
	if err != nil || setRes["success"] != true {
		t.Fatalf("rcSetCacheDir failed: %v", err)
	}

	// 2. Mount two directories
	dir1 := tmpDir + "/dir1"
	dir2 := tmpDir + "/dir2"
	_ = os.MkdirAll(dir1, 0755)
	_ = os.MkdirAll(dir2, 0755)

	_, err = rcVfsMount(context.Background(), rc.Params{"fs": dir1})
	if err != nil {
		t.Fatalf("mount dir1 failed: %v", err)
	}
	_, err = rcVfsMount(context.Background(), rc.Params{"fs": dir2})
	if err != nil {
		t.Fatalf("mount dir2 failed: %v", err)
	}

	// 3. Wildcard unmount drops all
	unmountAllRes, err := rcVfsUnmount(context.Background(), rc.Params{"fs": "*"})
	if err != nil || unmountAllRes["success"] != true {
		t.Fatalf("rcVfsUnmount wildcard failed: %v", err)
	}

	vfsMutex.Lock()
	remaining := len(vfsInstances)
	vfsMutex.Unlock()
	if remaining != 0 {
		t.Errorf("expected 0 active VFS instances after wildcard unmount, got %d", remaining)
	}
}

func TestVfsFindMatchingHierarchy(t *testing.T) {
	tmpDir := t.TempDir()
	subDir := tmpDir + "/subfolder"
	_ = os.MkdirAll(subDir, 0755)

	_, err := rcVfsMount(context.Background(), rc.Params{"fs": tmpDir})
	if err != nil {
		t.Fatalf("mount root failed: %v", err)
	}

	_, err = rcVfsMount(context.Background(), rc.Params{"fs": subDir})
	if err != nil {
		t.Fatalf("mount sub failed: %v", err)
	}

	// Lookup subDir should match subDir exactly, not root tmpDir
	vfsMutex.Lock()
	subVFS, subKey := findMatchingVFS(subDir)
	rootVFS, rootKey := findMatchingVFS(tmpDir)
	vfsMutex.Unlock()

	if subVFS == nil || subKey != subDir {
		t.Errorf("expected exact match for subDir %q, got key %q", subDir, subKey)
	}
	if rootVFS == nil || rootKey != tmpDir {
		t.Errorf("expected exact match for root tmpDir %q, got key %q", tmpDir, rootKey)
	}
	if subVFS == rootVFS {
		t.Errorf("expected different VFS instances for root and subDir")
	}

	// Clean up
	_, _ = rcVfsUnmount(context.Background(), rc.Params{"fs": "*"})
}

