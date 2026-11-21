import test from "node:test";
import assert from "node:assert/strict";
import { buildCardMarkdown, buildProgressCard } from "../src/card.js";

test("卡片是合法 JSON 且包含 markdown 元素", () => {
  const card = JSON.parse(buildCardMarkdown("**hi**"));
  assert.equal(card.config.wide_screen_mode, true);
  assert.equal(card.elements.length, 1);
  assert.deepEqual(card.elements[0], { tag: "markdown", content: "**hi**" });
});

test("空内容也能构造卡片", () => {
  const card = JSON.parse(buildCardMarkdown(""));
  assert.equal(card.elements[0].content, "");
});

test("代码块与引号被正确转义", () => {
  const content = '```js\nconsole.log("hi")\n```';
  const card = JSON.parse(buildCardMarkdown(content));
  assert.equal(card.elements[0].content, content);
});

test("可以关闭宽屏模式", () => {
  const card = JSON.parse(buildCardMarkdown("x", { wide: false }));
  assert.equal(card.config.wide_screen_mode, false);
});

test("非字符串内容被安全转换", () => {
  const card = JSON.parse(buildCardMarkdown(null));
  assert.equal(card.elements[0].content, "");
});

test("首个标题被提升为卡片 header", () => {
  const card = JSON.parse(buildCardMarkdown("## 标题\n\n正文"));
  assert.deepEqual(card.header, { title: { tag: "plain_text", content: "标题" } });
  assert.equal(card.elements.length, 1);
  assert.deepEqual(card.elements[0], { tag: "markdown", content: "正文" });
});

test("非首个标题降级为加粗文本", () => {
  const card = JSON.parse(buildCardMarkdown("# 一\n\n## 二"));
  assert.equal(card.header.title.content, "一");
  assert.ok(card.elements.some((e) => e.tag === "markdown" && e.content === "**二**"));
});

test("表格转换为 column_set 并去掉分隔行", () => {
  const card = JSON.parse(buildCardMarkdown("| 命令 | 作用 |\n|---|---|\n| /models | 选模型 |"));
  const columnSets = card.elements.filter((e) => e.tag === "column_set");
  assert.equal(columnSets.length, 2);
  assert.equal(columnSets[0].columns.length, 2);
  assert.equal(columnSets[0].columns[0].elements[0].content, "**命令**");
  assert.equal(columnSets[1].columns[0].elements[0].content, "/models");
  assert.equal(columnSets[1].columns[1].elements[0].content, "选模型");
});

test("表格中间的空行不会打断表格结构", () => {
  const card = JSON.parse(buildCardMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\n| 3 | 4 |"));
  const columnSets = card.elements.filter((e) => e.tag === "column_set");
  assert.equal(columnSets.length, 3);
  assert.equal(columnSets[2].columns[0].elements[0].content, "3");
});

test("分割线转换为 hr 元素", () => {
  const card = JSON.parse(buildCardMarkdown("a\n\n---\n\nb"));
  assert.deepEqual(
    card.elements.map((e) => e.tag),
    ["markdown", "hr", "markdown"],
  );
});

test("只有标题时也保留合法 elements", () => {
  const card = JSON.parse(buildCardMarkdown("# 只有标题"));
  assert.equal(card.header.title.content, "只有标题");
  assert.deepEqual(card.elements, [{ tag: "markdown", content: "" }]);
});

test("进度卡片包含标题、颜色与正文", () => {
  const card = JSON.parse(buildProgressCard());
  assert.equal(card.config.wide_screen_mode, true);
  assert.equal(card.config.update_multi, true);
  assert.equal(card.header.title.content, "任务执行中");
  assert.equal(card.header.template, "blue");
  assert.match(card.elements[0].content, /任务执行中/);
});

test("进度卡片支持自定义标题与颜色", () => {
  const card = JSON.parse(
    buildProgressCard({ title: "执行失败", text: "错误详情", template: "red" }),
  );
  assert.equal(card.header.title.content, "执行失败");
  assert.equal(card.header.template, "red");
  assert.equal(card.elements[0].content, "错误详情");
});

test("进度卡片可附带按钮动作", () => {
  const card = JSON.parse(
    buildProgressCard({
      actions: [{ text: "停止任务", type: "danger", value: { cmd: "/stop", key: "oc_1" } }],
    }),
  );
  const action = card.elements.at(-1);
  assert.equal(action.tag, "action");
  assert.equal(action.actions[0].text.content, "停止任务");
  assert.equal(action.actions[0].type, "danger");
  assert.deepEqual(action.actions[0].value, { cmd: "/stop", key: "oc_1" });
});

test("没有动作时不生成 action 元素", () => {
  const card = JSON.parse(buildProgressCard());
  assert.equal(card.elements.length, 1);
});