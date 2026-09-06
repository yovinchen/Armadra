import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SshHost, SshHostKeyScan } from "@armadra/shared";

const api = vi.hoisted(() => ({
  scan: vi.fn(),
  trust: vi.fn(),
  forget: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  runtimeApi: {
    scanSshHostKeys: api.scan,
    trustSshHostKey: api.trust,
    forgetSshHostKeys: api.forget,
  },
}));

import { HostKeyDialog } from "./HostKeyDialog";
import { usePreferencesStore } from "@/app/preferences-store";

const host: SshHost = { id: "box", name: "Box", host: "box.test" };
const fresh: SshHostKeyScan = {
  keys: [
    {
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:newnewnew",
      line: "box.test ssh-ed25519 AAAAnew",
      trusted: false,
    },
  ],
  changed: false,
  known: [],
};
const changed: SshHostKeyScan = {
  ...fresh,
  changed: true,
  known: ["SHA256:oldoldold"],
};

function mount() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HostKeyDialog host={host} />
    </QueryClientProvider>,
  );
}

function open() {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "主机密钥" }));
}

beforeEach(() => {
  api.scan.mockReset().mockResolvedValue(fresh);
  api.trust.mockReset().mockResolvedValue({ ...fresh, changed: false });
  api.forget.mockReset().mockResolvedValue(undefined);
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(cleanup);

describe("HostKeyDialog", () => {
  it("scans nothing until it is opened, then shows the fingerprint untrusted", async () => {
    mount();
    // A closed dialog talks to nobody: opening it is the read.
    expect(api.scan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "主机密钥" }));
    await waitFor(() =>
      expect(api.scan).toHaveBeenCalledExactlyOnceWith("box"),
    );
    await screen.findByText("SHA256:newnewnew");
    expect(screen.getByText("ssh-ed25519")).toBeTruthy();
    // The whole point of the dialog: the person compares first, then clicks.
    expect(api.trust).not.toHaveBeenCalled();
    expect(screen.queryByText("已信任")).toBeNull();
    expect(screen.getByRole("button", { name: "信任" })).toBeTruthy();
  });

  it("records a first key without ever asking to replace one", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "信任" }));
    await waitFor(() =>
      expect(api.trust).toHaveBeenCalledExactlyOnceWith(
        "box",
        "box.test ssh-ed25519 AAAAnew",
        false,
      ),
    );
  });

  it("shows the known fingerprint beside a changed key and needs an explicit replace", async () => {
    api.scan.mockResolvedValue(changed);
    api.trust.mockResolvedValue(fresh);
    open();
    await screen.findByText("密钥已变更");
    // Old and new side by side is what makes the decision possible at all.
    expect(screen.getAllByText("SHA256:oldoldold").length).toBeGreaterThan(0);
    expect(screen.getByText("SHA256:newnewnew")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "替换" }));
    expect(api.trust).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/SHA256:newnewnew/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    expect(api.trust).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "替换" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "确认替换",
      }),
    );
    await waitFor(() =>
      expect(api.trust).toHaveBeenCalledExactlyOnceWith(
        "box",
        "box.test ssh-ed25519 AAAAnew",
        true,
      ),
    );
  });

  it("offers no trust action for a key already on record", async () => {
    api.scan.mockResolvedValue({
      keys: [{ ...fresh.keys[0]!, trusted: true }],
      changed: false,
      known: ["SHA256:newnewnew"],
    });
    open();
    await screen.findByText("已信任");
    expect(screen.queryByRole("button", { name: "信任" })).toBeNull();
    expect(screen.queryByRole("button", { name: "替换" })).toBeNull();
  });

  it("re-scans after forgetting instead of claiming the file is now empty", async () => {
    open();
    await screen.findByText("SHA256:newnewnew");
    fireEvent.click(screen.getByRole("button", { name: "清除信任" }));
    await waitFor(() =>
      expect(api.forget).toHaveBeenCalledExactlyOnceWith("box"),
    );
    await waitFor(() => expect(api.scan).toHaveBeenCalledTimes(2));
  });
});
