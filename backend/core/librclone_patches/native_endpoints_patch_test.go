package main

import (
	"archive/zip"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/cache"
	"github.com/rclone/rclone/fs/config/obscure"
	"github.com/rclone/rclone/fs/filter"
	"github.com/rclone/rclone/fs/object"
	"github.com/rclone/rclone/fs/rc"
	"github.com/rclone/rclone/fs/rc/jobs"
)

func TestNativeCryptcheckOptionsThroughRCJob(t *testing.T) {
	ctx := context.Background()
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "keep.txt"), []byte("data"), 0644); err != nil {
		t.Fatal(err)
	}
	destination := ":crypt,remote='" + strings.ReplaceAll(t.TempDir(), "'", "''") + "',password='" + obscure.MustObscure("password") + "':"
	cryptFs, err := cache.Get(ctx, destination)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"keep.txt", "extra.txt"} {
		_, err := cryptFs.Put(ctx, strings.NewReader("data"), object.NewStaticObjectInfo(name, time.Now(), 4, true, nil, nil))
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		name   string
		oneWay bool
		filter rc.Params
	}{
		{name: "one-way", oneWay: true},
		{name: "filter", filter: rc.Params{"IncludeRule": []string{"keep.txt"}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			in := rc.Params{
				"_path": "operations/cryptcheck", "src": source, "dst": destination,
				"one_way": test.oneWay, "_config": rc.Params{"Checkers": 1},
			}
			if test.filter != nil {
				in["_filter"] = test.filter
			}
			out := jobs.NewJobFromParams(ctx, in)
			if out["success"] != true {
				t.Fatalf("cryptcheck failed: %v", out)
			}
		})
	}
}

func TestNativeArchiveOptionsThroughRCJob(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.Mkdir(source, 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"keep.txt", "skip.tmp"} {
		if err := os.WriteFile(filepath.Join(source, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	destination := filepath.Join(root, "result.zip")
	for _, dryRun := range []bool{true, false} {
		out := jobs.NewJobFromParams(context.Background(), rc.Params{
			"_path": "operations/archive", "action": "create",
			"src": source, "dst": destination, "format": "zip", "prefix": "my files",
			"_config": rc.Params{"DryRun": dryRun, "MaxDepth": 1},
			"_filter": rc.Params{"IncludeRule": []string{"*.txt"}},
		})
		if out["success"] != true {
			t.Fatalf("archive dryRun=%v: %v", dryRun, out)
		}
		if dryRun {
			if _, err := os.Stat(destination); !os.IsNotExist(err) {
				t.Fatalf("DryRun created an archive or stat failed: %v", err)
			}
		}
	}
	reader, err := zip.OpenReader(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if len(reader.File) != 1 || reader.File[0].Name != "my files/keep.txt" {
		t.Fatalf("expected only my files/keep.txt in archive, got %v", reader.File)
	}
}

func TestNativeArchiveDoesNotChangeInheritedFilter(t *testing.T) {
	source := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "file.txt"), []byte("data"), 0644); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	filterBefore := filter.GetConfig(ctx).Include("output.zip", 1, time.Now(), nil)
	_, err := rcOperationsArchive(ctx, rc.Params{
		"action": "create", "src": source,
		"dst": filepath.Join(source, "output.zip"), "format": "zip",
	})
	if err != nil {
		t.Fatal(err)
	}
	if filter.GetConfig(ctx).Include("output.zip", 1, time.Now(), nil) != filterBefore {
		t.Fatal("archive exclusion leaked into the inherited filter")
	}
}

func TestNativeArchiveRejectsUnusedOptions(t *testing.T) {
	source := t.TempDir()
	_, err := rcOperationsArchive(context.Background(), rc.Params{
		"action": "create", "src": source,
		"dst": filepath.Join(t.TempDir(), "output.zip"), "unsupported_option": true,
	})
	if err == nil || !strings.Contains(err.Error(), "unsupported_option") {
		t.Fatalf("expected unsupported option error, got %v", err)
	}
}

func TestNativeArchiveSingleFileWithFullPath(t *testing.T) {
	source := t.TempDir()
	for _, name := range []string{"selected.txt", "sibling.txt"} {
		if err := os.WriteFile(filepath.Join(source, name), []byte("data"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	destination := filepath.Join(t.TempDir(), "result.zip")
	out := jobs.NewJobFromParams(context.Background(), rc.Params{
		"_path": "operations/archive", "action": "create",
		"src": filepath.Join(source, "selected.txt"), "dst": destination,
		"full_path": true,
	})
	if out["success"] != true {
		t.Fatalf("archive failed: %v", out)
	}
	reader, err := zip.OpenReader(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if len(reader.File) != 1 || reader.File[0].Name == "selected.txt" || !strings.HasSuffix(reader.File[0].Name, "/selected.txt") {
		t.Fatalf("expected only the selected file with its full path, got %v", reader.File)
	}
}

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
