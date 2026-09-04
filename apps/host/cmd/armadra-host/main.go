package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"armadra.local/host/internal/server"
)

func main() {
	address := flag.String("listen", "127.0.0.1:43121", "Local protocol listener (loopback IP only)")
	flag.Parse()
	if flag.NArg() != 0 {
		log.Fatal("unexpected positional arguments")
	}
	listener, err := server.ListenLocal(*address)
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		log.Fatal(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	fmt.Printf("armadra-host listening on http://%s\n", listener.Addr())
	if err := server.Serve(ctx, listener, hex.EncodeToString(id[:])); err != nil {
		log.Fatal(err)
	}
}
