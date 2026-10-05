import type { ComponentSpec, WorkspaceState } from './types';

/**
 * 依赖账本（Dependency Ledger）
 *
 * 记录三类事实：
 * - contracts：每个组件当前契约版本（revision、键盘签名、属性清单）
 * - changes：契约改动来源（属性改名 / 移除 / 键盘行为变化），区分直接改动与级联改动
 * - refs：跨组件引用（关联组件的组合示例代码、读屏说明对基础组件的属性 / 键盘契约的引用）
 *
 * 属性改名、移除或键盘行为变化后，沿引用链立即失效重算：
 * - 能沿改名记录唯一映射的旧引用：自动迁移（改写正式内容）并在 provenance 留下来源
 * - 改名出现分支（多个去向）或版本不兼容：并列保留候选，用户选定前不写正式内容
 * - 旧数据缺少依赖信息：首次扫描统一标记 unverified（待核对）
 */

export type DependencyKind = 'property' | 'keyboard';
export type ChangeType = 'rename' | 'remove' | 'keyboard';
export type RefScope = 'code' | 'screenReader';

export type RefStatus =
  | 'current' // 引用有效
  | 'migrated' // 已按映射自动 / 手动迁移
  | 'unverified' // 旧数据缺依赖信息，待核对
  | 'pendingChoice' // 改名出现分支，待选定
  | 'pendingVerify' // 引用链上游经迁移改写，版本待核对
  | 'incompatible'; // 版本不兼容 / 无法映射，待处理

export interface ChangeOrigin {
  kind: 'direct' | 'cascade';
  /** 级联场景下，经由哪个组件的引用传播而来 */
  viaComponentId?: string;
  sourceChangeId?: string;
  note?: string;
}

export interface ContractChange {
  id: string;
  at: string;
  componentId: string;
  /** 改动产生的新契约版本号 */
  revision: number;
  type: ChangeType;
  oldName?: string;
  newName?: string;
  /** 移除属性时指定的接替属性；null 表示无接替（引用只能删除） */
  successorName?: string | null;
  oldKeyboard?: string;
  newKeyboard?: string;
  origin: ChangeOrigin;
}

export interface ComponentContract {
  revision: number;
  keyboardSignature: string;
  properties: Array<{ id: string; name: string; required: boolean }>;
}

export interface MigrationCandidate {
  id: string;
  action: 'migrate' | 'remove' | 'confirmKeyboard';
  /** migrate 时的目标属性名；remove 为 null */
  targetName: string | null;
  label: string;
  /** 映射路径说明，例如 variant→tone@r4 */
  detail: string;
}

export interface DependencyRef {
  id: string;
  ownerComponentId: string;
  scope: RefScope;
  /** scope=code 时所属示例 id */
  exampleId?: string;
  targetComponentId: string;
  kind: DependencyKind;
  /** 发现引用时的旧 token（属性名）；键盘引用固定为 __keyboard__ */
  oldName: string;
  /** 迁移后的属性名；删除引用迁移为 null */
  resolvedName?: string | null;
  /** 引用钉住的键盘签名 */
  keyboardSnapshot?: string;
  /** 引用钉住的契约版本 */
  pinnedRevision: number;
  status: RefStatus;
  pendingReason: string;
  candidates: MigrationCandidate[];
  /** 迁移与核对来源（可追加，不覆盖） */
  provenance: string[];
  /** 人工登记的组合依赖（即使 token 当前不存在也保留，等待选定迁移目标） */
  manual?: boolean;
  discoveredAt: string;
  updatedAt: string;
}

export interface DependencyLedger {
  version: 1;
  contracts: Record<string, ComponentContract>;
  changes: ContractChange[];
  refs: DependencyRef[];
  normalizedAt: string;
}

const KEYBOARD_TOKEN = '__keyboard__';

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const nowIso = () => new Date().toISOString();
export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const keyboardSignatureOf = (text: string) => text.trim();

export const UNRESOLVED_STATUSES: RefStatus[] = ['unverified', 'pendingChoice', 'pendingVerify', 'incompatible'];
export const isUnresolved = (ref: DependencyRef) => UNRESOLVED_STATUSES.includes(ref.status);

