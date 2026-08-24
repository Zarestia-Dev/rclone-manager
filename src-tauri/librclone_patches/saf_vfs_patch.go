package main

import "C"

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	_ "github.com/rclone/rclone/backend/all"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/fspath"
	"github.com/rclone/rclone/fs/rc"
	"github.com/rclone/rclone/vfs"
	"github.com/rclone/rclone/vfs/vfscommon"
)

type vfsHandleEntry struct {
	handle     vfs.Handle
	vfs        *vfs.VFS
	lastAccess time.Time
}

var (
	vfsMutex       sync.Mutex
	vfsInstances   = make(map[string]*vfs.VFS)
	vfsHandleMutex sync.Mutex
	vfsHandles     = make(map[int64]*vfsHandleEntry)
	vfsNextHandle  int64
)

const defaultHandleIdleTimeout = 5 * time.Minute

func ensureWritableCacheDir() {
	currentCache := config.GetCacheDir()
	if currentCache == "" || strings.HasPrefix(currentCache, "/data/local/tmp") || strings.HasPrefix(currentCache, "/tmp") {
		if xdgCache := os.Getenv("XDG_CACHE_HOME"); xdgCache != "" {
			_ = config.SetCacheDir(filepath.Join(xdgCache, "rclone"))
		} else if tmpDir := os.Getenv("TMPDIR"); tmpDir != "" {
			_ = config.SetCacheDir(filepath.Join(tmpDir, "rclone"))
		}
	}
}

func normalizeFsName(name string) string {
	name = strings.TrimPrefix(name, "saf://")
	return strings.TrimSuffix(strings.TrimSpace(name), ":")
}

func findMatchingVFS(fsName string) (*vfs.VFS, string) {
	// 1. Direct exact key lookup
	if instance, ok := vfsInstances[fsName]; ok && instance != nil {
		return instance, fsName
	}

	norm := normalizeFsName(fsName)

	// 2. Normalized key match (e.g. "myremote" vs "myremote:" vs "saf://myremote")
	for key, instance := range vfsInstances {
		if normalizeFsName(key) == norm && instance != nil {
			return instance, key
		}
	}

	// 3. Fs ConfigString exact normalized match (preserves subpaths like "myremote:path")
	for key, instance := range vfsInstances {
		if instance != nil && instance.Fs() != nil {
			if normalizeFsName(fs.ConfigString(instance.Fs())) == norm {
				return instance, key
			}
		}
	}

	// 4. Fallback to Fs Name match if no subpath was specified
	for key, instance := range vfsInstances {
		if instance != nil && instance.Fs() != nil {
			if normalizeFsName(instance.Fs().Name()) == norm {
				return instance, key
			}
		}
	}

	return nil, ""
}

func dropVFSInstance(instance *vfs.VFS) {
	if instance == nil {
		return
	}

	// 1. Close and forget all active handles belonging to this VFS
	vfsHandleMutex.Lock()
	var toClose []vfs.Handle
	for id, entry := range vfsHandles {
		if entry.vfs == instance {
			toClose = append(toClose, entry.handle)
			delete(vfsHandles, id)
		}
	}
	vfsHandleMutex.Unlock()

	for _, h := range toClose {
		_ = h.Close()
	}

	// 2. Flush on-disk cache if exists
	_ = instance.CleanUp()

	// 3. Shutdown VFS (stops polling goroutines, cancels ctx, removes from rclone active map)
	instance.Shutdown()
}

func dropMatchingVFS(fsName string) {
	norm := normalizeFsName(fsName)
	vfsMutex.Lock()
	var targets []*vfs.VFS
	seen := make(map[*vfs.VFS]bool)
	var keysToDelete []string

	for key, instance := range vfsInstances {
		if key == fsName || normalizeFsName(key) == norm || (instance != nil && instance.Fs() != nil && (normalizeFsName(instance.Fs().Name()) == norm || normalizeFsName(fs.ConfigString(instance.Fs())) == norm)) {
			if instance != nil && !seen[instance] {
				seen[instance] = true
				targets = append(targets, instance)
			}
			keysToDelete = append(keysToDelete, key)
		}
	}
	for _, k := range keysToDelete {
		delete(vfsInstances, k)
	}
	vfsMutex.Unlock()

	for _, inst := range targets {
		dropVFSInstance(inst)
	}
}

