import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AGENT_STATE_SOURCES } from "@armadra/shared";

import { usePreferencesStore } from "@/app/preferences-store";
import { translate } from "@/i18n";
import { StateSourceBadge } from "./StateSourceBadge";

beforeEach(() => usePreferencesStore.setState({ locale: "en" }));
afterEach(cleanup);

it("每种来源画一个可分辨的标记，说明留在名字里", () => {
  for (const source of AGENT_STATE_SOURCES) {
    const { unmount } = render(<StateSourceBadge source={source} />);
    const badge = screen.getByLabelText(
      translate("en", `agent.stateSource.${source}`),
    );
    expect(badge.getAttribute("data-state-source")).toBe(source);
    expect(badge.getAttribute("title")).toContain(
      translate("en", `agent.stateSource.${source}.note`),
    );
    unmount();
  }
});

/**
 * 没有来源不是「空闲」，是「还没有人报过」。头部不画东西，正好说明这一点；
 * 画一个灰标记只会让人以为那也是一种状态。
 */
it("没有来源就什么都不画", () => {
  const { container } = render(<StateSourceBadge source={undefined} />);
  expect(container.firstChild).toBeNull();
});

/** `observed` 是猜测：文案必须自己说出这一点，否则头部会被当成保证。 */
it("观测来源的说明写明它不能开门", () => {
  for (const locale of ["zh-CN", "en"] as const) {
    const note = translate(locale, "agent.stateSource.observed.note");
    expect(note.length).toBeGreaterThan(0);
    expect(note).not.toBe("agent.stateSource.observed.note");
  }
  expect(translate("en", "agent.stateSource.observed.note")).toContain(
    "refused",
  );
});
