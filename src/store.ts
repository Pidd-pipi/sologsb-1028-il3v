import { createInitialState } from './data';
import {
  acceptAutoProposalsForOwner,
  acceptProposal,
  createExampleRecord,
  ensureDocRecords,
  ignoreProposal,
  ledgerEntriesForOwner,
  MAIN_BRANCH,
  migrateLegacyState,
  pendingProposalsForOwner,
  publishBlockers,
  publishSnapshot,
  reconcile,
  registerChange,
  removeRecordsOfExample,
  renameExampleRecordTitle,
  reviewRecord,
  touchDocRecord,
  touchExampleRecord,
  uid
} from './ledger';
import type {
  ActionResult,
  ComponentSpec,
  DocField,
  LedgerEntry,
  MigrationProposal,
  RefRecord,
  ValidationIssue,
  WorkspaceState
} from './types';

const STORAGE_KEY = 'sologsb-1028-workspace-v1';

const clone = <T>(value: T): T => structuredClone(value);

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
    this.persist();
    this.emit();
  }

  addComponent() {
    const id = uid('component');
    const component: ComponentSpec = {
      id,
      name: 'Untitled component',
      category: 'Uncategorised',
      status: 'draft',
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
      snapshots: [],
      branch: MAIN_BRANCH,
      elementTag: `sp-component-${id.slice(-4)}`,
      contractVersion: '1.0.0',
      ledger: [],
      docLegacyVariants: []
    };
    this.commit('新建组件', (state) => {
      state.components.unshift(component);
      state.selectedId = id;
      ensureDocRecords(state, component);
      reconcile(state);
    });
  }

  /** 普通字段更新；screenReader / 键盘行为 / 交互签名请走专用方法。 */
  updateComponent(patch: Partial<ComponentSpec>) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑组件', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      Object.assign(target, patch, { updatedAt: new Date().toISOString() });
      reconcile(state);
    });
  }

  addProperty() {
    const selected = this.selected;
    if (!selected) return;
    this.commit('新增属性', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      target.properties.push({
        id: uid('property'),
        name: 'newProperty',
        type: 'string',
        required: false,
        defaultValue: '',
        description: '描述该属性对开发者和用户的影响。'
      });
      reconcile(state);
    });
  }

  updateProperty(propertyId: string, patch: Partial<ComponentSpec['properties'][number]>) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑属性', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      const property = target?.properties.find((item) => item.id === propertyId);
      if (!target || !property) return;
      const oldName = property.name;
      Object.assign(property, patch);
      if (patch.name !== undefined && patch.name.trim() !== '' && patch.name !== oldName) {
        // 属性改名：记契约版本/来源，沿引用链立即失效，可映射引用出自动迁移草案。
        registerChange(state, target, {
          kind: 'rename',
          source: '属性面板编辑',
          sourceAction: 'rename-property',
          fromToken: oldName,
          toToken: patch.name,
          propertyId,
          reason: `属性 ${oldName} 改名为 ${patch.name}`
        });
      } else {
        reconcile(state);
      }
    });
  }

  removeProperty(propertyId: string) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('删除属性', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      const property = target?.properties.find((item) => item.id === propertyId);
      if (!target || !property) return;
      const oldName = property.name;
      target.properties = target.properties.filter((item) => item.id !== propertyId);
      registerChange(state, target, {
        kind: 'remove',
        source: '属性面板编辑',
        sourceAction: 'remove-property',
        fromToken: oldName,
        propertyId,
        reason: `属性 ${oldName} 被移除`
      });
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
        code: `<${target.elementTag}>示例</${target.elementTag}>`,
        propertyIds: [],
        stale: false,
        staleReason: '',
        createdFromRevision: target.revision,
        needsReview: false,
        reviewNote: '',
        legacyVariants: []
      });
      createExampleRecord(state, target, exampleId, '新示例');
    });
  }

  updateExample(exampleId: string, patch: Partial<ComponentSpec['examples'][number]>) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑示例', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      const example = target?.examples.find((item) => item.id === exampleId);
      if (!target || !example) return;
      Object.assign(example, patch);
      if (patch.title !== undefined) renameExampleRecordTitle(state, exampleId, patch.title);
      touchExampleRecord(state, exampleId);
    });
  }

  removeExample(exampleId: string) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('删除示例', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      target.examples = target.examples.filter((item) => item.id !== exampleId);
      removeRecordsOfExample(state, exampleId);
      reconcile(state);
    });
  }

  /** 键盘行为说明编辑（文档本体）；交互签名变化则记键盘契约变更。 */
  updateKeyboardContract(patch: { keyboardBehavior?: string; interactionSignature?: string }) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑键盘契约', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      if (patch.keyboardBehavior !== undefined && patch.keyboardBehavior !== target.keyboardBehavior) {
        target.keyboardBehavior = patch.keyboardBehavior;
        touchDocRecord(state, target, 'keyboardBehavior');
      }
      if (patch.interactionSignature !== undefined && patch.interactionSignature.trim() !== target.interactionSignature.trim()) {
        target.interactionSignature = patch.interactionSignature;
        registerChange(state, target, {
          kind: 'keyboard',
          source: '交互签名编辑',
          sourceAction: 'edit-interaction-signature',
          reason: `键盘行为/交互签名发生变化：${target.interactionSignature.trim() || '（空）'}`
        });
      }
      target.updatedAt = new Date().toISOString();
    });
  }

  /** 读屏说明编辑：本身也是沿引用链被追踪的文档。 */
  updateScreenReader(text: string) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑读屏说明', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      target.screenReader = text;
      touchDocRecord(state, target, 'screenReader');
      target.updatedAt = new Date().toISOString();
    });
  }

  /** 分支改名：版本不兼容，旧引用并列保留为 legacy 变体。 */
  renameBranch(nextBranch: string): ActionResult {
    const selected = this.selected;
    if (!selected) return { ok: false, reason: '未选择组件。' };
    const branch = nextBranch.trim();
    if (!branch || branch === selected.branch) return { ok: false, reason: '分支名未变化。' };
    this.commit('契约分支改名', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      registerChange(state, target, {
        kind: 'branch',
        source: '分支管理',
        sourceAction: 'rename-branch',
        fromToken: target.branch,
        toToken: branch,
        reason: `契约分支 ${target.branch} → ${branch}（版本不兼容，并列保留）`
      });
      target.branch = branch;
      reconcile(state);
    });
    return { ok: true };
  }

  reviewRef(recordId: string, verified: boolean) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('核对引用关系', (state) => {
      reviewRecord(state, recordId, verified);
    });
  }

  acceptProposal(proposalId: string) {
    this.commit('选定迁移提案', (state) => acceptProposal(state, proposalId));
  }

  ignoreProposal(proposalId: string) {
    this.commit('搁置迁移提案', (state) => ignoreProposal(state, proposalId));
  }

  acceptAllAutoMigrations(componentId?: string): number {
    const id = componentId ?? this.selected?.id;
    if (!id) return 0;
    let count = 0;
    this.commit('全部接受自动迁移', (state) => {
      count = acceptAutoProposalsForOwner(state, id);
    });
    return count;
  }

  /** 正式保存（创建快照）：待整理项未处理完一律拒绝。 */
  publishVersion(reason = '手动版本'): ActionResult {
    const selected = this.selected;
    if (!selected) return { ok: false, reason: '未选择组件。' };
    let result: ActionResult = { ok: true };
    this.commit('保存正式版本', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      const published = publishSnapshot(state, target, reason);
      if (!published.ok) {
        result = { ok: false, reason: published.blockers?.[0]?.message ?? '存在未处理的待整理项。' };
        throw new ROLLBACK();
      }
    });
    return result;
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
      component.examples.forEach((example) => {
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
    }
    for (const blocker of publishBlockers(this.state)) {
      issues.push({
        id: `blocker-${blocker.kind}-${blocker.message}`,
        level: 'error',
        componentId: blocker.componentId,
        target: this.state.components.find((item) => item.id === blocker.componentId)?.name ?? '契约账本',
        message: blocker.message,
        field: 'ledger'
      });
    }
    return issues;
  }

  getRecordForExample(exampleId: string): RefRecord | undefined {
    return this.state.referenceLedger.records.find((record) => record.exampleId === exampleId);
  }

  getDocRecord(componentId: string, field: DocField): RefRecord | undefined {
    return this.state.referenceLedger.records.find(
      (record) => record.ownerComponentId === componentId && record.kind === 'doc' && record.docField === field
    );
  }

  getProposals(componentId: string): { entry: LedgerEntry; proposal: MigrationProposal }[] {
    return pendingProposalsForOwner(this.state, componentId);
  }

  getLedgerEntries(componentId: string): LedgerEntry[] {
    return ledgerEntriesForOwner(this.state, componentId);
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.state));
    this.state = previous;
    this.persist();
    this.emit();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.state));
    this.state = next;
    this.persist();
    this.emit();
  }

  reset() {
    this.undoStack = [];
    this.redoStack = [];
    this.state = migrateLegacyState(createInitialState());
    this.persist();
    this.emit();
  }

  private commit(label: string, mutator: (state: WorkspaceState) => void) {
    const before = clone(this.state);
    const next = clone(this.state);
    try {
      mutator(next);
    } catch (error) {
      if (error instanceof ROLLBACK) {
        this.lastAction = `${label}（已拦截）`;
        this.emit();
        return;
      }
      throw error;
    }
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
        if (parsed && Array.isArray(parsed.components)) return migrateLegacyState(parsed);
      }
    } catch {
      // A corrupted local draft falls back to the bundled demo data.
    }
    return migrateLegacyState(createInitialState());
  }

  private persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  private emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }
}

/** mutator 内部用于“校验不通过、整笔不落账”的控制信号。 */
class ROLLBACK extends Error {}
