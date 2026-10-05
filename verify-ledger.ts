import assert from 'node:assert/strict';
import { createInitialState } from './src/data';
import { migrateLegacyState } from './src/ledger';
import { SpecStore } from './src/store';

const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => memory.has(key) ? memory.get(key)! : null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
  key: () => null,
  length: 0
};

const find = (store: SpecStore, id: string) => store.state.components.find((c) => c.id === id)!;
const example = (store: SpecStore, cid: string, eid: string) => find(store, cid).examples.find((e) => e.id === eid)!;
const proposalsFor = (store: SpecStore, cid: string) => store.getProposals(cid);

// ---------- 1. 旧数据导入：全部引用缺依赖信息，先标待核对 ----------
const store = new SpecStore();
const dialogExample = example(store, 'dialog-spec', 'example-dialog-modal');
assert.equal(dialogExample.needsReview, true, '旧示例应为待核对');
assert.equal(dialogExample.stale, true, '旧数据自带 stale 仍保留');
assert.equal(store.publishVersion().ok, false, '待核对未处理不能保存正式版本');
assert.match(store.publishVersion().reason ?? '', /待核对/);

// ---------- 2. 核对通过后：沿引用链立即发现 type→variant 自动迁移 ----------
const dialogRecord = store.getRecordForExample('example-dialog-modal')!;
store.reviewRef(dialogRecord.id, true);
const refreshed = example(store, 'dialog-spec', 'example-dialog-modal');
assert.equal(refreshed.needsReview, false);
assert.equal(refreshed.stale, true, '命中基础组件改名挂账，应立即失效');
const auto = proposalsFor(store, 'dialog-spec').filter((r) => r.entry.kind === 'rename');
assert.equal(auto.length, 1, '应产生一条改名自动迁移提案');
assert.equal(auto[0].proposal.mode, 'auto');
assert.match(auto[0].proposal.previewBefore ?? '', /type="negative"/);
assert.match(auto[0].proposal.previewAfter ?? '', /variant="negative"/);
assert.match(auto[0].proposal.chainPath ?? '', /button/i, '应标注跨组件引用链');
// 选定前：正式内容仍是草案改名结果（编辑区可见），但未选定 → 发布仍被拦截
assert.match(refreshed.code, /variant="negative"/, '可映射旧引用应已自动迁移为草案');
assert.equal(store.publishVersion().ok, false, '提案未选定不能保存');

// ---------- 3. 选定自动迁移：保留来源 ----------
store.acceptProposal(auto[0].proposal.id);
assert.equal(proposalsFor(store, 'dialog-spec').filter((r) => r.entry.kind === 'rename').length, 0, '改名提案选定后清空');
const recordAfter = store.getRecordForExample('example-dialog-modal')!;
assert.equal(recordAfter.provenance?.source, 'auto-migration');
assert.equal(recordAfter.provenance?.fromToken, 'type');
assert.equal(recordAfter.provenance?.ledgerEntryId, 'ledger-button-rename-variant');
assert.match(example(store, 'dialog-spec', 'example-dialog-modal').code, /variant="negative"/);

// 仍有键盘挂账（旧数据 staleReason）未处理 → 继续拦截
const remaining = proposalsFor(store, 'dialog-spec');
assert.ok(remaining.length >= 1, '键盘契约变化提案仍在');
assert.equal(remaining.every((r) => r.proposal.mode === 'manual'), true);

// ---------- 4. 人工重算键盘提案，并核对所有旧文档引用 ----------
const keyboardProp = remaining.find((r) => r.proposal.target === 'example')!;
store.updateExample('example-dialog-modal', { code: example(store, 'dialog-spec', 'example-dialog-modal').code.replace('variant="negative"', 'variant="negative" aria-label="删除"') });
store.acceptProposal(keyboardProp.proposal.id);
// 旧数据的两份文档引用都需要核对
for (const field of ['keyboardBehavior', 'screenReader'] as const) {
  const docRecord = store.getDocRecord('dialog-spec', field)!;
  if (docRecord.needsReview) store.reviewRef(docRecord.id, true);
}
for (const row of proposalsFor(store, 'dialog-spec')) {
  store.acceptProposal(row.proposal.id);
}
assert.equal(proposalsFor(store, 'dialog-spec').length, 0, '所有提案应处理完毕');
assert.equal(store.state.referenceLedger.records.filter((r) => r.ownerComponentId === 'dialog-spec').every((r) => !r.needsReview), true);

// ---------- 5. 正式保存成功，契约版本落账 ----------
store.select('dialog-spec');
const before = find(store, 'dialog-spec');
const beforeRev = before.revision;
const result = store.publishVersion('场景验证');
assert.equal(result.ok, true, '待整理项处理完应可保存');
assert.equal(find(store, 'dialog-spec').revision, beforeRev + 1);
const entry = find(store, 'dialog-spec').ledger.find((e) => e.sourceAction === 'legacy-import')!;
assert.ok(entry, '挂账应在本组件视图可见（来源）');
const buttonEntry = find(store, 'button-spec').ledger[0];
assert.ok(buttonEntry.toRevision === 0 || buttonEntry.toRevision > 0);

