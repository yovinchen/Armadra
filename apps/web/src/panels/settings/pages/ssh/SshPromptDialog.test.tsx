import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { SshPrompt } from "@armadra/shared";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  answer: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  runtimeApi: {
    sshPrompts: api.list,
    answerSshPrompt: api.answer,
    cancelSshPrompt: api.cancel,
  },
}));

import { SshPromptDialog } from "./SshPromptDialog";
import { dispatchWorkspaceEvent, resetWorkspaceEvents } from "@/api/events";
import { usePreferencesStore } from "@/app/preferences-store";

const password: SshPrompt = {
  promptId: "p-1",
  hostId: "box",
  kind: "password",
  prompt: "me@box.test's password:",
};
const passphrase: SshPrompt = {
  promptId: "p-2",
  hostId: "box",
  kind: "passphrase",
  prompt: "Enter passphrase for key '/home/me/.ssh/id_ed25519':",
};
const SECRET = "correct-horse-battery-staple";

beforeEach(() => {
  api.list.mockReset().mockResolvedValue([]);
  api.answer.mockReset().mockResolvedValue(undefined);
  api.cancel.mockReset().mockResolvedValue(undefined);
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(() => {
  cleanup();
  resetWorkspaceEvents();
});

describe("SshPromptDialog", () => {
  it("stays closed until something is actually waiting", async () => {
    render(<SshPromptDialog />);
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks for what a fresh page missed and masks the field", async () => {
    api.list.mockResolvedValue([passphrase]);
    render(<SshPromptDialog />);
    const input = (await screen.findByLabelText(
      "密钥口令",
    )) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(screen.getByText(/id_ed25519/)).toBeTruthy();
  });

  it("clears the answer from state as it submits and never shows it again", async () => {
    render(<SshPromptDialog />);
    act(() => dispatchWorkspaceEvent({ type: "ssh.prompt", prompt: password }));
    const input = (await screen.findByLabelText("密码")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.submit(input.closest("form")!);
    // The secret leaves React state in the same tick it leaves for the runtime.
    expect(input.value).toBe("");
    await waitFor(() =>
      expect(api.answer).toHaveBeenCalledExactlyOnceWith("box", "p-1", SECRET),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("keeps the field empty when the answer could not be sent", async () => {
    api.answer.mockRejectedValue(new Error("nope"));
    render(<SshPromptDialog />);
    act(() => dispatchWorkspaceEvent({ type: "ssh.prompt", prompt: password }));
    const input = (await screen.findByLabelText("密码")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(api.answer).toHaveBeenCalledOnce());
    // A retry retypes it: a failed send is no reason to keep a secret around.
    await waitFor(() => expect(input.value).toBe(""));
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("cancels on close so ssh fails instead of hanging, then asks the next one", async () => {
    render(<SshPromptDialog />);
    act(() => {
      dispatchWorkspaceEvent({ type: "ssh.prompt", prompt: password });
      dispatchWorkspaceEvent({ type: "ssh.prompt", prompt: passphrase });
    });
    await screen.findByLabelText("密码");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(api.cancel).toHaveBeenCalledExactlyOnceWith("box", "p-1"),
    );
    // One at a time; the queued prompt is asked rather than dropped.
    expect(await screen.findByLabelText("密钥口令")).toBeTruthy();
  });

  it("ignores a repeat of a prompt it is already asking about", async () => {
    render(<SshPromptDialog />);
    act(() => {
      dispatchWorkspaceEvent({ type: "ssh.prompt", prompt: password });
      dispatchWorkspaceEvent({ type: "ssh.prompt", prompt: password });
    });
    await screen.findByLabelText("密码");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