export const STATUS_LABEL: Record<RefStatus, string> = {
  current: '有效',
  migrated: '已迁移',
  unverified: '待核对（旧数据）',
  pendingChoice: '待选定（分支）',
  pendingVerify: '待核对（传递失效）',
  incompatible: '不兼容（待处理）'
};

export function buildContract(component: ComponentSpec): ComponentContract {
  return {
    revision: component.revision,
    keyboardSignature: keyboardSignatureOf(component.keyboardBehavior),
    properties: component.properties.map((property) => ({ id: property.id, name: property.name, required: property.required }))
  };
}

export function createLedger(components: ComponentSpec[]): DependencyLedger {
  const contracts: Record<string, ComponentContract> = {};
  for (const component of components) contracts[component.id] = buildContract(component);
  return { version: 1, contracts, changes: [], refs: [], normalizedAt: nowIso() };
}

export function syncContract(ledger: DependencyLedger, component: ComponentSpec) {
  ledger.contracts[component.id] = buildContract(component);
}

/** 内容已被人工改写、token 不再出现时，移除失活的引用记录（人工删除引用的记录保留以留存来源） */
function pruneRefs(state: WorkspaceState) {
  const { ledger } = state;
  if (!ledger) return;
  ledger.refs = ledger.refs.filter((ref) => {
    if (ref.manual) return true;
    if (ref.resolvedName === null && ref.provenance.some((line) => line.includes('删除旧引用'))) return true;
    const owner = state.components.find((component) => component.id === ref.ownerComponentId);
    if (!owner) return false;
    const target = state.components.find((component) => component.id === ref.targetComponentId);
    const token = ref.resolvedName ?? ref.oldName;
    if (ref.scope === 'screenReader') {
      return target ? wordUsed(owner.screenReader, token) : false;
    }
    const example = owner.examples.find((item) => item.id === ref.exampleId);
    if (!example || !target?.tagName) return false;
    if (!tagUsed(example.code, target.tagName)) return false;
    return ref.kind === 'keyboard' ? true : attrUsed(example.code, token);
  });
}

/** 手动登记组合依赖：沿用当前契约版本；写入的旧 token 立即尝试映射 */
export function addManualRef(
  state: WorkspaceState,
  spec: { ownerComponentId: string; scope: RefScope; exampleId?: string; targetComponentId: string; kind: DependencyKind; token: string }
): DependencyRef | undefined {
  const { ledger } = state;
  if (!ledger) return undefined;
  const contract = ledger.contracts[spec.targetComponentId];
  if (!contract) return undefined;
  if (ledger.refs.some((ref) => refMatches(ref, spec.scope, spec.exampleId, spec.targetComponentId, spec.kind, spec.token))) {
    return findRef(ledger, spec);
  }
  const ref: DependencyRef = {
    id: uid('ref'),
    ownerComponentId: spec.ownerComponentId,
    scope: spec.scope,
    exampleId: spec.exampleId,
    targetComponentId: spec.targetComponentId,
    kind: spec.kind,
    oldName: spec.token,
    pinnedRevision: contract.revision,
    keyboardSnapshot: contract.keyboardSignature,
    status: 'current',
    pendingReason: '',
    candidates: [],
    provenance: [`人工登记组合依赖（${nowIso()}）`],
    manual: true,
    discoveredAt: nowIso(),
    updatedAt: nowIso()
  };
  ledger.refs.push(ref);
  if (ref.kind === 'property' && !contract.properties.some((property) => property.name === spec.token)) {
    resolveFromAllChanges(state, ledger, ref);
  }
  return ref;
}

export function removeRefRecord(ledger: DependencyLedger, refId: string) {
  ledger.refs = ledger.refs.filter((ref) => ref.id !== refId);
}

/**
 * 加载时规整旧数据：没有账本则新建并把扫描到的引用全部标记为待核对；
 * 已有账本则补齐缺失契约并扫描新增引用。
 */
export function normalizeState(state: WorkspaceState): WorkspaceState {
  if (!state.ledger) {
    state.ledger = createLedger(state.components);
    scanRefs(state, { initial: true });
    return state;
  }
  for (const component of state.components) {
    if (!state.ledger.contracts[component.id]) syncContract(state.ledger, component);
  }
  scanRefs(state, { initial: false });
  return state;
}

