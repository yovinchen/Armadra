import { describe, expect, it } from "vitest";
import type { GithubClient } from "./client";
import { PROJECT_STATUS_MAX_PAGES, projectStatuses } from "./endpoints";

/**
 * Projects v2 的 Status 映射按 cursor 翻页。以前写死五页（500 条），更大的
 * project 后面的 Issue 悄悄落进「未分组」；这里用 GraphQL 响应 fixture 驱动它。
 */

const PROJECT = "PVT_project";
const FIELD = "PVTSSF_status";

/** 一页 `items` 的 GraphQL `data`，形状照 `PROJECT_STATUSES_QUERY`。 */
function page(
  numbers: readonly number[],
  next: { hasNextPage: boolean; endCursor?: string },
): unknown {
  return {
    node: {
      items: {
        pageInfo: next,
        nodes: numbers.map((number) => ({
          content: { number },
          fieldValues: {
            nodes: [
              // 别的单选字段上的值不能混进 Status。
              { optionId: "other", field: { id: "PVTSSF_priority" } },
              { optionId: `opt-${number % 3}`, field: { id: FIELD } },
              // 非单选字段的值是空对象。
              {},
            ],
          },
        })),
      },
    },
  };
}

/** 按收到的 `after` 回答对应那一页的假客户端，并记下每次的变量。 */
function client(pages: ReadonlyMap<string, unknown>): {
  readonly client: GithubClient;
  readonly calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    client: {
      graphql: async (_query: string, variables: Record<string, unknown>) => {
        calls.push(variables);
        const after = (variables.after as string | undefined) ?? "";
        if (!pages.has(after)) throw new Error(`unexpected cursor ${after}`);
        return pages.get(after);
      },
    } as unknown as GithubClient,
  };
}

function numbers(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => from + index);
}

describe("projectStatuses", () => {
  it("follows the cursor past five pages until the last one", async () => {
    const pages = new Map<string, unknown>();
    const total = 7;
    for (let index = 0; index < total; index += 1) {
      const last = index === total - 1;
      pages.set(
        index === 0 ? "" : `c${index}`,
        page(
          numbers(index * 100 + 1, 100),
          last
            ? { hasNextPage: false, endCursor: `c${index + 1}` }
            : { hasNextPage: true, endCursor: `c${index + 1}` },
        ),
      );
    }
    const fake = client(pages);
    const answer = await projectStatuses(fake.client, PROJECT, FIELD);

    expect(answer.partial).toBe(false);
    expect(answer.statuses.size).toBe(700);
    // The 501st through 700th — beyond the old five-page ceiling — are there.
    expect(answer.statuses.get(650)).toBe(`opt-${650 % 3}`);
    expect(answer.statuses.get(700)).toBe(`opt-${700 % 3}`);
    expect(fake.calls).toHaveLength(total);
    expect(fake.calls[0]).toEqual({ project: PROJECT });
    expect(fake.calls[1]).toEqual({ project: PROJECT, after: "c1" });
  });

  it("stops at the page ceiling and says the map is partial", async () => {
    const pages = new Map<string, unknown>();
    // One more page than the ceiling allows, every one promising another.
    for (let index = 0; index <= PROJECT_STATUS_MAX_PAGES; index += 1) {
      pages.set(
        index === 0 ? "" : `c${index}`,
        page(numbers(index * 10 + 1, 10), {
          hasNextPage: true,
          endCursor: `c${index + 1}`,
        }),
      );
    }
    const fake = client(pages);
    const answer = await projectStatuses(fake.client, PROJECT, FIELD);

    expect(answer.partial).toBe(true);
    expect(fake.calls).toHaveLength(PROJECT_STATUS_MAX_PAGES);
    expect(answer.statuses.size).toBe(PROJECT_STATUS_MAX_PAGES * 10);
  });

  it("does not spin on a cursor it has already followed", async () => {
    const pages = new Map<string, unknown>([
      ["", page([1], { hasNextPage: true, endCursor: "loop" })],
      ["loop", page([2], { hasNextPage: true, endCursor: "loop" })],
    ]);
    const fake = client(pages);
    const answer = await projectStatuses(fake.client, PROJECT, FIELD);
    expect(answer.partial).toBe(true);
    expect(fake.calls).toHaveLength(2);
    expect([...answer.statuses.keys()]).toEqual([1, 2]);
  });

  it("treats a next page without a cursor as partial", async () => {
    const fake = client(new Map([["", page([1, 2], { hasNextPage: true })]]));
    const answer = await projectStatuses(fake.client, PROJECT, FIELD);
    expect(answer.partial).toBe(true);
    expect(answer.statuses.size).toBe(2);
  });

  it("is complete for a single page and skips items that are not issues", async () => {
    const data = page([4, 5], { hasNextPage: false });
    const items = (data as { node: { items: { nodes: unknown[] } } }).node.items
      .nodes;
    // A draft item or a pull request has no issue number.
    items.push({ content: {}, fieldValues: { nodes: [] } });
    const fake = client(new Map([["", data]]));
    const answer = await projectStatuses(fake.client, PROJECT, FIELD);
    expect(answer.partial).toBe(false);
    expect([...answer.statuses.entries()]).toEqual([
      [4, "opt-1"],
      [5, "opt-2"],
    ]);
  });
});
