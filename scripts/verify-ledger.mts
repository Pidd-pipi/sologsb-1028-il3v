// 临时验证脚本：走查依赖账本的核心流程，验证后删除
import { SpecStore } from '../src/store';

let pass = 0;
const failures: string[] = [];
const check = (label: string, cond: boolean) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
  else { failures.push(label); console.log(`  ✗ ${label}`); }
};

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
(globalThis as any).localStorage = new MemoryStorage();
(globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));

const findComponent = (store: SpecStore, id: string) => store.state.components.find((c) => c.id === id)!;
const findRef = (store: SpecStore, ownerId: string, targetId: string, token: string, scope = 'code') =>
  store.state.ledger!.refs.find((r) => r.ownerComponentId === ownerId && r.targetComponentId === targetId && r.oldName === token && r.scope === scope);
const verifyAll = (store: SpecStore) => {
  for (const ref of store.state.ledger!.refs) store.verifyRef(ref.id);
};

console.log('1. 旧数据规整：扫描出的跨组件引用全部标记待核对，且阻塞保存');
{
  localStorage.clear();
  const store = new SpecStore();
  const refs = store.state.ledger!.refs;
  check('账本已建立', !!store.state.ledger);
  check('布尔属性 modal 也被扫描到（code 引用）', !!findRef(store, 'task-dialog-spec', 'dialog-spec', 'modal'));
  check('全部旧引用为 unverified', refs.every((r) => r.status === 'unverified'));
  check('旧引用带来源说明', refs.every((r) => r.provenance.length > 0));
  check('旧引用无法保存正式版本', store.saveBlockers('task-dialog-spec').length > 0);
}

console.log('2. 核对后改名：沿引用链自动迁移、布尔属性改写、留存来源');
{
  localStorage.clear();
  const store = new SpecStore();
  verifyAll(store);
  store.select('button-spec');
  const variantProp = findComponent(store, 'button-spec').properties.find((p) => p.name === 'variant')!;
  check('改名成功', store.renameProperty(variantProp.id, 'tone').ok);

  const task = findComponent(store, 'task-dialog-spec');
  check('第二层示例代码自动改写 tone="accent"', task.examples[0].code.includes('tone="accent"'));
  const migrated = findRef(store, 'task-dialog-spec', 'button-spec', 'variant')!;
  check('引用状态为 migrated', migrated.status === 'migrated');
  check('resolvedName=tone', migrated.resolvedName === 'tone');
  check('留存迁移来源（旧→新 + 版本）', migrated.provenance.some((p) => p.includes('variant→tone') && p.includes('r')));
  check('dialog 示例也沿链改写', !findComponent(store, 'dialog-spec').examples[0].code.includes('variant='));
  check('直接迁移的引用不再是 unresolved（沿链第二层为待核对）', !['pendingChoice', 'incompatible', 'unverified'].includes(migrated.status));
  const unresolvedCode = store.state.ledger!.refs.filter((r) => r.scope === 'code' && ['pendingChoice', 'incompatible', 'unverified'].includes(r.status));
  check('没有待选定/不兼容/待核对旧数据的代码引用', unresolvedCode.length === 0);
}

console.log('3. 布尔属性改名：sp-dialog modal→backdrop 在组合代码中改写');
{
  localStorage.clear();
  const store = new SpecStore();
  verifyAll(store);
  store.select('dialog-spec');
  store.renameProperty(findComponent(store, 'dialog-spec').properties.find((p) => p.name === 'modal')!.id, 'backdrop');
  const code = findComponent(store, 'task-dialog-spec').examples[0].code;
  check('布尔属性 modal 改写为 backdrop', code.includes('open backdrop') && !code.includes(' modal'));
}

console.log('4. 键盘行为变化：立即失效、不可自动迁移、人工确认后恢复');
{
  localStorage.clear();
  const store = new SpecStore();
  verifyAll(store);
  store.select('dialog-spec');
  store.updateKeyboardBehavior('Esc 关闭；Tab 在对话框内部循环；打开后聚焦首项；新增 F6 退出');
  const kbRef = store.state.ledger!.refs.find((r) => r.ownerComponentId === 'task-dialog-spec' && r.targetComponentId === 'dialog-spec' && r.kind === 'keyboard' && r.scope === 'code')!;
  check('键盘引用标记 incompatible', kbRef.status === 'incompatible');
  check('给出“键盘行为已核对”候选', kbRef.candidates.some((c) => c.action === 'confirmKeyboard'));
  check('保存被阻塞', store.saveBlockers('task-dialog-spec').length > 0);
  store.chooseRefCandidate(kbRef.id, kbRef.candidates[0].id);
  check('人工确认后恢复 current', store.state.ledger!.refs.find((r) => r.id === kbRef.id)!.status === 'current');
}

