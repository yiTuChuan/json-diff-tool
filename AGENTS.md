# AGENTS

## 工具定位

`json-diff-tool` 是一个独立部署的前端工具，面向“单 JSON 格式化 / 查看”和“多组 JSON Diff 工作区”两个核心场景。

当前目标不是做复杂平台，而是做一个可直接部署到 `Vercel / Netlify` 的纯前端静态应用。

## 当前技术栈

- `React 18`
- `Vite 5`
- `TypeScript`

当前目录结构：

- `index.html`
- `package.json`
- `vite.config.ts`
- `tsconfig.json`
- `tsconfig.app.json`
- `src/main.tsx`
- `src/App.tsx`
- `src/styles.css`

## 当前产品结构

- 一级模式：
  - `格式化 / Viewer`
  - `对比工作区`
- 首页默认入口仍是 `格式化 / Viewer`。
- 但用户切到 `对比工作区` 后，刷新页面应继续停留在工作区。
- 当前 tab 通过 `hash` 同步：
  - `#formatter`
  - `#workspace`

## 当前核心能力

- 单 JSON 格式化。
- 单 JSON 树形查看。
- Viewer 支持折叠 / 展开。
- 多组 JSON 对比工作区。
- 工作区支持：
  - 新建临时组
  - 新建并保存
  - 默认收起详情
  - 手动展开当前组
  - 左右 JSON 标题
  - 备注
  - Diff 结果
  - 仅显示差异
  - 左树 / 右树 / Diff 树折叠
  - 组删除
- 左右 JSON 输入后，Diff 自动刷新。

## 当前状态模型

当前状态主要在 `src/App.tsx` 内，由 React state 管理。核心字段：

```ts
type TabKey = "formatter" | "workspace";

type Group = {
  id: string;
  title: string;
  note: string;
  shouldPersist: boolean;
  leftTitle: string;
  rightTitle: string;
  leftJsonText: string;
  rightJsonText: string;
  showDiffOnly: boolean;
  leftCollapsedPaths: string[];
  rightCollapsedPaths: string[];
  diffCollapsedPaths: string[];
  updatedAt: number;
};
```

页面级关键状态：

- `activeTab`
- `activeGroupId`
- `formatterText`
- `formatterError`
- `formatterCollapsedPaths`
- `storageNotice`
- `groups`

## 本地存储约束

- 工作区主存储 key：`json-diff-tool.workspace.v1`
- 工作区备份 key：`json-diff-tool.workspace.backup`
- UI 状态 key：`json-diff-tool.ui.v1`
- 只持久化 `shouldPersist === true` 的组。
- 首页 Formatter 文本当前不持久化。
- 主存储损坏或版本不兼容时，原始数据需要写入 backup key，并提示用户。

## 交互约束

- 工作区为空时，不自动注入默认临时组。
- 空工作区只保留一处建组入口，避免重复 CTA。
- 新建组默认保持收起，用户自行展开。
- 活跃组展开，非活跃组只显示摘要、状态和差异概况。
- Diff 结果不单独持久化，而是基于当前左右 JSON 实时计算。
- “仅显示差异”只影响 Diff 树，不影响左右原始树。
- “格式化左侧 / 格式化右侧”是辅助动作，不是刷新 Diff 的唯一入口。

## UI 约束

- 优先保证工具感，而不是介绍页感。
- Hero 只保留必要定位和模式切换，不重复堆说明卡片。
- 工作区优先可扫描性：
  - 先看摘要
  - 再展开单组
  - 再编辑 JSON
- 按钮层级要清楚区分：
  - 主动作
  - 次动作
  - 危险动作

## 本地验证要求

迁移后的本地验证至少覆盖：

1. 空工作区可见。
2. 新建组后默认收起。
3. 展开后可输入左右 JSON。
4. Diff 会自动刷新。
5. 刷新后仍保留在 `#workspace`。
6. `npm run build` 成功。

## 维护要求

- 后续只要 `json-diff-tool` 的技术栈、状态结构、存储结构、关键交互发生变化，就同步更新本文件。
- 文档使用中文，只记录稳定上下文，不写过程流水账。
