-- Agent 的名字：`handle` 从 `nodes.data_json` 里的一个字段，抬成一张有真约束的表。
--
-- 名字（`handle`）与标题（`nodes.title`）不是一回事：标题是给人看的散文，首个
-- Hook 回合之后会被自动命名改写；名字是 Agent 之间互相称呼用的稳定短名，只有显
-- 式改名才会变。设计见 `docs/design/agent-delivery.md` §2。
--
-- ## 为什么要一张表
--
-- 名字今天存在 `node.data.handle` 里，唯一性靠改名动词自己做一次全画布扫描。那
-- 是一次读-判-写，不是一次约束：两个 Agent 同时改成同一个名字会双双通过。
-- `PRIMARY KEY (board_id, handle)` 把「一块画布内唯一」变成数据库替我们守的事。
--
-- ## 这张表与 `data.handle` 的关系
--
-- 表是唯一来源：解析名字（`collab/addressing.ts::loadHandles`）只读这张表。
-- `node.data.handle` 保留为**渲染副本**，页面据此画节点头的徽标，不必再查一次；
-- 它与表在同一个事务里写（`canvas/documents.ts::saveBoard` → `canvas/handles.ts`），
-- 所以两者不会各自漂移。
--
-- ## 回填
--
-- 现存的 `data.handle` 按 `collab/addressing.ts::normalizeHandle` 的同一套形状
-- 规则筛一遍（1–24 个 ASCII 字母、数字、`-` 或 `_`，首字符是字母或数字，大小写
-- 折叠）再进表。同一块画布上撞名的保留 `updated_at` 较早的那个——先起的名字先
-- 到——另一个的副本字段清掉，**不猜一个新名字**：一个被系统悄悄改过的名字，比一
-- 个空着的名字更难发现。形状不合法的副本同样清掉：它本来就解析不出来。
--
-- 回填之后再把赢家的副本按折叠后的形式写回去，免得表里是 `review` 而副本还是
-- `Review`。

CREATE TABLE node_handles (
  board_id   TEXT NOT NULL,
  handle     TEXT NOT NULL,
  node_id    TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (board_id, handle)
);

CREATE INDEX node_handles_node ON node_handles(node_id);

INSERT INTO node_handles (board_id, handle, node_id, updated_at)
SELECT board_id, handle, node_id, updated_at
FROM (
  SELECT
    n.board_id AS board_id,
    lower(json_extract(n.data_json, '$.handle')) AS handle,
    n.id AS node_id,
    n.updated_at AS updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY n.board_id, lower(json_extract(n.data_json, '$.handle'))
      ORDER BY n.updated_at, n.id
    ) AS seat
  FROM nodes n
  WHERE json_valid(n.data_json)
    AND json_type(n.data_json, '$.handle') = 'text'
    AND length(lower(json_extract(n.data_json, '$.handle'))) BETWEEN 1 AND 24
    AND lower(json_extract(n.data_json, '$.handle')) GLOB '[a-z0-9]*'
    AND NOT lower(json_extract(n.data_json, '$.handle')) GLOB '*[^a-z0-9_-]*'
)
WHERE seat = 1;

-- 赢家的副本折叠成表里的写法。
UPDATE nodes
SET data_json = json_set(
  data_json,
  '$.handle',
  (SELECT h.handle FROM node_handles h WHERE h.node_id = nodes.id)
)
WHERE id IN (SELECT node_id FROM node_handles);

-- 没进表的副本一律清掉（撞名的输家，以及形状本来就不合法的）。
UPDATE nodes
SET data_json = json_remove(data_json, '$.handle')
WHERE json_valid(data_json)
  AND json_type(data_json, '$.handle') IS NOT NULL
  AND id NOT IN (SELECT node_id FROM node_handles);