func dropAllVFS() {
	vfsMutex.Lock()
	var targets []*vfs.VFS
	seen := make(map[*vfs.VFS]bool)
	for key, instance := range vfsInstances {
		if instance != nil && !seen[instance] {
			seen[instance] = true
			targets = append(targets, instance)
		}
		delete(vfsInstances, key)
	}
	vfsMutex.Unlock()

	for _, inst := range targets {
		dropVFSInstance(inst)
	}
}

func rcSetCacheDir(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	path, err := in.GetString("path")
	if err != nil || path == "" {
		return nil, errors.New("config/setcachedir requires path parameter")
	}
	cachePath := filepath.Clean(path)
	if filepath.Base(cachePath) != "rclone" {
		cachePath = filepath.Join(cachePath, "rclone")
	}
	_ = os.MkdirAll(cachePath, 0700)
	err = config.SetCacheDir(cachePath)
	if err != nil {
		return nil, fmt.Errorf("failed to set cache dir: %w", err)
	}
	return rc.Params{"success": true, "cache_dir": config.GetCacheDir()}, nil
}

func init() {
	initAndroidTrustStore()
	ensureWritableCacheDir()

	go startHandleSweeper()

	rc.Add(rc.Call{
		Path:  "config/setcachedir",
		Fn:    rcSetCacheDir,
		Title: "Set root cache directory for rclone.",
		Help:  "Sets the cache directory path used by rclone VFS and other subsystems.",
	})
	rc.Add(rc.Call{
		Path:  "vfs/stream/mount",
		Fn:    rcVfsMount,
		Title: "Mount SAF VFS stream.",
		Help:  "Pre-initializes and registers a VFS instance with full vfsOpt, _config, and _filter options.",
	})
	rc.Add(rc.Call{
		Path:  "vfs/stream/unmount",
		Fn:    rcVfsUnmount,
		Title: "Unmount SAF VFS stream.",
		Help:  "Cleans up and forgets an active VFS instance for specified remote.",
	})
	rc.Add(rc.Call{
		Path:  "vfs/stream/list",
		Fn:    rcVfsList,
		Title: "List directory via VFS.",
		Help:  "Returns directory entries via active VFS instance.",
	})
	rc.Add(rc.Call{
		Path:  "vfs/stream/stat",
		Fn:    rcVfsStat,
		Title: "Stat node via VFS.",
		Help:  "Returns file or directory metadata via VFS.",
	})
	rc.Add(rc.Call{
		Path:  "vfs/stream/open",
		Fn:    rcVfsOpen,
		Title: "Open VFS handle.",
		Help:  "Opens a VFS file handle for reading or writing.",
	})
	rc.Add(rc.Call{
		Path:  "vfs/stream/read",
		Fn:    rcVfsRead,
		Title: "Read chunk from VFS handle.",
		Help:  "Reads bytes at specified offset from open VFS handle.",
	})
	rc.Add(rc.Call{
		Path:  "vfs/stream/write",
		Fn:    rcVfsWrite,
		Title: "Write chunk to VFS handle.",
		Help:  "Writes bytes at specified offset to open VFS handle.",
	})
	rc.Add(rc.Call{
		Path:  "vfs/stream/close",
		Fn:    rcVfsClose,
		Title: "Close VFS handle.",
		Help:  "Closes open VFS handle.",
	})
	rc.Add(rc.Call{
		Path:  "vfs/stream/forget",
		Fn:    rcVfsForget,
		Title: "Forget VFS cache for a remote.",
		Help:  "Flushes directory and file cache for specified remote.",
	})
}

