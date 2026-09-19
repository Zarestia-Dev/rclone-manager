package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/mholt/archives"
	_ "github.com/rclone/rclone/backend/all"
	"github.com/rclone/rclone/backend/crypt"
	"github.com/rclone/rclone/cmd"
	_ "github.com/rclone/rclone/cmd/all"
	"github.com/rclone/rclone/cmd/archive/create"
	"github.com/rclone/rclone/cmd/archive/extract"
	"github.com/rclone/rclone/cmd/archive/list"
	"github.com/rclone/rclone/cmd/check"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/filter"
	"github.com/rclone/rclone/fs/hash"
	"github.com/rclone/rclone/fs/operations"
	"github.com/rclone/rclone/fs/rc"
)

func init() {
	rc.Add(rc.Call{
		Path:  "operations/archive",
		Fn:    rcOperationsArchive,
		Title: "Archive create, extract, or list files directly in process.",
		Help:  "Executes archive operations cleanly in-process over FFI.",
	})

	rc.Add(rc.Call{
		Path:  "operations/cryptcheck",
		Fn:    rcOperationsCryptCheck,
		Title: "Cryptcheck encrypted remotes directly in process.",
		Help:  "Checks encrypted remotes in-process over FFI.",
	})
}

// rcOperationsArchive handles create, extract, and list actions for archives cleanly.
func rcOperationsArchive(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	action, err := in.GetString("action")
	if err != nil || action == "" {
		// Fallback to reading first arg if action is inside arg
		var arg []string
		_ = in.GetStructMissingOK("arg", &arg)
		if len(arg) > 0 {
			action = arg[0]
		} else {
			return nil, errors.New("missing action (create, extract, or list)")
		}
	}

	switch action {
	case "create":
		srcPath, err := in.GetString("src")
		if err != nil {
			srcPath, _ = in.GetString("source")
		}
		dstPath, err := in.GetString("dst")
		if err != nil {
			dstPath, _ = in.GetString("destination")
		}

		if srcPath == "" || dstPath == "" {
			var arg []string
			_ = in.GetStructMissingOK("arg", &arg)
			if len(arg) >= 3 && arg[0] == "create" {
				srcPath = arg[1]
				dstPath = arg[2]
			} else if len(arg) >= 2 {
				srcPath = arg[0]
				dstPath = arg[1]
			}
		}

		if srcPath == "" || dstPath == "" {
			return nil, errors.New("archive create requires source and destination parameters")
		}

		format, _ := in.GetString("format")
		prefix, _ := in.GetString("prefix")

		src := cmd.NewFsSrc([]string{srcPath})
		dst, dstFile := cmd.NewFsDstFile([]string{dstPath})

		// Prevent infinite self-archiving loop if dstFile is created inside srcPath
		fi := filter.GetConfig(ctx)
		if dst != nil {
			dstFileName := filepath.Base(dstFile)
			_ = fi.Add(false, dstFileName)
		}

		var includes []string
		_ = in.GetStructMissingOK("include", &includes)
		for _, inc := range includes {
			if inc != "" {
				_ = fi.Add(true, inc)
			}
		}

		err = create.ArchiveCreate(ctx, dst, dstFile, src, format, prefix)
		if err != nil {
			return nil, err
		}
		return rc.Params{"success": true, "result": "archive created successfully"}, nil

	case "extract":
		srcPath, _ := in.GetString("src")
		if srcPath == "" {
			srcPath, _ = in.GetString("source")
		}
		dstPath, _ := in.GetString("dst")
		if dstPath == "" {
			dstPath, _ = in.GetString("destination")
		}

		if srcPath == "" || dstPath == "" {
			var arg []string
			_ = in.GetStructMissingOK("arg", &arg)
			if len(arg) >= 3 && arg[0] == "extract" {
				srcPath = arg[1]
				dstPath = arg[2]
			} else if len(arg) >= 2 {
				srcPath = arg[0]
				dstPath = arg[1]
			}
		}

		if srcPath == "" || dstPath == "" {
			return nil, errors.New("archive extract requires source and destination parameters")
		}

		src, srcFile := cmd.NewFsFile(srcPath)
		dst, dstDir := cmd.NewFsFile(dstPath)

		err = extract.ArchiveExtract(ctx, dst, dstDir, src, srcFile)
		if err != nil {
			return nil, err
		}
		return rc.Params{"success": true, "result": "archive extracted successfully"}, nil

	case "list":
		srcPath, _ := in.GetString("src")
		if srcPath == "" {
			srcPath, _ = in.GetString("source")
		}

		if srcPath == "" {
			var arg []string
			_ = in.GetStructMissingOK("arg", &arg)
			if len(arg) >= 2 && arg[0] == "list" {
				srcPath = arg[1]
			} else if len(arg) >= 1 {
				srcPath = arg[0]
			}
		}

		if srcPath == "" {
			return nil, errors.New("archive list requires source parameter")
		}

		src, srcFile := cmd.NewFsFile(srcPath)

		var buf bytes.Buffer
		listFn := func(ctx context.Context, f archives.FileInfo) error {
			fi := filter.GetConfig(ctx)
			if !fi.Include(f.NameInArchive, f.Size(), f.ModTime(), fs.Metadata{}) {
				return nil
			}
			name := f.NameInArchive
			if f.IsDir() && !strings.HasSuffix(name, "/") {
				name += "/"
			}
			buf.WriteString(fmt.Sprintf("%d %s %s\n", f.Size(), f.ModTime().Format("2006-01-02 15:04:05.000000000"), name))
			return nil
		}

		err = list.ArchiveList(ctx, src, srcFile, listFn)
		if err != nil {
			return nil, err
		}

		return rc.Params{
			"result":  buf.String(),
			"success": true,
		}, nil

	default:
		return nil, fmt.Errorf("unknown archive action: %s", action)
	}
}

