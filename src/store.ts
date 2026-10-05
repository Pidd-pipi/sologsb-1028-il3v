import { createInitialState } from './data';
import {
  applyCandidate,
  blockingReasons,
  buildContract,
  cascade,
  createLedger,
  findRef,
  isUnresolved,
  markRefVerified,
  normalizeState,
  recomputeRefs,
  removeRefRecord,
  scanRefs,
  syncContract,
  addManualRef,
  keyboardSignatureOf,
  type ContractChange
} from './ledger';
import type { ComponentSnapshot, ComponentSpec, ValidationIssue, WorkspaceState } from './types';

const STORAGE_KEY = 'sologsb-1028-workspace-v1';

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const signature = (component: ComponentSpec) => `${component.properties.map((item) => `${item.name}:${item.required}`).join('|')}::${component.interactionSignature}`;

export interface ActionResult {
  ok: boolean;
  reason?: string;
}

export class SpecStore extends EventTarget {
  state: WorkspaceState;
  private undoStack: WorkspaceState[] = [];
  private redoStack: WorkspaceState[] = [];
  private lastAction = '';

  constructor() {
    super();
    this.state = this.load();
  }

  get selected(): ComponentSpec | undefined {
    return this.state.components.find((item) => item.id === this.state.selectedId);
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get lastUndoLabel() { return this.lastAction; }

  select(id: string) {
    if (!this.state.components.some((item) => item.id === id)) return;
    this.state = { ...this.state, selectedId: id };
    this.persist(false);
    this.emit();
  }

  addComponent() {
    const id = uid('component');
    const component: ComponentSpec = {
      id,
      name: 'Untitled component',
      category: 'Uncategorised',
      status: 'draft',
      tagName: '',
      purpose: '说明该组件解决的用户问题。',
      usage: '说明何时使用、何时不要使用。',
      properties: [],
      states: 'default、hover、focus-visible、disabled。',
      keyboardBehavior: '记录 Tab、Enter、Space、方向键和 Esc 等行为。',
      screenReader: '记录角色、名称、状态和动态播报。',
      disabledScenarios: '记录不应使用该组件的场景。',
      interactionSignature: '',
      examples: [],
      revision: 1,
      updatedAt: new Date().toISOString(),
      snapshots: []
    };
    this.commit('新建组件', (state) => {
      state.components.unshift(component);
      state.selectedId = id;
      if (state.ledger) syncContract(state.ledger, component);
    });
  }

  updateComponent(patch: Partial<ComponentSpec>, markExamplesStale = false) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑组件', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      Object.assign(target, patch, { updatedAt: new Date().toISOString() });
      if (markExamplesStale) {
        target.examples.forEach((example) => {
          example.stale = true;
          example.staleReason = '组件交互或属性契约已修改，示例需要重新验证。';
        });
      }
      if (patch.screenReader !== undefined) scanRefs(state, { initial: false });
    });
  }

  addProperty() {
    const selected = this.selected;
    if (!selected) return;
    this.commit('新增属性', (state) => {
      state.components.find((item) => item.id === selected.id)?.properties.push({
        id: uid('property'),
        name: 'newProperty',
        type: 'string',
        required: false,
        defaultValue: '',
        description: '描述该属性对开发者和用户的影响。'
      });
      if (state.ledger) syncContract(state.ledger, state.components.find((item) => item.id === selected.id)!);
    });
  }

  updateProperty(propertyId: string, patch: Partial<ComponentSpec['properties'][number]>) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑属性', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      const property = target?.properties.find((item) => item.id === propertyId);
      if (target && property) {
        Object.assign(property, patch);
        if (state.ledger) syncContract(state.ledger, target);
      }
    });
  }

  /**
   * 属性改名：记录契约改动（直接来源）、提升契约版本，
   * 同组件示例立即改写旧属性名，随后沿引用链失效重算。
   * 重名改名会形成“分支”，此处拒绝以避免歧义（分支由历史改名记录自然产生）。
   */
  renameProperty(propertyId: string, nextName: string): ActionResult {
    const selected = this.selected;
    if (!selected) return { ok: false };
    const property = selected.properties.find((item) => item.id === propertyId);
    if (!property) return { ok: false };
    const trimmed = nextName.trim();
    if (!trimmed) return { ok: false, reason: '属性名不能为空。' };
    if (trimmed === property.name) return { ok: true };
    if (selected.properties.some((item) => item.id !== propertyId && item.name === trimmed)) {
      return { ok: false, reason: `属性名 ${trimmed} 已存在，改名会产生歧义分支，请换一个名称。` };
    }
    const oldName = property.name;
    this.commit('属性改名', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      const prop = target?.properties.find((item) => item.id === propertyId);
      if (!target || !prop || !state.ledger) return;
      prop.name = trimmed;
      target.revision += 1;
      target.updatedAt = new Date().toISOString();
      // 同组件组合示例立即改写，避免发布后复制代码报错（覆盖带值属性与布尔属性）
      for (const example of target.examples) {
        if (new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(\\s*=|[\\s>/])`).test(example.code)) {
          example.code = example.code.replace(new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?=\\s*=|[\\s>/])`, 'g'), trimmed);
          example.createdFromRevision = target.revision;
          example.stale = false;
          example.staleReason = '';
        }
      }
      const change: ContractChange = {
        id: uid('change'),
        at: new Date().toISOString(),
        componentId: target.id,
        revision: target.revision,
        type: 'rename',
        oldName,
        newName: trimmed,
        origin: { kind: 'direct' }
      };
      state.ledger.changes.unshift(change);
      syncContract(state.ledger, target);
      cascade(state.ledger, state, change);
    });
    return { ok: true };
  }

  /**
   * 属性移除：successorName 为接替属性（自动迁移目标）；null 表示无接替（引用只能删除）。
   */
  removeProperty(propertyId: string, successorName?: string | null) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('删除属性', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      const property = target?.properties.find((item) => item.id === propertyId);
      if (!target || !property) return;
      target.properties = target.properties.filter((item) => item.id !== propertyId);
      const rewriteName = (code: string, name: string, to: string | null) => {
        const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return to
          ? code.replace(new RegExp(`\\b${safe}\\b(?=\\s*=|[\\s>/])`, 'g'), to)
          : code
            .replace(new RegExp(`\\s*\\b${safe}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'g'), '')
            .replace(new RegExp(`\\s+\\b${safe}\\b(?=[\\s>/])`, 'g'), '');
      };
      target.examples.forEach((example) => {
        const usesName = new RegExp(`\\b${property.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(\\s*=|[\\s>/])`).test(example.code);
        const missingId = example.propertyIds.includes(propertyId);
        if (successorName !== undefined && successorName !== null && usesName) {
          // 有接替属性：能映射的旧引用自动迁移，避免发布后复制代码报错
          example.code = rewriteName(example.code, property.name, successorName);
          example.createdFromRevision = target.revision;
          example.stale = missingId;
          example.staleReason = missingId ? `属性 ${property.name} 已删除，请在依赖属性中改选 ${successorName}。` : '';
        } else if (missingId || usesName) {
          example.stale = true;
          example.staleReason = `属性 ${property.name} 已删除，示例代码或说明仍可能引用它。`;
        }
      });
      target.revision += 1;
      target.updatedAt = new Date().toISOString();
      if (state.ledger) {
        const change: ContractChange = {
          id: uid('change'),
          at: new Date().toISOString(),
          componentId: target.id,
          revision: target.revision,
          type: 'remove',
          oldName: property.name,
          successorName: successorName === undefined ? null : successorName,
          origin: { kind: 'direct' }
        };
        state.ledger.changes.unshift(change);
        syncContract(state.ledger, target);
        cascade(state.ledger, state, change);
      }
    });
  }

  /** 键盘行为变化：提升契约版本并沿引用链失效（键盘引用不能自动改写，一律转人工核对） */
  updateKeyboardBehavior(value: string) {
    const selected = this.selected;
    if (!selected || value === selected.keyboardBehavior) return;
    this.commit('修改键盘行为契约', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      const oldKeyboard = target.keyboardBehavior;
      target.keyboardBehavior = value;
      target.examples.forEach((example) => {
        example.stale = true;
        example.staleReason = '键盘行为契约发生变化，示例需要重新验证。';
      });
      target.updatedAt = new Date().toISOString();
      if (state.ledger) {
        const oldSig = keyboardSignatureOf(oldKeyboard);
        const newSig = keyboardSignatureOf(value);
        if (newSig && oldSig !== newSig) {
          target.revision += 1;
          const change: ContractChange = {
            id: uid('change'),
            at: new Date().toISOString(),
            componentId: target.id,
            revision: target.revision,
            type: 'keyboard',
            oldKeyboard: oldSig,
            newKeyboard: newSig,
            origin: { kind: 'direct' }
          };
          state.ledger.changes.unshift(change);
          syncContract(state.ledger, target);
          cascade(state.ledger, state, change);
        } else {
          syncContract(state.ledger, target);
        }
      }
    });
  }

  addExample() {
    const selected = this.selected;
    if (!selected) return;
    const exampleId = uid('example');
    this.commit('新增示例', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      target.examples.push({
        id: exampleId,
        title: '新示例',
        code: `<${target.tagName || target.name.toLowerCase().replaceAll(' ', '-')}>示例</${target.tagName || target.name.toLowerCase().replaceAll(' ', '-')}>`,
        propertyIds: [],
        stale: false,
        staleReason: '',
        createdFromRevision: target.revision
      });
    });
  }

  updateExample(exampleId: string, patch: Partial<ComponentSpec['examples'][number]>) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑示例', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      const example = target?.examples.find((item) => item.id === exampleId);
      if (example) {
        Object.assign(example, patch);
        scanRefs(state, { initial: false });
      }
    });
  }

  removeExample(exampleId: string) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('删除示例', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (target) {
        target.examples = target.examples.filter((item) => item.id !== exampleId);
        if (state.ledger) state.ledger.refs = state.ledger.refs.filter((ref) => ref.exampleId !== exampleId);
      }
    });
  }

  /** 手动登记组合依赖（示例对基础组件属性 / 键盘契约的引用） */
  addCompositionRef(exampleId: string, targetComponentId: string, kind: 'property' | 'keyboard', token: string) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('登记组合依赖', (state) => {
      if (state.ledger && findRef(state.ledger, { ownerComponentId: selected.id, scope: 'code', exampleId, targetComponentId, kind, token })) return;
      addManualRef(state, { ownerComponentId: selected.id, scope: 'code', exampleId, targetComponentId, kind, token });
    });
  }

  removeLedgerRef(refId: string) {
    this.commit('移除引用记录', (state) => {
      if (state.ledger) removeRefRecord(state.ledger, refId);
    });
  }

  chooseRefCandidate(refId: string, candidateId: string): ActionResult {
    let result: ActionResult = { ok: false };
    this.commit('选定迁移候选', (state) => {
      result = { ok: applyCandidate(state, refId, candidateId) };
      if (!result.ok) result.reason = '该候选已失效，请重新检查引用。';
    });
    return result;
  }

  verifyRef(refId: string): ActionResult {
    let result: ActionResult = { ok: false };
    this.commit('核对引用', (state) => {
      result = { ok: markRefVerified(state, refId) };
      if (!result.ok) result.reason = '该引用当前不需要核对。';
    });
    return result;
  }

  /** 待整理项与错误全部处理完之前，不能保存正式版本 */
  saveBlockers(componentId: string): string[] {
    const component = this.state.components.find((item) => item.id === componentId);
    if (!component) return ['组件不存在。'];
    const blockers: string[] = [];
    for (const issue of this.validate()) {
      if (issue.componentId === componentId && issue.level === 'error') blockers.push(issue.message);
    }
    for (const example of component.examples) {
      if (example.stale) blockers.push(`示例《${example.title}》仍标记失效：${example.staleReason || '需要重新验证'}`);
    }
    blockers.push(...blockingReasons(this.state, componentId));
    return [...new Set(blockers)];
  }

  createSnapshot(reason = '手动版本'): ActionResult {
    const selected = this.selected;
    if (!selected) return { ok: false, reason: '未选择组件。' };
    const blockers = this.saveBlockers(selected.id);
    if (blockers.length) {
      return { ok: false, reason: `待整理项未处理完，不能保存正式版本：\n${blockers.map((item) => `· ${item}`).join('\n')}` };
    }
    this.commit('创建版本快照', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      const { snapshots: _ignored, ...component } = clone(target);
      const snapshot: ComponentSnapshot = {
        revision: target.revision,
        savedAt: new Date().toISOString(),
        reason,
        component: { ...component, revision: target.revision }
      };
      target.snapshots.unshift(snapshot);
      target.snapshots = target.snapshots.slice(0, 12);
      target.revision += 1;
      target.updatedAt = new Date().toISOString();
      if (state.ledger) syncContract(state.ledger, target);
    });
    return { ok: true };
  }

  migrateExamples() {
    const selected = this.selected;
    if (!selected) return;
    this.commit('迁移示例到当前版本', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      recomputeRefs(state);
      const currentSignature = signature(target);
      const activePropertyIds = new Set(target.properties.map((item) => item.id));
      target.examples.forEach((example) => {
        example.propertyIds = example.propertyIds.filter((id) => activePropertyIds.has(id));
        example.stale = false;
        example.staleReason = '';
        example.createdFromRevision = target.revision;
      });
      target.interactionSignature = currentSignature.split('::')[1] ?? target.interactionSignature;
      target.revision += 1;
      target.updatedAt = new Date().toISOString();
      if (state.ledger) syncContract(state.ledger, target);
    });
  }

  validate(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const component of this.state.components) {
      const names = new Map<string, number>();
      component.properties.forEach((property) => names.set(property.name.trim(), (names.get(property.name.trim()) ?? 0) + 1));
      for (const [name, count] of names) {
        if (name && count > 1) {
          issues.push({ id: `${component.id}-duplicate-${name}`, level: 'error', componentId: component.id, target: component.name, message: `属性名称 ${name} 重复。`, field: 'properties' });
        }
      }
      const contractChanged = component.examples.some((example) => example.createdFromRevision < component.revision);
      component.examples.forEach((example) => {
        const missingReferences = example.propertyIds.filter((id) => !component.properties.some((property) => property.id === id));
        if (example.stale || missingReferences.length) {
          issues.push({ id: `${component.id}-${example.id}-stale`, level: 'warning', componentId: component.id, target: example.title, message: example.staleReason || '示例引用了已删除属性。', field: 'examples' });
        }
        if (!example.code.trim()) {
          issues.push({ id: `${component.id}-${example.id}-empty`, level: 'error', componentId: component.id, target: example.title, message: '示例代码不能为空。', field: 'examples' });
        }
      });
      if (!component.keyboardBehavior.trim()) {
        issues.push({ id: `${component.id}-keyboard`, level: 'error', componentId: component.id, target: component.name, message: '缺少键盘行为说明。', field: 'keyboard' });
      }
      if (!component.screenReader.trim()) {
        issues.push({ id: `${component.id}-screenreader`, level: 'error', componentId: component.id, target: component.name, message: '缺少读屏说明。', field: 'screenReader' });
      }
      if (contractChanged && component.examples.length) {
        issues.push({ id: `${component.id}-contract`, level: 'info', componentId: component.id, target: component.name, message: '属性契约或交互签名发生变化，建议创建快照并迁移示例。', field: 'properties' });
      }
    }
    // 依赖账本：待整理项（待核对 / 待选定 / 不兼容 / 传递失效）
    const ledger = this.state.ledger;
    if (ledger) {
      for (const ref of ledger.refs.filter(isUnresolved)) {
        const owner = this.state.components.find((component) => component.id === ref.ownerComponentId);
        const target = this.state.components.find((component) => component.id === ref.targetComponentId);
        const place = ref.scope === 'code'
          ? `示例《${owner?.examples.find((example) => example.id === ref.exampleId)?.title ?? '?'}》`
          : '读屏说明';
        const token = ref.kind === 'keyboard' ? '键盘契约' : `属性 ${ref.resolvedName ?? ref.oldName}`;
        issues.push({
          id: `${ref.id}-ledger`,
          level: 'error',
          componentId: ref.ownerComponentId,
          target: place,
          message: `${place}对 ${target?.name ?? ref.targetComponentId} 的 ${token} 引用待整理：${ref.pendingReason || '见依赖账本'}`,
          field: 'ledger'
        });
      }
    }
    return issues;
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.state));
    this.state = previous;
    this.persist(false);
    this.emit();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.state));
    this.state = next;
    this.persist(false);
    this.emit();
  }

  reset() {
    this.undoStack = [];
    this.redoStack = [];
    this.state = normalizeState(createInitialState());
    this.persist(false);
    this.emit();
  }

  private commit(label: string, mutator: (state: WorkspaceState) => void) {
    const before = clone(this.state);
    const next = clone(this.state);
    mutator(next);
    this.undoStack.push(before);
    this.undoStack = this.undoStack.slice(-40);
    this.redoStack = [];
    this.lastAction = label;
    this.state = next;
    this.persist();
    this.emit();
  }

  private load(): WorkspaceState {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as WorkspaceState;
        if (parsed && Array.isArray(parsed.components)) return normalizeState(parsed);
      }
    } catch {
      // A corrupted local draft falls back to the bundled demo data.
    }
    return normalizeState(createInitialState());
  }

  private persist(_notify = true) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  private emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }
}

// 保证新账本与契约构造器被打包（类型/工具再导出给界面层使用）
export { buildContract, createLedger };
