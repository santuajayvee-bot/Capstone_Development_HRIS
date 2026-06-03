/* ============================================================
   Shared date picker UI. Presentation-only wrapper for native
   input[type="date"] controls; original inputs keep their IDs,
   names, values, validation attributes, and change handlers.
   ============================================================ */

(function initLGSVDatePicker() {
  const ENHANCED = 'lgsvDateEnhanced';
  let booted = false;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function toParts(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
  }

  function toValue(year, month, day) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function labelFor(value) {
    const parts = toParts(value);
    if (!parts) return 'Select date';
    return new Date(parts.year, parts.month, parts.day).toLocaleDateString('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
    });
  }

  function fieldText(input) {
    const label = input.closest('label')?.textContent || '';
    return `${input.id || ''} ${input.name || ''} ${input.getAttribute('aria-label') || ''} ${label}`.toLowerCase();
  }

  function isBirthDate(input) {
    return /\b(dob|birth|date_of_birth|birth_date)\b/.test(fieldText(input).replace(/[-_]/g, ' '));
  }

  function yearBounds(input) {
    const currentYear = new Date().getFullYear();
    return { min: 1900, max: isBirthDate(input) ? currentYear : currentYear + 20 };
  }

  function defaultView(input) {
    const selected = toParts(input.value);
    if (selected) return new Date(selected.year, selected.month, selected.day);
    return isBirthDate(input) ? new Date(2005, 0, 1) : new Date();
  }

  function monthOptions(selectedMonth) {
    return Array.from({ length: 12 }, (_, index) => {
      const label = new Date(2000, index, 1).toLocaleDateString('en-US', { month: 'long' });
      return `<option value="${index}" ${index === selectedMonth ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
  }

  function yearOptions(input, selectedYear) {
    const bounds = yearBounds(input);
    let options = '';
    for (let year = bounds.max; year >= bounds.min; year -= 1) {
      options += `<option value="${year}" ${year === selectedYear ? 'selected' : ''}>${year}</option>`;
    }
    return options;
  }

  function closeDatePickers(except = null) {
    document.querySelectorAll('.lgsv-date-field.open').forEach(field => {
      if (field !== except) field.classList.remove('open');
    });
  }

  function syncField(field) {
    const input = field.querySelector('input[type="date"]');
    const value = field.querySelector('.lgsv-date-value');
    if (!input || !value) return;
    value.textContent = labelFor(input.value);
    value.classList.toggle('is-empty', !input.value);
    field.dataset.lastValue = input.value || '';
  }

  function renderPicker(field, year, month) {
    const input = field.querySelector('input[type="date"]');
    const panel = field.querySelector('.lgsv-date-panel');
    if (!input || !panel) return;

    const bounds = yearBounds(input);
    const viewDate = new Date(year, month, 1);
    year = Math.min(Math.max(viewDate.getFullYear(), bounds.min), bounds.max);
    month = year === viewDate.getFullYear() ? viewDate.getMonth() : (year === bounds.min ? 0 : 11);

    const selected = toParts(input.value);
    const today = new Date();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const previousDays = new Date(year, month, 0).getDate();
    let cells = '';

    for (let index = 0; index < 42; index += 1) {
      const dayOffset = index - firstDay + 1;
      const inMonth = dayOffset >= 1 && dayOffset <= daysInMonth;
      const cellDay = inMonth ? dayOffset : (dayOffset < 1 ? previousDays + dayOffset : dayOffset - daysInMonth);
      const cellMonth = inMonth ? month : (dayOffset < 1 ? month - 1 : month + 1);
      const cellDate = new Date(year, cellMonth, cellDay);
      const cellYear = cellDate.getFullYear();
      const canPick = cellYear >= bounds.min && cellYear <= bounds.max;
      const value = toValue(cellYear, cellDate.getMonth(), cellDate.getDate());
      const isSelected = selected && selected.year === cellYear && selected.month === cellDate.getMonth() && selected.day === cellDate.getDate();
      const isToday = today.getFullYear() === cellYear && today.getMonth() === cellDate.getMonth() && today.getDate() === cellDate.getDate();
      cells += `<button class="lgsv-date-day ${inMonth ? '' : 'is-outside'} ${isSelected ? 'is-selected' : ''} ${isToday ? 'is-today' : ''}" type="button" ${canPick ? `data-date="${value}"` : 'disabled'}>${cellDay}</button>`;
    }

    panel.innerHTML = `
      <div class="lgsv-date-head">
        <button type="button" class="lgsv-date-nav" data-month-step="-1" aria-label="Previous month">&lt;</button>
        <div class="lgsv-date-jump">
          <select class="lgsv-date-month" aria-label="Month">${monthOptions(month)}</select>
          <select class="lgsv-date-year" aria-label="Year">${yearOptions(input, year)}</select>
        </div>
        <button type="button" class="lgsv-date-nav" data-month-step="1" aria-label="Next month">&gt;</button>
      </div>
      <div class="lgsv-date-weekdays"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
      <div class="lgsv-date-grid">${cells}</div>
      <div class="lgsv-date-foot">
        <button type="button" data-date-today>Today</button>
        <button type="button" data-date-clear>Clear</button>
      </div>
    `;
    field.dataset.year = String(year);
    field.dataset.month = String(month);
  }

  function refresh(root = document) {
    const fields = root.matches?.('.lgsv-date-field') ? [root] : root.querySelectorAll?.('.lgsv-date-field') || [];
    fields.forEach(syncField);
  }

  function enhance(root = document) {
    const inputs = root.matches?.('input[type="date"]')
      ? [root]
      : root.querySelectorAll?.('input[type="date"]') || [];

    inputs.forEach(input => {
      if (input.dataset[ENHANCED] === '1' || input.closest('.lgsv-date-field, .onb-date-field')) return;

      input.dataset[ENHANCED] = '1';
      input.dataset.onbDateEnhanced = '1';
      input.classList.add('lgsv-date-native');
      input.tabIndex = -1;

      const field = document.createElement('div');
      field.className = `lgsv-date-field${isBirthDate(input) ? ' is-birth-date' : ''}`;
      const trigger = document.createElement('button');
      trigger.className = 'lgsv-date-trigger';
      trigger.type = 'button';
      trigger.innerHTML = '<span class="lgsv-date-value is-empty">Select date</span>';
      const panel = document.createElement('div');
      panel.className = 'lgsv-date-panel';

      input.parentNode.insertBefore(field, input);
      field.appendChild(input);
      field.appendChild(trigger);
      field.appendChild(panel);
      syncField(field);

      input.addEventListener('input', () => syncField(field));
      input.addEventListener('change', () => syncField(field));
      input.addEventListener('invalid', () => {
        const base = defaultView(input);
        closeDatePickers(field);
        renderPicker(field, Number(field.dataset.year || base.getFullYear()), Number(field.dataset.month || base.getMonth()));
        field.classList.add('open');
      });

      trigger.addEventListener('click', event => {
        event.stopPropagation();
        const base = defaultView(input);
        const year = Number(field.dataset.year || base.getFullYear());
        const month = Number(field.dataset.month || base.getMonth());
        closeDatePickers(field);
        renderPicker(field, year, month);
        field.classList.toggle('open');
      });

      panel.addEventListener('click', event => {
        event.stopPropagation();
        const target = event.target instanceof Element ? event.target.closest('button') : null;
        if (!target || target.disabled) return;
        if (target.dataset.monthStep) {
          const next = new Date(Number(field.dataset.year), Number(field.dataset.month) + Number(target.dataset.monthStep), 1);
          renderPicker(field, next.getFullYear(), next.getMonth());
          return;
        }
        if (target.dataset.date) input.value = target.dataset.date;
        if (target.hasAttribute('data-date-today')) {
          const today = new Date();
          input.value = toValue(today.getFullYear(), today.getMonth(), today.getDate());
        }
        if (target.hasAttribute('data-date-clear')) input.value = '';
        syncField(field);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        field.classList.remove('open');
      });

      panel.addEventListener('change', event => {
        event.stopPropagation();
        if (!(event.target instanceof Element) || !event.target.matches('.lgsv-date-month, .lgsv-date-year')) return;
        const nextYear = Number(panel.querySelector('.lgsv-date-year')?.value || field.dataset.year);
        const nextMonth = Number(panel.querySelector('.lgsv-date-month')?.value || field.dataset.month);
        renderPicker(field, nextYear, nextMonth);
      });
    });
  }

  function refreshChangedValues() {
    document.querySelectorAll('.lgsv-date-field').forEach(field => {
      const input = field.querySelector('input[type="date"]');
      if (input && (input.value || '') !== (field.dataset.lastValue || '')) syncField(field);
    });
  }

  function boot() {
    if (booted) {
      enhance();
      refresh();
      return;
    }
    booted = true;
    enhance();
    refresh();
    const observer = new MutationObserver(records => {
      records.forEach(record => {
        record.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) enhance(node);
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target?.closest('.lgsv-date-field')) closeDatePickers();
  });
  document.addEventListener('reset', event => setTimeout(() => refresh(event.target), 0), true);
  document.addEventListener('partialsLoaded', boot);
  document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  setInterval(refreshChangedValues, 800);

  window.LGSVDatePicker = { enhance, refresh, close: closeDatePickers };
})();
