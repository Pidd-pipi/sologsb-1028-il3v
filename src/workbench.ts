import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { diffAgainstSnapshot } from './diff';
import { SpecStore } from './store';
import type {
  ComponentExample,
  ComponentSpec,
  LedgerEntry,
  MigrationProposal,
  PreviewDensity,
  PreviewTheme,
  PropertySpec,
  RefProvenance,
  RefRecord,
  ValidationIssue
} from './types';

type EditorTab = 'overview' | 'api' | 'accessibility' | 'examples' | 'history';

const PROVENANCE_LABEL: Record<RefProvenance['source'], string> = {
  original: '原始引用',
  'auto-migration': '自动迁移',
  'manual-migration': '人工迁移',
  'parallel-legacy': '并列保留旧版',
  'legacy-import': '旧数据导入'
};

const CHANGE_LABEL: Record<LedgerEntry['kind'], string> = {
  rename: '属性改名',
  remove: '属性移除',
  keyboard: '键盘行为变化',
  branch: '分支改名'
};

export class SpecA11yWorkbench extends LitElement {
  static properties = {
    query: { state: true },
    tab: { state: true },
    previewTheme: { state: true },
    previewDensity: { state: true },
    toast: { state: true },
    showValidation: { state: true },
    branchDraft: { state: true }
  };

