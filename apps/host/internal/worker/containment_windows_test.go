//go:build windows

package worker

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Child mode starts only through this test's exact argv and per-child env.
// It waits for the parent to attach the outer job before creating descendants.
func TestContainmentChild(t *testing.T) {
	role := os.Getenv("ARMADRA_JOB_TEST_ROLE")
	if role == "" {
		return
	}
	if role == "parent" {
		scanner := bufio.NewScanner(os.Stdin)
		if !scanner.Scan() || scanner.Text() != "attached" {
			os.Exit(2)
		}
		child := exec.Command(os.Args[0], "-test.run=^TestContainmentChild$")
		child.Env = jobTestEnv("child")
		if child.Start() != nil {
			os.Exit(3)
		}
		fmt.Println(child.Process.Pid)
	}
	for {
		time.Sleep(time.Hour)
	}
}
func jobTestEnv(role string) []string {
	values := make([]string, 0)
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "ARMADRA_JOB_TEST_ROLE=") {
			values = append(values, value)
		}
	}
	return append(values, "ARMADRA_JOB_TEST_ROLE="+role)
}
func TestCommandContainmentStopsDescendants(t *testing.T) {
	for _, closeHandle := range []bool{false, true} {
		name := "terminate"
		if closeHandle {
			name = "host-handle-close"
		}
		t.Run(name, func(t *testing.T) {
			c, err := newContainment(true)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestContainmentChild$")
			command.Env = jobTestEnv("parent")
			stdin, err := command.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			stdout, err := command.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err = command.Start(); err != nil {
				t.Fatal(err)
			}
			defer command.Process.Kill()
			if err = c.Attach(command.Process); err != nil {
				t.Fatal(err)
			}
			if _, err = fmt.Fprintln(stdin, "attached"); err != nil {
				t.Fatal(err)
			}
			scanner := bufio.NewScanner(stdout)
			if !scanner.Scan() {
				t.Fatalf("missing child PID: %v", scanner.Err())
			}
			pid, err := strconv.Atoi(scanner.Text())
			if err != nil {
				t.Fatal(err)
			}
			child, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
			if err != nil {
				t.Fatal(err)
			}
			defer windows.CloseHandle(child)
			if closeHandle {
				err = c.Close()
			} else {
				err = c.Stop()
			}
			if err != nil {
				t.Fatal(err)
			}
			if !closeHandle {
				if err = c.Wait(ctx); err != nil {
					t.Fatal(err)
				}
			}
			status, err := windows.WaitForSingleObject(child, 5000)
			if err != nil || status != windows.WAIT_OBJECT_0 {
				t.Fatalf("descendant still alive: %v %v", status, err)
			}
			done := make(chan error, 1)
			go func() { done <- command.Wait() }()
			select {
			case <-done:
			case <-ctx.Done():
				t.Fatal("Worker process was not reaped")
			}
		})
	}
}
