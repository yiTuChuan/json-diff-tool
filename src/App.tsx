import { useEffect, useMemo, useRef, useState } from 'react';

type TabKey = 'formatter' | 'workspace';

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

type PersistedWorkspace = {
  version: number;
  groups: Group[];
};

type ParseResult =
  | { hasValue: false; error: string; value: null }
  | { hasValue: true; error: string; value: JsonValue };

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type TreeNode = {
  kind: 'object' | 'array' | 'primitive';
  status: 'plain' | 'unchanged' | 'added' | 'removed' | 'modified';
  pathKey: string;
  hasDiff: boolean;
  size?: number;
  value?: JsonValue;
  oldValue?: JsonValue;
  children?: Array<{ key: string; node: TreeNode }>;
};

const STORAGE_KEY = 'json-diff-tool.workspace.v1';
const STORAGE_BACKUP_KEY = 'json-diff-tool.workspace.backup';
const UI_STORAGE_KEY = 'json-diff-tool.ui.v1';
const STORAGE_VERSION = 1;

function readTabFromHash(): TabKey | '' {
  const hash = String(window.location.hash || '').replace(/^#/, '');
  return hash === 'workspace' || hash === 'formatter' ? hash : '';
}

function createId() {
  return 'group_' + Math.random().toString(36).slice(2, 10);
}

function createGroup(shouldPersist: boolean): Group {
  return {
    id: createId(),
    title: shouldPersist ? '已保存对比组' : '临时对比组',
    note: '',
    shouldPersist,
    leftTitle: 'Base JSON',
    rightTitle: 'Target JSON',
    leftJsonText: '',
    rightJsonText: '',
    showDiffOnly: false,
    leftCollapsedPaths: [],
    rightCollapsedPaths: [],
    diffCollapsedPaths: [],
    updatedAt: Date.now(),
  };
}

function loadUiTab(): TabKey {
  const hashTab = readTabFromHash();
  if (hashTab) return hashTab;

  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { activeTab?: TabKey }) : null;
    return parsed?.activeTab === 'workspace' ? 'workspace' : 'formatter';
  } catch {
    return 'formatter';
  }
}

function loadGroups(setStorageNotice: (value: string) => void): Group[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedWorkspace;
    if (!parsed || parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.groups)) {
      localStorage.setItem(STORAGE_BACKUP_KEY, raw);
      setStorageNotice('本地已保存数据版本不兼容，原始内容已备份。');
      return [];
    }
    return parsed.groups;
  } catch {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        localStorage.setItem(STORAGE_BACKUP_KEY, raw);
        setStorageNotice('本地已保存数据读取失败，原始内容已备份。');
      }
    } catch {
      setStorageNotice('本地数据读取失败，且无法写入备份。');
    }
    return [];
  }
}

function tryParseJson(text: string): ParseResult {
  const raw = text.trim();
  if (!raw) return { hasValue: false, error: '', value: null };
  try {
    return { hasValue: true, error: '', value: JSON.parse(raw) as JsonValue };
  } catch (error) {
    return { hasValue: false, error: `JSON 格式错误: ${(error as Error).message}`, value: null };
  }
}

function pathToKey(path: Array<string | number>) {
  if (!path.length) return '$';
  return path.map((part) => `${typeof part === 'number' ? 'i' : 'k'}:${encodeURIComponent(String(part))}`).join('/');
}

function makePath(path: Array<string | number>, next: string | number) {
  return [...path, next];
}

function isDeepEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return left === right;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => isDeepEqual(item, right[index]));
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left as Record<string, JsonValue>);
    const rightKeys = Object.keys(right as Record<string, JsonValue>);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      isDeepEqual((left as Record<string, JsonValue>)[key], (right as Record<string, JsonValue>)[key]),
    );
  }
  return false;
}

