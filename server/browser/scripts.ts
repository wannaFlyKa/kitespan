// The server's fixed scripts (DESIGN-B1 2.7.3): constant function texts, run with Runtime.callFunctionOn in kitespan's
// own isolated world (`kitespan`, made per main frame) or on an object that one of them returned. Values go in as
// call arguments, never into the text, so a value shaped like a script stays data. The page's own world cannot change
// what they see. No other text is ever run in a page: the debugging connection refuses Runtime.callFunctionOn with
// any function text but these (allow.ts).

/** The focused control, returned as a remote object (returnByValue false) and kept under the picker's id. */
export const PROBE_EL = `function () { const el = document.activeElement; return (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) ? el : null; }`;

/** Run on the kept object (this), returned by value; null when no app-drawn picker is needed. */
export const PICKER_FACTS = `function () {
  const el = this;
  if (!el.isConnected) return null;
  const r = el.getBoundingClientRect();
  const box = { x: r.x, y: r.y, w: r.width, h: r.height };
  let open = null; try { open = el.matches(':open'); } catch (e) {}
  const label = ((el.labels && el.labels[0] && el.labels[0].textContent) || el.getAttribute('aria-label') || el.name || '').trim().slice(0, 80);
  if (el instanceof HTMLSelectElement) {
    if (el.multiple || el.size > 1 || el.disabled) return null;
    let look = null; try { look = getComputedStyle(el).appearance; } catch (e) {}
    if (look === 'base-select') return null;
    const items = [];
    for (const child of el.children) {
      if (child instanceof HTMLOptGroupElement) for (const o of child.children) items.push({ group: child.label.slice(0, 200), label: o.label.slice(0, 200), disabled: o.disabled || child.disabled, index: o.index });
      else if (child instanceof HTMLOptionElement) items.push({ group: null, label: child.label.slice(0, 200), disabled: child.disabled, index: child.index });
      if (items.length >= 500) break;
    }
    return { kind: 'select', open, box, label, selected: el.selectedIndex, items };
  }
  if (!(el instanceof HTMLInputElement)) return null;
  const kinds = ['date', 'time', 'datetime-local', 'month', 'week', 'color'];
  if (!kinds.includes(el.type) || el.disabled || el.readOnly) return null;
  const list = el.type === 'color' && el.list ? Array.from(el.list.options).slice(0, 50).map((o) => o.value) : [];
  return { kind: el.type, open, box, label, value: el.value, min: el.min || null, max: el.max || null, step: el.step || null, list };
}`;

/** SET_SELECT_ON (index): on the kept object. */
export const SET_SELECT_ON = `function (index) {
  if (!(this instanceof HTMLSelectElement) || !this.isConnected || this.disabled || !Number.isInteger(index) || index < 0 || index >= this.options.length || this.options[index].disabled) return false;
  this.selectedIndex = index;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return this.selectedIndex === index;
}`;

/** SET_VALUE_ON (kind, value): on the kept object. */
export const SET_VALUE_ON = `function (kind, value) {
  if (!(this instanceof HTMLInputElement) || !this.isConnected || this.type !== kind || typeof value !== 'string') return false;
  this.value = value;
  if (this.value !== value) return false;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

/** SELECTION (max): the page's selected text, never from a password field. */
export const SELECTION = `function (max) {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement && el.type === 'password') return { refused: 'password' };
  if ((el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && typeof el.selectionStart === 'number' && el.selectionEnd > el.selectionStart) return { text: el.value.slice(el.selectionStart, el.selectionEnd).slice(0, max) };
  return { text: String(document.getSelection() ?? '').slice(0, max) };
}`;

/** FOCUS: what the focused field is, never its value. */
export const FOCUS = `function () {
  const el = document.activeElement;
  if (!el || el === document.body) return { editable: false };
  const editable = el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['button','checkbox','radio','submit','reset','file','image','range','color','hidden'].includes(el.type));
  if (!editable) return { editable: false };
  const r = el.getBoundingClientRect();
  return { editable: true, type: el instanceof HTMLInputElement ? el.type : (el instanceof HTMLTextAreaElement ? 'textarea' : 'contenteditable'), inputmode: el.getAttribute('inputmode'), enterkeyhint: el.getAttribute('enterkeyhint'), password: el instanceof HTMLInputElement && el.type === 'password', box: { x: r.x, y: r.y, w: r.width, h: r.height } };
}`;

/** CHOOSER_FACTS: on the file input that DOM.resolveNode gave in kitespan's world. */
export const CHOOSER_FACTS = `function () {
  if (!(this instanceof HTMLInputElement) || this.type !== 'file') return null;
  const accept = String(this.accept || '').split(',').map((s) => s.trim()).filter((s) => /^(\\.[A-Za-z0-9]{1,16}|[a-z]+\\/(\\*|[A-Za-z0-9.+-]{1,64}))$/.test(s)).slice(0, 20);
  const label = ((this.labels && this.labels[0] && this.labels[0].textContent) || this.getAttribute('aria-label') || this.name || '').trim().slice(0, 80);
  return { accept, multiple: this.multiple, label };
}`;

/** CHOOSER_CANCEL: the page sees a cancel, as when a user closes the system's file dialog. */
export const CHOOSER_CANCEL = `function () { if (!(this instanceof HTMLInputElement) || this.type !== 'file' || !this.isConnected) return false; this.dispatchEvent(new Event('cancel', { bubbles: true })); return true; }`;

/** Every fixed script by name: the only function texts that Runtime.callFunctionOn may carry. */
export const FIXED_SCRIPTS = { PROBE_EL, PICKER_FACTS, SET_SELECT_ON, SET_VALUE_ON, SELECTION, FOCUS, CHOOSER_FACTS, CHOOSER_CANCEL } as const;
export type FixedScript = keyof typeof FIXED_SCRIPTS;
export const FIXED_SCRIPT_TEXTS: ReadonlySet<string> = new Set(Object.values(FIXED_SCRIPTS));

/** The isolated world's name. */
export const WORLD_NAME = "kitespan";