func startHandleSweeper() {
	ticker := time.NewTicker(1 * time.Minute)
	for range ticker.C {
		cleanupIdleHandles(defaultHandleIdleTimeout)
	}
}

func cleanupIdleHandles(timeout time.Duration) {
	vfsHandleMutex.Lock()
	now := time.Now()
	var toClose []vfs.Handle
	for id, entry := range vfsHandles {
		if now.Sub(entry.lastAccess) > timeout {
			toClose = append(toClose, entry.handle)
			delete(vfsHandles, id)
		}
	}
	vfsHandleMutex.Unlock()

	for _, h := range toClose {
		_ = h.Close()
	}
}

func rcVfsMount(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	fsName, err := in.GetString("fs")
	if err != nil || fsName == "" {
		return nil, errors.New("vfs/stream/mount requires fs parameter")
	}

	vfsOpt := vfscommon.Opt
	vfsOpt.CacheMode = vfscommon.CacheModeWrites
	vfsOpt.ChunkSize = 2 * fs.Mebi
	vfsOpt.ChunkSizeLimit = 8 * fs.Mebi

	// 1. Parse vfsOpt from parameters
	_ = rc.ParseOptions(in, "vfsOpt", &vfsOpt)

	// 2. Parse backend config options (_config) and filters (_filter)
	ctx, err = rc.AddConfig(ctx, in)
	if err != nil {
		return nil, fmt.Errorf("failed to add config: %w", err)
	}
	ctx, err = rc.AddFilter(ctx, in)
	if err != nil {
		return nil, fmt.Errorf("failed to add filter: %w", err)
	}

	// 3. Resolve fs.Fs using rclone's standard loader (respecting _config, _filter, backend flags)
	f, err := rc.GetFs(ctx, in)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve filesystem for %s: %w", fsName, err)
	}

	// If replacing an existing instance for this remote, drop it cleanly first
	dropMatchingVFS(fsName)

	ensureWritableCacheDir()

	// 4. Create VFS instance (this automatically registers the VFS in rclone's active cache for vfs/list and vfs/stats)
	instance := vfs.New(ctx, f, &vfsOpt)

	vfsMutex.Lock()
	vfsInstances[fsName] = instance
	vfsMutex.Unlock()

	return rc.Params{
		"fs":  fsName,
		"vfs": fs.ConfigString(f),
	}, nil
}

func rcVfsUnmount(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	fsName, _ := in.GetString("fs")
	if fsName == "" || fsName == "*" {
		dropAllVFS()
		return rc.Params{"success": true}, nil
	}

	dropMatchingVFS(fsName)

	return rc.Params{"success": true}, nil
}

func getOrCreateVFS(fsName string) (*vfs.VFS, error) {
	vfsMutex.Lock()
	instance, _ := findMatchingVFS(fsName)
	vfsMutex.Unlock()

	if instance != nil {
		return instance, nil
	}

	return createDefaultVFS(fsName)
}

func createDefaultVFS(fsName string) (*vfs.VFS, error) {
	vfsMutex.Lock()
	defer vfsMutex.Unlock()

	if instance, _ := findMatchingVFS(fsName); instance != nil {
		return instance, nil
	}

	f, err := fs.NewFs(context.Background(), fsName)
	if err != nil {
		return nil, fmt.Errorf("failed to create fs for %s: %w", fsName, err)
	}

	opts := vfscommon.Opt
	opts.CacheMode = vfscommon.CacheModeWrites
	opts.ChunkSize = 2 * fs.Mebi
	opts.ChunkSizeLimit = 8 * fs.Mebi

	ensureWritableCacheDir()

	instance := vfs.New(context.Background(), f, &opts)
	vfsInstances[fsName] = instance
	return instance, nil
}

func readDir(v *vfs.VFS, path string) ([]os.FileInfo, error) {
	f, err := v.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	if !f.Node().IsDir() {
		return nil, syscall.ENOTDIR
	}

	return f.Readdir(-1)
}

