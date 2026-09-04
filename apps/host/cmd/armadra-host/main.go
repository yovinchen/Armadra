package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"armadra.local/host/internal/hoststate"
	"armadra.local/host/internal/server"
)

func main() {
	if err := run(os.Args[1:]); err != nil && !errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(os.Stderr, "armadra-host:", err)
		os.Exit(1)
	}
}

func run(args []string) (err error) {
	flags := flag.NewFlagSet("armadra-host", flag.ContinueOnError)
	address := flags.String("listen", "127.0.0.1:43121", "Local protocol listener (loopback IP only)")
	dataDir := flags.String("data-dir", "", "Host data directory (default: per-user Armadra/host)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments")
	}
	if *dataDir == "" {
		*dataDir, err = hoststate.DefaultDir()
		if err != nil {
			return err
		}
	}
	state, err := hoststate.Open(*dataDir)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := state.Close(); err == nil {
			err = closeErr
		}
	}()
	listener, err := server.ListenLocal(*address)
	if err != nil {
		return err
	}
	defer listener.Close()
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	fmt.Printf("armadra-host listening on http://%s\n", listener.Addr())
	return server.Serve(ctx, listener, server.Identity{HostID: state.ID, InstanceID: hex.EncodeToString(id[:])})
}