// rcOperationsCryptCheck checks integrity of an encrypted remote directly in process.
func rcOperationsCryptCheck(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	srcPath, _ := in.GetString("src")
	if srcPath == "" {
		srcPath, _ = in.GetString("srcFs")
	}
	if srcPath == "" {
		srcPath, _ = in.GetString("source")
	}
	dstPath, _ := in.GetString("dst")
	if dstPath == "" {
		dstPath, _ = in.GetString("dstFs")
	}
	if dstPath == "" {
		dstPath, _ = in.GetString("destination")
	}

	if srcPath == "" || dstPath == "" {
		var arg []string
		_ = in.GetStructMissingOK("arg", &arg)
		if len(arg) >= 2 {
			srcPath = arg[0]
			dstPath = arg[1]
		}
	}

	if srcPath == "" || dstPath == "" {
		return nil, errors.New("cryptcheck requires source and destination parameters")
	}

	fsrc, fdst := cmd.NewFsSrcDst([]string{srcPath, dstPath})

	fcrypt, ok := fdst.(*crypt.Fs)
	if !ok {
		return nil, fmt.Errorf("%s:%s is not a crypt remote", fdst.Name(), fdst.Root())
	}

	funderlying := fcrypt.UnWrap()
	hashType := funderlying.Hashes().GetOne()
	if hashType == hash.None {
		return nil, fmt.Errorf("%s:%s does not support any hashes", funderlying.Name(), funderlying.Root())
	}

	opt, closeFn, err := check.GetCheckOpt(fsrc, fcrypt)
	if err != nil {
		return nil, err
	}
	defer closeFn()

	opt.Check = func(ctx context.Context, dst, src fs.Object) (differ bool, noHash bool, err error) {
		cryptDst := dst.(*crypt.Object)
		underlyingDst := cryptDst.UnWrap()
		underlyingHash, err := underlyingDst.Hash(ctx, hashType)
		if err != nil {
			return true, false, fmt.Errorf("error reading hash from underlying %v: %w", underlyingDst, err)
		}
		if underlyingHash == "" {
			return false, true, nil
		}
		cryptHash, err := fcrypt.ComputeHash(ctx, cryptDst, src, hashType)
		if err != nil {
			return true, false, fmt.Errorf("error computing hash: %w", err)
		}
		if cryptHash == "" {
			return false, true, nil
		}
		if cryptHash != underlyingHash {
			err = fmt.Errorf("hashes differ (%s:%s) %q vs (%s:%s) %q", fdst.Name(), fdst.Root(), cryptHash, fsrc.Name(), fsrc.Root(), underlyingHash)
			fs.Errorf(src, "%s", err.Error())
			return true, false, nil
		}
		return false, false, nil
	}

	err = operations.CheckFn(ctx, opt)
	if err != nil {
		return nil, err
	}

	return rc.Params{"success": true, "result": "cryptcheck passed"}, nil
}
