/* ui.js
 * Pure(ish) UI layer: renders state into the DOM and forwards user
 * interactions to App via injected handler callbacks. Contains no
 * business logic, storage or scheduling code.
 */
'use strict';

const UI = (() => {
  let H = {}; // handlers injected from App

  function init(handlers) {
    H = handlers;

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => showTab(btn.dataset.tab));
    });

    document.getElementById('btnGenerate').addEventListener('click', () => H.onGenerateClick());
    document.getElementById('btnExport').addEventListener('click', () => H.onExportClick());
    document.getElementById('btnPrevWeek').addEventListener('click', () => H.onPrevWeek());
    document.getElementById('btnNextWeek').addEventListener('click', () => H.onNextWeek());
    document.getElementById('weekStartPicker').addEventListener('change', (e) => H.onWeekPicked(e.target.value));
    document.getElementById('btnAddEmployee').addEventListener('click', () => H.onAddEmployee());

    document.getElementById('btnCancelEmployee').addEventListener('click', closeEmployeeModal);
    document.getElementById('btnSaveEmployee').addEventListener('click', () => {
      const data = collectEmployeeForm();
      if (!data.name.trim()) { alert('Name is required.'); return; }
      H.onSaveEmployee(data);
    });
    document.getElementById('btnDeleteEmployee').addEventListener('click', () => {
      if (confirm('Delete this employee? This cannot be undone.')) H.onDeleteEmployee();
    });

    document.getElementById('btnCancelFloatPrompt').addEventListener('click', closeFloatPrompt);
    document.getElementById('btnConfirmFloatPrompt').addEventListener('click', () => {
      const counts = {};
      Models.WEEK_DAYS.forEach(d => {
        counts[d] = parseInt(document.getElementById('floatPrompt_' + d).value, 10) || 0;
      });
      H.onFloatPromptConfirm(counts);
    });

    document.getElementById('btnCancelAssign').addEventListener('click', closeAssignModal);

    document.getElementById('btnExportData').addEventListener('click', () => H.onExportData());
    document.getElementById('importDataInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      H.onImportData(file);
      e.target.value = ''; // allow re-selecting the same file later
    });
  }

  function showTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  // Formats a Date object as 'YYYY-MM-DD' using its LOCAL calendar date,
  // never UTC — toISOString() shifts the date back a day for anyone in a
  // timezone behind UTC (e.g. the Americas).
  function toLocalDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // ---------------- Week label ----------------
  function renderWeekLabel(weekStartDate) {
    const start = new Date(weekStartDate + 'T00:00:00');
    const end = new Date(weekStartDate + 'T00:00:00');
    end.setDate(end.getDate() + 6);
    const fmt = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    document.getElementById('weekLabel').textContent = `(${fmt(start)} — ${fmt(end)})`;
    document.getElementById('weekStartPicker').value = weekStartDate;
  }

  // ---------------- Roster table ----------------
  function roleRowClass(role) { return 'role-row-' + role.replace(/\s+/g, '-'); }

  function renderRosterTable(roster, employees) {
    const headRow = document.getElementById('rosterHeadRow');
    headRow.innerHTML = '<th>Role</th>' + Models.WEEK_DAYS.map(d => `<th>${d}</th>`).join('');

    const body = document.getElementById('rosterBody');
    body.innerHTML = '';

    const warningsBox = document.getElementById('rosterWarnings');
    if (roster && roster.warnings && roster.warnings.length) {
      warningsBox.style.display = 'block';
      warningsBox.innerHTML = `<strong>⚠ ${roster.warnings.length} issue(s) found:</strong><ul>${roster.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`;
    } else {
      warningsBox.style.display = 'none';
    }

    if (!roster) {
      body.innerHTML = `<tr><td colspan="${Models.WEEK_DAYS.length + 1}" style="text-align:center;padding:30px;color:#64748b;">No roster generated for this week yet.</td></tr>`;
      return;
    }

    const empById = Object.fromEntries(employees.map(e => [e.id, e]));

    Models.ROLES.forEach(role => {
      const tr = document.createElement('tr');
      tr.className = roleRowClass(role);
      const labelTd = document.createElement('td');
      labelTd.className = 'role-label';
      labelTd.textContent = role;
      tr.appendChild(labelTd);

      Models.WEEK_DAYS.forEach(day => {
        const td = document.createElement('td');

        if (role === 'Day Off') {
          const offIds = employees.filter(e => (roster.employeeDay[e.id] && roster.employeeDay[e.id][day] || []).includes('Day Off')).map(e => e.id);
          if (offIds.length === 0) {
            td.innerHTML = `<div class="cell-slot empty">—</div>`;
          } else {
            td.innerHTML = offIds.map(id => `<div class="cell-slot">${esc(empById[id] ? empById[id].name : '?')}</div>`).join('');
          }
        } else {
          const ids = (roster.schedule[day] && roster.schedule[day][role]) || [];
          let html = '';
          if (role === 'Float') {
            const required = (roster.floatCounts && roster.floatCounts[day]) || 0;
            for (let i = 0; i < Math.max(required, ids.length); i++) {
              const id = ids[i];
              if (id) {
                html += slotHTML(day, role, i, empById[id] ? empById[id].name : '(unknown)', true);
              } else {
                html += slotHTML(day, role, i, null, true);
              }
            }
            html += `<div class="add-float-btn" data-day="${day}" data-role="Float" data-slot="${ids.length}">+ Add Float</div>`;
          } else {
            if (ids.length === 0) {
              html += slotHTML(day, role, 0, null, false);
            } else {
              ids.forEach((id, i) => {
                html += slotHTML(day, role, i, empById[id] ? empById[id].name : '(unknown)', false);
              });
            }
          }
          td.innerHTML = html;
        }
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });

    // wire up click handlers
    body.querySelectorAll('.cell-slot').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('remove-x')) return; // handled separately
        const day = el.dataset.day, role = el.dataset.role, slot = parseInt(el.dataset.slot, 10);
        H.onCellClick(day, role, slot);
      });
    });
    body.querySelectorAll('.remove-x').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const parent = e.target.closest('.cell-slot');
        H.onRemoveAssignment(parent.dataset.day, parent.dataset.role, parseInt(parent.dataset.slot, 10));
      });
    });
    body.querySelectorAll('.add-float-btn').forEach(el => {
      el.addEventListener('click', () => {
        H.onCellClick(el.dataset.day, el.dataset.role, parseInt(el.dataset.slot, 10));
      });
    });
  }

  function slotHTML(day, role, slotIndex, name, removable) {
    if (name) {
      return `<div class="cell-slot" data-day="${day}" data-role="${role}" data-slot="${slotIndex}">
        <span>${esc(name)}</span><span class="remove-x" title="Remove">✕</span>
      </div>`;
    }
    return `<div class="cell-slot empty" data-day="${day}" data-role="${role}" data-slot="${slotIndex}">+ Assign</div>`;
  }

  // ---------------- Employees ----------------
  function renderEmployeeList(employees) {
    const container = document.getElementById('employeeList');
    if (employees.length === 0) {
      container.innerHTML = `<div class="empty-state">No employees yet. Click "Add Employee" to get started.</div>`;
      return;
    }
    container.innerHTML = employees.map(e => `
      <div class="employee-card" data-id="${e.id}">
        <h4><span><span class="status-dot ${e.active ? 'status-active' : 'status-inactive'}"></span>${esc(e.name)}</span></h4>
        <div class="muted">Pref: ${esc(e.shiftPreference || 'None')}</div>
        <div class="tag-row">
          ${e.qualifiedRoles.map(r => `<span class="tag">${esc(r)}</span>`).join('')}
        </div>
        <div class="tag-row">
          ${e.preferredRoles.map(r => `<span class="tag pref">★ ${esc(r)}</span>`).join('')}
          ${e.avoidRoles.map(r => `<span class="tag avoid">⛔ ${esc(r)}</span>`).join('')}
        </div>
      </div>
    `).join('');
    container.querySelectorAll('.employee-card').forEach(card => {
      card.addEventListener('click', () => H.onEditEmployee(card.dataset.id));
    });
  }

  let currentDateListField = null; // 'vacationDates' | 'unavailableDates' while modal open
  let workingDates = { vacationDates: [], unavailableDates: [] };

  function openEmployeeModal(emp, isEditing) {
    document.getElementById('employeeModalTitle').textContent = isEditing ? 'Edit Employee' : 'Add Employee';
    workingDates = { vacationDates: [...emp.vacationDates], unavailableDates: [...emp.unavailableDates] };

    const roleChecks = (name, selected) => Models.WORK_ROLES.map(r => `
      <label><input type="checkbox" data-group="${name}" value="${r}" ${selected.includes(r) ? 'checked' : ''}/> ${r}</label>
    `).join('');

    document.getElementById('employeeModalBody').innerHTML = `
      <div class="form-row">
        <label>Name</label>
        <input type="text" id="f_name" value="${esc(emp.name)}" style="width:100%">
      </div>
      <div class="form-row">
        <label><input type="checkbox" id="f_active" ${emp.active ? 'checked' : ''}/> Active</label>
      </div>
      <div class="form-row">
        <label>Qualified Roles</label>
        <div class="checkbox-grid">${roleChecks('qualifiedRoles', emp.qualifiedRoles)}</div>
        <div class="help">Employee will never be scheduled outside these roles. Kitchen/Housekeeping qualification also allows Float.</div>
      </div>
      <div class="form-row">
        <label>Preferred Roles</label>
        <div class="checkbox-grid">${roleChecks('preferredRoles', emp.preferredRoles)}</div>
      </div>
      <div class="form-row">
        <label>Roles to Avoid</label>
        <div class="checkbox-grid">${roleChecks('avoidRoles', emp.avoidRoles)}</div>
      </div>
      <div class="form-row">
        <label>Morning/Night Preference</label>
        <select id="f_shiftPref">
          <option value="None" ${emp.shiftPreference === 'None' ? 'selected' : ''}>None</option>
          <option value="Morning" ${emp.shiftPreference === 'Morning' ? 'selected' : ''}>Morning</option>
          <option value="Night" ${emp.shiftPreference === 'Night' ? 'selected' : ''}>Night</option>
        </select>
      </div>
      <div class="form-row">
        <label>Vacation Dates</label>
        <div class="date-range-row">
          <div>
            <span class="mini-label">From</span>
            <input type="date" id="f_addVacationFrom">
          </div>
          <div>
            <span class="mini-label">To (optional)</span>
            <input type="date" id="f_addVacationTo">
          </div>
          <button type="button" class="btn-secondary" id="f_addVacationBtn">Add</button>
        </div>
        <div class="help">Leave "To" empty to add a single day, or set both to add a whole period at once.</div>
        <div class="date-tag-input" id="f_vacationList"></div>
      </div>
      <div class="form-row">
        <label>Unavailable Dates</label>
        <div class="date-range-row">
          <div>
            <span class="mini-label">From</span>
            <input type="date" id="f_addUnavailFrom">
          </div>
          <div>
            <span class="mini-label">To (optional)</span>
            <input type="date" id="f_addUnavailTo">
          </div>
          <button type="button" class="btn-secondary" id="f_addUnavailBtn">Add</button>
        </div>
        <div class="help">Leave "To" empty to add a single day, or set both to add a whole period at once.</div>
        <div class="date-tag-input" id="f_unavailList"></div>
      </div>
      <div class="form-row">
        <label>Notes</label>
        <textarea id="f_notes">${esc(emp.notes)}</textarea>
      </div>
    `;
    renderDateChips('vacationDates', 'f_vacationList');
    renderDateChips('unavailableDates', 'f_unavailList');

    document.getElementById('f_addVacationBtn').addEventListener('click', () => {
      addDateRange('f_addVacationFrom', 'f_addVacationTo', 'vacationDates', 'f_vacationList');
    });
    document.getElementById('f_addUnavailBtn').addEventListener('click', () => {
      addDateRange('f_addUnavailFrom', 'f_addUnavailTo', 'unavailableDates', 'f_unavailList');
    });

    document.getElementById('btnDeleteEmployee').style.display = isEditing ? 'inline-block' : 'none';
    document.getElementById('employeeModal').style.display = 'flex';
  }

  function addDateRange(fromId, toId, field, containerId) {
    const fromEl = document.getElementById(fromId);
    const toEl = document.getElementById(toId);
    const fromVal = fromEl.value;
    const toVal = toEl.value || fromVal;

    if (!fromVal) return;

    if (toVal < fromVal) {
      alert('The "To" date cannot be earlier than the "From" date.');
      return;
    }

    // Safety cap to avoid accidentally generating thousands of dates
    const MAX_RANGE_DAYS = 366;
    const start = new Date(fromVal + 'T00:00:00');
    const end = new Date(toVal + 'T00:00:00');
    const dayCount = Math.round((end - start) / 86400000) + 1;
    if (dayCount > MAX_RANGE_DAYS) {
      alert(`This range is too long (${dayCount} days). Please choose a range of up to ${MAX_RANGE_DAYS} days.`);
      return;
    }

    for (let i = 0; i < dayCount; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const dateStr = toLocalDateStr(d);
      if (!workingDates[field].includes(dateStr)) workingDates[field].push(dateStr);
    }

    fromEl.value = '';
    toEl.value = '';
    renderDateChips(field, containerId);
  }

  function groupConsecutiveDates(dates) {
    const sorted = [...dates].sort();
    const groups = [];
    let current = null;

    sorted.forEach(dateStr => {
      if (current && isNextDay(current.end, dateStr)) {
        current.end = dateStr;
        current.dates.push(dateStr);
      } else {
        current = { start: dateStr, end: dateStr, dates: [dateStr] };
        groups.push(current);
      }
    });
    return groups;
  }
  function isNextDay(dateStr, candidateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return toLocalDateStr(d) === candidateStr;
  }

  function renderDateChips(field, containerId) {
    const container = document.getElementById(containerId);
    const groups = groupConsecutiveDates(workingDates[field]);
    container.innerHTML = groups.map(g => {
      const label = g.start === g.end ? g.start : `${g.start} → ${g.end}`;
      return `<span class="date-chip">${label} <span class="x" data-field="${field}" data-dates="${g.dates.join(',')}">✕</span></span>`;
    }).join('');
    container.querySelectorAll('.x').forEach(el => {
      el.addEventListener('click', () => {
        const toRemove = new Set(el.dataset.dates.split(','));
        workingDates[el.dataset.field] = workingDates[el.dataset.field].filter(d => !toRemove.has(d));
        renderDateChips(el.dataset.field, containerId);
      });
    });
  }

  function collectEmployeeForm() {
    const getChecked = (group) => Array.from(document.querySelectorAll(`input[data-group="${group}"]:checked`)).map(el => el.value);
    return {
      name: document.getElementById('f_name').value,
      active: document.getElementById('f_active').checked,
      qualifiedRoles: getChecked('qualifiedRoles'),
      preferredRoles: getChecked('preferredRoles'),
      avoidRoles: getChecked('avoidRoles'),
      shiftPreference: document.getElementById('f_shiftPref').value,
      vacationDates: workingDates.vacationDates,
      unavailableDates: workingDates.unavailableDates,
      notes: document.getElementById('f_notes').value
    };
  }

  function closeEmployeeModal() {
    document.getElementById('employeeModal').style.display = 'none';
  }

  // ---------------- Settings ----------------
  function renderRatesForm(rates) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const container = document.getElementById('ratesForm');
    container.innerHTML = days.map(d => `
      <label>${d}
        <input type="number" step="0.01" min="0" id="rate_${d}" value="${rates[d]}">
      </label>
    `).join('') + `<button class="btn-primary" id="btnSaveRates" style="margin-top:10px;">Save Rates</button>`;
    document.getElementById('btnSaveRates').addEventListener('click', () => {
      const newRates = {};
      days.forEach(d => { newRates[d] = parseFloat(document.getElementById(`rate_${d}`).value) || 0; });
      H.onRatesChange(newRates);
    });
  }

  function renderFloatForm(counts) {
    const container = document.getElementById('floatForm');
    container.innerHTML = Models.WEEK_DAYS.map(d => `
      <label>${d}
        <input type="number" min="0" step="1" id="deffloat_${d}" value="${counts[d] || 0}">
      </label>
    `).join('') + `<button class="btn-primary" id="btnSaveFloat" style="margin-top:10px;">Save Defaults</button>`;
    document.getElementById('btnSaveFloat').addEventListener('click', () => {
      const newCounts = {};
      Models.WEEK_DAYS.forEach(d => { newCounts[d] = parseInt(document.getElementById(`deffloat_${d}`).value, 10) || 0; });
      H.onDefaultFloatChange(newCounts);
    });
  }

  // ---------------- Float prompt modal ----------------
  function openFloatPrompt(defaults) {
    const body = document.getElementById('floatPromptBody');
    body.innerHTML = Models.WEEK_DAYS.map(d => `
      <label>${d}
        <input type="number" min="0" step="1" id="floatPrompt_${d}" value="${defaults[d] || 0}">
      </label>
    `).join('');
    document.getElementById('floatPromptModal').style.display = 'flex';
  }
  function closeFloatPrompt() {
    document.getElementById('floatPromptModal').style.display = 'none';
  }

  // ---------------- Assign modal ----------------
  function openAssignModal(day, role, slotIndex, qualifiedEmployees) {
    document.getElementById('assignModalTitle').textContent = `Assign — ${role} (${day})`;
    const body = document.getElementById('assignModalBody');
    if (qualifiedEmployees.length === 0) {
      body.innerHTML = `<p class="muted">No active, qualified & available employees found for this slot.</p>`;
    } else {
      body.innerHTML = `<div class="employee-list">` + qualifiedEmployees.map(e => `
        <div class="employee-card" data-id="${e.id}" style="cursor:pointer;">
          <h4>${esc(e.name)}</h4>
          <div class="tag-row">${e.qualifiedRoles.map(r => `<span class="tag">${esc(r)}</span>`).join('')}</div>
        </div>
      `).join('') + `</div>`;
      body.querySelectorAll('.employee-card').forEach(card => {
        card.addEventListener('click', () => H.onAssignPick(day, role, slotIndex, card.dataset.id));
      });
    }
    document.getElementById('assignModal').style.display = 'flex';
  }
  function closeAssignModal() {
    document.getElementById('assignModal').style.display = 'none';
  }

  // ---------------- Dashboard ----------------
  function renderDashboard(roster) {
    const container = document.getElementById('dashboardContent');
    if (!roster) {
      container.innerHTML = `<div class="empty-state">No roster generated yet. Go to the <strong>Roster</strong> tab to create one.</div>`;
      return;
    }
    const ids = Object.keys(roster.perEmployee);
    const names = ids.map(id => roster.perEmployee[id].name);
    const earnings = ids.map(id => roster.perEmployee[id].earnings);
    const hours = ids.map(id => roster.perEmployee[id].hoursWorked || 0);
    const sat = ids.map(id => roster.perEmployee[id].satShifts);
    const sun = ids.map(id => roster.perEmployee[id].sunShifts);
    const maxEarn = Math.max(1, ...earnings);
    const maxHours = Math.max(1, ...hours);
    const maxSat = Math.max(1, ...sat);
    const maxSun = Math.max(1, ...sun);

    const roleTotals = {};
    Models.ROLES.forEach(r => { roleTotals[r] = ids.reduce((a, id) => a + (roster.perEmployee[id].roleCounts[r] || 0), 0); });
    const maxRole = Math.max(1, ...Object.values(roleTotals));

    container.innerHTML = `
      <div class="stat-card quality-score-ring">
        <h4>Roster Quality Score</h4>
        <div class="stat-big" style="color:${roster.qualityScore >= 75 ? '#16a34a' : roster.qualityScore >= 50 ? '#f59e0b' : '#dc2626'}">${roster.qualityScore}</div>
        <div class="muted">out of 100</div>
      </div>

      <div class="stat-card">
        <h4>Horas Trabajadas Esta Semana</h4>
        ${ids.map((id, i) => barRow(names[i], hours[i], maxHours, hours[i] + 'h')).join('')}
      </div>

      <div class="stat-card">
        <h4>Earnings Balance</h4>
        ${ids.map((id, i) => barRow(names[i], earnings[i], maxEarn, '$' + earnings[i].toFixed(2))).join('')}
      </div>

      <div class="stat-card">
        <h4>Saturday Shifts</h4>
        ${ids.map((id, i) => barRow(names[i], sat[i], maxSat, sat[i])).join('')}
      </div>

      <div class="stat-card">
        <h4>Sunday Shifts</h4>
        ${ids.map((id, i) => barRow(names[i], sun[i], maxSun, sun[i])).join('')}
      </div>

      <div class="stat-card" style="grid-column: 1 / -1;">
        <h4>Role Distribution (roadhouse-wide)</h4>
        ${Models.ROLES.map(r => barRow(r, roleTotals[r], maxRole, roleTotals[r])).join('')}
      </div>

      <div class="stat-card" style="grid-column: 1 / -1;">
        <h4>Preference Satisfaction</h4>
        ${ids.map(id => {
          const st = roster.perEmployee[id];
          const total = st.prefHits + st.prefMisses;
          const pct = total > 0 ? Math.round((st.prefHits / total) * 100) : 100;
          return barRow(st.name, pct, 100, pct + '%');
        }).join('')}
      </div>
    `;
  }

  function barRow(label, value, max, displayValue) {
    const pct = Math.min(100, (value / max) * 100);
    return `<div class="bar-row">
      <div class="label" title="${esc(label)}">${esc(label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="bar-value">${esc(displayValue)}</div>
    </div>`;
  }

  // ---------------- History ----------------
  function renderHistory(rosters) {
    const container = document.getElementById('historyList');
    if (rosters.length === 0) {
      container.innerHTML = `<div class="empty-state">No rosters generated yet.</div>`;
      return;
    }
    container.innerHTML = rosters.map(r => `
      <div class="history-item" data-id="${r.id}">
        <div>
          <strong>Week of ${r.weekStartDate}</strong>
          <div class="muted">Generated ${new Date(r.createdAt).toLocaleString()} · Quality ${r.qualityScore}/100 · ${(r.warnings || []).length} warning(s)</div>
        </div>
        <button class="btn-secondary loadHistBtn" data-id="${r.id}">View / Load</button>
      </div>
    `).join('');
    container.querySelectorAll('.loadHistBtn').forEach(btn => {
      btn.addEventListener('click', () => H.onLoadHistoryRoster(btn.dataset.id));
    });
  }

  return {
    init, showTab,
    renderWeekLabel, renderRosterTable, renderEmployeeList, renderRatesForm, renderFloatForm,
    renderDashboard, renderHistory,
    openEmployeeModal, closeEmployeeModal,
    openFloatPrompt, closeFloatPrompt,
    openAssignModal, closeAssignModal
  };
})();
