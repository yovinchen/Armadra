import { useWindowIntents } from "../keybindings";
import { isDesktop } from "../platform";
import { dragRegionProps } from "./window-region";

/**
 * 全局顶部拖拽条：窗口最上面这 44px 就是标题栏，空白处按住能拖走整个窗口
 * （macOS 上双击还原 / 最大化，由壳自己接管）。
 *
 * 它是一个**空**的铺满元素——`-webkit-app-region: drag` 会往下继承，任何子节点
 * 都会跟着变成拖拽区。具体挂什么由 `dragRegionProps()` 决定。启动页、画布 + 侧栏展开、侧栏收起
 * 三种状态下都渲染同一条，左上角红绿灯右侧、侧栏顶栏、画布上方那 44px
 * 于是处处可拖。
 *
 * z 轴放在 `--z-pills`：这一带真正的交互控件（侧栏折叠钮 31、右上工具簇 26、
 * 横幅 27）都比它高，点击照常落在按钮上；启动页右上角的设置钮在正常流里，
 * 由 `Launcher` 自己抬到 `--z-dock`。
 *
 * 浏览器里没有无边框窗口这回事，直接不渲染。
 *
 * 壳推给页面的两条窗口事件（⌘W 的意图、主进程通知的点击）也订阅在这里：
 * 它们和这一条同一个由来——只因为外面有个原生窗口才存在——而这个组件在
 * App 里无条件渲染，订阅于是跟着窗口活一次，不随面板开合来回装卸。
 */
export function WindowDragLayer() {
  useWindowIntents();
  if (!isDesktop()) return null;
  return (
    <div
      aria-hidden
      data-testid="window-drag-layer"
      {...dragRegionProps()}
      className="fixed top-0 right-0 left-0 z-[var(--z-pills)] h-[var(--tabbar-h)]"
    />
  );
}
