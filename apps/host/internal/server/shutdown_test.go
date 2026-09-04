package server

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestShutdownWaitsForActiveRequest(t *testing.T) {
	l, err := ListenLocal("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	done := make(chan error, 1)
	go func() {
		done <- serve(ctx, l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			close(entered)
			<-release
			_, _ = io.WriteString(w, "finished")
		}), time.Second)
	}()
	response := make(chan string, 1)
	go func() {
		client := &http.Client{Timeout: 2 * time.Second}
		res, err := client.Get("http://" + l.Addr().String() + "/")
		if err != nil {
			response <- err.Error()
			return
		}
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		if err != nil {
			response <- err.Error()
			return
		}
		response <- string(body)
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case <-done:
		t.Fatal("host exited before request drained")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	select {
	case body := <-response:
		if body != "finished" {
			t.Fatalf("response %q", body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("response timed out")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown timed out")
	}
}

func TestShutdownClosesRequestAfterDeadline(t *testing.T) {
	l, err := ListenLocal("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered, requestCancelled := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- serve(ctx, l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			close(entered)
			<-r.Context().Done()
			close(requestCancelled)
		}), 20*time.Millisecond)
	}()
	go func() {
		client := &http.Client{Timeout: 2 * time.Second}
		if res, err := client.Get("http://" + l.Addr().String() + "/"); err == nil {
			res.Body.Close()
		}
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case <-requestCancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("request not cancelled after deadline")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("host hung past shutdown deadline")
	}
}
