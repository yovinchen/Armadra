// Entry point and command dispatch for the Armadra Host binary. The
// subcommands themselves live in config.go, serve.go, commands.go and the
// server-mode files beside them.

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	if err := run(os.Args[1:]); err != nil && !errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(os.Stderr, "Armadra:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	c, err := parseConfig(args)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch c.command {
	case "pair":
		return pairDevice(ctx, c)
	case "import":
		return importBundle(ctx, c)
	case "ownership":
		if c.ownership.action == "window" {
			return runMaintenanceWindow(ctx, c)
		}
		return runOwnership(ctx, c)
	case "start":
		return startBackground(ctx, c)
	case "status":
		return showServiceStatus(ctx, c)
	case "install":
		return installService(ctx, c)
	case "uninstall":
		return uninstallService(ctx, c)
	case "logs":
		return showLogs(ctx, c)
	case "upgrade":
		return upgradeHost(ctx, c)
	case "version":
		return showVersion(c)
	case "stop":
		return stopBackground(ctx, c.dataDir, c.output)
	default:
		return serveHost(ctx, c)
	}
}