// ---------------------------------------------------------------------------
// 引用扫描
// ---------------------------------------------------------------------------

const tagUsed = (code: string, tag: string) => new RegExp(`<${escapeRegExp(tag)}(?=[\\s>/])`).test(code);
/** 属性出现：带值（name="x"）或布尔属性（独立 token），但不匹配标签名 */
const attrUsed = (code: string, name: string) => new RegExp(`\\b${escapeRegExp(name)}\\b(\\s*=|(?=[\\s>/]))`).test(code);
const wordUsed = (text: string, name: string) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text);

/** 语义去重键：迁移后的 ref 同时以旧名 / 新名参与去重 */
function refMatches(ref: DependencyRef, scope: RefScope, exampleId: string | undefined, targetId: string, kind: DependencyKind, token: string) {
  return ref.scope === scope
    && (ref.exampleId ?? '') === (exampleId ?? '')
    && ref.targetComponentId === targetId
    && ref.kind === kind
    && (ref.oldName === token || ref.resolvedName === token);
}

export function findRef(
  ledger: DependencyLedger,
  query: { ownerComponentId: string; scope: RefScope; exampleId?: string; targetComponentId: string; kind: DependencyKind; token: string }
): DependencyRef | undefined {
  return ledger.refs.find((ref) => refMatches(ref, query.scope, query.exampleId, query.targetComponentId, query.kind, query.token));
}

function discoverRef(
  state: WorkspaceState,
  ledger: DependencyLedger,
  spec: { ownerComponentId: string; scope: RefScope; exampleId?: string; targetComponentId: string; kind: DependencyKind; token: string },
  initial: boolean
) {
  const { ownerComponentId, scope, exampleId, targetComponentId, kind, token } = spec;
  if (ledger.refs.some((ref) => refMatches(ref, scope, exampleId, targetComponentId, kind, token))) return;
  const contract = ledger.contracts[targetComponentId];
  if (!contract) return;
  const validNow = kind === 'keyboard'
    ? true
    : contract.properties.some((property) => property.name === token);
  const ref: DependencyRef = {
    id: uid('ref'),
    ownerComponentId,
    scope,
    exampleId,
    targetComponentId,
    kind,
    oldName: token,
    pinnedRevision: contract.revision,
    keyboardSnapshot: contract.keyboardSignature,
    status: 'current',
    pendingReason: '',
    candidates: [],
    provenance: [],
    discoveredAt: nowIso(),
    updatedAt: nowIso()
  };
  if (initial) {
    ref.status = 'unverified';
    ref.provenance.push('旧数据缺少依赖信息，系统标记为待核对。');
  } else if (!validNow) {
    // 用户在编辑中写下了一个当前不存在的旧 token：沿全部改名记录尝试映射
    resolveFromAllChanges(state, ledger, ref);
  }
  if (!ledger.refs.some((existing) => existing.id === ref.id)) ledger.refs.push(ref);
}