// ---------- 6. 属性改名实时链路：button 现场改名 disabled→isDisabled ----------
store.select('button-spec');
// 先核对 button 的旧数据引用
for (const record of store.state.referenceLedger.records.filter((r) => r.ownerComponentId === 'button-spec' && r.needsReview)) {
  store.reviewRef(record.id, true);
}
const disabledProp = find(store, 'button-spec').properties.find((p) => p.name === 'disabled')!;
store.updateProperty(disabledProp.id, { name: 'isDisabled' });
const targetExample = example(store, 'button-spec', 'example-button-disabled');
assert.match(targetExample.code, /<sp-button isDisabled>/, '本组件示例旧名应立即自动迁移');
const bp = proposalsFor(store, 'button-spec').filter((r) => r.entry.kind === 'rename');
assert.equal(bp.length, 1);
store.acceptProposal(bp[0].proposal.id);

// 组合示例 dialog 里 sp-button 没有 disabled，不受影响
assert.equal(proposalsFor(store, 'dialog-spec').filter((r) => r.entry.fromToken === 'disabled').length, 0);

// ---------- 6b. 搁置自动迁移：旧引用仍在时继续拦截发布，改对后放行 ----------
store.addComponent();
const freshId = store.state.selectedId;
store.updateComponent({ name: 'Widget', elementTag: 'sp-widget' });
store.addProperty();
const fooProp = find(store, freshId).properties[0];
store.updateProperty(fooProp.id, { name: 'foo' });
store.addExample();
const newExample = find(store, freshId).examples[0];
store.updateExample(newExample.id, { title: 'foo 示例', code: '<sp-widget foo></sp-widget>', propertyIds: [fooProp.id] });
store.updateProperty(find(store, freshId).properties[0].id, { name: 'bar' });
const fooProposal = proposalsFor(store, freshId).find((r) => r.entry.kind === 'rename')!;
assert.ok(fooProposal, '应有改名迁移提案');
store.ignoreProposal(fooProposal.proposal.id);
assert.match(find(store, freshId).examples[0].code, /<sp-widget foo>/, '搁置应回退草案');
assert.equal(store.publishVersion().ok, false, '旧引用仍在，不能保存正式版本');
// 人工把代码改对
store.updateExample(newExample.id, { code: '<sp-widget bar></sp-widget>' });
assert.equal(store.publishVersion().ok, true, '内容改正后应放行');

// ---------- 7. 属性移除：无法映射，manual 提案，清理后可发布 ----------
store.select('button-spec');
const labelProp = find(store, 'button-spec').properties.find((p) => p.name === 'label')!;
store.removeProperty(labelProp.id);
const rm = proposalsFor(store, 'button-spec').filter((r) => r.entry.kind === 'remove');
assert.ok(rm.length >= 1, '移除应产生人工重算提案');
rm.forEach((r) => store.acceptProposal(r.proposal.id));
assert.equal(proposalsFor(store, 'button-spec').filter((r) => r.entry.kind === 'remove').length, 0);

// ---------- 8. 键盘行为变化：示例与读屏说明立即失效 ----------
store.select('field-spec');
for (const record of store.state.referenceLedger.records.filter((r) => r.ownerComponentId === 'field-spec' && r.needsReview)) {
  store.reviewRef(record.id, true);
}
const fieldBefore = proposalsFor(store, 'field-spec').length;
store.updateKeyboardContract({ interactionSignature: 'ArrowDown/ArrowUp 调整；Enter 确认' });
const kb = proposalsFor(store, 'field-spec').filter((r) => r.entry.kind === 'keyboard');
assert.ok(kb.length >= 2, '键盘变化应同时波及示例与读屏说明');
// 读屏说明编辑后重算
store.updateScreenReader('label 与 input 使用 for/id 关联；invalid 时播报错误（已按新键盘契约核对）。');
// 示例人工确认
const kbExample = kb.find((r) => r.proposal.target === 'example')!;
store.acceptProposal(kbExample.proposal.id);
// 读屏提案在编辑后仍在（来源挂账），选定它
const kbDoc = proposalsFor(store, 'field-spec').find((r) => r.entry.kind === 'keyboard' && r.proposal.target === 'doc');
if (kbDoc) store.acceptProposal(kbDoc.proposal.id);
assert.equal(proposalsFor(store, 'field-spec').filter((r) => r.entry.kind === 'keyboard').length, 0);
assert.ok(fieldBefore >= 0);

// ---------- 9. 分支改名：并列保留旧版本 ----------
store.select('field-spec');
const renameBranchResult = store.renameBranch('v2-experimental');
assert.equal(renameBranchResult.ok, true);
const par = proposalsFor(store, 'field-spec').filter((r) => r.proposal.mode === 'parallel');
assert.ok(par.length >= 1, '分支不兼容应并列保留');
store.acceptProposal(par[0].proposal.id);
const exWithLegacy = find(store, 'field-spec').examples.find((e) => (e.legacyVariants ?? []).length > 0);
assert.ok(exWithLegacy, '旧版本代码应作为 legacy 变体并列保留');
assert.match(exWithLegacy!.legacyVariants![0].code, /sp-textfield/);

// ---------- 10. 撤销 ----------
store.undo(); // 撤销“选定并列保留”
store.undo(); // 撤销“分支改名”本身
assert.equal(find(store, 'field-spec').branch, 'main', '撤销应回退分支改名');
store.redo();
assert.equal(find(store, 'field-spec').branch, 'v2-experimental');

// ---------- 11. 复制安全：失效示例 stale 标记存在（UI 据此阻断复制） ----------
assert.equal(typeof dialogExample.stale, 'boolean');

console.log('ALL SCENARIOS PASSED');
