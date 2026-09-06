import { runtimeApi } from "@/api/client";

/**
 * `language.formatOnSave`（语言服务设计 §2.3「保存」）。
 *
 * 两条约束决定了它长这样：
 *
 *  * **读必须是同步的。** 保存路径上多一个 `await` 就把 `PUT` 推迟到下一个
 *    微任务；保存是用户按下 ⌘S 之后最该立刻发生的事，不该为了读一个开关而
 *    排队。所以 {@link formatOnSaveEnabled} 只看缓存，不发请求。
 *  * **编辑器节点不订阅 react-query。** 画布上可以同时开十几个编辑器，为一份
 *    共享文档挂十几个订阅只是噪声，而且会让「节点能不能渲染」取决于外面有
 *    没有 `QueryClientProvider`。
 *
 * 缓存由编辑器挂载时的 {@link refreshFormatOnSave} 填，设置页写完立刻再填
 * 一次。还没填上时答案是「关」——这正是默认值。
 */

let enabled = false;
let inflight: Promise<void> | null = null;

/** 同步读。缓存还没填上就是默认值「关」。 */
export function formatOnSaveEnabled(): boolean {
  return enabled;
}

/**
 * 后台刷新一次。并发调用共用同一个请求；读不到设置就当作「关」——保存时
 * 格式化默认就是关，读不到更不该把它打开。
 */
export function refreshFormatOnSave(): Promise<void> {
  inflight ??= runtimeApi
    .settings()
    .then((settings) => {
      enabled = settings.language?.formatOnSave === true;
    })
    .catch(() => {
      enabled = false;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 测试用。 */
export function resetFormatOnSave(): void {
  enabled = false;
  inflight = null;
}