/** 扫描所有组件，发现组合示例代码与读屏说明中的跨组件引用 */
export function scanRefs(state: WorkspaceState, options: { initial: boolean }) {
  const { ledger } = state;
  if (!ledger) return;
  pruneRefs(state);
  for (const owner of state.components) {
    for (const target of state.components) {
      if (target.id === owner.id || !target.tagName) continue;
      // 组合示例代码：出现目标组件标签后，检查其属性与键盘契约
      for (const example of owner.examples) {
        if (!tagUsed(example.code, target.tagName)) continue;
        for (const property of target.properties) {
          if (attrUsed(example.code, property.name)) {
            discoverRef(state, ledger, { ownerComponentId: owner.id, scope: 'code', exampleId: example.id, targetComponentId: target.id, kind: 'property', token: property.name }, options.initial);
          }
        }
        discoverRef(state, ledger, { ownerComponentId: owner.id, scope: 'code', exampleId: example.id, targetComponentId: target.id, kind: 'keyboard', token: KEYBOARD_TOKEN }, options.initial);
      }
      // 读屏说明：裸属性名引用（如 “variant 层级需随名称播报”）
      for (const property of target.properties) {
        if (wordUsed(owner.screenReader, property.name)) {
          discoverRef(state, ledger, { ownerComponentId: owner.id, scope: 'screenReader', targetComponentId: target.id, kind: 'property', token: property.name }, options.initial);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 失效重算（沿引用链）
// ---------------------------------------------------------------------------

interface PathState {
  name: string | null;
  path: string[];
}

const removeCandidate = (path: string[]): MigrationCandidate => ({
  id: '__remove__',
  action: 'remove',
  targetName: null,
  label: '删除该引用',
  detail: path.join('；') || '旧属性已移除且无接替项'
});

function applicableChanges(ledger: DependencyLedger, ref: DependencyRef) {
  return ledger.changes
    .filter((change) => change.componentId === ref.targetComponentId
      && change.revision > ref.pinnedRevision
      && (change.type === 'rename' || change.type === 'remove'))
    .sort((a, b) => a.revision - b.revision);
}

function getRefText(state: WorkspaceState, ref: DependencyRef): { text: string; set: (next: string) => void } | undefined {
  const owner = state.components.find((component) => component.id === ref.ownerComponentId);
  if (!owner) return undefined;
  if (ref.scope === 'screenReader') {
    return { text: owner.screenReader, set: (next) => { owner.screenReader = next; } };
  }
  const example = owner.examples.find((item) => item.id === ref.exampleId);
  if (!example) return undefined;
  return { text: example.code, set: (next) => { example.code = next; } };
}

function replaceAttrToken(code: string, oldName: string, newName: string) {
  return code.replace(new RegExp(`\\b${escapeRegExp(oldName)}\\b(?=\\s*=|[\\s>/])`, 'g'), newName);
}
function replaceWordToken(text: string, oldName: string, newName: string) {
  return text.replace(new RegExp(`\\b${escapeRegExp(oldName)}\\b`, 'g'), newName);
}
function deleteAttrToken(code: string, name: string) {
  return code
    .replace(new RegExp(`\\s*\\b${escapeRegExp(name)}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'g'), '')
    .replace(new RegExp(`\\s+\\b${escapeRegExp(name)}\\b(?=[\\s>/])`, 'g'), '');
}
function deleteWordToken(text: string, name: string) {
  return text.replace(new RegExp(`\\s*\\b${escapeRegExp(name)}\\b`, 'g'), '');
}

function applyMigration(state: WorkspaceState, ledger: DependencyLedger, ref: DependencyRef, toName: string, path: string[], source?: string) {
  const target = ledger.contracts[ref.targetComponentId];
  const accessor = getRefText(state, ref);
  const fromName = ref.resolvedName ?? ref.oldName;
  if (accessor) {
    accessor.set(ref.scope === 'code' ? replaceAttrToken(accessor.text, fromName, toName) : replaceWordToken(accessor.text, fromName, toName));
  }
  ref.resolvedName = toName;
  ref.status = 'migrated';
  ref.pendingReason = '';
  ref.candidates = [];
  ref.pinnedRevision = target?.revision ?? ref.pinnedRevision;
  ref.keyboardSnapshot = target?.keyboardSignature ?? ref.keyboardSnapshot;
  ref.updatedAt = nowIso();
  ref.provenance.push(`自动迁移：${ref.oldName}→${toName}（${path.join('；') || '直接映射'}${source ? `；来源：${source}` : ''}）`);
  clearExampleStale(state, ref);
}

function clearExampleStale(state: WorkspaceState, ref: DependencyRef) {
  if (ref.scope !== 'code' || !ref.exampleId) return;
  const owner = state.components.find((component) => component.id === ref.ownerComponentId);
  const example = owner?.examples.find((item) => item.id === ref.exampleId);
  if (example) {
    example.stale = false;
    example.staleReason = '';
  }
}

function pathLabel(change: ContractChange, from: string, to: string | null): string {
  if (change.type === 'remove') {
    const suffix = change.successorName ? `→${change.successorName}` : '（无接替）';
    return `${from} 移除@r${change.revision}${suffix}`;
  }
  return `${from}→${to}@r${change.revision}`;
}

/** 单条改动作用于一个路径状态（不匹配时原样返回） */
function applyChangeToPath(current: PathState, change: ContractChange): PathState[] {
  if (current.name === null) return [current];
  if (current.name !== change.oldName) return [current];
  if (change.type === 'rename' && change.newName) {
    return [{ name: change.newName, path: [...current.path, pathLabel(change, current.name, change.newName)] }];
  }
  if (change.type === 'remove') {
    return [{ name: change.successorName ?? null, path: [...current.path, pathLabel(change, current.name, change.successorName ?? null)] }];
  }
  return [current];
}

function dedupePaths(paths: PathState[]): PathState[] {
  return paths.filter((path, index) => paths.findIndex((other) => other.name === path.name && other.path.join('>') === path.path.join('>')) === index);
}

function resolvePropertyRef(state: WorkspaceState, ledger: DependencyLedger, ref: DependencyRef, sourceLabel?: string) {
  const contract = ledger.contracts[ref.targetComponentId];
  if (!contract) {
    ref.status = 'incompatible';
    ref.pendingReason = '目标组件契约缺失。';
    return;
  }
  const changes = applicableChanges(ledger, ref);
  const startName = ref.resolvedName ?? ref.oldName;

  if (!changes.length) {
    if (contract.properties.some((property) => property.name === startName)) {
      if (ref.status !== 'migrated') ref.status = 'current';
      ref.pendingReason = '';
      ref.candidates = [];
      ref.pinnedRevision = contract.revision;
    } else {
      ref.status = 'incompatible';
      ref.pendingReason = `属性 ${startName} 在目标契约中不存在，且没有改名记录。`;
      ref.candidates = [removeCandidate([])];
    }
    return;
  }

  // 按版本分组推进状态：
  // - 同一起点名在同一版本存在多条并行改名 → 分支，各自独立产出并列去向；
  // - 否则按改动顺序链式推进。
  const revisions = [...new Set(changes.map((change) => change.revision))].sort((a, b) => a - b);
  let states: PathState[] = [{ name: startName, path: [] }];
  for (const revision of revisions) {
    const group = changes.filter((change) => change.revision === revision);
    let next: PathState[] = [];
    for (const base of states) {
      // 该起点在本版本是否有并行去向
      const parallel = group.filter((change) => change.oldName === base.name);
      if (parallel.length > 1) {
        for (const change of parallel) next.push(...applyChangeToPath(base, change).filter((item) => item !== base));
      } else {
        let working: PathState[] = [base];
        for (const change of group) {
          working = working.flatMap((item) => applyChangeToPath(item, change));
        }
        next.push(...working);
      }
    }
    states = dedupePaths(next);
  }

  const deduped = states.filter((stateItem, index) => states.findIndex((other) => other.name === stateItem.name) === index);
  const isLive = (name: string | null) => name === null || contract.properties.some((property) => property.name === name);

  if (deduped.length === 1) {
    const only = deduped[0];
    if (only.name && isLive(only.name)) {
      applyMigration(state, ledger, ref, only.name, only.path, sourceLabel);
      return;
    }
    ref.status = 'incompatible';
    ref.pendingReason = only.name
      ? `属性 ${ref.oldName} 的去向 ${only.name} 在当前契约中已不存在。`
      : `属性 ${ref.oldName} 已被移除且没有接替项，需要人工删除引用。`;
    ref.candidates = [removeCandidate(only.path)];
    return;
  }

  const liveEnds = deduped.filter((stateItem) => stateItem.name && isLive(stateItem.name));
  if (liveEnds.length <= 1 && !deduped.some((stateItem) => stateItem.name === null)) {
    ref.status = 'incompatible';
    ref.pendingReason = `属性 ${ref.oldName} 的所有改名去向在当前契约中都已不存在。${deduped.map((stateItem) => stateItem.path.join('；')).join(' / ')}`;
    ref.candidates = [removeCandidate(deduped.flatMap((stateItem) => stateItem.path))];
    return;
  }

  // 分支：并列保留候选，选定前不写正式内容
  ref.status = 'pendingChoice';
  ref.pendingReason = `属性 ${ref.oldName} 存在 ${deduped.length} 个改名去向，请选定迁移目标。`;
  ref.candidates = deduped.map((stateItem) => {
    if (stateItem.name === null) return removeCandidate(stateItem.path);
    return {
      id: uid('cand'),
      action: 'migrate' as const,
      targetName: stateItem.name,
      label: `迁移到 ${stateItem.name}`,
      detail: stateItem.path.join('；')
    };
  });
}

function resolveKeyboardRef(ledger: DependencyLedger, ref: DependencyRef) {
  const contract = ledger.contracts[ref.targetComponentId];
  if (!contract) {
    ref.status = 'incompatible';
    ref.pendingReason = '目标组件契约缺失。';
    return;
  }
  const change = [...ledger.changes]
    .filter((item) => item.componentId === ref.targetComponentId && item.type === 'keyboard' && item.revision > ref.pinnedRevision)
    .sort((a, b) => b.revision - a.revision)[0];
  if (!change) {
    if (ref.status !== 'migrated') ref.status = 'current';
    ref.pendingReason = '';
    ref.candidates = [];
    ref.pinnedRevision = contract.revision;
    ref.keyboardSnapshot = contract.keyboardSignature;
    return;
  }
  ref.status = 'incompatible';
  ref.pendingReason = `键盘行为契约在 r${change.revision} 发生变化：「${change.oldKeyboard ?? '—'}」→「${change.newKeyboard ?? '—'}」，请人工核对示例与读屏说明。`;
  ref.candidates = [{
    id: '__keyboard_confirm__',
    action: 'confirmKeyboard',
    targetName: null,
    label: '键盘行为已核对',
    detail: `确认 r${change.revision} 的键盘行为变化`
  }];
}

/** 沿引用链分层失效重算：直接引用第 1 层，经由其他组件传递的引用为更深层 */
export function cascade(ledger: DependencyLedger, state: WorkspaceState, change: ContractChange) {
  const sourceLabel = describeOrigin(change);

  // 1) 计算每个组件到变更组件的最短引用链深度
  const depth = new Map<string, number>([[change.componentId, 0]]);
  let frontier = new Set<string>([change.componentId]);
  while (frontier.size) {
    const next = new Set<string>();
    for (const targetId of frontier) {
      for (const ref of ledger.refs) {
        if (ref.targetComponentId !== targetId || ref.ownerComponentId === targetId) continue;
        if (!depth.has(ref.ownerComponentId)) {
          depth.set(ref.ownerComponentId, (depth.get(targetId) ?? 0) + 1);
          next.add(ref.ownerComponentId);
        }
      }
    }
    frontier = next;
  }

  // 2) 处理引用。若一个组件因迁移而被改写了正式内容（migrated 集合），
  //    引用该组件的下游即使直接引用（hop=1 相对该组件）也标记传递待核对。
  const migratedOwners = new Set<string>();
  const affected = ledger.refs
    .filter((ref) => depth.has(ref.targetComponentId))
    .sort((a, b) => (depth.get(a.targetComponentId) ?? 0) - (depth.get(b.targetComponentId) ?? 0));
  for (const ref of affected) {
    if (ref.status === 'unverified') continue; // 旧数据待人工核对，不自动处理
    const hop = (depth.get(ref.targetComponentId) ?? 0) + 1;
    const transitive = hop > 1 || migratedOwners.has(ref.targetComponentId);
    if (ref.kind === 'property') {
      resolvePropertyRef(state, ledger, ref, sourceLabel);
      if (ref.status === 'migrated') migratedOwners.add(ref.ownerComponentId);
      if (transitive && ref.status === 'migrated') {
        // 第二（或更深）层 / 上游刚被迁移改写：自动改写正式内容后标记“传递失效待核对”
        ref.status = 'pendingVerify';
        ref.pendingReason = `引用链上游经由 ${sourceLabel} 已自动迁移（${ref.oldName}→${ref.resolvedName ?? '已删除'}），请核对改写后的内容。`;
        ref.candidates = [];
        ref.provenance.push(`沿引用链传递：自动迁移并标记待核对（第 ${hop} 层）：${sourceLabel}`);
        ref.updatedAt = nowIso();
      }
    } else if (ref.status === 'current' || ref.status === 'migrated') {
      // 键盘契约不能自动改写：直接变化给 incompatible；纯传递场景给待核对
      resolveKeyboardRef(ledger, ref);
      if (transitive) {
        ref.status = 'pendingVerify';
        ref.pendingReason = `引用链上游经由 ${sourceLabel} 发生契约改写，请重新核对键盘行为。`;
        ref.candidates = [{
          id: '__keyboard_confirm__',
          action: 'confirmKeyboard',
          targetName: null,
          label: '键盘行为已核对',
          detail: `确认经由引用链传递的键盘契约变化（${sourceLabel}）`
        }];
        ref.provenance.push(`沿引用链传递：键盘契约待核对（第 ${hop} 层）：${sourceLabel}`);
        ref.updatedAt = nowIso();
      }
    }
  }
}

/** 编辑中新增的旧 token 引用：忽略钉住版本，沿全部改名记录尝试映射 */
function resolveFromAllChanges(state: WorkspaceState, ledger: DependencyLedger, ref: DependencyRef) {
  const contract = ledger.contracts[ref.targetComponentId];
  if (!contract) return;
  const earliest = ledger.changes
    .filter((change) => change.componentId === ref.targetComponentId && (change.type === 'rename' || change.type === 'remove'))
    .sort((a, b) => a.revision - b.revision)[0];
  ref.pinnedRevision = earliest ? earliest.revision - 1 : contract.revision;
  ref.status = 'current';
  if (ref.kind === 'property') resolvePropertyRef(state, ledger, ref, '编辑时写入旧属性名');
}

/** 重新计算所有钉住旧版本的引用（unverified 仍需人工先核对） */
export function recomputeRefs(state: WorkspaceState) {
  const { ledger } = state;
  if (!ledger) return;
  scanRefs(state, { initial: false });
  for (const ref of ledger.refs) {
    if (ref.status === 'unverified') continue;
    const contract = ledger.contracts[ref.targetComponentId];
    if (!contract || ref.pinnedRevision >= contract.revision) continue;
    if (ref.kind === 'property') resolvePropertyRef(state, ledger, ref);
    else resolveKeyboardRef(ledger, ref);
  }
}

// ---------------------------------------------------------------------------
// 人工处置：选定候选 / 核对通过 / 删除引用记录
// ---------------------------------------------------------------------------

/** 用户在分支或不兼容候选中做出选择后，才写入正式内容 */
export function applyCandidate(state: WorkspaceState, refId: string, candidateId: string): boolean {
  const { ledger } = state;
  if (!ledger) return false;
  const ref = ledger.refs.find((item) => item.id === refId);
  if (!ref) return false;
  const candidate = ref.candidates.find((item) => item.id === candidateId);
  if (!candidate) return false;
  const contract = ledger.contracts[ref.targetComponentId];
  const accessor = getRefText(state, ref);

  if (candidate.action === 'confirmKeyboard') {
    ref.status = 'current';
    ref.pendingReason = '';
    ref.candidates = [];
    ref.pinnedRevision = contract?.revision ?? ref.pinnedRevision;
    ref.keyboardSnapshot = contract?.keyboardSignature ?? ref.keyboardSnapshot;
    ref.provenance.push(`人工确认：${candidate.detail}（${nowIso()}）`);
    ref.updatedAt = nowIso();
    clearExampleStale(state, ref);
    return true;
  }

  if (candidate.action === 'remove') {
    if (accessor) {
      const token = ref.resolvedName ?? ref.oldName;
      accessor.set(ref.scope === 'code' ? deleteAttrToken(accessor.text, token) : deleteWordToken(accessor.text, token));
    }
    ref.status = 'migrated';
    ref.resolvedName = null;
    ref.pendingReason = '';
    ref.candidates = [];
    ref.pinnedRevision = contract?.revision ?? ref.pinnedRevision;
    ref.provenance.push(`人工选定：删除旧引用 ${ref.oldName}（${candidate.detail}）`);
    ref.updatedAt = nowIso();
    return true;
  }

  // migrate
  const targetName = candidate.targetName;
  if (!targetName || !contract?.properties.some((property) => property.name === targetName)) return false;
  if (accessor) {
    const token = ref.resolvedName ?? ref.oldName;
    accessor.set(ref.scope === 'code' ? replaceAttrToken(accessor.text, token, targetName) : replaceWordToken(accessor.text, token, targetName));
  }
  ref.status = 'migrated';
  ref.resolvedName = targetName;
  ref.pendingReason = '';
  ref.candidates = [];
  ref.pinnedRevision = contract.revision;
  ref.keyboardSnapshot = contract.keyboardSignature;
  ref.provenance.push(`人工选定迁移：${ref.oldName}→${targetName}（${candidate.detail}）`);
  ref.updatedAt = nowIso();
  clearExampleStale(state, ref);
  return true;
}

/** 旧数据待核对 / 传递失效：核对通过后立即按改名记录重算（可能自动迁移或进入分支） */
export function markRefVerified(state: WorkspaceState, refId: string): boolean {
  const { ledger } = state;
  if (!ledger) return false;
  const ref = ledger.refs.find((item) => item.id === refId);
  if (!ref || (ref.status !== 'unverified' && ref.status !== 'pendingVerify')) return false;
  const contract = ledger.contracts[ref.targetComponentId];
  if (!contract) return false;
  if (ref.kind === 'property') {
    // 保留旧 resolvedName/钉住版本：已是 migrated 的引用核对后保持 migrated（来源不丢）
    resolvePropertyRef(state, ledger, ref, ref.status === 'unverified' ? '旧数据人工核对' : '传递失效人工核对');
    const settled = ref.status as RefStatus;
    if (settled === 'current' || settled === 'migrated') {
      ref.provenance.push(`人工核对通过（${settled === 'migrated' ? `已确认迁移到 ${ref.resolvedName}，` : ''}钉住 r${ref.pinnedRevision}，${nowIso()}）`);
    }
  } else {
    resolveKeyboardRef(ledger, ref);
    if ((ref.status as RefStatus) === 'current') ref.provenance.push(`人工核对通过（键盘契约 r${contract.revision}，${nowIso()}）`);
  }
  ref.updatedAt = nowIso();
  return true;
}

export function describeOrigin(change: ContractChange): string {
  if (change.origin.kind === 'direct') return `直接改动 r${change.revision}`;
  return `级联改动 r${change.revision}（经 ${change.origin.viaComponentId ?? '?'}）${change.origin.note ? ` · ${change.origin.note}` : ''}`;
}

export function describeChange(change: ContractChange, componentName: string): string {
  switch (change.type) {
    case 'rename': return `${componentName}：属性 ${change.oldName} 改名为 ${change.newName}`;
    case 'remove': return `${componentName}：属性 ${change.oldName} 移除${change.successorName ? `，接替属性 ${change.successorName}` : '，无接替项'}`;
    case 'keyboard': return `${componentName}：键盘行为契约变化`;
  }
}

// ---------------------------------------------------------------------------
// 阻塞条件
// ---------------------------------------------------------------------------

export function blockingReasons(state: WorkspaceState, componentId: string): string[] {
  const { ledger, components } = state;
  if (!ledger) return [];
  const nameOf = (id: string) => components.find((component) => component.id === id)?.name ?? id;
  const reasons: string[] = [];

  for (const ref of ledger.refs.filter(isUnresolved)) {
    const where = ref.scope === 'code'
      ? `组合示例《${components.find((component) => component.id === ref.ownerComponentId)?.examples.find((example) => example.id === ref.exampleId)?.title ?? '?'}》`
      : '读屏说明';
    const token = ref.kind === 'keyboard' ? '键盘契约' : `属性 ${ref.resolvedName ?? ref.oldName}`;
    if (ref.ownerComponentId === componentId) {
      reasons.push(`${where}对 ${nameOf(ref.targetComponentId)} 的 ${token} 引用：${STATUS_LABEL[ref.status]} —— ${ref.pendingReason || '待整理'}`);
    }
  }

  const incoming = ledger.refs.filter((ref) => ref.targetComponentId === componentId && isUnresolved(ref));
  if (incoming.length) {
    const owners = new Set(incoming.map((ref) => nameOf(ref.ownerComponentId)));
    reasons.push(`关联组件仍有 ${incoming.length} 项失效引用未处理（${[...owners].join('、')}），发布后复制代码可能报错。`);
  }
  return reasons;
}

export function refBlocksCopy(ref: DependencyRef) {
  return ref.scope === 'code' && isUnresolved(ref);
}