  private store = new SpecStore();
  private query = '';
  private tab: EditorTab = 'examples';
  private previewTheme: PreviewTheme = 'light';
  private previewDensity: PreviewDensity = 'regular';
  private toast = '';
  private showValidation = true;
  private branchDraft = '';
  private toastTimer?: number;

  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      color: var(--spectrum-gray-900);
      background: linear-gradient(135deg, var(--spectrum-gray-100), var(--spectrum-blue-100));
      font-family: var(--spectrum-sans-font-family, Inter, ui-sans-serif, system-ui);
    }
    * { box-sizing: border-box; }
    .app { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
    header {
      position: sticky; top: 0; z-index: 20;
      display: flex; align-items: center; gap: 18px; padding: 14px 22px;
      background: color-mix(in srgb, var(--spectrum-gray-50) 92%, transparent);
      border-bottom: 1px solid var(--spectrum-gray-300); backdrop-filter: blur(14px);
    }
    .brand { min-width: 245px; }
    .brand h1 { margin: 0; font-size: 18px; letter-spacing: -.02em; }
    .brand p { margin: 3px 0 0; color: var(--spectrum-gray-700); font-size: 12px; }
    .toolbar { display: flex; align-items: center; gap: 8px; flex: 1; }
    .toolbar sp-search { min-width: 280px; flex: 1; max-width: 520px; }
    .save-state { color: var(--spectrum-gray-700); font-size: 12px; white-space: nowrap; }
    .layout {
      display: grid; grid-template-columns: minmax(245px, 290px) minmax(0, 1fr) minmax(315px, 390px);
      min-height: calc(100vh - 72px);
    }
    .sidebar, .inspector { background: color-mix(in srgb, var(--spectrum-gray-50) 90%, transparent); }
    .sidebar { border-right: 1px solid var(--spectrum-gray-300); padding: 18px 12px; }
    .sidebar-heading { display: flex; justify-content: space-between; align-items: center; padding: 0 8px 12px; }
    .sidebar-heading h2, .panel h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; }
    .component-list { display: grid; gap: 7px; }
    .component-item {
      width: 100%; text-align: left; border: 1px solid transparent; border-radius: 10px;
      background: transparent; color: inherit; padding: 11px 12px; cursor: pointer;
    }
    .component-item:hover { background: var(--spectrum-gray-200); }
    .component-item[aria-current='page'] { border-color: var(--spectrum-blue-600); background: var(--spectrum-blue-200); }
    .item-title { display: flex; justify-content: space-between; gap: 8px; font-weight: 700; }
    .item-meta { display: block; color: var(--spectrum-gray-700); font-size: 12px; margin-top: 5px; }
    .item-badges { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 7px; font-size: 10px; font-weight: 700; background: var(--spectrum-gray-300); }
    .pill.published { background: var(--spectrum-green-300); }
    .pill.review { background: var(--spectrum-orange-300); }
    .pill.todo { background: var(--spectrum-red-400); color: #1d0707; }
    .pill.contract { background: var(--spectrum-blue-300); }
    .main { min-width: 0; padding: 22px; }
    .title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 15px; margin-bottom: 16px; }
    .title-row h2 { font-size: 28px; margin: 0; letter-spacing: -.035em; }
    .title-row p { margin: 6px 0 0; color: var(--spectrum-gray-700); }
    .contract-line { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .tabs { display: flex; gap: 5px; overflow-x: auto; padding: 5px; border: 1px solid var(--spectrum-gray-300); border-radius: 12px; background: var(--spectrum-gray-100); margin-bottom: 16px; }
    .tab { border: 0; border-radius: 8px; background: transparent; color: var(--spectrum-gray-800); padding: 8px 12px; font: inherit; cursor: pointer; white-space: nowrap; }
    .tab[aria-selected='true'] { background: var(--spectrum-gray-50); box-shadow: 0 1px 4px rgb(0 0 0 / .12); font-weight: 700; }
    .panel { border: 1px solid var(--spectrum-gray-300); border-radius: 16px; background: var(--spectrum-gray-50); padding: 20px; box-shadow: 0 8px 26px rgb(20 30 50 / .06); }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .field { display: grid; gap: 7px; min-width: 0; }
    .field.full { grid-column: 1 / -1; }
    .field > span { font-size: 12px; font-weight: 700; }
    textarea, input[type='text'], select {
      width: 100%; border: 1px solid var(--spectrum-gray-400); border-radius: 8px;
      padding: 9px 10px; background: var(--spectrum-gray-50); color: var(--spectrum-gray-900);
      font: inherit; line-height: 1.5;
    }
    textarea:focus, input:focus, select:focus { outline: 3px solid var(--spectrum-blue-400); outline-offset: 1px; border-color: var(--spectrum-blue-700); }
    textarea { min-height: 110px; resize: vertical; }
    .property-list, .example-list { display: grid; gap: 12px; }
    .property-card, .example-card { border: 1px solid var(--spectrum-gray-300); border-radius: 12px; padding: 14px; background: var(--spectrum-gray-75, var(--spectrum-gray-100)); }
    .property-head, .example-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
    .property-head strong, .example-head strong { flex: 1; }
    .inline { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .empty { padding: 28px; border: 1px dashed var(--spectrum-gray-400); border-radius: 12px; text-align: center; color: var(--spectrum-gray-700); }
    .inspector { border-left: 1px solid var(--spectrum-gray-300); padding: 18px; display: grid; align-content: start; gap: 15px; }
    .preview { border-radius: 14px; border: 1px solid var(--spectrum-gray-400); padding: 18px; display: grid; place-items: center; min-height: 150px; transition: .2s; }
    .preview.dark { background: #1b1b1b; color: #f5f5f5; border-color: #444; }
    .preview.light { background: #fff; color: #111; }
    .preview.compact { padding: 9px; }
    .preview.regular { padding: 18px; }
    .preview.spacious { padding: 32px; }
    .demo-button { border: 0; border-radius: 8px; padding: 10px 16px; background: #1473e6; color: white; font: inherit; }
    .issue { border-left: 4px solid var(--spectrum-gray-500); border-radius: 8px; background: var(--spectrum-gray-100); padding: 10px 11px; margin-bottom: 8px; font-size: 12px; }
    .issue.error { border-color: var(--spectrum-red-600); }
    .issue.warning { border-color: var(--spectrum-orange-600); }
    .issue.info { border-color: var(--spectrum-blue-600); }
    .issue strong { display: block; margin-bottom: 3px; }
    .issue .row-actions { display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
    .issue button.link { border: 0; background: transparent; color: var(--spectrum-blue-800); padding: 0; cursor: pointer; text-decoration: underline; font: inherit; }
    .diff { display: grid; gap: 7px; margin-top: 9px; }
    .diff-row { border: 1px solid var(--spectrum-gray-300); border-radius: 8px; padding: 9px; font-size: 11px; }
    .diff-row b { display: block; margin-bottom: 4px; text-transform: capitalize; }
    .before { color: var(--spectrum-red-800); white-space: pre-wrap; }
    .after { color: var(--spectrum-green-900); white-space: pre-wrap; }
    pre { white-space: pre-wrap; word-break: break-word; background: #202020; color: #f5f5f5; padding: 12px; border-radius: 8px; font-size: 12px; }
    pre.legacy { background: #3a2c12; color: #ffe9b8; }
    .search-empty { padding: 20px 8px; color: var(--spectrum-gray-700); font-size: 13px; }
    .footer-hint { position: fixed; bottom: 10px; left: 50%; transform: translateX(-50%); z-index: 30; background: #202020; color: white; border-radius: 999px; padding: 6px 12px; font-size: 11px; opacity: .9; }
    sp-toast { position: fixed; right: 18px; bottom: 18px; z-index: 50; }
    .provenance { font-size: 11px; color: var(--spectrum-gray-700); display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .tag-mini { border: 1px solid var(--spectrum-gray-400); border-radius: 6px; padding: 1px 6px; background: var(--spectrum-gray-100); }
    .ledger-entry { border: 1px solid var(--spectrum-gray-300); border-radius: 10px; padding: 12px; margin-bottom: 10px; background: var(--spectrum-gray-75, var(--spectrum-gray-100)); }
    .ledger-entry h4 { margin: 0 0 6px; font-size: 13px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .ledger-meta { font-size: 11px; color: var(--spectrum-gray-700); display: grid; gap: 3px; }
    .proposal-line { border-top: 1px dashed var(--spectrum-gray-300); margin-top: 8px; padding-top: 8px; font-size: 12px; display: grid; gap: 6px; }
    .proposal-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .branch-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .branch-row input { max-width: 180px; }
    @media (max-width: 1180px) {
      .layout { grid-template-columns: 230px minmax(0, 1fr); }
      .inspector { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--spectrum-gray-300); grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 760px) {
      header { flex-wrap: wrap; padding: 12px; }
      .brand { min-width: 100%; }
      .toolbar { flex-wrap: wrap; }
      .toolbar sp-search { min-width: 100%; }
      .layout { grid-template-columns: 1fr; }
      .sidebar { border-right: 0; border-bottom: 1px solid var(--spectrum-gray-300); }
      .inspector { grid-template-columns: 1fr; }
      .form-grid { grid-template-columns: 1fr; }
      .field.full { grid-column: auto; }
      .main { padding: 14px; }
      .title-row { display: grid; }
      .actions { justify-content: flex-start; }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.store.addEventListener('change', this.onStoreChange);
    window.addEventListener('keydown', this.onKeyDown);
  }

  disconnectedCallback() {
    this.store.removeEventListener('change', this.onStoreChange);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private onStoreChange = () => {
    this.requestUpdate();
  };

  private onKeyDown = (event: KeyboardEvent) => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.store.redo() : this.store.undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.publish('键盘保存');
      return;
    }
    if (modifier && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.renderRoot.querySelector<HTMLElement>('sp-search')?.focus();
      return;
    }
    if (event.altKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      this.store.addComponent();
      return;
    }
    const tabMap: Record<string, EditorTab> = { '1': 'overview', '2': 'api', '3': 'accessibility', '4': 'examples', '5': 'history' };
    if (event.altKey && tabMap[event.key]) {
      event.preventDefault();
      this.tab = tabMap[event.key];
    }
  };

  protected render(): TemplateResult {
    const selected = this.store.selected;
    const issues = this.store.validate();
    const selectedIssues = selected ? issues.filter((item) => item.componentId === selected.id) : [];
    const filtered = this.filteredComponents;
    return html`
      <sp-theme color=${this.previewTheme === 'dark' ? 'dark' : 'light'} scale=${this.previewDensity === 'compact' ? 'medium' : 'large'}>
        <div class="app">
          <header>
            <div class="brand">
              <h1>Component Contract Studio</h1>
              <p>依赖账本 · 引用失效传播 · 迁移选定</p>
            </div>
            <div class="toolbar">
              <sp-search
                placeholder="搜索组件、属性、键盘行为或示例"
                aria-label="全文搜索"
                .value=${this.query}
                @input=${(event: Event) => { this.query = (event.currentTarget as HTMLInputElement & { value?: string }).value ?? ''; }}
              ></sp-search>
              <sp-button variant="secondary" ?disabled=${!this.store.canUndo} @click=${() => this.store.undo()}>撤销</sp-button>
              <sp-button variant="secondary" ?disabled=${!this.store.canRedo} @click=${() => this.store.redo()}>重做</sp-button>
              <sp-button variant="accent" @click=${() => this.publish('工具栏保存')}>保存正式版本</sp-button>
              <span class="save-state">本地自动保存 · 契约 ${selected?.contractVersion ?? '0.0.0'} · r${selected?.revision ?? 0}</span>
            </div>
          </header>
          <div class="layout">
            <aside class="sidebar" aria-label="组件目录">
              <div class="sidebar-heading">
                <h2>组件目录</h2>
                <sp-action-button size="s" label="新建组件" @click=${() => this.store.addComponent()}>＋</sp-action-button>
              </div>
              <div class="component-list">
                ${filtered.length ? repeat(filtered, (item) => item.id, (item) => {
                  const todos = this.todoCount(item.id);
                  return html`
                  <button class="component-item" aria-current=${item.id === this.store.state.selectedId ? 'page' : nothing} @click=${() => this.store.select(item.id)}>
                    <span class="item-title">
                      <span>${item.name}</span>
                      <span class="pill ${item.status}">${this.statusLabel(item.status)}</span>
                    </span>
                    <span class="item-meta">${item.category} · ${item.properties.length} 个属性 · ${item.examples.length} 个示例</span>
                    <span class="item-badges">
                      <span class="pill contract">${item.branch}@${item.contractVersion}</span>
                      ${todos ? html`<span class="pill todo">待整理 ${todos}</span>` : nothing}
                    </span>
                  </button>
                `;}) : html`<div class="search-empty">没有匹配的组件。可尝试属性名、键盘行为或代码文本。</div>`}
              </div>
            </aside>
            <main class="main">${selected ? this.renderEditor(selected) : html`<div class="empty">新建或选择组件开始编辑。</div>`}</main>
            <aside class="inspector" aria-label="预览与检查">
              ${this.renderPreview(selected)}
              ${this.renderValidation(selectedIssues)}
            </aside>
          </div>
          ${this.toast ? html`<sp-toast open variant="positive" timeout="3000">${this.toast}</sp-toast>` : nothing}
          <div class="footer-hint">⌘/Ctrl+Z 撤销 · ⌘/Ctrl+S 保存正式版本 · ⌘/Ctrl+K 搜索 · Alt+1–5 切换面板</div>
        </div>
      </sp-theme>
    `;
  }

  private publish(reason: string) {
    const result = this.store.publishVersion(reason);
    if (result.ok) {
      this.flash(`正式版本已保存（契约 ${this.store.selected?.contractVersion}）`);
    } else {
      this.flash(`无法保存：${result.reason}`);
    }
  }

  private todoCount(componentId: string): number {
    const records = this.store.state.referenceLedger.records.filter((record) => record.ownerComponentId === componentId);
    let count = records.filter((record) => record.status !== 'fresh').length;
    count += this.store.getProposals(componentId).length;
    return count;
  }

  private renderEditor(component: ComponentSpec): TemplateResult {
    return html`
      <div class="title-row">
        <div>
          <h2>${component.name}</h2>
          <p>${component.purpose}</p>
          <div class="contract-line">
            <span class="pill contract">契约 ${component.contractVersion}</span>
            <span class="pill contract">分支 ${component.branch}</span>
            <span class="pill">r${component.revision}</span>
            ${this.store.getProposals(component.id).length ? html`<span class="pill todo">${this.store.getProposals(component.id).length} 条迁移待选定</span>` : nothing}
          </div>
        </div>
        <div class="actions">
          <select aria-label="组件状态" .value=${component.status} @change=${(event: Event) => this.store.updateComponent({ status: (event.currentTarget as HTMLSelectElement).value as ComponentSpec['status'] })}>
            <option value="draft">草稿</option>
            <option value="review">待审</option>
            <option value="published">已发布</option>
          </select>
        </div>
      </div>
      <div class="tabs" role="tablist" aria-label="编辑区域">
        ${this.renderTab('overview', '1 概述')}
        ${this.renderTab('api', '2 属性与状态')}
        ${this.renderTab('accessibility', '3 无障碍')}
        ${this.renderTab('examples', '4 关联示例')}
        ${this.renderTab('history', '5 依赖账本与版本')}
      </div>
      ${this.tab === 'overview' ? this.renderOverview(component) : nothing}
      ${this.tab === 'api' ? this.renderApi(component) : nothing}
      ${this.tab === 'accessibility' ? this.renderAccessibility(component) : nothing}
      ${this.tab === 'examples' ? this.renderExamples(component) : nothing}
      ${this.tab === 'history' ? this.renderHistory(component) : nothing}
    `;
  }

  private renderTab(tab: EditorTab, label: string): TemplateResult {
    return html`<button class="tab" role="tab" aria-selected=${this.tab === tab} @click=${() => { this.tab = tab; }}>${label}</button>`;
  }

  private renderOverview(component: ComponentSpec): TemplateResult {
    return html`
      <section class="panel" aria-label="组件概述">
        <div class="form-grid">
          <label class="field"><span>组件名称</span><input type="text" .value=${component.name} @change=${(event: Event) => this.store.updateComponent({ name: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="field"><span>分类</span><input type="text" .value=${component.category} @change=${(event: Event) => this.store.updateComponent({ category: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="field full"><span>用途</span><textarea .value=${component.purpose} @change=${(event: Event) => this.store.updateComponent({ purpose: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
          <label class="field full"><span>使用规则</span><textarea .value=${component.usage} @change=${(event: Event) => this.store.updateComponent({ usage: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
          <label class="field full"><span>禁用场景</span><textarea .value=${component.disabledScenarios} @change=${(event: Event) => this.store.updateComponent({ disabledScenarios: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
        </div>
      </section>
    `;
  }

  private renderApi(component: ComponentSpec): TemplateResult {
    return html`
      <section class="panel">
        <div class="property-head">
          <h2>属性契约（改名/移除会立即沿引用链失效）</h2>
          <sp-button size="s" variant="secondary" @click=${() => this.store.addProperty()}>新增属性</sp-button>
        </div>
        <div class="property-list">
          ${component.properties.length ? repeat(component.properties, (item) => item.id, (property) => this.renderProperty(property)) : html`<div class="empty">尚未定义属性。</div>`}
        </div>
        <div class="form-grid" style="margin-top: 18px">
          <label class="field full"><span>状态说明</span><textarea .value=${component.states} @change=${(event: Event) => this.store.updateComponent({ states: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
          <label class="field full"><span>交互签名（键盘契约：变化后关联示例与读屏说明立即失效重算）</span><textarea .value=${component.interactionSignature} @change=${(event: Event) => this.store.updateKeyboardContract({ interactionSignature: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
        </div>
      </section>
    `;
  }

  private renderProperty(property: PropertySpec): TemplateResult {
    return html`
      <article class="property-card">
        <div class="property-head">
          <strong>${property.name || '未命名属性'}</strong>
          <sp-action-button size="s" label="删除属性" @click=${() => this.store.removeProperty(property.id)}>删除</sp-action-button>
        </div>
        <div class="form-grid">
          <label class="field"><span>名称（改名会记录契约版本与来源）</span><input type="text" .value=${property.name} @change=${(event: Event) => this.store.updateProperty(property.id, { name: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="field"><span>类型</span><input type="text" .value=${property.type} @change=${(event: Event) => this.store.updateProperty(property.id, { type: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="field"><span>默认值</span><input type="text" .value=${property.defaultValue} @change=${(event: Event) => this.store.updateProperty(property.id, { defaultValue: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="inline"><input type="checkbox" .checked=${property.required} @change=${(event: Event) => this.store.updateProperty(property.id, { required: (event.currentTarget as HTMLInputElement).checked })} /> 必填属性</label>
          <label class="field full"><span>属性说明</span><textarea .value=${property.description} @change=${(event: Event) => this.store.updateProperty(property.id, { description: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
        </div>
      </article>
    `;
  }

  private renderAccessibility(component: ComponentSpec): TemplateResult {
    const keyboardRecord = this.store.getDocRecord(component.id, 'keyboardBehavior');
    const srRecord = this.store.getDocRecord(component.id, 'screenReader');
    return html`
      <section class="panel">
        <div class="form-grid">
          <label class="field full">
            <span>键盘行为（契约本体）</span>
            <textarea .value=${component.keyboardBehavior} @change=${(event: Event) => this.store.updateKeyboardContract({ keyboardBehavior: (event.currentTarget as HTMLTextAreaElement).value })}></textarea>
          </label>
          ${this.renderRecordCard(keyboardRecord)}
          ${this.renderDocProposals(component, 'keyboardBehavior')}
          <label class="field full">
            <span>读屏说明（引用属性/组件，改名后失效追踪）</span>
            <textarea .value=${component.screenReader} @change=${(event: Event) => this.store.updateScreenReader((event.currentTarget as HTMLTextAreaElement).value)}></textarea>
          </label>
          ${this.renderRecordCard(srRecord)}
          ${this.renderDocProposals(component, 'screenReader')}
          ${(component.docLegacyVariants ?? []).length ? html`
            <div class="field full">
              <span>并列保留的旧版本文档</span>
              ${repeat(component.docLegacyVariants ?? [], (item) => item.ledgerEntryId + item.field, (item) => html`
                <div class="issue warning"><strong>${item.label} · ${item.field === 'screenReader' ? '读屏说明' : '键盘行为'}</strong><pre class="legacy">${item.text}</pre></div>
              `)}
            </div>` : nothing}
          <label class="field full"><span>禁用场景</span><textarea .value=${component.disabledScenarios} @change=${(event: Event) => this.store.updateComponent({ disabledScenarios: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
        </div>
      </section>
    `;
  }

  private renderRecordCard(record: RefRecord | undefined) {
    if (!record) return nothing;
    return html`
      <div class="field full">
        ${record.needsReview ? html`
          <div class="issue warning">
            <strong>待核对 · ${record.title}</strong>
            ${record.reviewNote ?? '旧数据缺少依赖信息。'}
            <div class="row-actions">
              <button class="link" @click=${() => { this.store.reviewRef(record.id, true); this.flash('引用关系已核对'); }}>引用无误，核对通过</button>
            </div>
          </div>` : nothing}
        ${this.renderProvenance(record)}
        ${record.targets.length ? html`<div class="provenance">引用：${repeat(record.targets, (target) => target.token, (target) => html`<span class="tag-mini">${this.componentName(target.componentId)} · ${target.token.split('/').pop()}</span>`)}</div>` : nothing}
      </div>
    `;
  }

  private renderProvenance(record: RefRecord | undefined) {
    if (!record) return nothing;
    const provenance = record.provenance;
    if (!provenance) return nothing;
    return html`<div class="provenance">
      <span class="tag-mini">来源：${PROVENANCE_LABEL[provenance.source]}</span>
      ${provenance.fromToken ? html`<span class="tag-mini">旧引用 ${provenance.fromToken}（已迁移）</span>` : nothing}
      ${provenance.fromBranch ? html`<span class="tag-mini">分支 ${provenance.fromBranch}</span>` : nothing}
      ${provenance.fromRevision ? html`<span class="tag-mini">r${provenance.fromRevision}</span>` : nothing}
      ${provenance.note ? html`<span>${provenance.note}</span>` : nothing}
    </div>`;
  }

  private renderDocProposals(component: ComponentSpec, field: 'keyboardBehavior' | 'screenReader') {
    const rows = this.store.getProposals(component.id).filter(({ proposal }) => proposal.target === 'doc' && proposal.docField === field);
    if (!rows.length) return nothing;
    return html`<div class="field full">${rows.map(({ entry, proposal }) => this.renderProposal(entry, proposal))}</div>`;
  }

  private renderExamples(component: ComponentSpec): TemplateResult {
    const autoCount = this.store.getProposals(component.id).filter(({ proposal }) => proposal.mode === 'auto').length;
    return html`
      <section class="panel">
        <div class="property-head">
          <h2>关联示例（依赖账本追踪引用链）</h2>
          <div class="inline">
            ${autoCount ? html`<sp-button size="s" variant="accent" @click=${() => { const n = this.store.acceptAllAutoMigrations(component.id); this.flash(n ? `已选定 ${n} 条自动迁移` : '没有可自动迁移的项'); }}>全部选定自动迁移（${autoCount}）</sp-button>` : nothing}
            <sp-button size="s" variant="secondary" @click=${() => this.store.addExample()}>新增示例</sp-button>
          </div>
        </div>
        <div class="example-list">
          ${component.examples.length ? repeat(component.examples, (item) => item.id, (example) => this.renderExample(component, example)) : html`<div class="empty">尚无示例。新增后会追踪属性依赖和契约版本。</div>`}
        </div>
      </section>
    `;
  }

  private renderExample(component: ComponentSpec, example: ComponentExample): TemplateResult {
    const record = this.store.getRecordForExample(example.id);
    const proposals = record
      ? this.store.getProposals(component.id).filter(({ proposal }) => proposal.refRecordId === record.id)
      : [];
    return html`
      <article class="example-card">
        <div class="example-head">
          <strong>${example.title}</strong>
          ${example.needsReview ? html`<span class="pill review">待核对</span>` : example.stale ? html`<span class="pill review">失效重算中</span>` : html`<span class="pill published">r${example.createdFromRevision}</span>`}
          <sp-action-button size="s" label="复制代码" @click=${() => this.copyExample(example)}>复制</sp-action-button>
          <sp-action-button size="s" label="删除示例" @click=${() => this.store.removeExample(example.id)}>删除</sp-action-button>
        </div>
        ${example.stale ? html`<div class="issue warning"><strong>关联失效</strong>${example.staleReason || '引用契约已变化，复制前需先处理。'}</div>` : nothing}
        ${record?.needsReview ? html`
          <div class="issue warning">
            <strong>待核对：旧数据缺少依赖信息</strong>
            ${record.reviewNote ?? ''} 引用关系当前只能按代码推断，核对前不能保存正式版本。
            <div class="row-actions">
              <button class="link" @click=${() => { this.store.reviewRef(record.id, true); this.flash('已核对，失效检查已重新计算'); }}>引用无误，核对通过</button>
            </div>
          </div>` : nothing}
        ${proposals.map(({ entry, proposal }) => this.renderProposal(entry, proposal))}
        ${this.renderProvenance(record)}
        ${(example.legacyVariants ?? []).length ? html`
          <div class="issue warning" style="margin-top:8px">
            <strong>并列保留的旧版本（不兼容分支）</strong>
            ${repeat(example.legacyVariants ?? [], (item) => item.ledgerEntryId, (item) => html`
              <div style="margin-top:6px"><span class="tag-mini">${item.label}</span><pre class="legacy">${item.code}</pre></div>
            `)}
          </div>` : nothing}
        <div class="form-grid">
          <label class="field full"><span>标题</span><input type="text" .value=${example.title} @change=${(event: Event) => this.store.updateExample(example.id, { title: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="field full"><span>代码（迁移草案在选定前不计入正式内容）</span><textarea .value=${example.code} @change=${(event: Event) => this.store.updateExample(example.id, { code: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
          <div class="field full">
            <span>依赖属性</span>
            <div class="inline" style="flex-wrap: wrap">
              ${component.properties.map((property) => html`
                <label class="inline"><input type="checkbox" .checked=${example.propertyIds.includes(property.id)} @change=${(event: Event) => {
                  const values = new Set(example.propertyIds);
                  (event.currentTarget as HTMLInputElement).checked ? values.add(property.id) : values.delete(property.id);
                  this.store.updateExample(example.id, { propertyIds: [...values] });
                }} /> ${property.name}</label>
              `)}
              ${!component.properties.length ? html`<span>当前组件没有属性。</span>` : nothing}
            </div>
          </div>
          <div class="field full"><pre>${example.code}</pre></div>
        </div>
      </article>
    `;
  }

  private renderProposal(entry: LedgerEntry, proposal: MigrationProposal): TemplateResult {
    const modeLabel = { auto: '可自动迁移', parallel: '并列保留', manual: '需人工重算' }[proposal.mode];
    return html`
      <div class="issue ${proposal.mode === 'manual' ? 'error' : 'warning'}">
        <strong>${CHANGE_LABEL[entry.kind]} · ${modeLabel}${proposal.chainPath ? html` · <span class="tag-mini">引用链 ${proposal.chainPath}</span>` : nothing}</strong>
        ${proposal.reason}
        ${proposal.previewAfter !== undefined && proposal.previewAfter !== proposal.previewBefore ? html`
          <div class="diff">
            <div class="diff-row"><b>迁移前</b><span class="before">${proposal.previewBefore}</span></div>
            <div class="diff-row"><b>迁移后（草案）</b><span class="after">${proposal.previewAfter}</span></div>
          </div>` : nothing}
        <div class="proposal-actions">
          <sp-button size="s" variant=${proposal.mode === 'manual' ? 'secondary' : 'accent'} @click=${() => {
            this.store.acceptProposal(proposal.id);
            this.flash(proposal.mode === 'auto' ? '已选定自动迁移并保留来源' : proposal.mode === 'parallel' ? '已并列保留旧版本' : '已确认人工重算');
          }}>${proposal.mode === 'manual' ? '我已改好，确认重算' : proposal.mode === 'parallel' ? '并列保留旧版' : '选定自动迁移'}</sp-button>
          <button class="link" @click=${() => { this.store.ignoreProposal(proposal.id); this.flash('已搁置该提案'); }}>搁置</button>
          <span class="tag-mini">来源：${entry.source}</span>
        </div>
      </div>
    `;
  }

  private renderHistory(component: ComponentSpec): TemplateResult {
    const snapshot = component.snapshots[0];
    const rows = diffAgainstSnapshot(component, snapshot);
    const entries = this.store.getLedgerEntries(component.id);
    return html`
      <section class="panel">
        <div class="property-head">
          <h2>依赖账本与正式版本</h2>
          <sp-button size="s" variant="accent" @click=${() => this.publish('历史面板保存')}>保存正式版本</sp-button>
        </div>
        <p>当前契约 <b>${component.contractVersion}</b>（r${component.revision}，分支 ${component.branch}）。最近快照：${snapshot ? `r${snapshot.revision} · ${new Date(snapshot.savedAt).toLocaleString('zh-CN')}` : '暂无'}。</p>
        <div class="branch-row" style="margin: 10px 0">
          <span>契约分支改名（不兼容时新旧并列保留）：</span>
          <input type="text" aria-label="新分支名" placeholder=${component.branch} .value=${this.branchDraft} @input=${(event: Event) => { this.branchDraft = (event.currentTarget as HTMLInputElement).value; }} />
          <sp-button size="s" variant="secondary" @click=${() => {
            const result = this.store.renameBranch(this.branchDraft.trim());
            if (result.ok) { this.flash('分支已改名，旧引用并列保留'); this.branchDraft = ''; }
            else this.flash(result.reason ?? '分支名无效');
          }}>应用分支改名</sp-button>
        </div>

        <h3>改动来源与引用关系</h3>
        ${entries.length ? repeat(entries, (entry) => entry.id, (entry) => this.renderLedgerEntry(component, entry)) : html`<div class="empty">尚无契约改动。属性改名、移除或键盘行为变化后会在此记账。</div>`}

        <h3 style="margin-top:18px">与最近快照的差异</h3>
        ${snapshot ? (rows.length ? html`<div class="diff">${rows.map((row) => html`<div class="diff-row"><b>${row.field}</b><span class="before">- ${row.before || '（空）'}</span><br /><span class="after">+ ${row.after || '（空）'}</span></div>`)}</div>` : html`<div class="issue info">当前内容与最近快照一致。</div>`) : html`<div class="empty">保存一次正式版本后即可比较字段、属性和示例变化。</div>`}
      </section>
    `;
  }

  private renderLedgerEntry(component: ComponentSpec, entry: LedgerEntry): TemplateResult {
    const originName = this.componentName(entry.originComponentId);
    const versionText = entry.toRevision === 0 ? '待正式保存' : `r${entry.fromRevision} → r${entry.toRevision}`;
    return html`
      <div class="ledger-entry">
        <h4>
          <span class="pill ${entry.breaking ? 'todo' : 'published'}">${entry.breaking ? '不兼容' : '可兼容'}</span>
          ${CHANGE_LABEL[entry.kind]} · ${originName}
          ${entry.fromToken ? html`<span class="tag-mini">${entry.fromToken}${entry.toToken ? ` → ${entry.toToken}` : ''}</span>` : nothing}
        </h4>
        <div class="ledger-meta">
          <span>改动来源：${entry.source}（${entry.sourceAction}）</span>
          <span>契约版本：${entry.branch} · ${versionText}</span>
          <span>时间：${new Date(entry.createdAt).toLocaleString('zh-CN')}</span>
          <span>受影响引用：${entry.refRecordIds.length} 条 · 提案 ${entry.proposals.filter((p) => p.status === 'proposed').length} 待选定 / ${entry.proposals.filter((p) => p.status === 'accepted').length} 已选定</span>
        </div>
        ${entry.proposals.length ? repeat(entry.proposals, (proposal) => proposal.id + proposal.status, (proposal) => proposal.ownerComponentId === component.id ? html`
          <div class="proposal-line">
            <span class="tag-mini">${{ proposed: '待选定', accepted: '已选定', ignored: '已搁置' }[proposal.status]}</span>
            ${proposal.reason}
            ${proposal.status === 'proposed' ? html`
              <div class="proposal-actions">
                <sp-button size="s" variant=${proposal.mode === 'auto' ? 'accent' : 'secondary'} @click=${() => this.store.acceptProposal(proposal.id)}>${proposal.mode === 'manual' ? '确认人工重算' : proposal.mode === 'parallel' ? '并列保留' : '选定自动迁移'}</sp-button>
                <button class="link" @click=${() => this.store.ignoreProposal(proposal.id)}>搁置</button>
              </div>` : nothing}
          </div>` : nothing) : nothing}
      </div>
    `;
  }

  private renderPreview(component?: ComponentSpec): TemplateResult {
    if (!component) return html`<section class="panel"><h2>预览</h2><p>选择组件后显示主题与密度预览。</p></section>`;
    return html`
      <section class="panel">
        <div class="property-head"><h2>实时预览</h2><button class="tab" @click=${() => { this.previewTheme = this.previewTheme === 'light' ? 'dark' : 'light'; }}>${this.previewTheme === 'light' ? '深色' : '浅色'}</button></div>
        <div class="inline" style="margin-bottom: 10px">
          <label>密度</label>
          <select .value=${this.previewDensity} @change=${(event: Event) => { this.previewDensity = (event.currentTarget as HTMLSelectElement).value as PreviewDensity; }}>
            <option value="compact">紧凑</option>
            <option value="regular">标准</option>
            <option value="spacious">宽松</option>
          </select>
        </div>
        <div class="preview ${this.previewTheme} ${this.previewDensity}">
          ${component.category === 'Forms'
            ? html`<label style="width:100%"><span style="display:block;font-size:12px;margin-bottom:6px">${component.properties.find((item) => item.name === 'label')?.defaultValue ?? '字段标签'}</span><input style="width:100%;padding:10px;border:1px solid #888;border-radius:8px" placeholder="输入内容" /></label>`
            : html`<button class="demo-button">${component.properties.find((item) => item.name === 'label')?.defaultValue ?? component.name}</button>`}
        </div>
      </section>
    `;
  }

  private renderValidation(issues: ValidationIssue[]): TemplateResult {
    return html`
      <section class="panel">
        <div class="property-head">
          <h2>规范检查与发布闸门</h2>
          <sp-button size="s" variant="secondary" @click=${() => { this.showValidation = !this.showValidation; }}>${this.showValidation ? '收起' : '展开'}</sp-button>
        </div>
        ${this.showValidation ? (issues.length ? issues.map((issue) => html`
          <div class="issue ${issue.level}"><strong>${issue.target}</strong>${issue.message}</div>
        `) : html`<div class="issue info"><strong>可以保存正式版本</strong>待核对项、失效引用与迁移提案均已处理完。</div>`) : nothing}
      </section>
    `;
  }

  private get filteredComponents(): ComponentSpec[] {
    const query = this.query.trim().toLowerCase();
    if (!query) return this.store.state.components;
    return this.store.state.components.filter((component) => JSON.stringify(component).toLowerCase().includes(query));
  }

  private componentName(id: string): string {
    return this.store.state.components.find((item) => item.id === id)?.name ?? id;
  }

  private statusLabel(status: ComponentSpec['status']): string {
    return { draft: '草稿', review: '待审', published: '已发布' }[status];
  }

  private copyExample(example: ComponentExample) {
    if (example.stale || example.needsReview) {
      this.flash('引用仍失效或待核对，处理完才能复制，避免发布后报错');
      this.tab = 'examples';
      return;
    }
    void this.copy(example.code);
  }

  private async copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      this.flash('代码已复制');
    } catch {
      this.flash('复制失败，请手动选择代码');
    }
  }

  private flash(message: string) {
    this.toast = message;
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toast = ''; }, 3200);
  }
}

customElements.define('spec-a11y-workbench', SpecA11yWorkbench);