func rcVfsList(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	fsName, err := in.GetString("fs")
	if err != nil || fsName == "" {
		return nil, errors.New("vfs/stream/list requires fs parameter")
	}
	remotePath, _ := in.GetString("remote")

	v, err := getOrCreateVFS(fsName)
	if err != nil {
		return nil, err
	}

	entries, err := readDir(v, remotePath)
	if err != nil {
		return nil, err
	}

	var list []rc.Params
	for _, item := range entries {
		list = append(list, rc.Params{
			"Name":    item.Name(),
			"Path":    fspath.JoinRootPath(remotePath, item.Name()),
			"Size":    item.Size(),
			"IsDir":   item.IsDir(),
			"ModTime": item.ModTime().Format(time.RFC3339),
		})
	}
	return rc.Params{"list": list}, nil
}

func rcVfsStat(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	fsName, err := in.GetString("fs")
	if err != nil || fsName == "" {
		return nil, errors.New("vfs/stream/stat requires fs parameter")
	}
	remotePath, _ := in.GetString("remote")

	v, err := getOrCreateVFS(fsName)
	if err != nil {
		return nil, err
	}

	node, err := v.Stat(remotePath)
	if err != nil {
		return nil, err
	}

	return rc.Params{
		"item": rc.Params{
			"Name":    node.Name(),
			"Path":    remotePath,
			"Size":    node.Size(),
			"IsDir":   node.IsDir(),
			"ModTime": node.ModTime().Format(time.RFC3339),
		},
	}, nil
}

func rcVfsOpen(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	fsName, err := in.GetString("fs")
	if err != nil || fsName == "" {
		return nil, errors.New("vfs/stream/open requires fs parameter")
	}
	remotePath, _ := in.GetString("remote")
	modeStr, _ := in.GetString("mode")

	v, err := getOrCreateVFS(fsName)
	if err != nil {
		return nil, err
	}

	flags := os.O_RDONLY
	if modeStr == "w" || modeStr == "rw" {
		flags = os.O_RDWR | os.O_CREATE
	}

	handle, err := v.OpenFile(remotePath, flags, 0644)
	if err != nil {
		return nil, err
	}

	handleID := atomic.AddInt64(&vfsNextHandle, 1)

	vfsHandleMutex.Lock()
	vfsHandles[handleID] = &vfsHandleEntry{
		handle:     handle,
		vfs:        v,
		lastAccess: time.Now(),
	}
	vfsHandleMutex.Unlock()

	fi, _ := handle.Stat()
	size := int64(0)
	if fi != nil {
		size = fi.Size()
	}

	return rc.Params{
		"handle_id": handleID,
		"size":      size,
	}, nil
}

func rcVfsRead(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	handleID, err := in.GetInt64("handle_id")
	if err != nil {
		return nil, err
	}
	offset, _ := in.GetInt64("offset")
	count, _ := in.GetInt64("count")
	if count <= 0 || count > 4*1024*1024 {
		count = 512 * 1024
	}

	vfsHandleMutex.Lock()
	entry, ok := vfsHandles[handleID]
	if ok {
		entry.lastAccess = time.Now()
	}
	vfsHandleMutex.Unlock()
	if !ok {
		return nil, errors.New("invalid handle id")
	}

	buf := make([]byte, count)
	n, err := entry.handle.ReadAt(buf, offset)
	if err != nil && err != io.EOF {
		return nil, err
	}

	encoded := base64.StdEncoding.EncodeToString(buf[:n])
	return rc.Params{
		"bytes_read": n,
		"data":       encoded,
	}, nil
}

