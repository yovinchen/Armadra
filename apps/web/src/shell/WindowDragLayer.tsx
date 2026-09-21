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
 * **它必须是 App 里的第一个子节点。** 可拖拽区域由原生层按 DOM 顺序计算：
 * `drag` 矩形并进去、`no-drag` 矩形减出来，后出现的覆盖先出现的。排在侧栏
 * 后面时，侧栏标题栏里那几颗 `no-drag` 按钮先被减掉、再被这一整条加回来，
 * 页面里的命中测试看不出任何问题（那是 z 轴的事），按下去却是拖窗口。
 * z 轴放在 `--z-pills` 只管页面自己的指针事件。
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
