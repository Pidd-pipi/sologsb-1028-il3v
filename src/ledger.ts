import type {
  ComponentSpec,
  DocField,
  LedgerEntry,
  MigrationProposal,
  ProposalMode,
  RefRecord,
  RefTarget,
  WorkspaceState
} from './types';

const DIGEST_FIELDS: DocField[] = ['screenReader', 'keyboardBehavior'];
export const MAIN_BRANCH = 'main';

export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const keyboardFingerprint = (component: ComponentSpec): string =>
  `${component.id}@${component.branch}#r${component.revision}::${component.interactionSignature.trim()}`;

/** 契约 token：分支/版本/属性名，账本与引用都以它对账。 */
export const tokenFor = (component: ComponentSpec, propertyId?: string): string => {
  const property = propertyId ? component.properties.find((item) => item.id === propertyId) : undefined;
  return `${component.branch}/r${component.revision}/${property?.name ?? '*'}`;
};

export const tokenLoose = (token: string): string => token.replace(/\/r\d+\//, '/');

const nowIso = () => new Date().toISOString();

/** 从示例代码的标签属性区提取属性名。 */
const codeAttributes = (code: string): string[] => {
  const names = new Set<string>();
  const tagRe = /<\/?[A-Za-z][\w.-]*([^>]*)>/g;
  const attrRe = /([A-Za-z][\w-]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(code))) {
    const head = tag[1] ?? '';
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(head))) names.add(attr[1]);
  }
  return [...names];
};

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (name: string) => new RegExp(`\\b${escapeRe(name)}\\b`);

/** 仅替换标签属性区里的旧名，避免误伤标签名与文本内容。 */
export const renameInCode = (code: string, from: string, to: string): string => {
  const tagRe = /<\/?[A-Za-z][\w.-]*[^>]*>/g;
  return code.replace(tagRe, (tagText) =>
    tagText.replace(new RegExp(`(?<![\\w-.])${escapeRe(from)}(?![\\w-])`, 'g'), to));
};

const renameInText = (text: string, from: string, to: string) => text.replace(wordRe(from), to);

/** 重建引用记录的 targets；状态由 reconcile 依据提案统一派生。 */
const recomputeTargets = (record: RefRecord, state: WorkspaceState, owner: ComponentSpec | undefined): void => {
  if (!owner) {
    record.targets = [];
    return;
  }
  const example = record.kind === 'example' ? owner.examples.find((item) => item.id === record.exampleId) : undefined;
  const code = example?.code ?? '';
  const targets: RefTarget[] = [];
  const seen = new Set<string>();
  const push = (component: ComponentSpec, propertyId?: string) => {
    const token = tokenFor(component, propertyId);
    if (seen.has(token)) return;
    seen.add(token);
    const verifiedBefore = record.targets.find((old) => old.token === token)?.verified ?? false;
    targets.push({ componentId: component.id, branch: component.branch, revision: component.revision, propertyId, token, verified: record.needsReview ? false : verifiedBefore || record.kind === 'doc' });
  };

  if (example) {
    for (const propertyId of example.propertyIds) {
      if (owner.properties.some((item) => item.id === propertyId)) push(owner, propertyId);
    }
    // 组合示例跨组件引用：按标签名发现被组合组件的属性。
    for (const component of state.components) {
      if (component.id === owner.id || !code.includes(component.elementTag)) continue;
      for (const attr of codeAttributes(code)) {
        const property = component.properties.find((item) => item.name === attr);
        if (property) push(component, property.id);
      }
    }
  } else {
    const field = record.docField ?? 'screenReader';
    const text = String(owner[field] ?? '');
    for (const component of state.components) {
      const mentioned = component.id === owner.id || (component.elementTag !== '' && text.includes(component.elementTag));
      if (!mentioned) continue;
      for (const property of component.properties) {
        if (wordRe(property.name).test(text)) push(component, property.id);
      }
    }
  }
  record.targets = targets;
};

const recordsOfOwner = (state: WorkspaceState, componentId: string) =>
  state.referenceLedger.records.filter((record) => record.ownerComponentId === componentId);

const recordExample = (state: WorkspaceState, record: RefRecord) => {
  const owner = state.components.find((item) => item.id === record.ownerComponentId);
  return owner?.examples.find((item) => item.id === record.exampleId);
};

