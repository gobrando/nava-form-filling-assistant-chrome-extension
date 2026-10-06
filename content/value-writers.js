// Value writers for the page agent: native-setter writes with input and change events, a keystroke retry for masked text, choice and option matching, settled readback verification, page-level revalidation, and masking of sensitive values for provenance.
(function installPageValueWriters(root) {
  'use strict';

  const CHECKED_ANSWER_PATTERN = /^(yes|true|1|on)$/i;
  const NO_MATCHING_CHOICE = 'The answer does not match one of the choices on the form.';

  /**
   * deps:
   * - engine: the form engine (normalize, valuesEquivalent).
   * - dom: the page DOM helpers (fieldVisible, select2SelectionMatches, labelFor, validationProblem).
   * - rawCurrentValue(element): the field inventory's reading of a control's current value.
   * - fieldMap, groupMap: the agent-owned maps from the latest scan, read to find each assignment's control.
   * - presentationMode(), nextAnimationFrame(), delay(ms): the agent's demo-mode flag and timing primitives.
   * - settleTiming: the agent's per-field settle constants (PRODUCTION_SETTLE_MS, PRESENTATION_FIELD_MS, DOM_QUIET_MS, MAX_SETTLE_MS).
   */
  function create(deps) {
    const { engine, dom, rawCurrentValue, fieldMap, groupMap, presentationMode, nextAnimationFrame, delay, settleTiming } = deps;
    const { fieldVisible, select2SelectionMatches, labelFor, validationProblem } = dom;
    const { PRODUCTION_SETTLE_MS, PRESENTATION_FIELD_MS, DOM_QUIET_MS, MAX_SETTLE_MS } = settleTiming;

    async function waitForStableRead(element, readValue) {
      await nextAnimationFrame();
      await nextAnimationFrame();
      const startedAt = Date.now();
      let lastChangedAt = startedAt;
      let lastDomChangeAt = startedAt;
      let observed = String(readValue() ?? '');
      const minimumWait = presentationMode() ? PRESENTATION_FIELD_MS : PRODUCTION_SETTLE_MS;
      const observer = typeof MutationObserver === 'function' && document.documentElement
        ? new MutationObserver(() => { lastDomChangeAt = Date.now(); })
        : null;
      try {
        observer?.observe(element.closest?.('form') || document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['aria-invalid', 'aria-describedby', 'class', 'hidden'],
        });
        while (Date.now() - startedAt < MAX_SETTLE_MS) {
          await delay(80);
          const next = String(readValue() ?? '');
          if (next !== observed) {
            observed = next;
            lastChangedAt = Date.now();
          }
          const elapsed = Date.now() - startedAt;
          const valueQuiet = Date.now() - lastChangedAt >= DOM_QUIET_MS;
          const domQuiet = Date.now() - lastDomChangeAt >= DOM_QUIET_MS;
          if (elapsed >= minimumWait && valueQuiet && domQuiet) {
            return { value: observed, settled: true, problem: validationProblem(element) };
          }
        }
        return { value: observed, settled: false, problem: validationProblem(element) || 'The page did not finish validating this value.' };
      } finally {
        observer?.disconnect();
      }
    }

    function nativeValueSetter(element) {
      const prototype = element.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : element.tagName === 'SELECT'
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      return Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    }

    function dispatchValueEvents(element) {
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }

    function setTextValue(element, value) {
      const setter = nativeValueSetter(element);
      if (setter) setter.call(element, value);
      else element.value = value;
      dispatchValueEvents(element);
    }

    async function incrementalWrite(element, value) {
      const pattern = String(element.getAttribute?.('pattern') || '');
      const patternRequiresFormatting = /\\[()s-]|[() ]|\}\s*-\s*/.test(pattern);
      const digitsOnly = /date|tel|phone|ssn|social security/i.test(`${element.type} ${labelFor(element)} ${element.id}`)
        && !patternRequiresFormatting;
      const characters = [...(digitsOnly ? String(value).replace(/\D/g, '') : String(value))];
      element.focus();
      setTextValue(element, '');
      for (const character of characters) {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: character, bubbles: true, composed: true }));
        element.dispatchEvent(new InputEvent('beforeinput', { data: character, inputType: 'insertText', bubbles: true, composed: true }));
        const start = Number.isFinite(element.selectionStart) ? element.selectionStart : element.value.length;
        if (typeof element.setRangeText === 'function') {
          element.setRangeText(character, start, element.selectionEnd ?? start, 'end');
        } else {
          setTextValue(element, `${element.value}${character}`);
        }
        element.dispatchEvent(new InputEvent('input', { data: character, inputType: 'insertText', bubbles: true, composed: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { key: character, bubbles: true, composed: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      element.blur();
    }

    function optionMatch(optionLabel, optionValue, wanted) {
      const normalizedTarget = engine.normalize(wanted);
      const target = ['false', '0'].includes(normalizedTarget)
        ? 'no'
        : ['true', '1'].includes(normalizedTarget)
          ? 'yes'
          : normalizedTarget;
      const label = engine.normalize(optionLabel);
      const value = engine.normalize(optionValue);
      if (!target) return false;
      if (target === label || target === value) return true;
      if (target === 'yes') return /^(yes|y|true|1)$/.test(label) || /^(yes|y|true|1)$/.test(value);
      if (target === 'no') return /^(no|n|false|0)$/.test(label) || /^(no|n|false|0)$/.test(value);
      return Boolean(label)
        && (` ${label} `.includes(` ${target} `) || ` ${target} `.includes(` ${label} `));
    }

    function setChecked(element, checked) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
      if (setter) setter.call(element, checked);
      else element.checked = checked;
      dispatchValueEvents(element);
    }

    function checkboxAnswer(value) {
      return CHECKED_ANSWER_PATTERN.test(String(value));
    }

    // The scanned control an assignment targets: the matching member of a choice
    // group, or the single field registered under the assignment's key.
    function assignmentTarget(fieldKey, value) {
      const grouped = groupMap.get(fieldKey);
      const entry = grouped?.find(({ optionLabel, optionValue }) => optionMatch(optionLabel, optionValue, value));
      return { grouped, entry, element: entry?.element || fieldMap.get(fieldKey) };
    }

    function writeBlocker(element, value) {
      if (!element) return 'The field changed after the page scan. Scan the page again.';
      if (!fieldVisible(element)) return 'The field is hidden by an earlier question.';
      if (element.disabled) return 'The field is disabled by an earlier question.';
      if (Number(element.maxLength) > 0 && String(value).length > element.maxLength) {
        return `The value is longer than the form allows (${element.maxLength} characters).`;
      }
      return '';
    }

    function captureOutline(element) {
      const { outline, outlineOffset } = element.style;
      return () => {
        element.style.outline = outline;
        element.style.outlineOffset = outlineOffset;
      };
    }

    async function spotlight(element) {
      element.scrollIntoView({ block: 'center', behavior: 'auto' });
      element.style.outline = '3px solid #b14092';
      element.style.outlineOffset = '3px';
      await nextAnimationFrame();
      await nextAnimationFrame();
    }

    // Writer strategies. Each write is synchronous, goes through the native
    // setters and input/change events, and returns a refusal reason or ''.

    // Radio groups and exclusive checkbox groups clear every other member; an
    // inclusive checkbox group only checks the chosen box.
    function writeChoiceGroup({ grouped, entry }) {
      if (!entry) return NO_MATCHING_CHOICE;
      if (entry.element.type === 'radio' || grouped.some((member) => member.exclusive)) {
        grouped.forEach((member) => setChecked(member.element, member.element === entry.element));
      } else {
        setChecked(entry.element, true);
      }
      return '';
    }

    function writeCheckbox({ element }, value) {
      setChecked(element, checkboxAnswer(value));
      return '';
    }

    function writeSelectOption({ element }, value) {
      const option = [...element.options].find((candidate) => optionMatch(candidate.textContent, candidate.value, value));
      if (!option) return NO_MATCHING_CHOICE;
      setTextValue(element, option.value);
      return '';
    }

    function writeNativeValue({ element }, value) {
      setTextValue(element, String(value));
      return '';
    }

    const VALUE_WRITERS = Object.freeze({
      choiceGroup: { write: writeChoiceGroup },
      checkbox: { write: writeCheckbox },
      // Native select (Select2 included): readback also confirms Select2's rendered selection.
      select: { write: writeSelectOption, confirmsRenderedSelection: true },
      // A radio outside any group keeps the native value write and is never typed into.
      plainValue: { write: writeNativeValue },
      // Text that a mask rejects as one value gets one keystroke-by-keystroke retry.
      text: { write: writeNativeValue, retry: incrementalWrite },
    });

    function writerFor({ element, grouped }) {
      if (grouped) return VALUE_WRITERS.choiceGroup;
      if (element.type === 'checkbox') return VALUE_WRITERS.checkbox;
      if (element.tagName === 'SELECT') return VALUE_WRITERS.select;
      return element.type === 'radio' ? VALUE_WRITERS.plainValue : VALUE_WRITERS.text;
    }

    // Readback shared by write verification and page-level revalidation: what a
    // control currently holds (read), what to report (report), and whether it
    // holds the requested answer (holds).
    const READBACKS = Object.freeze({
      group: {
        read: (_element, grouped) => grouped.find((member) => member.element.checked)?.optionValue || '',
        report: (_element, observed) => observed,
        holds: (_element, grouped, wanted) => grouped
          .some((member) => member.element.checked && optionMatch(member.optionLabel, member.optionValue, wanted)),
      },
      checkbox: {
        read: (element) => rawCurrentValue(element),
        report: (element) => (element.checked ? 'yes' : 'no'),
        holds: (element, _grouped, wanted) => element.checked === checkboxAnswer(wanted),
      },
      value: {
        read: (element) => rawCurrentValue(element),
        report: (_element, observed) => observed,
        holds: (element, _grouped, wanted, observed) => engine.valuesEquivalent(wanted, observed, { type: element.type, label: labelFor(element) }),
      },
    });

    function readbackFor(element, grouped) {
      if (grouped) return READBACKS.group;
      return element.type === 'checkbox' ? READBACKS.checkbox : READBACKS.value;
    }

    async function writeAssignment(assignment) {
      const target = assignmentTarget(assignment.fieldKey, assignment.value);
      const unavailable = writeBlocker(target.element, assignment.value);
      if (unavailable) return { ...assignment, status: 'blocked', reason: unavailable };

      const writer = writerFor(target);
      const restoreOutline = captureOutline(target.element);
      if (presentationMode()) await spotlight(target.element);
      const refusal = writer.write(target, assignment.value);
      if (refusal) {
        restoreOutline();
        return { ...assignment, status: 'blocked', reason: refusal };
      }
      if (typeof target.element.blur === 'function') target.element.blur();

      const outcome = await verifyWrite(writer, target, assignment.value);
      if (presentationMode()) restoreOutline();
      return {
        ...assignment,
        status: outcome.verified ? 'verified' : 'blocked',
        actual: outcome.actual,
        reason: outcome.verified ? '' : outcome.problem || 'The form did not keep the value after two verified write methods. Enter this field directly.',
      };
    }

    // Wait for the page to settle, then read the control back.
    async function settledReadBack(writer, { element, grouped }, wanted) {
      const readback = readbackFor(element, grouped);
      const stability = await waitForStableRead(element, () => readback.read(element, grouped));
      const holds = readback.holds(element, grouped, wanted, stability.value)
        && (!writer.confirmsRenderedSelection || select2SelectionMatches(element));
      return {
        verified: holds && stability.settled && !stability.problem,
        actual: readback.report(element, stability.value),
        problem: stability.problem,
      };
    }

    async function verifyWrite(writer, target, wanted) {
      const first = await settledReadBack(writer, target, wanted);
      if (first.verified || !writer.retry) return first;
      await writer.retry(target.element, wanted);
      return settledReadBack(writer, target, wanted);
    }

    function maskValue(value, sensitive) {
      if (!sensitive) return String(value ?? '');
      const text = String(value ?? '');
      const digits = text.replace(/\D/g, '');
      return digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••';
    }

    function revalidationFailure(problem, pageSettled) {
      if (problem) return problem;
      return pageSettled
        ? 'The form changed this value during page validation. Enter it directly.'
        : 'The page did not finish validating all values.';
    }

    // After page-level validation, re-read every verified field once more.
    function revalidateAssignment(result, pageSettled) {
      if (result.status !== 'verified') return result;
      const { grouped, element: matched } = assignmentTarget(result.fieldKey, result.value);
      const element = matched || grouped?.[0]?.element;
      if (!element || !fieldVisible(element) || element.disabled) {
        return { ...result, status: 'blocked', reason: 'The field changed or became unavailable while the page validated.' };
      }
      const readback = readbackFor(element, grouped);
      const observed = readback.read(element, grouped);
      const actual = readback.report(element, observed);
      const holds = readback.holds(element, grouped, result.value, observed)
        && (element.tagName !== 'SELECT' || select2SelectionMatches(element));
      const problem = validationProblem(element);
      if (pageSettled && holds && !problem) return { ...result, actual };
      return { ...result, status: 'blocked', actual, reason: revalidationFailure(problem, pageSettled) };
    }

    return { writeAssignment, revalidateAssignment, maskValue };
  }

  const api = { create };
  root.NavaPageValueWriters = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
