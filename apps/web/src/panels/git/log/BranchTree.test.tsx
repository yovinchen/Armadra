import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GitRefsRepository } from "@armadra/shared";

import { installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { BranchTree } from "./BranchTree";
import { refKey } from "./build-tree";

installDomPolyfills();

const repositories: GitRefsRepository[] = [
  {
    repositoryPath: ".",
    repositoryId: "id",
    kind: "root",
    name: "armadra",
    head: { oid: "a".repeat(40), branch: "main" },
    branches: [
      {
        name: "main",
        oid: "a".repeat(40),
        upstream: "origin/main",
        ahead: 2,
        behind: 1,
        current: true,
      },
      {
        name: "feat/x",
        oid: "b".repeat(40),
        upstream: null,
        ahead: null,
        behind: null,
        current: false,
      },
      {
        name: "feat/y",
        oid: "c".repeat(40),
        upstream: null,
        ahead: null,
        behind: null,
        current: false,
      },
    ],
    remotes: [],
    tags: [],
    worktrees: [],
    stashCount: 0,
    stashes: [],
  },
];

function view(overrides: Partial<Parameters<typeof BranchTree>[0]> = {}) {
  const props = {
    repositories,
    colors: new Map([[".", 0]]),
    filter: "",
    onFilterChange: () => undefined,
    selected: [],
    onSelect: () => undefined,
    expanded: [".::root", ".::local"],
    onToggleExpanded: () => undefined,
    favorites: [],
    onToggleFavorite: () => undefined,
    ...overrides,
  } as Parameters<typeof BranchTree>[0];
  return render(<BranchTree {...props} />);
}

beforeEach(() => usePreferencesStore.setState({ locale: "en" }));
afterEach(cleanup);

describe("分支树", () => {
  it("展开着的那几层才画出来", () => {
    view();
    expect(screen.getByText("Local")).toBeTruthy();
    expect(screen.getByText("✓ main")).toBeTruthy();
    // `feat` 段没展开，它的两条分支还看不到。
    expect(screen.getByText("feat")).toBeTruthy();
    expect(screen.queryByText("x")).toBeNull();
  });

  it("点击是单选，⌘ 点击是加选", () => {
    const onSelect = vi.fn();
    view({ onSelect });
    fireEvent.click(screen.getByText("✓ main"));
    expect(onSelect.mock.calls[0]![1]).toBe(false);
    fireEvent.click(screen.getByText("✓ main"), { metaKey: true });
    expect(onSelect.mock.calls[1]![1]).toBe(true);
    expect(onSelect.mock.calls[1]![0].reference).toBe("main");
  });

  it("HEAD 节点在最上面，没选任何分支时它是选中的", () => {
    const { container } = view();
    const head = container.querySelector('[data-node="head"]')!;
    expect(head.getAttribute("aria-selected")).toBe("true");
    const selected = view({ selected: [refKey(".", "main")] });
    expect(
      selected.container
        .querySelector('[data-node="head"]')!
        .getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("ahead / behind 画在分支行上", () => {
    view();
    expect(screen.getByText("↑2")).toBeTruthy();
    expect(screen.getByText("↓1")).toBeTruthy();
  });

  it("星标写的是仓库加引用，不是裸分支名", () => {
    const onToggleFavorite = vi.fn();
    view({ onToggleFavorite });
    fireEvent.click(screen.getByLabelText("Add to favourites"));
    expect(onToggleFavorite).toHaveBeenCalledWith(refKey(".", "main"));
  });

  it("过滤时整棵树展开，命中的叶子直接可见", () => {
    view({ filter: "feat/y", expanded: [] });
    expect(screen.getByText("y")).toBeTruthy();
    expect(screen.queryByText("✓ main")).toBeNull();
  });
});
