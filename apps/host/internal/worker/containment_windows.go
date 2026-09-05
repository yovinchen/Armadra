//go:build windows

package worker

import (
	"context"
	"errors"
	"os"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The handle is private and never inherited. Closing the Host therefore kills
// its Worker and the Worker's command descendants, including nested jobs.
type windowsContainment struct {
	mu  sync.Mutex
	job windows.Handle
}

func newContainment(enabled bool) (containment, error) {
	if !enabled {
		return nil, nil
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)))
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	return &windowsContainment{job: job}, nil
}

func (c *windowsContainment) Attach(process *os.Process) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.job == 0 {
		return errors.New("worker containment is closed")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(process.Pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	return windows.AssignProcessToJobObject(c.job, handle)
}

func (c *windowsContainment) Stop() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.job == 0 {
		return errors.New("worker containment is closed")
	}
	return windows.TerminateJobObject(c.job, 1)
}

// Windows' fixed-layout JOBOBJECT_BASIC_ACCOUNTING_INFORMATION. All members
// before ActiveProcesses are retained so the kernel reads the documented ABI.
type jobAccounting struct {
	TotalUserTime, TotalKernelTime                                                 int64
	ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime                             int64
	TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses uint32
}

func (c *windowsContainment) active() (uint32, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.job == 0 {
		return 0, errors.New("worker containment closed before cleanup confirmation")
	}
	var stats jobAccounting
	err := windows.QueryInformationJobObject(c.job, windows.JobObjectBasicAccountingInformation,
		uintptr(unsafe.Pointer(&stats)), uint32(unsafe.Sizeof(stats)), nil)
	return stats.ActiveProcesses, err
}

func (c *windowsContainment) Wait(ctx context.Context) error {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		active, err := c.active()
		if err != nil {
			return err
		}
		if active == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (c *windowsContainment) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.job == 0 {
		return nil
	}
	err := windows.CloseHandle(c.job)
	if err == nil {
		c.job = 0
	}
	return err
}