function createValueTree(value: JsonValue, path: Array<string | number>, status: TreeNode['status']): TreeNode {
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      status,
      pathKey: pathToKey(path),
      size: value.length,
      hasDiff: status !== 'unchanged',
      children: value.map((item, index) => ({
        key: `[${index}]`,
        node: createValueTree(item, makePath(path, index), status),
      })),
    };
  }

  if (value && typeof value === 'object') {
    return {
      kind: 'object',
      status,
      pathKey: pathToKey(path),
      size: Object.keys(value).length,
      hasDiff: status !== 'unchanged',
      children: Object.keys(value).map((key) => ({
        key,
        node: createValueTree((value as Record<string, JsonValue>)[key], makePath(path, key), status),
      })),
    };
  }

  return {
    kind: 'primitive',
    status,
    pathKey: pathToKey(path),
    value,
    hasDiff: status !== 'unchanged',
  };
}

function markHasDiff(node: TreeNode, hasDiff: boolean): TreeNode {
  return {
    ...node,
    hasDiff,
    children: node.children?.map((child) => ({
      key: child.key,
      node: markHasDiff(child.node, hasDiff),
    })),
  };
}

function createDiffTree(left: JsonValue | undefined, right: JsonValue | undefined, path: Array<string | number>): TreeNode {
  if (isDeepEqual(left, right)) {
    return markHasDiff(createValueTree((left ?? null) as JsonValue, path, 'unchanged'), false);
  }
  if (left === undefined) return markHasDiff(createValueTree(right as JsonValue, path, 'added'), true);
  if (right === undefined) return markHasDiff(createValueTree(left, path, 'removed'), true);

  if (Array.isArray(left) && Array.isArray(right)) {
    const size = Math.max(left.length, right.length);
    const children = Array.from({ length: size }, (_, index) => ({
      key: `[${index}]`,
      node: createDiffTree(left[index], right[index], makePath(path, index)),
    }));
    return {
      kind: 'array',
      status: children.some((child) => child.node.hasDiff) ? 'modified' : 'unchanged',
      pathKey: pathToKey(path),
      size,
      hasDiff: children.some((child) => child.node.hasDiff),
      children,
    };
  }

  if (
    left &&
    right &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
    const children = keys.map((key) => ({
      key,
      node: createDiffTree(
        (left as Record<string, JsonValue>)[key],
        (right as Record<string, JsonValue>)[key],
        makePath(path, key),
      ),
    }));
    return {
      kind: 'object',
      status: children.some((child) => child.node.hasDiff) ? 'modified' : 'unchanged',
      pathKey: pathToKey(path),
      size: keys.length,
      hasDiff: children.some((child) => child.node.hasDiff),
      children,
    };
  }

  return {
    kind: 'primitive',
    status: 'modified',
    pathKey: pathToKey(path),
    oldValue: left,
    value: right,
    hasDiff: true,
  };
}

function countDiffStats(node: TreeNode) {
  const stats = { added: 0, removed: 0, modified: 0 };
  const walk = (current: TreeNode) => {
    if (current.status === 'added') stats.added += 1;
    if (current.status === 'removed') stats.removed += 1;
    if (current.status === 'modified' && current.kind === 'primitive') stats.modified += 1;
    current.children?.forEach((child) => walk(child.node));
  };
  walk(node);
  return stats;
}

function markerForStatus(status: TreeNode['status']) {
  if (status === 'added') return '+';
  if (status === 'removed') return '-';
  if (status === 'modified') return '~';
  return '•';
}

function formatTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function trimText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}...` : value;
}

function formatPrimitive(value: JsonValue | undefined) {
  if (value === null) return <span className="token-null">null</span>;
  if (typeof value === 'string') return <span className="token-string">"{value}"</span>;
  if (typeof value === 'number') return <span className="token-number">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="token-boolean">{String(value)}</span>;
  if (typeof value === 'undefined') return <span className="token-keyword">undefined</span>;
  return <span>{String(value)}</span>;
}

type TreeProps = {
  node: TreeNode;
  label?: string;
  collapsed: Set<string>;
  onToggle: (pathKey: string) => void;
  showDiffOnly: boolean;
};

function TreeNodeView({ node, label, collapsed, onToggle, showDiffOnly }: TreeProps) {
  if (showDiffOnly && !node.hasDiff) return null;

  if (node.kind === 'primitive') {
    if (node.status === 'modified') {
      return (
        <div className="tree-node">
          <div className="tree-row status-modified">
            <span className="tree-spacer">•</span>
            <span className="marker status-modified">~</span>
            <div className="node-main">
              {label ? <span className="node-key">{label}</span> : null}
              {label ? ': ' : null}
              <span className="token-keyword">old</span> {formatPrimitive(node.oldValue)}
              <span className="token-keyword"> → new</span> {formatPrimitive(node.value)}
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="tree-node">
        <div className={`tree-row status-${node.status}`}>
          <span className="tree-spacer">•</span>
          <span className={`marker status-${node.status}`}>{markerForStatus(node.status)}</span>
          <div className="node-main">
            {label ? <span className="node-key">{label}</span> : null}
            {label ? ': ' : null}
            {formatPrimitive(node.value)}
          </div>
        </div>
      </div>
    );
  }

  const isCollapsed = collapsed.has(node.pathKey);
  const childHtml = node.children?.map((child) => (
    <TreeNodeView
      key={`${node.pathKey}-${child.key}`}
      node={child.node}
      label={child.key}
      collapsed={collapsed}
      onToggle={onToggle}
      showDiffOnly={showDiffOnly}
    />
  ));

  if (showDiffOnly && !childHtml?.some(Boolean) && node.hasDiff && node.status !== 'added' && node.status !== 'removed') {
    return null;
  }

  return (
    <div className="tree-node">
      <div className={`tree-row status-${node.status}`}>
        <button className="tree-toggle" type="button" onClick={() => onToggle(node.pathKey)}>
          {isCollapsed ? '▸' : '▾'}
        </button>
        <span className={`marker status-${node.status}`}>{markerForStatus(node.status)}</span>
        <div className="node-main">
          {label ? <span className="node-key">{label}</span> : null}
          {label ? ': ' : null}
          <span className="node-brace">{node.kind === 'array' ? '[' : '{'}</span>
          <span className="node-type">{node.kind === 'array' ? `${node.size} items` : `${node.size} keys`}</span>
        </div>
      </div>
      {isCollapsed ? null : <div className="tree-children">{childHtml}</div>}
      <div className={`tree-row status-${node.status}`}>
        <span className="tree-spacer">•</span>
        <span className={`marker status-${node.status}`}>{markerForStatus(node.status)}</span>
        <div className="node-main">
          <span className="node-brace">{node.kind === 'array' ? ']' : '}'}</span>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [storageNotice, setStorageNotice] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>(loadUiTab);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [formatterText, setFormatterText] = useState('');
  const [formatterCollapsedPaths, setFormatterCollapsedPaths] = useState<string[]>([]);
  const [groups, setGroups] = useState<Group[]>(() => loadGroups(setStorageNotice));
  const [formatterError, setFormatterError] = useState('');
  const workspaceInputRef = useRef<{ key: string; start: number; end: number; scrollTop: number } | null>(null);

  useEffect(() => {
    const onHashChange = () => {
      const hashTab = readTabFromHash();
      if (hashTab) setActiveTab(hashTab);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ activeTab }));
    if (window.location.hash !== `#${activeTab}`) {
      window.location.hash = activeTab;
    }
  }, [activeTab]);

  useEffect(() => {
    try {
      const payload: PersistedWorkspace = {
        version: STORAGE_VERSION,
        groups: groups.filter((group) => group.shouldPersist),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      setStorageNotice(`本地保存失败：${(error as Error).message}`);
    }
  }, [groups]);

  useEffect(() => {
    if (!workspaceInputRef.current) return;
    const target = document.querySelector<HTMLElement>(`[data-input-key="${workspaceInputRef.current.key}"]`);
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.focus();
      target.setSelectionRange(workspaceInputRef.current.start, workspaceInputRef.current.end);
      target.scrollTop = workspaceInputRef.current.scrollTop;
    }
    workspaceInputRef.current = null;
  });

  const formatterParsed = useMemo(() => tryParseJson(formatterText), [formatterText]);
  const updateGroup = (groupId: string, updater: (group: Group) => Group) => {
    setGroups((current) => current.map((group) => (group.id === groupId ? updater(group) : group)));
  };

  const handleTabChange = (tab: TabKey) => {
    setActiveTab(tab);
  };

  const handleFormatterFormat = () => {
    if (formatterParsed.error) {
      setFormatterError(formatterParsed.error);
      return;
    }
    if (formatterParsed.hasValue) {
      setFormatterText(JSON.stringify(formatterParsed.value, null, 2));
    }
    setFormatterError('');
  };

  const addGroup = (shouldPersist: boolean) => {
    setGroups((current) => [createGroup(shouldPersist), ...current]);
    setActiveTab('workspace');
    setActiveGroupId(null);
  };

  const moveFormatterIntoGroup = () => {
    const parsed = tryParseJson(formatterText);
    const group = createGroup(false);
    if (parsed.hasValue) {
      group.leftJsonText = JSON.stringify(parsed.value, null, 2);
    }
    setGroups((current) => [group, ...current]);
    setActiveTab('workspace');
    setActiveGroupId(null);
  };

  const toggleCollapsedPath = (
    groupId: string,
    field: 'leftCollapsedPaths' | 'rightCollapsedPaths' | 'diffCollapsedPaths',
    pathKey: string,
  ) => {
    updateGroup(groupId, (group) => {
      const next = group[field].includes(pathKey)
        ? group[field].filter((item) => item !== pathKey)
        : [...group[field], pathKey];
      return { ...group, [field]: next, updatedAt: Date.now() };
    });
  };

  const renderGroupTree = (
    group: Group,
    side: 'left' | 'right' | 'diff',
    parsed: ParseResult | TreeNode,
  ) => {
    if (side !== 'diff') {
      const result = parsed as ParseResult;
      if (result.error) return <div className="tree empty">{result.error}</div>;
      if (!result.hasValue) return <div className="tree empty viewer-mini">等待 JSON 输入。</div>;
      const tree = createValueTree(result.value, [], 'plain');
      const collapsed = new Set(side === 'left' ? group.leftCollapsedPaths : group.rightCollapsedPaths);
      return (
        <div className="tree viewer-mini">
          <TreeNodeView
            node={tree}
            collapsed={collapsed}
            onToggle={(pathKey) =>
              toggleCollapsedPath(group.id, side === 'left' ? 'leftCollapsedPaths' : 'rightCollapsedPaths', pathKey)
            }
            showDiffOnly={false}
          />
        </div>
      );
    }

    const tree = parsed as TreeNode;
    return (
      <div className="tree">
        <TreeNodeView
          node={tree}
          collapsed={new Set(group.diffCollapsedPaths)}
          onToggle={(pathKey) => toggleCollapsedPath(group.id, 'diffCollapsedPaths', pathKey)}
          showDiffOnly={group.showDiffOnly}
        />
      </div>
    );
  };

  return (
    <div className="app-shell">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Json Diff Tool</span>
          <h1>JSON Viewer with Diff Workspace</h1>
          <p>先格式化 JSON，再在工作区里管理多组对比。所有设计都围绕快速输入、快速观察和最少干扰。</p>
          <p className="hero-note">支持本地保存、自动刷新 diff、组级折叠和差异聚焦。</p>
          <div className="tabs">
            <button className={`tab ${activeTab === 'formatter' ? 'active' : ''}`} onClick={() => handleTabChange('formatter')} type="button">
              格式化 / Viewer
            </button>
            <button className={`tab ${activeTab === 'workspace' ? 'active' : ''}`} onClick={() => handleTabChange('workspace')} type="button">
              对比工作区
            </button>
          </div>
        </div>
      </section>

      <section className={`page ${activeTab === 'formatter' ? 'active' : ''}`}>
        <div className="formatter-layout">
          <section className="section card editor-panel">
            <div className="section-header">
              <div>
                <span className="section-kicker">Input</span>
                <h2 className="section-title">JSON 输入</h2>
                <p className="section-subtitle">单 JSON 格式化是首页默认功能。你可以把这里当作一个轻量 JSON Viewer。</p>
              </div>
              <div className="toolbar">
                <button className="btn" type="button" onClick={() => setFormatterText(JSON.stringify({ demo: true, list: [1, 2, 3] }, null, 2))}>示例数据</button>
                <button className="btn" type="button" onClick={() => { setFormatterText(''); setFormatterError(''); setFormatterCollapsedPaths([]); }}>清空</button>
                <button className="btn btn-primary" type="button" onClick={handleFormatterFormat}>格式化</button>
              </div>
            </div>
            <div className="panel-body">
              <textarea value={formatterText} onChange={(event) => { setFormatterText(event.target.value); setFormatterError(''); }} placeholder="粘贴 JSON，支持对象、数组、字符串、数字、布尔值、null。" />
              <div className="error-message">{formatterError}</div>
            </div>
          </section>

          <section className="section card viewer-panel">
            <div className="section-header">
              <div>
                <span className="section-kicker">Viewer</span>
                <h2 className="section-title">结构查看</h2>
                <p className="section-subtitle">支持属性折叠，便于快速检查层级结构与节点值。</p>
              </div>
              <div className="toolbar">
                <button className="btn btn-small" type="button" onClick={() => setFormatterCollapsedPaths([])}>全部展开</button>
                <button className="btn btn-small" type="button" onClick={() => setFormatterCollapsedPaths(['$'])}>全部折叠</button>
              </div>
            </div>
            <div className="panel-body">
              <div className="viewer-shell">
                <div className="viewer-toolbar">
                  <span className="viewer-note">{formatterParsed.hasValue ? '已解析成功，可继续折叠查看或进入对比工作区。' : '等待合法 JSON 输入。'}</span>
                  <button className="btn btn-small" type="button" onClick={moveFormatterIntoGroup}>将当前 JSON 放入新对比组</button>
                </div>
                {formatterParsed.error ? (
                  <div className="tree empty">{formatterParsed.error}</div>
                ) : formatterParsed.hasValue ? (
                  <div className="tree">
                    <TreeNodeView
                      node={createValueTree(formatterParsed.value, [], 'plain')}
                      collapsed={new Set(formatterCollapsedPaths)}
                      onToggle={(pathKey) =>
                        setFormatterCollapsedPaths((current) =>
                          current.includes(pathKey) ? current.filter((item) => item !== pathKey) : [...current, pathKey],
                        )
                      }
                      showDiffOnly={false}
                    />
                  </div>
                ) : (
                  <div className="tree empty">粘贴一个 JSON，点击格式化后即可在这里查看可折叠结构。</div>
                )}
              </div>
            </div>
          </section>
        </div>
      </section>

      <section className={`page ${activeTab === 'workspace' ? 'active' : ''}`}>
        <div className="compare-page">
          <section className="card">
            <div className="workspace-toolbar">
              <div>
                <span className="section-kicker">Workspace</span>
                <p>先创建组，再按需展开详情开始编辑。工作区默认保持摘要视图，减少长页面滚动。</p>
                <div className="workspace-stats">
                  <span className="summary-badge">总组数 {groups.length}</span>
                  <span className="summary-badge added">已保存 {groups.filter((group) => group.shouldPersist).length}</span>
                  <span className="summary-badge modified">临时组 {groups.filter((group) => !group.shouldPersist).length}</span>
                </div>
                {storageNotice ? <p className="storage-notice">{storageNotice}</p> : null}
              </div>
              {groups.length ? (
                <div className="toolbar">
                  <button className="btn" type="button" onClick={() => addGroup(false)}>新建临时组</button>
                  <button className="btn btn-primary" type="button" onClick={() => addGroup(true)}>新建并保存</button>
                </div>
              ) : null}
            </div>
          </section>

          <div className="workspace-groups">
            {groups.length ? (
              groups.map((group) => {
                const isActive = activeGroupId === group.id;
                const leftParsed = tryParseJson(group.leftJsonText);
                const rightParsed = tryParseJson(group.rightJsonText);
                const hasComparableJson = leftParsed.hasValue && rightParsed.hasValue && !leftParsed.error && !rightParsed.error;
                const diffTree = hasComparableJson ? createDiffTree(leftParsed.value, rightParsed.value, []) : null;
                const diffStats = diffTree ? countDiffStats(diffTree) : { added: 0, removed: 0, modified: 0 };

                return (
                  <section key={group.id} className={`card group-card ${isActive ? 'active' : 'collapsed'}`}>
                    <div className="group-head">
                      <div className="group-head-top">
                        <div className="group-summary-main">
                          <div className="group-title-shell">
                            <div className="group-title-header">
                              <span className="section-kicker">Diff Group</span>
                              <div className="group-meta">
                                <span className={`pill ${group.shouldPersist ? 'persisted' : 'temporary'}`}>{group.shouldPersist ? '已保存到本地' : '临时组'}</span>
                                <span className="group-timestamp">最近变更 {formatTimestamp(group.updatedAt)}</span>
                              </div>
                            </div>
                            <input
                              className="group-title-input"
                              type="text"
                              value={group.title}
                              placeholder="为此对比组命名"
                              onChange={(event) => updateGroup(group.id, (current) => ({ ...current, title: event.target.value, updatedAt: Date.now() }))}
                            />
                          </div>
                          <div className="summary group-inline-summary">
                            {hasComparableJson ? (
                              <>
                                <span className="summary-badge">{group.leftTitle} vs {group.rightTitle}</span>
                                <span className="summary-badge added">新增 {diffStats.added}</span>
                                <span className="summary-badge removed">删除 {diffStats.removed}</span>
                                <span className="summary-badge modified">修改 {diffStats.modified}</span>
                              </>
                            ) : (
                              <>
                                <span className="summary-badge">{group.leftJsonText.trim() ? '左侧已输入' : '左侧待输入'}</span>
                                <span className="summary-badge">{group.rightJsonText.trim() ? '右侧已输入' : '右侧待输入'}</span>
                                {leftParsed.error ? <span className="summary-badge removed">左侧有错误</span> : null}
                                {rightParsed.error ? <span className="summary-badge removed">右侧有错误</span> : null}
                              </>
                            )}
                          </div>
                          {!isActive && group.note.trim() ? <p className="group-note-preview">{trimText(group.note.trim(), 120)}</p> : null}
                        </div>
                        <div className="group-head-actions">
                          <button className="btn btn-small" type="button" onClick={() => setActiveGroupId(isActive ? null : group.id)}>
                            {isActive ? '收起详情' : '展开详情'}
                          </button>
                          <button
                            className="btn btn-small"
                            type="button"
                            onClick={() => updateGroup(group.id, (current) => ({ ...current, shouldPersist: !current.shouldPersist, updatedAt: Date.now() }))}
                          >
                            {group.shouldPersist ? '转为临时组' : '保存到本地'}
                          </button>
                          <button className="btn btn-small btn-danger" type="button" onClick={() => setGroups((current) => current.filter((item) => item.id !== group.id))}>
                            删除本组
                          </button>
                        </div>
                      </div>
                    </div>

                    {isActive ? (
                      <div className="group-body">
                        <div className="group-ops-card">
                          <div className="group-ops-row">
                            <div>
                              <span className="section-kicker">Editing</span>
                              <p className="ops-note">输入后自动刷新 diff。格式化按钮仅用于整理 JSON 文本。</p>
                            </div>
                            <div className="group-mode-actions">
                              <button
                                className="btn btn-small"
                                type="button"
                                onClick={() => updateGroup(group.id, (current) => {
                                  const parsed = tryParseJson(current.leftJsonText);
                                  return parsed.hasValue ? { ...current, leftJsonText: JSON.stringify(parsed.value, null, 2), updatedAt: Date.now() } : current;
                                })}
                              >
                                格式化左侧
                              </button>
                              <button
                                className="btn btn-small"
                                type="button"
                                onClick={() => updateGroup(group.id, (current) => {
                                  const parsed = tryParseJson(current.rightJsonText);
                                  return parsed.hasValue ? { ...current, rightJsonText: JSON.stringify(parsed.value, null, 2), updatedAt: Date.now() } : current;
                                })}
                              >
                                格式化右侧
                              </button>
                            </div>
                          </div>
                          <div className="group-ops-row secondary">
                            <label className="toggle-row">
                              <input
                                checked={group.showDiffOnly}
                                onChange={(event) => updateGroup(group.id, (current) => ({ ...current, showDiffOnly: event.target.checked, updatedAt: Date.now() }))}
                                type="checkbox"
                              />
                              <span>仅显示差异</span>
                            </label>
                            <div className="group-mode-actions">
                              <button className="btn btn-small" type="button" onClick={() => updateGroup(group.id, (current) => ({ ...current, leftCollapsedPaths: [], rightCollapsedPaths: [], diffCollapsedPaths: [] }))}>全部展开</button>
                              <button className="btn btn-small" type="button" onClick={() => updateGroup(group.id, (current) => ({ ...current, leftCollapsedPaths: ['$'], rightCollapsedPaths: ['$'], diffCollapsedPaths: ['$'] }))}>全部折叠</button>
                            </div>
                          </div>
                        </div>

                        <textarea
                          className="group-note"
                          data-input-key={`${group.id}:note`}
                          value={group.note}
                          onChange={(event) => updateGroup(group.id, (current) => ({ ...current, note: event.target.value, updatedAt: Date.now() }))}
                          placeholder="备注：记录临时信息、排查结论或上下文说明。"
                        />

                        <div className="group-grid">
                          <section className="json-panel">
                            <div className="json-panel-header">
                              <div className="panel-header-main">
                                <span className="panel-label">Base Json</span>
                                <input
                                  className="json-title-input"
                                  data-input-key={`${group.id}:leftTitle`}
                                  value={group.leftTitle}
                                  onChange={(event) => updateGroup(group.id, (current) => ({ ...current, leftTitle: event.target.value, updatedAt: Date.now() }))}
                                />
                              </div>
                              <div className="toolbar">
                                <button className="btn btn-small" type="button" onClick={() => updateGroup(group.id, (current) => ({ ...current, leftCollapsedPaths: [] }))}>展开</button>
                                <button className="btn btn-small" type="button" onClick={() => updateGroup(group.id, (current) => ({ ...current, leftCollapsedPaths: ['$'] }))}>折叠</button>
                              </div>
                            </div>
                            <div className="json-panel-body">
                              <textarea
                                data-input-key={`${group.id}:leftJsonText`}
                                value={group.leftJsonText}
                                onChange={(event) => {
                                  workspaceInputRef.current = {
                                    key: `${group.id}:leftJsonText`,
                                    start: event.target.selectionStart,
                                    end: event.target.selectionEnd,
                                    scrollTop: event.target.scrollTop,
                                  };
                                  updateGroup(group.id, (current) => ({ ...current, leftJsonText: event.target.value, updatedAt: Date.now() }));
                                }}
                                placeholder="粘贴左侧 Base JSON"
                              />
                              <div className="error-message">{leftParsed.error}</div>
                              <div className="viewer-shell">{renderGroupTree(group, 'left', leftParsed)}</div>
                            </div>
                          </section>

                          <section className="json-panel">
                            <div className="json-panel-header">
                              <div className="panel-header-main">
                                <span className="panel-label">Target Json</span>
                                <input
                                  className="json-title-input"
                                  data-input-key={`${group.id}:rightTitle`}
                                  value={group.rightTitle}
                                  onChange={(event) => updateGroup(group.id, (current) => ({ ...current, rightTitle: event.target.value, updatedAt: Date.now() }))}
                                />
                              </div>
                              <div className="toolbar">
                                <button className="btn btn-small" type="button" onClick={() => updateGroup(group.id, (current) => ({ ...current, rightCollapsedPaths: [] }))}>展开</button>
                                <button className="btn btn-small" type="button" onClick={() => updateGroup(group.id, (current) => ({ ...current, rightCollapsedPaths: ['$'] }))}>折叠</button>
                              </div>
                            </div>
                            <div className="json-panel-body">
                              <textarea
                                data-input-key={`${group.id}:rightJsonText`}
                                value={group.rightJsonText}
                                onChange={(event) => {
                                  workspaceInputRef.current = {
                                    key: `${group.id}:rightJsonText`,
                                    start: event.target.selectionStart,
                                    end: event.target.selectionEnd,
                                    scrollTop: event.target.scrollTop,
                                  };
                                  updateGroup(group.id, (current) => ({ ...current, rightJsonText: event.target.value, updatedAt: Date.now() }));
                                }}
                                placeholder="粘贴右侧 Target JSON"
                              />
                              <div className="error-message">{rightParsed.error}</div>
                              <div className="viewer-shell">{renderGroupTree(group, 'right', rightParsed)}</div>
                            </div>
                          </section>
                        </div>

                        <section className="diff-panel">
                          <div className="diff-panel-header">
                            <div>
                              <span className="section-kicker">Diff Result</span>
                              <h3 className="section-title">Diff 结果</h3>
                              <p className="section-subtitle">输入后自动刷新。支持仅显示差异与折叠浏览。</p>
                            </div>
                            <div className="toolbar">
                              <button className="btn btn-small" type="button" onClick={() => updateGroup(group.id, (current) => ({ ...current, diffCollapsedPaths: [] }))}>展开 Diff</button>
                              <button className="btn btn-small" type="button" onClick={() => updateGroup(group.id, (current) => ({ ...current, diffCollapsedPaths: ['$'] }))}>折叠 Diff</button>
                            </div>
                          </div>
                          <div className="panel-body">
                            <div className="summary">
                              {hasComparableJson ? (
                                <>
                                  <span className="summary-badge">{group.leftTitle} vs {group.rightTitle}</span>
                                  <span className="summary-badge added">新增 {diffStats.added}</span>
                                  <span className="summary-badge removed">删除 {diffStats.removed}</span>
                                  <span className="summary-badge modified">修改 {diffStats.modified}</span>
                                </>
                              ) : (
                                <span className="summary-badge">等待对比</span>
                              )}
                            </div>
                            <div className="viewer-shell diff-shell">
                              {diffTree ? renderGroupTree(group, 'diff', diffTree) : <div className="tree empty">两侧 JSON 都解析成功后，这里会显示差异树。</div>}
                            </div>
                          </div>
                        </section>
                      </div>
                    ) : null}
                  </section>
                );
              })
            ) : (
              <section className="card empty-workspace">
                <div className="panel-body">
                  <span className="section-kicker">No Groups</span>
                  <h2 className="section-title">还没有对比组</h2>
                  <p className="section-subtitle">先创建一个临时组或保存组，再手动展开详情开始编辑 JSON。</p>
                  <div className="toolbar mt-16">
                    <button className="btn" type="button" onClick={() => addGroup(false)}>新建临时组</button>
                    <button className="btn btn-primary" type="button" onClick={() => addGroup(true)}>新建并保存</button>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