const recordText = (state: WorkspaceState, record: RefRecord): string => {
  const owner = state.components.find((item) => item.id === record.ownerComponentId);
  if (!owner) return '';
  return record.kind === 'example'
    ? owner.examples.find((item) => item.id === record.exampleId)?.code ?? ''
    : String(owner[record.docField ?? 'screenReader'] ?? '');
};

/** 记录文本中是否仍以“属性”的身份提到某名字（示例限属性区）。 */
const recordMentionsName = (state: WorkspaceState, record: RefRecord, origin: ComponentSpec, name: string): boolean => {
  const owner = state.components.find((item) => item.id === record.ownerComponentId);
  if (!owner) return false;
  if (record.kind === 'example') {
    const example = recordExample(state, record);
    if (!example) return false;
    const self = owner.id === origin.id;
    if (!self && !example.code.includes(origin.elementTag)) return false;
    return codeAttributes(example.code).includes(name) || example.propertyIds.some((id) => origin.properties.some((p) => p.id === id && p.name === name));
  }
  const text = String(owner[record.docField ?? 'screenReader'] ?? '');
  const mentioned = owner.id === origin.id || text.includes(origin.elementTag);
  return mentioned && wordRe(name).test(text);
};

/** 全量对账：重建引用、沿引用链挂失效提案、派生示例状态。 */
export const reconcile = (state: WorkspaceState): void => {
  for (const component of state.components) {
    for (const record of recordsOfOwner(state, component.id)) recomputeTargets(record, state, component);
  }

  for (const origin of state.components) {
    for (const entry of origin.ledger.filter((item) => item.toRevision === 0)) {
      const affected = findAffected(state, origin, entry);
      for (const record of affected) ensureProposal(state, origin, entry, record);
    }
  }

  // 依据未决提案派生记录与示例状态。
  for (const record of state.referenceLedger.records) {
    const owner = state.components.find((item) => item.id === record.ownerComponentId);
    const pending = owner?.ledger
      .flatMap((entry) => entry.proposals)
      .filter((proposal) => proposal.refRecordId === record.id && proposal.status === 'proposed') ?? [];
    if (record.needsReview) record.status = 'pending-review';
    else if (pending.some((proposal) => proposal.mode === 'parallel')) record.status = 'kept-legacy';
    else if (pending.length) record.status = 'stale';
    else record.status = 'fresh';
  }

  for (const component of state.components) {
    for (const example of component.examples) {
      const record = state.referenceLedger.records.find((item) => item.exampleId === example.id);
      example.needsReview = record?.needsReview ?? false;
      example.reviewNote = record?.reviewNote;
      example.stale = record ? record.status !== 'fresh' : false;
      example.staleReason = record ? statusReason(state, record) : '';
    }
  }
};

/** 沿引用链找出一笔挂账影响的记录（待核对记录先不挂提案，核对后由下一轮 reconcile 补）。 */
const findAffected = (state: WorkspaceState, origin: ComponentSpec, entry: LedgerEntry): RefRecord[] => {
  const out: RefRecord[] = [];
  const push = (record: RefRecord | undefined) => {
    if (record && !record.needsReview && !out.includes(record)) out.push(record);
  };
  const referencesOrigin = (record: RefRecord) => record.targets.some((target) => target.componentId === origin.id);

  if (entry.kind === 'rename' && entry.propertyId && entry.fromToken) {
    for (const record of state.referenceLedger.records) {
      const stamped = record.provenance?.ledgerEntryId === entry.id;
      if (stamped || recordMentionsName(state, record, origin, entry.fromToken)) push(record);
    }
  } else if (entry.kind === 'remove' && entry.propertyId && entry.fromToken) {
    for (const record of state.referenceLedger.records) {
      const example = record.kind === 'example' ? recordExample(state, record) : undefined;
      const danglingId = example?.propertyIds.includes(entry.propertyId) ?? false;
      if (danglingId || recordMentionsName(state, record, origin, entry.fromToken)) push(record);
    }
  } else if (entry.kind === 'keyboard') {
    for (const component of state.components) {
      for (const record of recordsOfOwner(state, component.id)) {
        if (component.id === origin.id) {
          // 自身：示例与读屏说明失效；键盘行为文本本身是改动来源，不失效。
          if (record.kind === 'example' || record.docField === 'screenReader') push(record);
        } else if (referencesOrigin(record)) {
          push(record);
        } else if (record.kind === 'doc') {
          // 引用链传播：同一组件里只要有引用受影响，文档整体重算。
          const siblingReferences = recordsOfOwner(state, component.id).some((other) => other.kind === 'example' && referencesOrigin(other));
          if (siblingReferences) push(record);
        }
      }
    }
  } else if (entry.kind === 'branch') {
    for (const record of state.referenceLedger.records) {
      if (referencesOrigin(record)) push(record);
    }
  }
  return out;
};

