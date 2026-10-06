// Page DOM reading for the page agent: element visibility, whitespace-normalized text, Select2 widgets, field labels and choice questions, and validation messages.
(function installPageDom(root) {
  'use strict';

  /**
   * deps:
   * - engine: the form engine, for normalizing rendered Select2 text.
   */
  function create(deps) {
    const { engine } = deps;

    function visible(element) {
      if (!element || element.type === 'hidden') return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    }

    function cleanText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function select2Container(element) {
      if (element?.tagName !== 'SELECT') return null;
      const sibling = element.nextElementSibling;
      if (sibling?.matches?.('.select2, .select2-container')) return sibling;
      const parent = element.parentElement;
      if (!parent?.querySelector) return null;
      try {
        return parent.querySelector('.select2-container');
      } catch {
        return null;
      }
    }

    function fieldVisible(element) {
      if (visible(element)) return true;
      const container = select2Container(element);
      return Boolean(container && visible(container));
    }

    function select2SelectionMatches(element) {
      const container = select2Container(element);
      if (!container) return true;
      const rendered = cleanText(container.querySelector?.('.select2-selection__rendered')?.textContent);
      const selected = [...(element.options || [])].find((option) => String(option.value) === String(element.value));
      return Boolean(rendered && selected && engine.normalize(rendered) === engine.normalize(cleanText(selected.textContent)));
    }

    function associatedLabel(element) {
      if (element.id) {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label) return label;
      }
      return null;
    }

    function explicitLabel(element) {
      const associated = associatedLabel(element);
      if (associated) return cleanText(associated.textContent);
      const wrapped = element.closest('label');
      if (wrapped) return cleanText(wrapped.textContent);
      return '';
    }

    function labelledByText(element) {
      const ids = cleanText(element.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
      return cleanText(ids.map((id) => document.getElementById(id)?.textContent || '').join(' '));
    }

    function questionText(element, optionLabel) {
      const group = element.closest('fieldset, [role="radiogroup"], [role="group"]');
      if (group) {
        const heading = group.querySelector(':scope > legend, :scope > [role="heading"], :scope > .question, :scope > .form-label, :scope > label');
        const text = cleanText(heading?.textContent);
        if (text && text !== optionLabel) return text;
      }

      let parent = element.parentElement;
      for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
        const heading = parent.querySelector(':scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > .question, :scope > .form-label');
        const text = cleanText(heading?.textContent);
        if (text && text !== optionLabel && text.length < 240) return text;
      }
      return '';
    }

    function labelFor(element) {
      const explicit = explicitLabel(element);
      const aria = cleanText(element.getAttribute('aria-label'));
      const by = labelledByText(element);
      const placeholder = cleanText(element.getAttribute('placeholder'));
      return explicit || aria || by || placeholder || cleanText(element.name) || cleanText(element.id) || 'Unlabeled field';
    }

    function validationProblem(element) {
      if (!element) return '';
      if (element.getAttribute?.('aria-invalid') === 'true') return 'The form marked this value invalid.';
      if (typeof element.checkValidity === 'function' && !element.checkValidity()) {
        return cleanText(element.validationMessage) || 'The value does not satisfy the form’s validation rules.';
      }
      const describedBy = String(element.getAttribute?.('aria-describedby') || '').split(/\s+/).filter(Boolean);
      const describedError = describedBy
        .map((id) => document.getElementById(id))
        .filter((node) => {
          if (!node || !visible(node)) return false;
          const signal = `${node.getAttribute?.('role') || ''} ${node.getAttribute?.('aria-live') || ''} ${node.id || ''} ${node.className || ''}`;
          return /\b(alert|assertive|error|invalid|validation|feedback|danger)\b/i.test(signal);
        })
        .map((node) => cleanText(node.textContent))
        .find(Boolean);
      return describedError || '';
    }

    return {
      visible,
      cleanText,
      fieldVisible,
      select2SelectionMatches,
      associatedLabel,
      explicitLabel,
      labelledByText,
      questionText,
      labelFor,
      validationProblem,
    };
  }

  const api = { create };
  root.NavaPageDom = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
