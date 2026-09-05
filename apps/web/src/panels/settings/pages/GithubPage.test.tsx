import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { create, GithubCredentialStatusSchema } from "@armadra/protocol";

const store = vi.hoisted(() => ({
  workspace: { id: "workspace-1", rootPath: "/tmp" },
}));

const session = vi.hoisted(() => ({
  state: { status: "idle" } as Record<string, unknown>,
  client: null as unknown,
  connect: vi.fn(async () => {}),
  reset: vi.fn(),
}));

vi.mock("../../../store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

vi.mock("../../../host/github-session", () => {
  const useGithubSession = <T,>(selector: (state: typeof session) => T) =>
    selector(session);
  useGithubSession.getState = () => session;
  return { useGithubSession };
});

import { GithubPage } from "./GithubPage";

/** A status that would echo a token back if the page ever trusted one. */
const status = create(GithubCredentialStatusSchema, {
  source: 3,
  store: 3,
  available: true,
  apiBase: "https://api.github.com",
  accountLogin: "octocat",
  tokenScopes: ["repo", "read:org"],
  revision: 3n,
  checkedAtUnixMs: 1_788_557_900_000n,
});

function client(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "workspace-1",
    getCredential: vi.fn(async () => status),
    configureCredential: vi.fn(async () => status),
    revokeCredential: vi.fn(async () =>
      create(GithubCredentialStatusSchema, {
        source: 1,
        store: 1,
        available: false,
        apiBase: "https://api.github.com",
        reasonCode: "NO_CREDENTIAL",
        revision: 4n,
      }),
    ),
    ...overrides,
  };
}

function renderPage(api: ReturnType<typeof client>) {
  session.state = { status: "blocked", reason: "noCredential" };
  session.client = api;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GithubPage />
    </QueryClientProvider>,
  );
}

function tokenField(): HTMLInputElement {
  return document.querySelector(
    "[data-slot='github-token']",
  ) as HTMLInputElement;
}

beforeEach(() => {
  session.connect.mockClear();
  session.state = { status: "idle" };
  session.client = null;
});
afterEach(cleanup);

describe("GitHub credential settings", () => {
  it("shows what the stored credential can do, including the degraded store", async () => {
    renderPage(client());
    expect(await screen.findByText("octocat")).toBeTruthy();
    expect(screen.getByText("现在可以取得令牌")).toBeTruthy();
    // The 0600 file fallback is named as a fallback, not as "stored securely".
    expect(screen.getByText("0600 文件（降级）")).toBeTruthy();
    expect(screen.getByText(/系统钥匙串不可用/)).toBeTruthy();
    expect(screen.getByText("repo, read:org")).toBeTruthy();
  });

  it("shows the machine reason code when no token can be produced", async () => {
    renderPage(
      client({
        getCredential: vi.fn(async () =>
          create(GithubCredentialStatusSchema, {
            source: 1,
            store: 1,
            available: false,
            apiBase: "https://api.github.com",
            reasonCode: "GH_CLI_NOT_LOGGED_IN",
            revision: 2n,
          }),
        ),
      }),
    );
    expect(await screen.findByText("GH_CLI_NOT_LOGGED_IN")).toBeTruthy();
    expect(screen.getByText("现在取不到令牌")).toBeTruthy();
  });

  it("keeps the token field a never-refilled password box", async () => {
    const api = client();
    renderPage(api);
    await screen.findByText("octocat");
    // The stored source is TOKEN_REF, but nothing pre-fills the field.
    fireEvent.change(document.querySelector("select") as HTMLSelectElement, {
      target: { value: "3" },
    });
    const field = tokenField();
    expect(field.type).toBe("password");
    expect(field.value).toBe("");

    fireEvent.change(field, { target: { value: "ghp_secret" } });
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() =>
      expect(api.configureCredential).toHaveBeenCalledWith({
        source: 3,
        token: "ghp_secret",
        apiBase: undefined,
        expectedRevision: 3n,
      }),
    );
    // Cleared the moment the Host accepted it, and never read back from the
    // status response.
    await waitFor(() => expect(tokenField().value).toBe(""));
  });

  it("revokes against the revision it displayed", async () => {
    const api = client();
    renderPage(api);
    await screen.findByText("octocat");
    fireEvent.click(screen.getByText("撤销凭据"));
    await waitFor(() =>
      expect(api.revokeCredential).toHaveBeenCalledWith({
        expectedRevision: 3n,
      }),
    );
  });
});