const proposalMode = (kind: LedgerEntry['kind']): ProposalMode =>
  kind === 'rename' ? 'auto' : kind === 'branch' ? 'parallel' : 'manual';

const ensureProposal = (state: WorkspaceState, origin: ComponentSpec, entry: LedgerEntry, record: RefRecord): void => {
  if (entry.proposals.some((proposal) => proposal.refRecordId === record.id)) return;
  const owner = state.components.find((item) => item.id === record.ownerComponentId);
  if (!owner) return;
  const mode = proposalMode(entry.kind);
  const before = recordText(state, record);
  let after: string | undefined;
  if (entry.kind === 'rename' && entry.fromToken && entry.toToken) {
    after = record.kind === 'example'
      ? renameInCode(before, entry.fromToken, entry.toToken)
      : renameInText(before, entry.fromToken, entry.toToken);
    if (after === before) after = undefined;
  }
  const reason = {
    rename: `属性 ${entry.fromToken} 已改名为 ${entry.toToken}（${entry.source}），可自动迁移，来源已记录。`,
    remove: `属性 ${entry.fromToken} 已移除（${entry.source}），旧引用无法映射，需要人工重算。`,
    keyboard: `「${origin.name}」键盘行为契约已变化（${entry.source}），请沿引用链核对并重算本项。`,
    branch: `契约分支由 ${entry.fromToken} 改名为 ${entry.toToken} 且版本不兼容，新旧版本并列保留。`
  }[entry.kind];
  entry.proposals.push({
    id: uid('proposal'),
    ledgerEntryId: entry.id,
    refRecordId: record.id,
    ownerComponentId: record.ownerComponentId,
    target: record.kind,
    exampleId: record.exampleId,
    docField: record.docField,
    mode,
    status: 'proposed',
    fromToken: entry.fromToken,
    toToken: entry.toToken,
    reason,
    chainPath: origin.id === record.ownerComponentId ? undefined : `${origin.name} → ${owner.name}`,
    previewBefore: before,
    previewAfter: after,
    createdAt: nowIso()
  });
  if (!entry.refRecordIds.includes(record.id)) entry.refRecordIds.push(record.id);

  // 可映射的旧引用：提案一生成就把内容迁移为草案并留下来源；选定前可搁置回退，选定后才随正式版本落定。
  if (entry.kind === 'rename' && after !== undefined && entry.fromToken && entry.toToken) {
    if (record.kind === 'example') {
      const ex = owner.examples.find((item) => item.id === record.exampleId);
      if (ex) ex.code = after;
    } else if (record.docField && DIGEST_FIELDS.includes(record.docField)) {
      owner[record.docField] = after as never;
    }
    record.provenance = {
      source: 'auto-migration',
      ledgerEntryId: entry.id,
      fromToken: entry.fromToken,
      fromBranch: entry.branch,
      fromRevision: entry.fromRevision,
      migratedAt: entry.createdAt
    };
  }
};

const statusReason = (state: WorkspaceState, record: RefRecord): string => {
  if (record.needsReview) return record.reviewNote ?? '旧数据缺少依赖信息，已标待核对，核对前不能保存正式版本。';
  const owner = state.components.find((item) => item.id === record.ownerComponentId);
  const pending = owner?.ledger
    .flatMap((entry) => entry.proposals)
    .find((proposal) => proposal.refRecordId === record.id && proposal.status === 'proposed');
  return pending?.reason ?? '引用契约已变化，等待重算。';
};

