import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { diffAgainstSnapshot } from './diff';
import { SpecStore } from './store';
import { STATUS_LABEL, isUnresolved, describeChange, describeOrigin, type DependencyRef } from './ledger';
import type { ComponentExample, ComponentSpec, PreviewDensity, PreviewTheme, PropertySpec, ValidationIssue } from './types';

type EditorTab = 'overview' | 'api' | 'accessibility' | 'examples' | 'history';

export class SpecA11yWorkbench extends LitElement {
  static properties = {
    query: { state: true },
    tab: { state: true },
    previewTheme: { state: true },
    previewDensity: { state: true },
    toast: { state: true },
    showValidation: { state: true }
  };

  private store = new SpecStore();
  private query = '';
  private tab: EditorTab = 'overview';
  private previewTheme: PreviewTheme = 'light';
  private previewDensity: PreviewDensity = 'regular';
  private toast = '';
  private showValidation = true;
  private toastTimer?: number;
  /** 属性改名草稿（属性 id -> 输入值）；失焦/回车时才提交改名，避免逐字符记录 */
  private renameDrafts = new Map<string, string>();
  /** 正在确认移除的属性 id（展示接替属性选择） */
  private removingPropertyId = '';
  private removingSuccessor = '';
  /** 新增组合依赖的草稿 */
  private composeTarget = new Map<string, string>();

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
    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 7px; font-size: 10px; font-weight: 700; background: var(--spectrum-gray-300); }
    .pill.published { background: var(--spectrum-green-300); }
    .pill.review { background: var(--spectrum-orange-300); }
    .main { min-width: 0; padding: 22px; }
    .title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 15px; margin-bottom: 16px; }
    .title-row h2 { font-size: 28px; margin: 0; letter-spacing: -.035em; }
    .title-row p { margin: 6px 0 0; color: var(--spectrum-gray-700); }
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
    .property-head, .example-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
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
    .issue button { border: 0; background: transparent; color: var(--spectrum-blue-800); padding: 0; cursor: pointer; text-decoration: underline; }
    .diff { display: grid; gap: 7px; margin-top: 9px; }
    .diff-row { border: 1px solid var(--spectrum-gray-300); border-radius: 8px; padding: 9px; font-size: 11px; }
    .diff-row b { display: block; margin-bottom: 4px; text-transform: capitalize; }
    .before { color: var(--spectrum-red-800); white-space: pre-wrap; }
    .after { color: var(--spectrum-green-900); white-space: pre-wrap; }
    pre { white-space: pre-wrap; word-break: break-word; background: #202020; color: #f5f5f5; padding: 12px; border-radius: 8px; font-size: 12px; }
    .search-empty { padding: 20px 8px; color: var(--spectrum-gray-700); font-size: 13px; }
    .footer-hint { position: fixed; bottom: 10px; left: 50%; transform: translateX(-50%); z-index: 30; background: #202020; color: white; border-radius: 999px; padding: 6px 12px; font-size: 11px; opacity: .9; }
    sp-toast { position: fixed; right: 18px; bottom: 18px; z-index: 50; }
    .pending-count { color: var(--spectrum-red-700); font-weight: 700; }
    .ref-list { display: grid; gap: 8px; margin: 10px 0; }
    .ref-chip { border: 1px solid var(--spectrum-gray-300); border-radius: 10px; padding: 10px 12px; background: var(--spectrum-gray-100); display: grid; gap: 6px; }
    .ref-chip.unresolved { border-color: var(--spectrum-orange-600); background: var(--spectrum-orange-200); }
    .ref-chip-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
    .ref-chip-head strong { flex: 1; min-width: 160px; }
    .ref-pin { color: var(--spectrum-gray-700); font-size: 11px; }
    .ref-reason { font-size: 12px; color: var(--spectrum-gray-900); }
    .ref-actions { flex-wrap: wrap; }
    .ref-detail { font-size: 11px; color: var(--spectrum-gray-700); }
    .ref-provenance { font-size: 11px; color: var(--spectrum-gray-700); }
    .ref-provenance ul { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 3px; }
    .ledger-section { display: grid; gap: 8px; margin: 8px 0 16px; }
    .ledger-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .ledger-subhead { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--spectrum-gray-700); margin: 6px 0; }
    .ledger-row { border: 1px solid var(--spectrum-gray-300); border-radius: 8px; padding: 9px 10px; margin-bottom: 8px; display: grid; gap: 3px; background: var(--spectrum-gray-75, var(--spectrum-gray-100)); }
    .ledger-meta { font-size: 11px; color: var(--spectrum-gray-700); }
    .ledger-detail { font-size: 11px; color: var(--spectrum-gray-800); white-space: pre-wrap; }
    .blocker-list { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 3px; }
    @media (max-width: 1180px) {
      .layout { grid-template-columns: 230px minmax(0, 1fr); }
      .inspector { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--spectrum-gray-300); grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .ledger-grid { grid-template-columns: 1fr; }
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
      const result = this.store.createSnapshot('键盘保存');
      if (result.ok) this.flash('正式版本已保存');
      else this.flash(result.reason?.split('\n')[0] ?? '待整理项未处理完，不能保存正式版本');
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
              <p>规范、无障碍与示例失效追踪</p>
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
              <sp-button variant="accent" @click=${() => this.saveVersion('工具栏保存')}>保存版本</sp-button>
              <span class="save-state">本地自动保存 · ${selected?.revision ?? 0} 版${this.totalPending() ? html` · ${this.totalPending()} 项待整理` : nothing}</span>
            </div>
          </header>
          <div class="layout">
            <aside class="sidebar" aria-label="组件目录">
              <div class="sidebar-heading">
                <h2>组件目录</h2>
                <sp-action-button size="s" label="新建组件" @click=${() => this.store.addComponent()}>＋</sp-action-button>
              </div>
              <div class="component-list">
                ${filtered.length ? repeat(filtered, (item) => item.id, (item) => html`
                  <button class="component-item" aria-current=${item.id === this.store.state.selectedId ? 'page' : nothing} @click=${() => this.store.select(item.id)}>
                    <span class="item-title">
                      <span>${item.name}</span>
                      <span class="pill ${item.status}">${this.statusLabel(item.status)}</span>
                    </span>
                    <span class="item-meta">${item.category} · ${item.properties.length} 个属性 · ${item.examples.length} 个示例${this.pendingForComponent(item.id) ? html` · <strong class="pending-count">${this.pendingForComponent(item.id)} 项待整理</strong>` : nothing}</span>
                  </button>
                `) : html`<div class="search-empty">没有匹配的组件。可尝试属性名、键盘行为或代码文本。</div>`}
              </div>
            </aside>
            <main class="main">${selected ? this.renderEditor(selected) : html`<div class="empty">新建或选择组件开始编辑。</div>`}</main>
            <aside class="inspector" aria-label="预览与检查">
              ${this.renderPreview(selected)}
              ${this.renderValidation(selectedIssues)}
            </aside>
          </div>
          ${this.toast ? html`<sp-toast open variant="positive" timeout="3000">${this.toast}</sp-toast>` : nothing}
          <div class="footer-hint">⌘/Ctrl+Z 撤销 · ⇧⌘/Ctrl+Z 重做 · ⌘/Ctrl+K 搜索 · Alt+1–5 切换面板</div>
        </div>
      </sp-theme>
    `;
  }

  private renderEditor(component: ComponentSpec): TemplateResult {
    return html`
      <div class="title-row">
        <div>
          <h2>${component.name}</h2>
          <p>${component.purpose}</p>
        </div>
        <div class="actions">
          <select aria-label="组件状态" .value=${component.status} @change=${(event: Event) => this.store.updateComponent({ status: (event.currentTarget as HTMLSelectElement).value as ComponentSpec['status'] })}>
            <option value="draft">草稿</option>
            <option value="review">待审</option>
            <option value="published">已发布</option>
          </select>
          <sp-button variant="secondary" @click=${() => this.store.migrateExamples()}>重算引用</sp-button>
          ${this.hasStaleExamples(component) ? html`<sp-button variant="accent" @click=${() => { this.store.migrateExamples(); this.flash('示例已迁移到当前契约'); }}>迁移示例</sp-button>` : nothing}
          <sp-button variant="accent" ?disabled=${this.store.saveBlockers(component.id).length > 0} @click=${() => this.saveVersion('编辑器保存')}>保存正式版本</sp-button>
        </div>
      </div>
      <div class="tabs" role="tablist" aria-label="编辑区域">
        ${this.renderTab('overview', '1 概述')}
        ${this.renderTab('api', '2 属性与状态')}
        ${this.renderTab('accessibility', '3 无障碍')}
        ${this.renderTab('examples', '4 示例')}
        ${this.renderTab('history', '5 版本')}
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
          <h2>属性契约</h2>
          <sp-button size="s" variant="secondary" @click=${() => this.store.addProperty()}>新增属性</sp-button>
        </div>
        <div class="property-list">
          ${component.properties.length ? repeat(component.properties, (item) => item.id, (property) => this.renderProperty(component, property)) : html`<div class="empty">尚未定义属性。</div>`}
        </div>
        <div class="form-grid" style="margin-top: 18px">
          <label class="field full"><span>状态说明</span><textarea .value=${component.states} @change=${(event: Event) => this.store.updateComponent({ states: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
          <label class="field full"><span>交互签名（修改后会标记关联示例失效）</span><textarea .value=${component.interactionSignature} @change=${(event: Event) => this.store.updateComponent({ interactionSignature: (event.currentTarget as HTMLTextAreaElement).value }, true)}></textarea></label>
        </div>
      </section>
    `;
  }

  private renderProperty(component: ComponentSpec, property: PropertySpec): TemplateResult {
    const removing = this.removingPropertyId === property.id;
    return html`
      <article class="property-card">
        <div class="property-head">
          <strong>${property.name || '未命名属性'}</strong>
          ${removing
            ? html`
              <div class="inline">
                <select aria-label="接替属性" .value=${this.removingSuccessor} @change=${(event: Event) => { this.removingSuccessor = (event.currentTarget as HTMLSelectElement).value; }}>
                  <option value="">无接替（引用只能删除）</option>
                  ${component.properties.filter((item) => item.id !== property.id).map((item) => html`<option value=${item.name}>由 ${item.name} 接替</option>`)}
                </select>
                <sp-button size="s" variant="accent" @click=${() => { this.store.removeProperty(property.id, this.removingSuccessor || null); this.cancelRemove(); this.flash(`属性 ${property.name} 已移除，引用已沿链重算`); }}>确认移除</sp-button>
                <sp-action-button size="s" label="取消移除" @click=${this.cancelRemove}>取消</sp-action-button>
              </div>`
            : html`<sp-action-button size="s" label="删除属性" @click=${() => this.startRemove(property.id)}>删除</sp-action-button>`}
        </div>
        <div class="form-grid">
          <label class="field"><span>名称（改名会记录到依赖账本并沿引用链失效重算）</span><input type="text" .value=${this.renameDrafts.get(property.id) ?? property.name} @input=${(event: Event) => { this.renameDrafts.set(property.id, (event.currentTarget as HTMLInputElement).value); }} @change=${() => this.commitRename(property.id)} @keydown=${(event: KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); (event.currentTarget as HTMLInputElement).blur(); } }} /></label>
          <label class="field"><span>类型</span><input type="text" .value=${property.type} @change=${(event: Event) => this.store.updateProperty(property.id, { type: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="field"><span>默认值</span><input type="text" .value=${property.defaultValue} @change=${(event: Event) => this.store.updateProperty(property.id, { defaultValue: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="inline"><input type="checkbox" .checked=${property.required} @change=${(event: Event) => this.store.updateProperty(property.id, { required: (event.currentTarget as HTMLInputElement).checked })} /> 必填属性</label>
          <label class="field full"><span>属性说明</span><textarea .value=${property.description} @change=${(event: Event) => this.store.updateProperty(property.id, { description: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
        </div>
      </article>
    `;
  }

  private renderAccessibility(component: ComponentSpec): TemplateResult {
    return html`
      <section class="panel">
        <div class="form-grid">
          <label class="field full"><span>键盘行为（变化会提升契约版本，并沿引用链使组合示例与读屏说明失效）</span><textarea .value=${component.keyboardBehavior} @change=${(event: Event) => this.store.updateKeyboardBehavior((event.currentTarget as HTMLTextAreaElement).value)}></textarea></label>
          <label class="field full"><span>读屏说明（文本中出现的关联组件属性名会自动登记为引用，改名后失效重算）</span><textarea .value=${component.screenReader} @change=${(event: Event) => this.store.updateComponent({ screenReader: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
          <label class="field full"><span>禁用场景</span><textarea .value=${component.disabledScenarios} @change=${(event: Event) => this.store.updateComponent({ disabledScenarios: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
        </div>
        ${(() => {
          const srRefs = this.store.state.ledger?.refs.filter((ref) => ref.ownerComponentId === component.id && ref.scope === 'screenReader') ?? [];
          return srRefs.length ? html`<h3>读屏说明中的关联引用（${srRefs.length}）</h3><div class="ref-list">${srRefs.map((ref) => this.renderRefChip(ref))}</div>` : nothing;
        })()}
      </section>
    `;
  }

  private renderExamples(component: ComponentSpec): TemplateResult {
    return html`
      <section class="panel">
        <div class="property-head">
          <h2>关联示例</h2>
          <sp-button size="s" variant="secondary" @click=${() => this.store.addExample()}>新增示例</sp-button>
        </div>
        <div class="example-list">
          ${component.examples.length ? repeat(component.examples, (item) => item.id, (example) => this.renderExample(component, example)) : html`<div class="empty">尚无示例。新增后会追踪属性依赖和版本契约。</div>`}
        </div>
      </section>
    `;
  }

  private renderExample(component: ComponentSpec, example: ComponentExample): TemplateResult {
    const refs = this.refsFor(component.id, example.id);
    const blocked = refs.some((ref) => isUnresolved(ref));
    return html`
      <article class="example-card">
        <div class="example-head">
          <strong>${example.title}</strong>
          <span class="pill ${example.stale || blocked ? 'review' : 'published'}">${blocked ? '引用失效·禁复制' : example.stale ? '需要迁移' : `r${example.createdFromRevision}`}</span>
          <sp-action-button size="s" label="复制代码" ?disabled=${example.stale || blocked} @click=${() => this.copy(example.code)}>复制</sp-action-button>
          <sp-action-button size="s" label="删除示例" @click=${() => this.store.removeExample(example.id)}>删除</sp-action-button>
        </div>
        ${example.stale ? html`<div class="issue warning"><strong>关联失效</strong>${example.staleReason}</div>` : nothing}
        ${blocked ? html`<div class="issue error"><strong>不能复制：引用链上有未处理的旧属性名/键盘契约</strong>在下方依赖区选定迁移或核对通过后才会解锁，避免发布出去的代码报错。</div>` : nothing}
        ${refs.length ? html`<div class="ref-list">${refs.map((ref) => this.renderRefChip(ref))}</div>` : nothing}
        <div class="form-grid">
          <label class="field full"><span>标题</span><input type="text" .value=${example.title} @change=${(event: Event) => this.store.updateExample(example.id, { title: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="field full"><span>代码</span><textarea .value=${example.code} @change=${(event: Event) => this.store.updateExample(example.id, { code: (event.currentTarget as HTMLTextAreaElement).value })}></textarea></label>
          <div class="field full">
            <span>依赖属性（本组件）</span>
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
          ${this.renderCompositionPicker(component, example)}
          <div class="field full"><pre>${example.code}</pre></div>
        </div>
      </article>
    `;
  }

  /** 手动登记组合依赖：选择基础组件 + 属性 / 键盘契约 */
  private renderCompositionPicker(component: ComponentSpec, example: ComponentExample): TemplateResult {
    const others = this.store.state.components.filter((item) => item.id !== component.id && item.tagName);
    const targetId = this.composeTarget.get(example.id) ?? others[0]?.id ?? '';
    const target = this.store.state.components.find((item) => item.id === targetId);
    return html`
      <div class="field full">
        <span>组合依赖（基础组件，保存进依赖账本）</span>
        <div class="inline" style="flex-wrap: wrap">
          <select aria-label="基础组件" .value=${targetId} @change=${(event: Event) => { this.composeTarget.set(example.id, (event.currentTarget as HTMLSelectElement).value); this.requestUpdate(); }}>
            ${others.map((item) => html`<option value=${item.id}>${item.name}（${item.tagName}）</option>`)}
          </select>
          <sp-button size="s" variant="secondary" ?disabled=${!target} @click=${() => { if (target) { this.store.addCompositionRef(example.id, target.id, 'keyboard', '__keyboard__'); this.flash('已登记键盘契约依赖'); } }}>登记键盘契约</sp-button>
          ${target?.properties.map((property) => html`
            <sp-button size="s" variant="secondary" @click=${() => { this.store.addCompositionRef(example.id, target.id, 'property', property.name); this.flash(`已登记对 ${property.name} 的依赖`); }}>${property.name}</sp-button>
          `)}
        </div>
      </div>
    `;
  }

  private renderRefChip(ref: DependencyRef): TemplateResult {
    const target = this.store.state.components.find((component) => component.id === ref.targetComponentId);
    const token = ref.kind === 'keyboard' ? '键盘契约' : (ref.resolvedName === null ? `${ref.oldName}（已删引用）` : (ref.resolvedName ?? ref.oldName));
    const unresolved = isUnresolved(ref);
    return html`
      <div class="ref-chip ${unresolved ? 'unresolved' : ''}">
        <div class="ref-chip-head">
          <strong>${target?.name ?? ref.targetComponentId} · ${token}</strong>
          <span class="pill ${unresolved ? 'review' : 'published'}">${STATUS_LABEL[ref.status]}</span>
          <span class="ref-pin">钉住 r${ref.pinnedRevision} / 当前 r${target?.revision ?? '?'}</span>
          <sp-action-button size="s" label="移除引用记录" @click=${() => { this.store.removeLedgerRef(ref.id); this.flash('引用记录已移除'); }}>×</sp-action-button>
        </div>
        ${ref.pendingReason ? html`<div class="ref-reason">${ref.pendingReason}</div>` : nothing}
        ${ref.candidates.length ? html`
          <div class="inline ref-actions">
            ${ref.candidates.map((candidate) => html`
              <sp-button size="s" variant="accent" @click=${() => {
                const result = this.store.chooseRefCandidate(ref.id, candidate.id);
                if (result.ok) this.flash('已按选定方案迁移正式内容');
                else this.flash(result.reason ?? '候选已失效');
              }}>${candidate.label}</sp-button>
            `)}
          </div>
          <div class="ref-detail">${ref.candidates.map((candidate) => candidate.detail).join(' / ')}</div>
        ` : nothing}
        ${ref.status === 'unverified' || ref.status === 'pendingVerify' ? html`
          <div class="inline ref-actions"><sp-button size="s" variant="accent" @click=${() => { const result = this.store.verifyRef(ref.id); this.flash(result.ok ? '已核对，正在按改名记录重算' : (result.reason ?? '无需核对')); }}>核对通过并按映射重算</sp-button></div>
        ` : nothing}
        ${ref.provenance.length ? html`<details class="ref-provenance"><summary>迁移与核对来源（${ref.provenance.length}）</summary><ul>${ref.provenance.map((line) => html`<li>${line}</li>`)}</ul></details>` : nothing}
      </div>
    `;
  }

  private renderHistory(component: ComponentSpec): TemplateResult {
    const snapshot = component.snapshots[0];
    const rows = diffAgainstSnapshot(component, snapshot);
    const ledger = this.store.state.ledger;
    const pendingRefs = this.pendingRefs(component.id);
    const blockers = this.store.saveBlockers(component.id);
    const componentChanges = ledger?.changes.filter((change) => change.componentId === component.id) ?? [];
    return html`
      <section class="panel">
        <div class="property-head">
          <h2>依赖账本与正式版本</h2>
          <div class="inline">
            <sp-button size="s" variant="secondary" @click=${() => { this.store.migrateExamples(); this.flash('已沿引用链重新计算'); }}>重新检查引用</sp-button>
            <sp-button size="s" variant="accent" ?disabled=${blockers.length > 0} @click=${() => this.saveVersion('历史面板保存')}>保存正式版本</sp-button>
          </div>
        </div>
        <p>当前契约 r${component.revision}。最近快照：${snapshot ? `r${snapshot.revision} · ${new Date(snapshot.savedAt).toLocaleString('zh-CN')}` : '暂无'}。待整理项未处理完不能保存正式版本。</p>

        ${blockers.length ? html`
          <div class="issue error"><strong>保存被阻塞（${blockers.length} 项）</strong><ul class="blocker-list">${blockers.map((item) => html`<li>${item}</li>`)}</ul></div>
        ` : html`<div class="issue info"><strong>可以保存正式版本</strong>待整理项、失效示例与检查错误均已清零。</div>`}

        <h3>待整理（${pendingRefs.length}）</h3>
        ${pendingRefs.length
          ? html`<div class="ledger-section">${repeat(pendingRefs, (ref) => ref.id, (ref) => this.renderRefChip(ref))}</div>`
          : html`<div class="issue info">该组件的读屏说明与组合示例没有待核对、待选定或不兼容的引用。</div>`}

        <h3>改动来源与引用关系</h3>
        ${ledger ? html`
          <div class="ledger-grid">
            <div>
              <div class="ledger-subhead">本组件契约改动（${componentChanges.length}）</div>
              ${componentChanges.length ? componentChanges.map((change) => html`
                <div class="ledger-row">
                  <strong>${describeChange(change, component.name)}</strong>
                  <span class="ledger-meta">r${change.revision} · ${new Date(change.at).toLocaleString('zh-CN')} · ${describeOrigin(change)}</span>
                  ${change.type === 'keyboard' ? html`<span class="ledger-detail">「${change.oldKeyboard}」→「${change.newKeyboard}」</span>` : nothing}
                </div>
              `) : html`<div class="empty">尚无契约改动。属性改名、移除或键盘行为变化会在此留痕。</div>`}
            </div>
            <div>
              <div class="ledger-subhead">本组件的全部引用（${this.allRefs(component.id).length}）</div>
              ${this.allRefs(component.id).length ? html`<div class="ledger-section">${this.allRefs(component.id).map((ref) => this.renderRefChip(ref))}</div>` : html`<div class="empty">组合示例代码与读屏说明中暂未发现跨组件引用。</div>`}
            </div>
          </div>
        ` : html`<div class="empty">依赖账本缺失，请刷新以重新规整旧数据。</div>`}

        <h3>与最近快照的差异</h3>
        ${snapshot
          ? (rows.length ? html`<div class="diff">${rows.map((row) => html`<div class="diff-row"><b>${row.field}</b><span class="before">- ${row.before || '（空）'}</span><br /><span class="after">+ ${row.after || '（空）'}</span></div>`)}</div>` : html`<div class="issue info">当前内容与最近快照一致。</div>`)
          : html`<div class="empty">保存一次正式版本后即可比较字段、属性和示例变化。</div>`}
      </section>
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
          <h2>规范检查</h2>
          <sp-button size="s" variant="secondary" @click=${() => { this.showValidation = !this.showValidation; }}>${this.showValidation ? '收起' : '展开'}</sp-button>
        </div>
        ${this.showValidation ? (issues.length ? issues.map((issue) => html`
          <div class="issue ${issue.level}"><strong>${issue.target}</strong>${issue.message}</div>
        `) : html`<div class="issue info"><strong>当前组件通过检查</strong>没有发现属性、示例或无障碍说明问题。</div>`) : nothing}
      </section>
    `;
  }

  private get filteredComponents(): ComponentSpec[] {
    const query = this.query.trim().toLowerCase();
    if (!query) return this.store.state.components;
    return this.store.state.components.filter((component) => JSON.stringify(component).toLowerCase().includes(query));
  }

  private hasStaleExamples(component: ComponentSpec): boolean {
    return component.examples.some((example) => example.stale);
  }

  private saveVersion(reason: string) {
    const result = this.store.createSnapshot(reason);
    if (result.ok) this.flash('正式版本已保存');
    else this.flash(result.reason?.split('\n')[0] ?? '待整理项未处理完，不能保存正式版本');
  }

  private commitRename(propertyId: string) {
    const draft = this.renameDrafts.get(propertyId);
    this.renameDrafts.delete(propertyId);
    if (draft === undefined) return;
    const current = this.store.selected?.properties.find((property) => property.id === propertyId)?.name;
    if (current === undefined || draft.trim() === current) return;
    const result = this.store.renameProperty(propertyId, draft);
    if (!result.ok && result.reason) this.flash(result.reason);
    else if (result.ok) this.flash('改名已记入依赖账本，引用已沿链重算');
  }

  private startRemove(propertyId: string) {
    this.removingPropertyId = propertyId;
    this.removingSuccessor = '';
    this.requestUpdate();
  }

  private cancelRemove = () => {
    this.removingPropertyId = '';
    this.removingSuccessor = '';
  };

  private refsFor(ownerId: string, exampleId: string): DependencyRef[] {
    return this.store.state.ledger?.refs.filter((ref) => ref.ownerComponentId === ownerId && ref.scope === 'code' && ref.exampleId === exampleId) ?? [];
  }

  private allRefs(ownerId: string): DependencyRef[] {
    return this.store.state.ledger?.refs.filter((ref) => ref.ownerComponentId === ownerId) ?? [];
  }

  private pendingRefs(ownerId: string): DependencyRef[] {
    return this.allRefs(ownerId).filter((ref) => isUnresolved(ref));
  }

  private pendingForComponent(componentId: string): number {
    return new Set([
      ...this.store.state.ledger?.refs.filter((ref) => isUnresolved(ref) && (ref.ownerComponentId === componentId || ref.targetComponentId === componentId)).map((ref) => ref.id) ?? []
    ]).size;
  }

  private totalPending(): number {
    return new Set(this.store.state.ledger?.refs.filter((ref) => isUnresolved(ref)).map((ref) => ref.id) ?? []).size;
  }

  private statusLabel(status: ComponentSpec['status']): string {
    return { draft: '草稿', review: '待审', published: '已发布' }[status];
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
    this.toastTimer = window.setTimeout(() => { this.toast = ''; }, 3000);
  }
}

customElements.define('spec-a11y-workbench', SpecA11yWorkbench);
