package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/rclone/rclone/fs/rc"
)

func TestMediaReadCancellation(t *testing.T) {
	started := make(chan struct{})
	finished := make(chan error, 1)
	read := cancellableMediaRead(func(ctx context.Context, _ rc.Params) (rc.Params, error) {
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	go func() {
		_, err := read(context.Background(), rc.Params{"readToken": "cancel-active"})
		finished <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("read did not start")
	}
	if _, err := cancelMediaRead(context.Background(), rc.Params{"readToken": "cancel-active"}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("unexpected result: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("read did not cancel")
	}
}

func TestCancellationBeforeReadStarts(t *testing.T) {
	in := rc.Params{"readToken": "cancel-before-start"}
	if _, err := cancelMediaRead(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	called := false
	read := cancellableMediaRead(func(_ context.Context, _ rc.Params) (rc.Params, error) { called = true; return rc.Params{}, nil })
	if _, err := read(context.Background(), in); !errors.Is(err, context.Canceled) {
		t.Fatalf("unexpected result: %v", err)
	}
	if called {
		t.Fatal("cancelled read reached the filesystem")
	}
	mediaReads.Lock()
	_, retained := mediaReads.cancels["cancel-before-start"]
	mediaReads.Unlock()
	if retained {
		t.Fatal("finished read retained its cancellation entry")
	}
}

func TestDuplicateReadTokenDoesNotDetachTheOriginalRead(t *testing.T) {
	in := rc.Params{"readToken": "duplicate-active"}
	started := make(chan struct{})
	finished := make(chan error, 1)
	read := cancellableMediaRead(func(ctx context.Context, _ rc.Params) (rc.Params, error) {
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	go func() { _, err := read(context.Background(), in); finished <- err }()
	t.Cleanup(func() { _, _ = cancelMediaRead(context.Background(), in) })
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("read did not start")
	}
	if _, err := read(context.Background(), in); err == nil || err.Error() != "readToken is already active" {
		t.Fatalf("duplicate token was not rejected: %v", err)
	}
	_, _ = cancelMediaRead(context.Background(), in)
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("original read lost cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("original read was detached")
	}
}