/** 记录一笔契约改动。改名时立即把可映射的旧引用改写为草案并留下来源；提案由 reconcile 挂账。 */
export const registerChange = (
  state: WorkspaceState,
  origin: ComponentSpec,
  change: {
    kind: 'rename' | 'remove' | 'keyboard' | 'branch';
    source: string;
    sourceAction: string;
    fromToken?: string;
    toToken?: string;
    propertyId?: string;
    reason: string;
  }
): LedgerEntry => {
  const entry: LedgerEntry = {
    id: uid('ledger'),
    createdAt: nowIso(),
    originComponentId: origin.id,
    kind: change.kind,
    source: change.source,
    sourceAction: change.sourceAction,
    branch: origin.branch,
    fromRevision: origin.revision,
    toRevision: 0,
    fromToken: change.fromToken,
    toToken: change.toToken,
    propertyId: change.propertyId,
    breaking: change.kind !== 'rename',
    reason: change.reason,
    refRecordIds: [],
    proposals: []
  };
  origin.ledger.unshift(entry);

  // 失效传播与可映射引用的草案迁移都在 reconcile → ensureProposal 中统一完成。
  reconcile(state);
  return entry;
};

export interface PublishBlocker {
  componentId: string;
  kind: 'pending-review' | 'stale-ref' | 'proposal';
  message: string;
}

/** 正式保存前的闸门：待核对 / 失效引用 / 未选定提案未处理完，一律不能保存正式版本。 */
export const publishBlockers = (state: WorkspaceState, focusComponentId?: string): PublishBlocker[] => {
  const blockers: PublishBlocker[] = [];
  for (const record of state.referenceLedger.records) {
    if (focusComponentId && record.ownerComponentId !== focusComponentId) continue;
    const owner = state.components.find((item) => item.id === record.ownerComponentId);
    if (record.needsReview) {
      blockers.push({ componentId: record.ownerComponentId, kind: 'pending-review', message: `「${owner?.name}」${record.title}缺少依赖信息，待核对。` });
    } else if (record.status !== 'fresh') {
      blockers.push({ componentId: record.ownerComponentId, kind: 'stale-ref', message: `「${owner?.name}」${record.title}引用已失效，需重算。` });
    }
  }
  for (const component of state.components) {
    if (focusComponentId && component.id !== focusComponentId) continue;
    const pending = component.ledger.flatMap((entry) => entry.proposals).filter((proposal) => proposal.status === 'proposed');
    for (const proposal of pending) {
      blockers.push({
        componentId: component.id,
        kind: 'proposal',
        message: `「${component.name}」有未选定的迁移提案（${{ auto: '可自动迁移', parallel: '并列保留', manual: '需人工处理' }[proposal.mode]}）。`
      });
    }
    // 已搁置但旧引用实际仍在内容里：不能假装没事，发布闸门继续拦截（人工改正内容后即解除）。
    for (const entry of component.ledger) {
      if (entry.kind !== 'rename' && entry.kind !== 'remove') continue;
      for (const proposal of entry.proposals) {
        if (proposal.status !== 'ignored') continue;
        const record = state.referenceLedger.records.find((item) => item.id === proposal.refRecordId);
        if (record && entry.fromToken && recordMentionsName(state, record, component, entry.fromToken)) {
          const owner = state.components.find((item) => item.id === record.ownerComponentId);
          blockers.push({
            componentId: record.ownerComponentId,
            kind: 'stale-ref',
            message: `「${owner?.name}」${record.title}仍引用已${entry.kind === 'rename' ? '改名' : '移除'}的 ${entry.fromToken}，请迁移或人工改正。`
          });
        }
      }
    }
  }
  return blockers;
};

const bumpContractVersion = (version: string, breaking: boolean): string => {
  const [major = '0', minor = '1'] = version.split('.');
  return breaking ? `${Number(major) + 1}.0.0` : `${major}.${Number(minor) + 1}.0`;
};

/** 选定通过：保存正式版本，落契约版本，结清挂账。 */
export const publishSnapshot = (
  state: WorkspaceState,
  component: ComponentSpec,
  reason: string
): { ok: boolean; blockers?: PublishBlocker[] } => {
  const blockers = publishBlockers(state, component.id);
  if (blockers.length) return { ok: false, blockers };

  const pendingEntries = component.ledger.filter((entry) => entry.toRevision === 0);
  const breaking = pendingEntries.some((entry) => entry.breaking);
  const nextRevision = component.revision + 1;
  const nextVersion = pendingEntries.length ? bumpContractVersion(component.contractVersion, breaking) : component.contractVersion;
  const savedAt = nowIso();

  const { snapshots: _snapshots, ...rest } = component;
  component.snapshots.unshift({
    revision: component.revision,
    savedAt,
    reason,
    component: { ...structuredClone(rest), contractVersion: nextVersion }
  });
  component.snapshots = component.snapshots.slice(0, 12);
  for (const entry of pendingEntries) {
    entry.toRevision = nextRevision;
    entry.proposals.forEach((proposal) => {
      if (proposal.status === 'proposed') proposal.status = 'accepted';
    });
  }
  component.revision = nextRevision;
  component.contractVersion = nextVersion;
  component.updatedAt = savedAt;
  reconcile(state);
  return { ok: true };
};

