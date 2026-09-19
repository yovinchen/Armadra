/**
 * 三份导入 fixture（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §7）。
 *
 * 放在单独的文件里是因为 `parse.test.ts`、`layout.test.ts` 与
 * `to-items.test.ts` 都要用同一份输入——三层各测各的，但测的必须是同一张图，
 * 否则「解析对了但生成错了」这种偏差会在层与层之间漏过去。
 *
 * 标签一律用西文：这不是测试文件，`i18n.test.ts` 会把任何非注释的中文当成
 * 写死的界面文案。中文标签的覆盖放在各 `.test.ts` 里（那些文件是豁免的）。
 */

/** 含 subgraph 与边标签的 LR 流程图。 */
export const FLOWCHART_LR = `flowchart LR
  A[Start] --> B{Continue}
  B -- yes --> C((Done))
  B -- no --> D([Stop])
  subgraph S [Wrap up]
    C
    D
  end`;

/** TD 方向，覆盖 diamond / circle / stadium / hexagon 与三种线型。 */
export const FLOWCHART_TD = `graph TD
  a[rect] --> b{diamond}
  b --> c((circle))
  c --> d([stadium])
  d --> e{{hexagon}}
  e -.-> f[dotted target]
  f ==> g[thick target]
  g --- h[no arrow]
  h --> bare
  style a fill:#e03131
  classDef cool fill:#4465e9
  class b cool`;

/** 非 flowchart：走图片回退。 */
export const SEQUENCE = `sequenceDiagram
  Alice->>John: Hello John
  John-->>Alice: Great!`;

/** 语法错：解析必须抛，且不产生任何对象。 */
export const BROKEN = `flowchart LR
  A --> `;
