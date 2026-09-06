/** 一份 JSON 对象；设置文档从头到尾就是这一种形状。 */
export type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PATCH 的合并语义，与 Runtime 的 `settings.rs::merge` 逐条对齐：
 *
 *  - 两边都是对象 → 递归合并，补丁里没提到的键原样保留；
 *  - 值是 `null` → 删掉这个键（这就是「恢复默认」的写法）；
 *  - 其余一律整体替换，**数组也是整体替换**：把 `ssh.hosts` 按下标合并会
 *    让「删掉第二台主机」变成「把第二台改成第三台」。
 *
 * 两侧必须是同一套规则。Host 只校验结构、不懂设置的含义，所以走 Host 时
 * 由前端在这里做合并；规则一旦分叉，同一个补丁在两侧会得到不同的文档。
 */
export function mergeSettings(base: JsonObject, patch: JsonObject): JsonObject {
  const next: JsonObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
      continue;
    }
    // `undefined` 在 JSON 里根本走不到 Runtime，所以这里也当作没提到这个键。
    if (value === undefined) continue;
    const current = next[key];
    // 只有「对象盖对象」才递归。对象盖标量时 Runtime 是整体替换（连里面的
    // `null` 也照原样存下），这里跟着一样，免得同一个补丁两侧结果不同。
    next[key] =
      isObject(value) && isObject(current)
        ? mergeSettings(current, value)
        : value;
  }
  return next;
}