const findProposal = (state: WorkspaceState, proposalId: string) => {
  for (const origin of state.components) {
    for (const entry of origin.ledger) {
      const proposal = entry.proposals.find((item) => item.id === proposalId);
      if (proposal) return { origin, entry, proposal };
    }
  }
  return undefined;
};

/** 接受迁移提案（选定）。auto=应用迁移并确认；manual=人工已改好；parallel=新旧并列保留。 */
export const acceptProposal = (state: WorkspaceState, proposalId: string): void => {
  const hit = findProposal(state, proposalId);
  if (!hit) return;
  const { entry, proposal } = hit;
  const record = state.referenceLedger.records.find((item) => item.id === proposal.refRecordId);
  const owner = state.components.find((item) => item.id === proposal.ownerComponentId);
  if (!record || !owner) return;

  if (proposal.mode === 'auto' && entry.fromToken && entry.toToken) {
    // 对核对后才出现的记录，选定时才真正应用迁移。
    if (record.kind === 'example') {
      const example = owner.examples.find((item) => item.id === record.exampleId);
      if (example) example.code = renameInCode(example.code, entry.fromToken, entry.toToken);
    } else if (proposal.docField) {
      owner[proposal.docField] = renameInText(String(owner[proposal.docField]), entry.fromToken, entry.toToken);
    }
    record.provenance = {
      source: 'auto-migration',
      ledgerEntryId: entry.id,
      fromToken: entry.fromToken,
      fromBranch: entry.branch,
      fromRevision: entry.fromRevision,
      migratedAt: nowIso()
    };
  }

  if (proposal.mode === 'manual' && entry.kind === 'remove' && entry.propertyId) {
    const example = owner.examples.find((item) => item.id === record.exampleId);
    if (example) example.propertyIds = example.propertyIds.filter((id) => id !== entry.propertyId);
    record.provenance = { source: 'manual-migration', ledgerEntryId: entry.id, fromToken: entry.fromToken, migratedAt: nowIso() };
  }

  if (proposal.mode === 'parallel' && entry.fromToken) {
    if (proposal.target === 'example') {
      const example = owner.examples.find((item) => item.id === record.exampleId);
      if (example && !example.legacyVariants?.some((variant) => variant.ledgerEntryId === entry.id)) {
        example.legacyVariants ??= [];
        example.legacyVariants.unshift({
          code: proposal.previewBefore ?? example.code,
          label: `旧分支 ${entry.fromToken}（r${entry.fromRevision}）`,
          branch: entry.fromToken,
          revision: entry.fromRevision,
          ledgerEntryId: entry.id,
          fromToken: entry.fromToken,
          createdAt: nowIso()
        });
      }
    } else if (proposal.docField) {
      const field = proposal.docField;
      if (!owner.docLegacyVariants?.some((variant) => variant.ledgerEntryId === entry.id && variant.field === field)) {
        owner.docLegacyVariants ??= [];
        owner.docLegacyVariants.unshift({
          field,
          text: proposal.previewBefore ?? String(owner[field] ?? ''),
          label: `旧分支 ${entry.fromToken}（r${entry.fromRevision}）`,
          branch: entry.fromToken,
          revision: entry.fromRevision,
          ledgerEntryId: entry.id,
          createdAt: nowIso()
        });
      }
    }
    record.provenance = { source: 'parallel-legacy', ledgerEntryId: entry.id, fromBranch: entry.fromToken, fromRevision: entry.fromRevision, migratedAt: nowIso() };
  }

  proposal.status = 'accepted';
  reconcile(state);
};

/** 忽略提案；auto 会把草案内容回退为旧引用，等待人工处理。 */
export const ignoreProposal = (state: WorkspaceState, proposalId: string): void => {
  const hit = findProposal(state, proposalId);
  if (!hit) return;
  const { entry, proposal } = hit;
  proposal.status = 'ignored';
  if (proposal.mode === 'auto' && entry.fromToken && entry.toToken) {
    const owner = state.components.find((item) => item.id === proposal.ownerComponentId);
    if (owner) {
      if (proposal.target === 'example') {
        const example = owner.examples.find((item) => item.id === proposal.exampleId);
        if (example) example.code = renameInCode(example.code, entry.toToken, entry.fromToken);
      } else if (proposal.docField) {
        owner[proposal.docField] = renameInText(String(owner[proposal.docField]), entry.toToken, entry.fromToken);
      }
    }
  }
  reconcile(state);
};