console.log('5. 移除：有接替自动迁移；无接替不兼容并列删除候选，选定前不改写');
{
  localStorage.clear();
  const store = new SpecStore();
  verifyAll(store);
  store.select('button-spec');
  store.addProperty();
  const comp = findComponent(store, 'button-spec');
  store.updateProperty(comp.properties[comp.properties.length - 1].id, { name: 'size' });
  store.removeProperty(comp.properties.find((p) => p.name === 'variant')!.id, 'size');
  const dialogRef = findRef(store, 'dialog-spec', 'button-spec', 'variant')!;
  check('带接替自动迁移', dialogRef.status === 'migrated' && dialogRef.resolvedName === 'size');
  check('dialog 示例改写为 size', findComponent(store, 'dialog-spec').examples[0].code.includes('size='));

  localStorage.clear();
  const store2 = new SpecStore();
  verifyAll(store2);
  store2.select('button-spec');
  store2.removeProperty(findComponent(store2, 'button-spec').properties.find((p) => p.name === 'variant')!.id, null);
  const ref = findRef(store2, 'dialog-spec', 'button-spec', 'variant')!;
  check('无接替标记 incompatible', ref.status === 'incompatible');
  check('并列保留删除候选', ref.candidates.length === 1 && ref.candidates[0].action === 'remove');
  const before = findComponent(store2, 'dialog-spec').examples[0].code;
  check('无效候选不生效', !store2.chooseRefCandidate(ref.id, 'bogus').ok && findComponent(store2, 'dialog-spec').examples[0].code === before);
  check('待整理时保存阻塞', store2.saveBlockers('dialog-spec').some((b) => b.includes('variant')));
  store2.chooseRefCandidate(ref.id, ref.candidates[0].id);
  check('选定后正式内容才改写', !findComponent(store2, 'dialog-spec').examples[0].code.includes('variant'));
  check('选定后阻塞解除', !store2.saveBlockers('dialog-spec').some((b) => b.includes('variant')));
}

console.log('6. 分支改名：两个去向并列保留，选定前不写正式内容');
{
  localStorage.clear();
  const store = new SpecStore();
  verifyAll(store);
  // 人工构造并行分支：r4 上 variant→tone 与 variant→emphasis 两条来源并存
  const ledger = store.state.ledger!;
  ledger.changes.unshift(
    { id: 'c1', at: new Date().toISOString(), componentId: 'button-spec', revision: 4, type: 'rename', oldName: 'variant', newName: 'tone', origin: { kind: 'direct' } },
    { id: 'c2', at: new Date().toISOString(), componentId: 'button-spec', revision: 4, type: 'rename', oldName: 'variant', newName: 'emphasis', origin: { kind: 'cascade', viaComponentId: 'theming-spec', note: '主题包并行改名' } }
  );
  const contract = ledger.contracts['button-spec']!;
  contract.revision = 4;
  contract.properties = contract.properties.filter((p) => p.name !== 'variant');
  contract.properties.push({ id: 'p-x1', name: 'tone', required: false }, { id: 'p-x2', name: 'emphasis', required: false });

  const ref = findRef(store, 'dialog-spec', 'button-spec', 'variant')!;
  const before = findComponent(store, 'dialog-spec').examples[0].code;
  store.select('dialog-spec');
  store.migrateExamples(); // 触发沿改名记录重算
  const afterRef = store.state.ledger!.refs.find((r) => r.id === ref.id)!;
  check('多去向标记 pendingChoice', afterRef.status === 'pendingChoice');
  check('并列两个迁移候选', afterRef.candidates.filter((c) => c.action === 'migrate').length === 2);
  check('候选保留各自来源（直接/级联）', afterRef.pendingReason.includes('2 个改名去向'));
  check('选定前正式内容未被改写', findComponent(store, 'dialog-spec').examples[0].code === before);
  const toneCandidate = afterRef.candidates.find((c) => c.targetName === 'tone')!;
  check('存在迁移到 tone 的候选', !!toneCandidate);
  store.chooseRefCandidate(afterRef.id, toneCandidate.id);
  check('选定后写入正式内容', findComponent(store, 'dialog-spec').examples[0].code.includes('tone='));
  check('选定来源写入 provenance', store.state.ledger!.refs.find((r) => r.id === ref.id)!.provenance.some((p) => p.includes('人工选定')));
}

