# AGENTS.md

## 项目约定

- Node.js >= 24，ESM，无 npm 依赖。
- 不引入框架，保持零依赖；确需依赖时先讨论。
- 代码风格：双引号、分号、2 空格缩进，不加行内注释。
- 路径类配置必须绝对路径，缺失时启动失败。

## 常用命令

```bash
npm test
./scripts/e2e-smoke.sh
./scripts/e2e-recovery.sh
```

## 变更要求

- 修改执行器相关逻辑时，同时更新 `test/mcode.test.js` 与 `test/exec-events.test.js`。
- 修改任务状态机时，同步 schema 迁移与 `test/taskstore.test.js`。
- 提交前必须跑全量 `npm test`。
- 提交信息使用 Conventional Commits。

## 目录

- `src/mcode.js`：mcode 执行器，参数构造、事件消费、终止与摘要。
- `src/exec-events.js`：JSONL 事件解析与状态聚合。
- `src/handler.js`：命令、任务生命周期、卡片交互。
- `src/taskstore.js`：SQLite 持久层。
- `docs/architecture.md`：协议与流程。