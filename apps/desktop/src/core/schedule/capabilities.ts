/**
 * `HostService/Hello` 多报的那些能力名。
 *
 * 页面在打开自动化面板之前先问一次 Hello，看 `capabilities` 里有没有
 * `automation.plans.v1`；没有就显示「这台 Host 不支持自动化」，一次 RPC 都不发
 * （`apps/web/src/host/automation-session.ts` 的 `unsupported` 那一档）。所以这
 * 个域装配成功这件事必须能传到那一份 Hello 里。
 *
 * 做成一个注册表而不是往身份域里写死一个常量：身份域不该知道有哪些域存在，而
 * 后面的域（资源、浏览器、GitHub）会来报它们自己的那一个。`IdentityHttp` 早就
 * 留了 `capabilities` 这个可选钩子，这里填的就是它。
 */

/** 自动化面板认的那个名字。改它等于让所有已装机器的面板一起熄灭。 */
export const AUTOMATION_CAPABILITY = "automation.plans.v1";

const registered = new Set<string>();

/** 报一个能力名，返回撤销函数。同一个名字报两次只算一次。 */
export function registerCapability(name: string): () => void {
  registered.add(name);
  return () => {
    registered.delete(name);
  };
}

/** 当前报出去的全部能力名，声明顺序。 */
export function coreCapabilities(): readonly string[] {
  return [...registered];
}