console.log('7. 版本不兼容的传递失效：第二层引用在自动迁移改写后标 pendingVerify，核对即确认');
{
  localStorage.clear();
  const store = new SpecStore();
  verifyAll(store);
  // task-dialog 的读屏说明显式提到 dialog 的 modal 属性（screenReader 属性引用）
  store.select('task-dialog-spec');
  store.updateComponent({ screenReader: '沿用 Modal dialog 的 role=dialog 与 modal 播报；确认完成后播报结果。' });
  // 第三层 confirm-flow 组合 sp-task-dialog（引用 task-dialog 的 open 与键盘契约）
  store.addComponent();
  const flowId = store.state.components[0].id;
  store.select(flowId);
  store.updateComponent({ name: 'Confirm flow', tagName: 'sp-confirm-flow', screenReader: '' });
  store.addExample();
  const flowExampleId = store.state.components[0].examples[0].id;
  store.updateExample(flowExampleId, { code: '<sp-confirm-flow><sp-task-dialog open heading="确认"></sp-task-dialog></sp-confirm-flow>' });
  store.addCompositionRef(flowExampleId, 'task-dialog-spec', 'property', 'open');
  store.addCompositionRef(flowExampleId, 'task-dialog-spec', 'keyboard', '__keyboard__');
  verifyAll(store);

  // dialog.modal→backdrop：task-dialog 读屏（hop1）自动迁移；
  // 该迁移改写了 task-dialog 的正式内容，引用 task-dialog 的 flow（hop2）需要重新核对
  store.select('dialog-spec');
  store.renameProperty(findComponent(store, 'dialog-spec').properties.find((p) => p.name === 'modal')!.id, 'backdrop');

  const taskSrRef = store.state.ledger!.refs.find((r) => r.ownerComponentId === 'task-dialog-spec' && r.targetComponentId === 'dialog-spec' && r.scope === 'screenReader' && r.oldName === 'modal')!;
  check('第一层读屏引用自动迁移', taskSrRef.status === 'migrated' && taskSrRef.resolvedName === 'backdrop');
  check('读屏正式内容被改写', findComponent(store, 'task-dialog-spec').screenReader.includes('backdrop'));

  const kbRef = store.state.ledger!.refs.find((r) => r.ownerComponentId === flowId && r.targetComponentId === 'task-dialog-spec' && r.kind === 'keyboard')!;
  check('第二层键盘引用因上游契约改写标记传递待核对', kbRef.status === 'pendingVerify');
  store.verifyRef(kbRef.id);
  check('人工核对后恢复 current 且来源留存', store.state.ledger!.refs.find((r) => r.id === kbRef.id)!.status === 'current' && store.state.ledger!.refs.find((r) => r.id === kbRef.id)!.provenance.some((p) => p.includes('人工核对通过')));

  // 属性引用的直接迁移（task 示例代码 modal→backdrop）
  check('第一层示例代码直接改写', findComponent(store, 'task-dialog-spec').examples[0].code.includes('open backdrop'));
}

console.log('8. 正式版本闸门：错误、失效示例、待整理引用（含下游传入）任一存在均不可保存；清零后可保存');
{
  localStorage.clear();
  const store = new SpecStore();
  store.select('button-spec');
  // button 自身内容干净，但 dialog/task 仍持未核对的旧引用：发布后它们复制代码会报错，故阻塞
  const initial = store.saveBlockers('button-spec');
  check('存在下游未核对引用时基础组件被阻塞', initial.some((b) => b.includes('关联组件')));
  check('createSnapshot 返回原因', !store.createSnapshot('x').ok);

  // 清零：核对全部引用
  verifyAll(store);
  // dialog 的预置 stale 示例也需迁移
  store.select('dialog-spec');
  store.migrateExamples();
  store.select('button-spec');
  const blockers = store.saveBlockers('button-spec');
  check('全部整理完后阻塞清零', blockers.length === 0);
  const r = store.createSnapshot('正式版本');
  check('正式版本保存成功并产生快照', r.ok && findComponent(store, 'button-spec').snapshots.length === 1);

  // 键盘行为清空造成校验错误，同样阻塞
  store.updateKeyboardBehavior('');
  check('校验错误阻塞保存', store.saveBlockers('button-spec').some((b) => b.includes('键盘')));

  store.select('task-dialog-spec');
  check('task-dialog 干净后也可保存', store.saveBlockers('task-dialog-spec').length === 0);
}

console.log('9. 人工登记组合依赖：登记旧属性名立即尝试映射');
{
  localStorage.clear();
  const store = new SpecStore();
  store.select('dialog-spec');
  // 先把 button.variant 改名 tone
  store.select('button-spec');
  store.renameProperty(findComponent(store, 'button-spec').properties.find((p) => p.name === 'variant')!.id, 'tone');
  // 在一个全新示例中手写旧名 variant，并登记依赖
  store.select('dialog-spec');
  store.addExample();
  const example = findComponent(store, 'dialog-spec').examples.slice(-1)[0];
  store.updateExample(example.id, { code: '<sp-button variant="primary">旧代码</sp-button>' });
  store.addCompositionRef(example.id, 'button-spec', 'property', 'variant');
  const ref = store.state.ledger!.refs.find((r) => r.exampleId === example.id && r.oldName === 'variant')!;
  check('登记旧名后自动迁移到 tone', ref && ref.status === 'migrated' && ref.resolvedName === 'tone');
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) process.exit(1);
