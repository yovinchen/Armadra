// 场景 2：编辑器节点（状态文档 §37）。
//
//   - 媒体预览：带透明的 PNG（棋盘格、滚轮缩放）、PDF（截图里真的画出了
//     内容）、MP4 与 MP3（原生控件、元数据读得出来）；
//   - 草稿保护：改了不存、刷新页面，草稿放回；草稿期间磁盘上改同一个文件，
//     提示条给出「合并」，打开的是三方合并；
//   - Git 行边标记：仓库里改一行，那一行出现标记；
//   - 快速打开：空输入列出最近文件，`文件:行:列` 跳到那个位置。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  decodePng,
  mp3Silence,
  pdfDocument,
  pngRgba,
  regionStats,
} from "./fixtures.mjs";
import { git, makeNode, newRepository, sleep } from "./harness.mjs";

const NOTES =
  Array.from(
    { length: 12 },
    (_, index) => `第 ${index + 1} 行：草稿与合并`,
  ).join("\n") + "\n";
const APP = [
  "export function greet(name: string): string {",
  "  const greeting = `hello ${name}`;",
  "  return greeting.toUpperCase();",
  "}",
  "",
  "export const answer = 42;",
  "",
].join("\n");

/** 在同一个 Chrome 里用 MediaRecorder 录一段 canvas，得到一份真的 MP4。 */
async function recordMp4(stack) {
  const page = await stack.browser.page(await stack.browser.context(), {
    width: 320,
    height: 240,
  });
  const base64 = await page.evaluate(`
    const type = ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    if (!type) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 240;
    document.body.append(canvas);
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: type });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    let frame = 0;
    const timer = setInterval(() => {
      frame += 1;
      context.fillStyle = "#1e3a8a"; context.fillRect(0, 0, 320, 240);
      context.fillStyle = "#f97316"; context.fillRect(20 + (frame * 6) % 240, 80, 60, 60);
      context.fillStyle = "#fff"; context.font = "28px sans-serif"; context.fillText("Armadra " + frame, 20, 40);
    }, 33);
    recorder.start(200);
    await new Promise((done) => setTimeout(done, 1800));
    recorder.stop();
    await new Promise((done) => (recorder.onstop = done));
    clearInterval(timer);
    const blob = new Blob(chunks, { type });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  `);
  await page.close();
  if (!base64)
    throw new Error("这个 Chrome 的 MediaRecorder 不支持 MP4，造不出视频夹具");
  return Buffer.from(base64, "base64");
}

/** 节点体在视口里的矩形。 */
const bodyRect = (page, id) =>
  page.evaluate(`
    const node = document.querySelector('.react-flow__node[data-id="${id}"] [data-slot="node-body"]');
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  `);

/** 编辑器节点里 CodeMirror 的正文与光标（根 tile 挂在 `.cm-content` 的 cmTile 上，与 EditorView.findFromDOM 同一条路）。 */
const editorState = (page, id) =>
  page.evaluate(`
    const content = document.querySelector('.react-flow__node[data-id="${id}"] .cm-content');
    const view = content?.cmTile?.root?.view ?? content?.cmView?.view;
    if (!view) return content ? { text: content.innerText } : null;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    return { text: view.state.doc.toString(), line: line.number, column: head - line.from + 1 };
  `);

