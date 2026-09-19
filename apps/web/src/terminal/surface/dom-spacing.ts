import type { Terminal } from "@xterm/xterm";

/**
 * 元素重新量得出尺寸之后，把 DOM 渲染器的字距重新推一遍。
 *
 * xterm 的 DOM 渲染器不按网格摆字形，它用 CSS `letter-spacing` 钉住步进，而这个
 * 值每个渲染器实例**只算一次**：`_setDefaultSpacing()` 取
 * `dimensions.css.cell.width - _widthCache.get("W")`。宽度缓存用 `offsetWidth`
 * 测量，而不在渲染树里的元素量出来是 **0**——于是在摘掉 / `display:none` 期间
 * 建起来的 DOM 渲染器会烘进「一整格」的 `letter-spacing`，每个字符都比应该的位置
 * 多退一个空格。
 *
 * 这不是假想：回退到 DOM 渲染器的路径正是 `WebglAddon.dispose()`，而它跑在生命
 * 周期 effect 的 cleanup 里——React 那时**已经**把元素摘掉了。丢名额、折叠、切
 * 画布都会走这条路，结果就是「字母短暂散开」那一下。
 *
 * xterm 只在字符尺寸 / dpr / 选项变化时重算字距，**resize 不会**，所以重新可见
 * 的那条正常路径里没有任何东西能治它。`handleCharSizeChanged()` 是能治的最窄的
 * 那根杆（重新量、清宽度缓存、重推字距）。
 *
 * 每次 fit 都会跑，所以做成**变化门**：比较只花一次缓存读，字距已经对得上的终端
 * 完全不碰。**测量仍为 0 时直接放弃**——那说明元素还是量不出来，什么也推不出，
 * 与其把同一个错数再烘一遍，不如什么都不做。内部字段一律 fail-open 地取（和
 * xterm 其他猜内部的地方同一个风格）：将来 xterm 改名字，这里静默退回原样行为，
 * 不抛。只有 DOM 渲染器有宽度缓存，WebGL 渲染器在第一道门就出去了。
 *
 * 返回是否真的重推了（调用方欠一次重绘）。
 */

/** 字距比较的容差：亚像素噪声不值得重推一次渲染器。 */
const SPACING_EPS = 0.01;

interface WidthCacheLike {
  get: (char: string, bold: boolean, italic: boolean) => number;
}

interface DomRendererLike {
  _widthCache?: WidthCacheLike;
  _rowFactory?: { defaultSpacing: number };
  dimensions?: { css?: { cell?: { width?: number } } };
  handleCharSizeChanged?: () => void;
}

export function resyncDomRendererSpacing(terminal: Terminal): boolean {
  try {
    const renderer = (
      terminal as unknown as {
        _core?: {
          _renderService?: { _renderer?: { value?: DomRendererLike } };
        };
      }
    )._core?._renderService?._renderer?.value;
    const cache = renderer?._widthCache;
    const factory = renderer?._rowFactory;
    if (
      !renderer ||
      !cache ||
      !factory ||
      typeof renderer.handleCharSizeChanged !== "function"
    ) {
      return false;
    }
    const cellWidth = renderer.dimensions?.css?.cell?.width;
    if (!Number.isFinite(cellWidth) || !cellWidth) return false;
    const measured = cache.get("W", false, false);
    // 量不出来（元素不在渲染树里）：放弃，不要再烘一次错数。
    if (!(measured > 0)) return false;
    if (
      Math.abs(cellWidth - measured - factory.defaultSpacing) <= SPACING_EPS
    ) {
      return false;
    }
    renderer.handleCharSizeChanged();
    return true;
  } catch {
    return false;
  }
}
