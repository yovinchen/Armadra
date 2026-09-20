import type { DatabaseSync } from "node:sqlite";
import { uuidV7 } from "../workspaces/support";

/**
 * 「我上次读到哪」与「我被读了多少」这两行（迁移 `0025`，设计 §13）。
 *
 * 两张表一个模块：它们是同一件事的两半——游标让下一次读只给新的，审计让预算
 * 算得出这条连线已经花掉多少。放在 `collab/` 而不是 `db/`，因为除了上下文读
 * 取没有第二个调用者，而把它抬进一个通用的数据层只会让这两条语句离它们的规
 * 矩更远。
 */

/** 读取动词。写进 `context_reads.verb`，也是节点头那份清单的分类。 */
export type ReadVerb = "summary" | "transcript" | "terminal" | "content";

/** 一条游标：读的是哪份文件、读到第几个字节。 */
export interface ReadCursor {
  readonly transcriptPath: string;
  readonly byteOffset: number;
  readonly updatedAtMs: number;
}

interface CursorRow {
  readonly transcript_path: string;
  readonly byte_offset: number;
  readonly updated_at_ms: number;
}

/**
 * `(reader, target)` 的游标，**只有当它记的还是同一份文件时**才返回。
 *
 * 换了文件就是换了会话，偏移在新文件里指向的是另一段话；这种时候从头读一遍
 * 才是对的，所以这里直接答 `undefined` 而不是把偏移清零后交出去——调用方需要
 * 知道「这是第一次读」和「读过但文件换了」是同一种处理。
 */
export function readCursor(
  database: DatabaseSync,
  reader: string,
  target: string,
  transcriptPath: string,
): ReadCursor | undefined {
  const row = database
    .prepare(
      "SELECT transcript_path, byte_offset, updated_at_ms FROM context_read_cursors " +
        "WHERE reader_node_id = ? AND target_node_id = ?",
    )
    .get(reader, target) as CursorRow | undefined;
  if (row === undefined) return undefined;
  if (row.transcript_path !== transcriptPath) return undefined;
  return {
    transcriptPath: row.transcript_path,
    byteOffset: Math.max(0, Number(row.byte_offset)),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

/** 记下读到哪了。同一对读者/目标只有一行，所以是 upsert。 */
export function writeCursor(
  database: DatabaseSync,
  reader: string,
  target: string,
  cursor: { readonly transcriptPath: string; readonly byteOffset: number },
  nowMs: number,
): void {
  database
    .prepare(
      "INSERT INTO context_read_cursors " +
        "(reader_node_id, target_node_id, transcript_path, byte_offset, updated_at_ms) " +
        "VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(reader_node_id, target_node_id) DO UPDATE SET " +
        "transcript_path = excluded.transcript_path, " +
        "byte_offset = excluded.byte_offset, " +
        "updated_at_ms = excluded.updated_at_ms",
    )
    .run(
      reader,
      target,
      cursor.transcriptPath,
      Math.max(0, Math.trunc(cursor.byteOffset)),
      Math.trunc(nowMs),
    );
}

/** 一次跨 Agent 读取，落一行审计。返回写进去的 id。 */
export function noteRead(
  database: DatabaseSync,
  entry: {
    readonly reader: string;
    readonly target: string;
    readonly verb: ReadVerb;
    readonly bytes: number;
  },
  nowMs: number,
): string {
  const id = uuidV7();
  database
    .prepare(
      "INSERT INTO context_reads (id, reader_node_id, target_node_id, verb, bytes, at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      entry.reader,
      entry.target,
      entry.verb,
      Math.max(0, Math.trunc(entry.bytes)),
      Math.trunc(nowMs),
    );
  return id;
}

/** 审计里的一行，页面看到的形状。 */
export interface ContextRead {
  readonly id: string;
  readonly readerNodeId: string;
  /** 读者在画布上的名字，没有就没有。 */
  readonly readerHandle?: string;
  readonly readerTitle?: string;
  readonly verb: ReadVerb;
  readonly bytes: number;
  readonly atMs: number;
}

export interface ContextReadsPage {
  /** 这个节点一共被读过多少次。 */
  readonly total: number;
  /** 总字节数。 */
  readonly bytes: number;
  /** 最近的那几条，新的在前。 */
  readonly reads: readonly ContextRead[];
}

/** 页面「被读取 N 次」那一栏要的东西。 */
export function listContextReads(
  database: DatabaseSync,
  target: string,
  limit: number,
): ContextReadsPage {
  const totals = database
    .prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(bytes), 0) AS bytes " +
        "FROM context_reads WHERE target_node_id = ?",
    )
    .get(target) as { total: number; bytes: number } | undefined;
  const rows = database
    .prepare(
      "SELECT r.id AS id, r.reader_node_id AS reader, r.verb AS verb, r.bytes AS bytes, " +
        "r.at_ms AS at_ms, h.handle AS handle, n.title AS title " +
        "FROM context_reads r " +
        "LEFT JOIN node_handles h ON h.node_id = r.reader_node_id " +
        "LEFT JOIN nodes n ON n.id = r.reader_node_id " +
        "WHERE r.target_node_id = ? ORDER BY r.at_ms DESC, r.id DESC LIMIT ?",
    )
    .all(target, Math.max(1, Math.trunc(limit))) as {
    id: string;
    reader: string;
    verb: string;
    bytes: number;
    at_ms: number;
    handle: string | null;
    title: string | null;
  }[];
  return {
    total: Number(totals?.total ?? 0),
    bytes: Number(totals?.bytes ?? 0),
    reads: rows.map((row) => ({
      id: row.id,
      readerNodeId: row.reader,
      ...(row.handle === null ? {} : { readerHandle: row.handle }),
      ...(row.title === null ? {} : { readerTitle: row.title }),
      verb: row.verb as ReadVerb,
      bytes: Number(row.bytes),
      atMs: Number(row.at_ms),
    })),
  };
}