export default async function editor({ stack, output, report, scenario }) {
  const run = scenario(report, "编辑器（§37）", output);
  const project = join(stack.scratch, "editor-project");
  newRepository(project);
  mkdirSync(join(project, "media"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "notes.txt"), NOTES);
  writeFileSync(join(project, "src/app.ts"), APP);
  // 64×48：左半透明，右半一个实心橙色圆，中间一条半透明带。
  writeFileSync(
    join(project, "media/logo.png"),
    pngRgba(64, 48, (x, y) => {
      if ((x - 44) ** 2 + (y - 24) ** 2 < 14 ** 2) return [249, 115, 22, 255];
      if (y >= 20 && y < 28) return [59, 130, 246, 128];
      return [0, 0, 0, 0];
    }),
  );
  writeFileSync(join(project, "media/manual.pdf"), pdfDocument("Armadra PDF"));
  writeFileSync(join(project, "media/tone.mp3"), mp3Silence(160));
  writeFileSync(join(project, "media/clip.mp4"), await recordMp4(stack));
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "init"]);
  // 仓库里改一行（不经编辑器）：打开后第 3 行应当有「修改」标记。
  writeFileSync(
    join(project, "src/app.ts"),
    APP.replace("toUpperCase()", "toLowerCase()"),
  );
  run.ok("工作空间就位", "PNG / PDF / MP4 / MP3 + git 仓库");

  const { workspace, board } = await stack.workspace("编辑器", project);
  const media = {
    image: makeNode(
      board.id,
      "editor",
      "logo.png",
      { x: 20, y: 20 },
      { width: 400, height: 260 },
      { kind: "editor", path: "media/logo.png" },
    ),
    audio: makeNode(
      board.id,
      "editor",
      "tone.mp3",
      { x: 20, y: 300 },
      { width: 400, height: 170 },
      { kind: "editor", path: "media/tone.mp3" },
    ),
    video: makeNode(
      board.id,
      "editor",
      "clip.mp4",
      { x: 20, y: 490 },
      { width: 400, height: 300 },
      { kind: "editor", path: "media/clip.mp4" },
    ),
    pdf: makeNode(
      board.id,
      "editor",
      "manual.pdf",
      { x: 440, y: 20 },
      { width: 440, height: 600 },
      { kind: "editor", path: "media/manual.pdf" },
    ),
  };
  await stack.seedBoard(workspace.id, board.id, Object.values(media));
  const url = stack.boardUrl(workspace.id, board.id);

  const page = await stack.browser.page(await stack.browser.context());
  await page.goto(url);
  await page.settle();

  /* -------------------------------- 图片 --------------------------------- */
  const imageInfo = await page.until(
    `const img = document.querySelector('.react-flow__node[data-id="${media.image.id}"] img');
     return img && img.complete && img.naturalWidth ? { w: img.naturalWidth, bg: getComputedStyle(img).backgroundImage } : null;`,
    "图片载入",
  );
  run.check(
    imageInfo.w === 64 && imageInfo.bg.includes("conic-gradient"),
    "图片载入并铺棋盘格",
    imageInfo.bg.slice(0, 60),
  );
  const badge = () =>
    page.evaluate(`
      const node = document.querySelector('.react-flow__node[data-id="${media.image.id}"]');
      return [...node.querySelectorAll('[data-slot="badge"]')].map((b) => b.textContent).find((t) => t.endsWith("%")) ?? null;
    `);
  const fitScale = await badge();
  const viewport = await page.centerOf(
    `return document.querySelector('.react-flow__node[data-id="${media.image.id}"] [data-testid="image-viewport"]');`,
    "图片视口",
  );
  for (let tick = 0; tick < 4; tick += 1) {
    await page.call("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: viewport.x,
      y: viewport.y,
      deltaX: 0,
      deltaY: -100,
    });
    await sleep(80);
  }
  await sleep(300);
  const zoomed = await badge();
  run.check(
    Number.parseInt(zoomed) > Number.parseInt(fitScale),
    "滚轮放大图片",
    `${fitScale} → ${zoomed}`,
  );
  const imageRect = await page.evaluate(`
    const r = document.querySelector('.react-flow__node[data-id="${media.image.id}"] img').getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  `);

  /* --------------------------------- PDF --------------------------------- */
  await page.until(
    `return !!document.querySelector('.react-flow__node[data-id="${media.pdf.id}"] iframe[src^="blob:"]')`,
    "PDF 框架载入",
  );
  // 内置查看器是一个独立的插件进程，给它时间画出第一页。
  await sleep(3500);

  /* ------------------------------ 音视频 -------------------------------- */
  const videoInfo = await page.until(
    `const v = document.querySelector('.react-flow__node[data-id="${media.video.id}"] video');
     return v && v.readyState >= 1 ? { controls: v.controls, duration: v.duration, w: v.videoWidth, error: v.error?.code ?? null } : null;`,
    "视频元数据",
  );
  run.check(
    videoInfo.controls && videoInfo.w === 320 && !videoInfo.error,
    "视频有控件，读得出画面尺寸",
    videoInfo,
  );
  const audioInfo = await page.until(
    `const a = document.querySelector('.react-flow__node[data-id="${media.audio.id}"] audio');
     return a && a.readyState >= 1 ? { controls: a.controls, duration: a.duration, error: a.error?.code ?? null } : null;`,
    "音频元数据",
  );
  run.check(
    audioInfo.controls && audioInfo.duration > 3 && !audioInfo.error,
    "音频有控件，读得出时长",
    audioInfo,
  );

  const mediaShot = await run.shot(page, "editor-1-media");
  const image = decodePng(readFileSync(mediaShot));
  const pdfRect = await bodyRect(page, media.pdf.id);
  const pdfStats = regionStats(image, pdfRect);
  // 空白的框只有一两种颜色；画出来的页面有白纸、橙色块与抗锯齿的文字。
  run.check(
    pdfStats.colors > 20 && pdfStats.brightRatio > 0.2,
    "PDF 真的渲染出来（截图不是空白）",
    pdfStats,
  );
  // 图片左边四分之一是全透明的：棋盘格的两种表面色应当各占一大块。
  const checker = regionStats(image, {
    x: imageRect.x + 1,
    y: imageRect.y + 1,
    width: imageRect.width / 4,
    height: imageRect.height / 4,
  });
  run.check(
    checker.topShares[1] > 0.2,
    "透明区域显示棋盘格（两种颜色交替）",
    checker,
  );

  /* ------------------------------- 文本编辑 ------------------------------ */
  // 文本编辑放在另一块画布上：这一块此刻由上面的页面持有租约，core 不收
  // 没带 clientId 的整块替换（§41）。
  const textBoard = await stack.api(`/api/workspaces/${workspace.id}/boards`, {
    method: "POST",
    body: JSON.stringify({ name: "文本" }),
  });
  const notes = makeNode(
    textBoard.id,
    "editor",
    "notes.txt",
    { x: 20, y: 20 },
    { width: 520, height: 400 },
    { kind: "editor", path: "notes.txt" },
  );
  const app = makeNode(
    textBoard.id,
    "editor",
    "app.ts",
    { x: 560, y: 20 },
    { width: 520, height: 300 },
    { kind: "editor", path: "src/app.ts" },
  );
  await stack.seedBoard(workspace.id, textBoard.id, [notes, app]);
  await page.goto(stack.boardUrl(workspace.id, textBoard.id));
  await page.settle();
  await page.until(
    `return !!document.querySelector('.react-flow__node[data-id="${notes.id}"] .cm-content')`,
    "文本编辑器载入",
  );

  // Git 行边标记：app.ts 第 3 行在磁盘上改过。
  const gutter = await page.until(
    `const node = document.querySelector('.react-flow__node[data-id="${app.id}"]');
     const marks = [...(node?.querySelectorAll('.cm-git-gutter .cm-gutterElement') ?? [])]
       .filter((element) => element.firstElementChild?.className?.startsWith("cm-git-"));
     if (!marks.length) return null;
     const lines = [...node.querySelectorAll('.cm-lineNumbers .cm-gutterElement')];
     return marks.map((mark) => {
       const top = mark.getBoundingClientRect().top;
       const number = lines.find((line) => Math.abs(line.getBoundingClientRect().top - top) < 3)?.textContent;
       return { kind: mark.firstElementChild.className, line: number };
     });`,
    "Git 行边标记",
  );
  run.check(
    gutter.some((mark) => mark.kind === "cm-git-modified" && mark.line === "3"),
    "仓库里改的第 3 行出现修改标记",
    gutter,
  );

  // 改 notes.txt 不保存。
  await page.clickOn(
    `const lines = document.querySelectorAll('.react-flow__node[data-id="${notes.id}"] .cm-line'); return lines[1];`,
    "notes 第 2 行",
  );
  await page.key("End");
  await page.type("（草稿）");
  await sleep(1200); // 草稿去抖 400ms
  const typed = await editorState(page, notes.id);
  run.check(
    typed?.text.includes("第 2 行：草稿与合并（草稿）"),
    "输入进了编辑器",
    typed?.text.split("\n")[1],
  );
  run.check(
    readFileSync(join(project, "notes.txt"), "utf8") === NOTES,
    "磁盘上的文件没有变",
  );
  await run.shot(page, "editor-2-dirty");

  await page.reload();
  await page.settle();
  const restored = await page.until(
    `const node = document.querySelector('.react-flow__node[data-id="${notes.id}"]');
     const toast = [...document.querySelectorAll('[data-sonner-toast]')].map((e) => e.textContent).find((t) => t.includes("草稿"));
     const text = node?.querySelector('.cm-content')?.innerText ?? "";
     return toast && text.includes("（草稿）") ? toast : null;`,
    "刷新后草稿放回",
  );
  run.check(
    restored.includes("已恢复未保存的草稿"),
    "刷新后草稿恢复，提示「已恢复」",
    restored,
  );
  await run.shot(page, "editor-3-restored");

  // 草稿期间磁盘上改同一个文件：第 2 行与草稿冲突，第 10 行只有磁盘改了。
  // 应出现外部改动提示与「合并」，打开的是三方合并。
  writeFileSync(
    join(project, "notes.txt"),
    NOTES.replace("第 2 行：草稿与合并", "第 2 行：磁盘版").replace(
      "第 10 行：草稿与合并",
      "第 10 行：磁盘上改的",
    ),
  );
  const bar = await page.until(
    `const node = document.querySelector('.react-flow__node[data-id="${notes.id}"]');
     const bars = [...(node?.querySelectorAll('[role="status"]') ?? [])];
     const bar = bars.find((b) => [...b.querySelectorAll("button")].some((x) => x.textContent.trim() === "合并"));
     return bar ? bar.textContent : null;`,
    "外部改动提示条带「合并」",
    { timeout: 30_000 },
  );
  run.ok("磁盘改动后出现提示条", bar);
  await page.clickOn(
    `const node = document.querySelector('.react-flow__node[data-id="${notes.id}"]');
     return [...node.querySelectorAll('[role="status"] button')].find((b) => b.textContent.trim() === "合并");`,
    "合并按钮",
  );
  const dialog = await page.until(
    `const d = document.querySelector('[role="dialog"]');
     return d && d.textContent.includes("打开时的版本") && d.textContent.includes("磁盘上的版本") ? d.textContent : null;`,
    "三方合并对话框",
  );
  run.check(
    dialog.includes("合并磁盘上的修改") && dialog.includes("1 处冲突"),
    "打开三方合并（打开时的版本 / 草稿 / 磁盘上的版本，1 处冲突）",
  );
  await sleep(600);
  await run.shot(page, "editor-4-merge");
  await page.clickOn(
    `return [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "取草稿");`,
    "冲突处取草稿",
  );
  await page.clickOn(
    `return [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "应用到草稿");`,
    "应用到草稿",
  );
  const merged = await page.until(
    `const text = document.querySelector('.react-flow__node[data-id="${notes.id}"] .cm-content')?.innerText ?? "";
     return !document.querySelector('[role="dialog"]') && text.includes("（草稿）") && text.includes("磁盘上改的") ? text : null;`,
    "合并结果放回编辑器",
  );
  run.ok(
    "合并结果同时含草稿与磁盘两边的改动",
    merged.split("\n").filter((line) => /草稿）|磁盘上改的/.test(line)),
  );

  /* ------------------------------- 快速打开 ------------------------------ */
  await page.clickOn(
    `return document.querySelector('.react-flow__pane');`,
    "画布空白处",
  );
  await page.key("p", 4);
  const recent = await page.until(
    `const heading = [...document.querySelectorAll('[cmdk-group-heading]')].find((h) => h.textContent === "最近打开");
     if (!heading) return null;
     return [...heading.parentElement.querySelectorAll('[cmdk-item]')].map((item) => item.textContent.trim());`,
    "快速打开列出最近文件",
  );
  run.check(
    recent.some((item) => item.includes("notes.txt")) &&
      recent.some((item) => item.includes("app.ts")),
    "最近文件在列",
    recent,
  );
  await run.shot(page, "editor-5-quick-open-recent");
  await page.type("src/app.ts:3:12");
  await page.until(
    `return [...document.querySelectorAll('[cmdk-item]')].some((item) => item.textContent.includes("app.ts"));`,
    "按路径找到 app.ts",
  );
  await sleep(400);
  await run.shot(page, "editor-6-quick-open-location");
  await page.clickOn(
    `return [...document.querySelectorAll('[cmdk-item]')].find((item) => item.textContent.includes("src/app.ts"));`,
    "选中 app.ts",
  );
  const jumped = await page.until(
    `const content = document.querySelector('.react-flow__node[data-id="${app.id}"] .cm-content');
     const view = content?.cmTile?.root?.view ?? content?.cmView?.view;
     if (!view) return null;
     const head = view.state.selection.main.head;
     const line = view.state.doc.lineAt(head);
     return line.number === 3 ? { line: line.number, column: head - line.from + 1 } : null;`,
    "跳到第 3 行",
  );
  run.check(jumped.column === 12, "`文件:行:列` 跳到第 3 行第 12 列", jumped);
  await run.shot(page, "editor-7-jumped");

  /* -------------------------------- 窄屏 --------------------------------- */
  const phone = await stack.browser.page(await stack.browser.context());
  await phone.viewport(390, 844, true);
  await phone.goto(url);
  await phone.settle();
  await phone.until(
    `return document.querySelectorAll(".react-flow__node").length >= 4`,
    "手机页画布",
  );
  await sleep(1200);
  await run.shot(phone, "mobile-editor");
  run.consoleClean(page, phone);
  await phone.close();
  await page.close();
  run.entry.status = "passed";
}
