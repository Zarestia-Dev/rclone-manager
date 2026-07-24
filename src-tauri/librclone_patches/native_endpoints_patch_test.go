package main

import (
	"bytes"
	"context"
	"os"
	"testing"

	"github.com/rclone/rclone/fs/rc"
)

func TestNativeArchiveCreateListExtract(t *testing.T) {
	call := rc.Calls.Get("operations/archive")
	if call == nil {
		t.Fatalf("expected operations/archive to be registered in rc.Calls")
	}

	tmpDir := t.TempDir()
	srcDir := tmpDir + "/source"
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		t.Fatalf("failed to mkdir srcDir: %v", err)
	}

	data := bytes.Repeat([]byte("Hello Rclone Archive\n"), 1000) // ~21KB
	_ = os.WriteFile(srcDir+"/file1.txt", data, 0644)
	_ = os.WriteFile(srcDir+"/file2.txt", data, 0644)

	// 1. Create Archive (saving archive inside source directory)
	dstZip := srcDir + "/my_archive.zip"
	res, err := rcOperationsArchive(context.Background(), rc.Params{
		"action": "create",
		"src":    srcDir,
		"dst":    dstZip,
		"format": "zip",
	})
	if err != nil {
		t.Fatalf("rcOperationsArchive create failed: %v", err)
	}
	if res["success"] != true {
		t.Fatalf("expected success=true, got %v", res)
	}

	fi, err := os.Stat(dstZip)
	if err != nil {
		t.Fatalf("failed to stat dstZip: %v", err)
	}
	t.Logf("Created zip size: %d bytes", fi.Size())

	if fi.Size() == 0 || fi.Size() > 100000 {
		t.Errorf("unexpected zip size: %d bytes", fi.Size())
	}

	// 2. List Archive
	listRes, err := rcOperationsArchive(context.Background(), rc.Params{
		"action": "list",
		"src":    dstZip,
	})
	if err != nil {
		t.Fatalf("rcOperationsArchive list failed: %v", err)
	}
	listOutput, ok := listRes["result"].(string)
	if !ok {
		t.Fatalf("expected string result from list")
	}
	t.Logf("Archive list output:\n%s", listOutput)

	// 3. Extract Archive
	extractDir := tmpDir + "/extracted"
	extractRes, err := rcOperationsArchive(context.Background(), rc.Params{
		"action": "extract",
		"src":    dstZip,
		"dst":    extractDir,
	})
	if err != nil {
		t.Fatalf("rcOperationsArchive extract failed: %v", err)
	}
	if extractRes["success"] != true {
		t.Fatalf("expected extract success=true, got %v", extractRes)
	}

	extFile1, err := os.ReadFile(extractDir + "/file1.txt")
	if err != nil {
		t.Fatalf("failed to read extracted file1.txt: %v", err)
	}
	if !bytes.Equal(extFile1, data) {
		t.Errorf("extracted file content mismatch")
	}
}

func TestNativeCat(t *testing.T) {
	call := rc.Calls.Get("operations/cat")
	if call == nil {
		t.Fatalf("expected operations/cat to be registered in rc.Calls")
	}

	tmpDir := t.TempDir()
	testFile := tmpDir + "/testcat.txt"
	expected := "Hello Cat Operation!"
	_ = os.WriteFile(testFile, []byte(expected), 0644)

	res, err := rcOperationsCat(context.Background(), rc.Params{
		"path": testFile,
	})
	if err != nil {
		t.Fatalf("rcOperationsCat failed: %v", err)
	}
	out, _ := res["result"].(string)
	if out != expected {
		t.Errorf("expected %q, got %q", expected, out)
	}
}
