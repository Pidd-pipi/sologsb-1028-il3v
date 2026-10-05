export type ComponentStatus = 'draft' | 'review' | 'published';
export type PreviewTheme = 'light' | 'dark';
export type PreviewDensity = 'compact' | 'regular' | 'spacious';

/** 组件契约允许发生的改动种类，决定失效传播方式。 */
export type ContractChangeKind = 'rename' | 'remove' | 'keyboard' | 'branch';
/** auto=可映射自动迁移；parallel=分支/不兼容，并列保留；manual=只能人工重算。 */
export type ProposalMode = 'auto' | 'parallel' | 'manual';
export type ProposalStatus = 'proposed' | 'accepted' | 'ignored';
export type RefStatus = 'fresh' | 'stale' | 'kept-legacy' | 'pending-review';
export type DocField = 'screenReader' | 'keyboardBehavior' | 'states' | 'purpose' | 'usage';

export interface PropertySpec {
  id: string;
  name: string;
  type: string;
  required: boolean;
  defaultValue: string;
  description: string;
}

/** 迁移来源，跟随引用一直保留，回答“这条引用从哪来”。 */
export interface RefProvenance {
  source: 'original' | 'auto-migration' | 'manual-migration' | 'parallel-legacy' | 'legacy-import';
  fromToken?: string;
  fromBranch?: string;
  fromRevision?: number;
  ledgerEntryId?: string;
  note?: string;
  migratedAt: string;
}

/** 旧引用并列保留时留下的历史版本（示例代码）。 */
export interface LegacyExampleVariant {
  code: string;
  label: string;
  branch: string;
  revision: number;
  ledgerEntryId: string;
  fromToken?: string;
  createdAt: string;
}

/** 旧引用并列保留时留下的历史版本（文档字段）。 */
export interface LegacyDocVariant {
  field: DocField;
  text: string;
  label: string;
  branch: string;
  revision: number;
  ledgerEntryId: string;
  createdAt: string;
}

export interface ComponentExample {
  id: string;
  title: string;
  code: string;
  propertyIds: string[];
  /** 派生：存在未处理的失效引用时为 true，由账本重算。 */
  stale: boolean;
  staleReason: string;
  createdFromRevision: number;
  /** 派生：旧数据导入且缺少依赖信息时为 true，需要人工核对。 */
  needsReview?: boolean;
  reviewNote?: string;
  legacyVariants?: LegacyExampleVariant[];
}

/** 账本中被引用的目标：某个组件契约（可精确到属性）。 */
export interface RefTarget {
  componentId: string;
  branch: string;
  revision: number;
  propertyId?: string;
  token: string;
  /** 用户显式确认过的引用（勾选/核对/迁移）为 true；旧数据推断为 false。 */
  verified: boolean;
}

/** 依赖账本中的一条引用关系：谁（示例/文档）引用了哪个契约。 */
export interface RefRecord {
  id: string;
  ownerComponentId: string;
  kind: 'example' | 'doc';
  exampleId?: string;
  docField?: DocField;
  title: string;
  targets: RefTarget[];
  status: RefStatus;
  /** 旧数据缺少依赖信息时置位，核对完成前阻塞正式保存。 */
  needsReview: boolean;
  reviewNote?: string;
  /** 上次确认时的键盘契约指纹，用于判定键盘行为变化。 */
  baselineFingerprint?: string;
  provenance?: RefProvenance;
}

/** 迁移提案：在用户“选定”之前只记录预览，不写入正式内容。 */
export interface MigrationProposal {
  id: string;
  ledgerEntryId: string;
  refRecordId: string;
  ownerComponentId: string;
  target: 'example' | 'doc';
  exampleId?: string;
  docField?: DocField;
  mode: ProposalMode;
  status: ProposalStatus;
  fromToken?: string;
  toToken?: string;
  reason: string;
  /** 沿引用链传播时的组件路径说明。 */
  chainPath?: string;
  /** 迁移前/后内容预览，选定前仅作草案。 */
  previewBefore?: string;
  previewAfter?: string;
  createdAt: string;
}

/** 契约变更记录：契约版本、改动来源、受影响引用。 */
export interface LedgerEntry {
  id: string;
  createdAt: string;
  originComponentId: string;
  kind: ContractChangeKind;
  source: string;
  sourceAction: string;
  branch: string;
  fromRevision: number;
  /** 0 = 尚未进入正式版本；正式保存时写入新版本号。 */
  toRevision: number;
  fromToken?: string;
  toToken?: string;
  propertyId?: string;
  breaking: boolean;
  reason: string;
  refRecordIds: string[];
  proposals: MigrationProposal[];
}

export interface ComponentSpec {
  id: string;
  name: string;
  category: string;
  status: ComponentStatus;
  purpose: string;
  usage: string;
  properties: PropertySpec[];
  states: string;
  keyboardBehavior: string;
  screenReader: string;
  disabledScenarios: string;
  interactionSignature: string;
  examples: ComponentExample[];
  revision: number;
  updatedAt: string;
  snapshots: ComponentSnapshot[];
  /** 组件契约所在分支（默认 main）。 */
  branch: string;
  /** 组合示例中用于识别引用的自定义元素标签名。 */
  elementTag: string;
  /** 语义化契约版本，随正式保存递增。 */
  contractVersion: string;
  /** 改动来源历史（契约变更流水）。 */
  ledger: LedgerEntry[];
  docLegacyVariants?: LegacyDocVariant[];
}

export interface ComponentSnapshot {
  revision: number;
  savedAt: string;
  reason: string;
  component: Omit<ComponentSpec, 'snapshots'>;
}

export interface ReferenceLedger {
  version: number;
  records: RefRecord[];
}

export interface WorkspaceState {
  ledgerVersion: number;
  components: ComponentSpec[];
  referenceLedger: ReferenceLedger;
  selectedId: string;
}

export interface ValidationIssue {
  id: string;
  level: 'error' | 'warning' | 'info';
  componentId: string;
  target: string;
  message: string;
  field: 'properties' | 'examples' | 'keyboard' | 'screenReader' | 'ledger';
}

export interface DiffRow {
  field: string;
  before: string;
  after: string;
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
}
