package main

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/rclone/rclone/fs/rc"
)

// Cancellation can race with the blocking FFI call starting. A nil entry is a
// cancellation that arrived first; the scheduled read consumes and removes it.
var mediaReads = struct {
	sync.Mutex
	cancels map[string]context.CancelFunc
}{cancels: make(map[string]context.CancelFunc)}

func init() {
	// Wrap the stock operations/getfile in place rather than adding a second
	// read call: callers without a readToken get exactly the upstream behavior.
	getfile := rc.Calls.Get("operations/getfile")
	if getfile == nil {
		panic("operations/getfile is required for media reads")
	}
	patched := *getfile
	patched.Fn = cancellableMediaRead(getfile.Fn)
	patched.Help += "\n\nThis build also accepts an optional readToken. A read that has one stops after\n30 seconds, or as soon as operations/cancelread is called with the same token.\n"
	rc.Add(patched)
	rc.Add(rc.Call{Path: "operations/cancelread", Fn: cancelMediaRead, Title: "Cancel an in-process file read"})
}

func cancellableMediaRead(read rc.Func) rc.Func {
	return func(ctx context.Context, in rc.Params) (rc.Params, error) {
		token, err := in.GetString("readToken")
		if rc.IsErrParamNotFound(err) {
			return read(ctx, in)
		}
		if err != nil || token == "" {
			return nil, errors.New("readToken must be a non-empty string")
		}
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		mediaReads.Lock()
		previous, cancelled := mediaReads.cancels[token]
		if cancelled && previous != nil {
			mediaReads.Unlock()
			cancel()
			return nil, errors.New("readToken is already active")
		}
		if cancelled {
			cancel()
		} else {
			mediaReads.cancels[token] = cancel
		}
		mediaReads.Unlock()
		defer func() {
			cancel()
			mediaReads.Lock()
			delete(mediaReads.cancels, token)
			mediaReads.Unlock()
		}()
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return read(ctx, in)
	}
}

func cancelMediaRead(_ context.Context, in rc.Params) (rc.Params, error) {
	token, err := in.GetString("readToken")
	if err != nil || token == "" {
		return nil, errors.New("readToken is required")
	}
	mediaReads.Lock()
	cancel := mediaReads.cancels[token]
	mediaReads.cancels[token] = nil
	mediaReads.Unlock()
	if cancel != nil {
		cancel()
	}
	// A cancel can arrive just after a read completed. Retire that tombstone;
	// the normal starting-read race consumes it immediately.
	time.AfterFunc(30*time.Second, func() {
		mediaReads.Lock()
		if mediaReads.cancels[token] == nil {
			delete(mediaReads.cancels, token)
		}
		mediaReads.Unlock()
	})
	return rc.Params{}, nil
}