func rcVfsWrite(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	handleID, err := in.GetInt64("handle_id")
	if err != nil {
		return nil, err
	}
	offset, _ := in.GetInt64("offset")
	dataStr, err := in.GetString("data")
	if err != nil {
		return nil, err
	}

	data, err := base64.StdEncoding.DecodeString(dataStr)
	if err != nil {
		return nil, err
	}

	vfsHandleMutex.Lock()
	entry, ok := vfsHandles[handleID]
	if ok {
		entry.lastAccess = time.Now()
	}
	vfsHandleMutex.Unlock()
	if !ok {
		return nil, errors.New("invalid handle id")
	}

	n, err := entry.handle.WriteAt(data, offset)
	if err != nil && err != io.EOF {
		return nil, err
	}

	return rc.Params{"bytes_written": n}, nil
}

func rcVfsClose(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	handleID, err := in.GetInt64("handle_id")
	if err != nil {
		return nil, err
	}

	vfsHandleMutex.Lock()
	entry, ok := vfsHandles[handleID]
	delete(vfsHandles, handleID)
	vfsHandleMutex.Unlock()

	if !ok {
		return rc.Params{"success": true}, nil
	}

	err = entry.handle.Close()
	if err != nil {
		return nil, err
	}

	return rc.Params{"success": true}, nil
}

func rcVfsForget(ctx context.Context, in rc.Params) (out rc.Params, err error) {
	fsName, _ := in.GetString("fs")
	if fsName != "" {
		vfsMutex.Lock()
		instance, _ := findMatchingVFS(fsName)
		vfsMutex.Unlock()
		if instance != nil {
			if root, err := instance.Root(); err == nil && root != nil {
				root.ForgetAll()
			}
			_ = instance.CleanUp()
		}
	} else {
		vfsMutex.Lock()
		var instances []*vfs.VFS
		for _, inst := range vfsInstances {
			instances = append(instances, inst)
		}
		vfsMutex.Unlock()
		for _, inst := range instances {
			if root, err := inst.Root(); err == nil && root != nil {
				root.ForgetAll()
			}
			_ = inst.CleanUp()
		}
	}
	return rc.Params{"success": true}, nil
}

func initAndroidTrustStore() {
	if _, err := os.Stat("/system/etc/security/cacerts"); err != nil {
		return
	}

	addDirs := []string{
		"/apex/com.android.conscrypt/cacerts",
		"/system/etc/security/cacerts",
	}

	uid := os.Getuid() / 100000
	userCaDir := fmt.Sprintf("/data/misc/user/%d/cacerts-added", uid)
	if _, err := os.Stat(userCaDir); err == nil {
		addDirs = append(addDirs, userCaDir)
	}

	pool := x509.NewCertPool()
	loadedCount := 0

	for _, dir := range addDirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			path := filepath.Join(dir, entry.Name())
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			if pool.AppendCertsFromPEM(data) {
				loadedCount++
			}
		}
	}
	if loadedCount > 0 {
		fs.Infof(nil, "Loaded %d Android CA certificates into trust pool", loadedCount)
	}
}

//export RcloneVfsRead
func RcloneVfsRead(handleID int64, offset int64, count int32, outPtr *byte) int32 {
	if count <= 0 || outPtr == nil {
		return -1
	}

	vfsHandleMutex.Lock()
	entry, ok := vfsHandles[handleID]
	if ok {
		entry.lastAccess = time.Now()
	}
	vfsHandleMutex.Unlock()
	if !ok {
		return -1
	}

	buf := unsafe.Slice(outPtr, count)
	n, err := entry.handle.ReadAt(buf, offset)
	if err != nil && err != io.EOF {
		return -1
	}
	return int32(n)
}

//export RcloneVfsWrite
func RcloneVfsWrite(handleID int64, offset int64, count int32, inPtr *byte) int32 {
	if count <= 0 || inPtr == nil {
		return -1
	}

	vfsHandleMutex.Lock()
	entry, ok := vfsHandles[handleID]
	if ok {
		entry.lastAccess = time.Now()
	}
	vfsHandleMutex.Unlock()
	if !ok {
		return -1
	}

	data := unsafe.Slice(inPtr, count)
	n, err := entry.handle.WriteAt(data, offset)
	if err != nil && err != io.EOF {
		return -1
	}
	return int32(n)
}