/** 接受某组件名下所有可自动迁移的提案（沿引用链，含来自其它基础组件的挂账）。 */
export const acceptAutoProposalsForOwner = (state: WorkspaceState, ownerComponentId: string): number => {
  const ids: string[] = [];
  for (const component of state.components) {
    for (const entry of component.ledger) {
      for (const proposal of entry.proposals) {
        if (proposal.status === 'proposed' && proposal.mode === 'auto' && proposal.ownerComponentId === ownerComponentId) {
          ids.push(proposal.id);
        }
      }
    }
  }
  ids.forEach((id) => acceptProposal(state, id));
  return ids.length;
};

/** 人工核对引用关系；核对后下一轮对账会立即补挂失效提案。 */
export const reviewRecord = (state: WorkspaceState, recordId: string, verified: boolean): void => {
  const record = state.referenceLedger.records.find((item) => item.id === recordId);
  const owner = state.components.find((item) => item.id === record?.ownerComponentId);
  if (!record || !owner) return;
  record.needsReview = false;
  record.reviewNote = undefined;
  record.targets.forEach((target) => {
    target.verified = verified;
  });
  record.provenance ??= { source: 'manual-migration', migratedAt: nowIso(), note: '旧数据人工核对' };
  if (record.kind === 'doc' && record.docField === 'keyboardBehavior') {
    record.baselineFingerprint = keyboardFingerprint(owner);
  }
  reconcile(state);
};

/** 用户编辑示例（代码/标题/依赖）后解除待核对。 */
export const touchExampleRecord = (state: WorkspaceState, exampleId: string): void => {
  const record = state.referenceLedger.records.find((item) => item.exampleId === exampleId);
  if (record?.needsReview) {
    record.needsReview = false;
    record.reviewNote = undefined;
    record.provenance ??= { source: 'manual-migration', migratedAt: nowIso(), note: '编辑后解除待核对' };
  }
  reconcile(state);
};

/** 文档字段编辑后维护基线并解除待核对。 */
export const touchDocRecord = (state: WorkspaceState, component: ComponentSpec, field: DocField): void => {
  const record = state.referenceLedger.records.find(
    (item) => item.ownerComponentId === component.id && item.kind === 'doc' && item.docField === field
  );
  if (!record) return;
  if (record.needsReview) {
    record.needsReview = false;
    record.reviewNote = undefined;
    record.provenance ??= { source: 'manual-migration', migratedAt: nowIso(), note: '编辑后解除待核对' };
  }
  if (field === 'keyboardBehavior') record.baselineFingerprint = keyboardFingerprint(component);
  reconcile(state);
};

export const createExampleRecord = (state: WorkspaceState, component: ComponentSpec, exampleId: string, title: string): RefRecord => {
  const record: RefRecord = {
    id: uid('ref'),
    ownerComponentId: component.id,
    kind: 'example',
    exampleId,
    title: `示例「${title}」`,
    targets: [],
    status: 'fresh',
    needsReview: false,
    provenance: { source: 'original', migratedAt: nowIso() }
  };
  state.referenceLedger.records.push(record);
  reconcile(state);
  return record;
};

export const renameExampleRecordTitle = (state: WorkspaceState, exampleId: string, title: string): void => {
  const record = state.referenceLedger.records.find((item) => item.exampleId === exampleId);
  if (record) record.title = `示例「${title}」`;
};

export const removeRecordsOfExample = (state: WorkspaceState, exampleId: string): void => {
  state.referenceLedger.records = state.referenceLedger.records.filter((record) => record.exampleId !== exampleId);
};

const docTitle: Record<DocField, string> = {
  screenReader: '读屏说明',
  keyboardBehavior: '键盘行为说明',
  states: '状态说明',
  purpose: '用途说明',
  usage: '使用规则'
};

export const ensureDocRecords = (state: WorkspaceState, component: ComponentSpec): void => {
  for (const field of DIGEST_FIELDS) {
    const exists = state.referenceLedger.records.some(
      (record) => record.ownerComponentId === component.id && record.kind === 'doc' && record.docField === field
    );
    if (!exists) {
      state.referenceLedger.records.push({
        id: uid('ref'),
        ownerComponentId: component.id,
        kind: 'doc',
        docField: field,
        title: docTitle[field],
        targets: [],
        status: 'fresh',
        needsReview: false,
        baselineFingerprint: field === 'keyboardBehavior' ? keyboardFingerprint(component) : undefined,
        provenance: { source: 'original', migratedAt: nowIso() }
      });
    }
  }
};

/** 旧数据迁移：缺依赖账本信息的引用一律先标待核对，不猜成正式关系。 */
export const migrateLegacyState = (state: WorkspaceState): WorkspaceState => {
  state.referenceLedger ??= { version: 1, records: [] };
  state.ledgerVersion ??= 1;
  for (const component of state.components) {
    component.branch ||= MAIN_BRANCH;
    component.elementTag ||= `sp-${component.id.replace(/-(spec|component).*$/, '').replace(/[^a-z0-9]+/g, '-')}`;
    component.contractVersion ||= `${component.revision}.0.0`;
    component.ledger ||= [];
    for (const example of component.examples) {
      example.legacyVariants ??= [];
      if (!state.referenceLedger.records.some((record) => record.exampleId === example.id)) {
        state.referenceLedger.records.push({
          id: uid('ref-legacy'),
          ownerComponentId: component.id,
          kind: 'example',
          exampleId: example.id,
          title: `示例「${example.title}」`,
          targets: [],
          status: 'pending-review',
          needsReview: true,
          reviewNote: '旧数据缺少依赖账本信息，引用关系由代码推断，需人工核对。',
          provenance: { source: 'legacy-import', migratedAt: nowIso(), fromRevision: example.createdFromRevision }
        });
      }
      // 旧版已标失效的示例，把来源补成一笔待处理的键盘契约挂账。
      if (example.stale && example.staleReason && !component.ledger.some((entry) => entry.kind === 'keyboard' && entry.sourceAction === 'legacy-import')) {
        component.ledger.unshift({
          id: uid('ledger'),
          createdAt: nowIso(),
          originComponentId: component.id,
          kind: 'keyboard',
          source: '旧版本导入',
          sourceAction: 'legacy-import',
          branch: component.branch,
          fromRevision: example.createdFromRevision,
          toRevision: 0,
          breaking: true,
          reason: example.staleReason,
          refRecordIds: [],
          proposals: []
        });
      }
    }
    for (const field of DIGEST_FIELDS) {
      if (!state.referenceLedger.records.some(
        (record) => record.ownerComponentId === component.id && record.kind === 'doc' && record.docField === field
      )) {
        state.referenceLedger.records.push({
          id: uid('ref-legacy'),
          ownerComponentId: component.id,
          kind: 'doc',
          docField: field,
          title: docTitle[field],
          targets: [],
          status: 'pending-review',
          needsReview: true,
          reviewNote: '旧数据缺少依赖信息，文档中引用的组件/属性需人工核对。',
          baselineFingerprint: field === 'keyboardBehavior' ? keyboardFingerprint(component) : undefined,
          provenance: { source: 'legacy-import', migratedAt: nowIso() }
        });
      }
    }
  }
  reconcile(state);
  return state;
};

/** 给 UI 展示用：某组件相关的未决提案（含来自其它基础组件的挂账）。 */
export const pendingProposalsForOwner = (state: WorkspaceState, ownerComponentId: string): { entry: LedgerEntry; proposal: MigrationProposal }[] => {
  const rows: { entry: LedgerEntry; proposal: MigrationProposal }[] = [];
  for (const component of state.components) {
    for (const entry of component.ledger) {
      for (const proposal of entry.proposals) {
        if (proposal.status === 'proposed' && proposal.ownerComponentId === ownerComponentId) rows.push({ entry, proposal });
      }
    }
  }
  return rows;
};

export const ledgerEntriesForOwner = (state: WorkspaceState, ownerComponentId: string): LedgerEntry[] => {
  const rows: LedgerEntry[] = [];
  for (const component of state.components) {
    for (const entry of component.ledger) {
      if (entry.originComponentId === ownerComponentId || entry.proposals.some((proposal) => proposal.ownerComponentId === ownerComponentId)) {
        rows.push(entry);
      }
    }
  }
  return rows;
};
