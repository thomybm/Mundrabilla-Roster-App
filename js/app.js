/* app.js
 * Application bootstrap + state management. Wires DB <-> Scheduler <-> Stats <-> UI.
 * Keeps business logic out of ui.js (which only renders / captures DOM events).
 */
'use strict';

const App = (() => {

  const state = {
    employees: [],
    rates: Object.assign({}, Models.DEFAULT_RATES),
    defaultFloatCounts: makeZeroFloatCounts(),
    weekStartDate: mostRecentWednesday(new Date()),
    currentRoster: null, // { id, weekStartDate, schedule, employeeDay, floatCounts, warnings, perEmployee, qualityScore, cost }
    historyRosters: [],
    editingEmployeeId: null
  };

  function makeZeroFloatCounts() {
    const o = {};
    Models.WEEK_DAYS.forEach(d => o[d] = 0);
    return o;
  }

  function mostRecentWednesday(d) {
    const date = new Date(d);
    date.setHours(0, 0, 0, 0);
    const day = date.getDay(); // 0 Sun ... 6 Sat
    // Wednesday = 3
    const diff = (day - 3 + 7) % 7;
    date.setDate(date.getDate() - diff);
    return toDateStr(date);
  }
  // Formats a Date object as 'YYYY-MM-DD' using its LOCAL calendar date,
  // never UTC — toISOString() would shift the date back a day for anyone
  // in a timezone behind UTC (e.g. the Americas).
  function toDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  // Parses a 'YYYY-MM-DD' string as local midnight, never UTC midnight —
  // `new Date('2026-07-08')` alone is parsed as UTC and can render as the
  // previous day in negative-UTC-offset timezones.
  function parseLocalDate(dateStr) {
    return new Date(dateStr + 'T00:00:00');
  }
  function addDays(dateStr, n) {
    const d = parseLocalDate(dateStr);
    d.setDate(d.getDate() + n);
    return toDateStr(d);
  }

  async function tryLoadSeedData() {
    try {
      const res = await fetch('./seed-data.json');
      if (!res.ok) return; // no seed file bundled — perfectly normal, do nothing
      const data = await res.json();
      await DB.importAllData(data, 'replace');
      console.log('Loaded starting data from seed-data.json');
    } catch (err) {
      // Missing file, offline with nothing cached yet, or invalid JSON —
      // all non-fatal. The app just starts empty, same as before this feature.
      console.log('No seed data loaded (this is fine):', err.message);
    }
  }

  async function tryLoadSeedData() {
    try {
      const res = await fetch('./seed-data.json', { cache: 'no-store' });
      if (!res.ok) return; // file not present — fine, just skip silently
      const data = await res.json();
      await DB.importAllData(data, 'replace');
      console.log('Loaded bundled seed-data.json for first run.');
    } catch (err) {
      // No seed file, or it's malformed — not an error worth bothering the
      // person with, the app just starts empty as it always did before.
      console.log('No seed data loaded:', err.message);
    }
  }

  // ---------------- Init ----------------
  async function init() {
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('sw.js');
        // When a newer app version activates (e.g. after updating files on
        // GitHub Pages), automatically reload once to pick it up — instead
        // of silently keeping old cached files until someone manually clears
        // the cache or unregisters the service worker.
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloaded) return;
          reloaded = true;
          window.location.reload();
        });
      } catch (e) { console.warn('SW failed', e); }
    }

    state.employees = await DB.getAllEmployees();

    // First-run only: if this device has never had any employees stored,
    // try loading a bundled seed-data.json shipped alongside the app so new
    // devices/browsers start pre-populated instead of empty. This never runs
    // again once real data exists, so it can't clobber anything later.
    if (state.employees.length === 0) {
      await tryLoadSeedData();
      state.employees = await DB.getAllEmployees();
    }

    const storedRates = await DB.getSetting('rates');
    if (storedRates) state.rates = storedRates;
    const storedFloat = await DB.getSetting('defaultFloatCounts');
    if (storedFloat) state.defaultFloatCounts = storedFloat;
    const storedWeek = await DB.getSetting('currentWeekStart');
    if (storedWeek) {
      // Re-snap to Wednesday in case this value was saved by an older version
      // of the app affected by the UTC/local timezone bug (fixes itself here
      // rather than requiring the user to manually clear stored data).
      state.weekStartDate = mostRecentWednesday(parseLocalDate(storedWeek));
      if (state.weekStartDate !== storedWeek) {
        await DB.putSetting('currentWeekStart', state.weekStartDate);
      }
    }

    state.historyRosters = await DB.getAllRosters();

    // First-run seed: if this device has never had any data entered (fresh
    // install / fresh browser), try loading a bundled seed-data.json with a
    // starting set of employees/settings. This is entirely optional — most
    // deployments won't have this file, and a missing/404 file is silently
    // ignored. See README notes in the repo for how to generate one.
    if (state.employees.length === 0 && state.historyRosters.length === 0) {
      await tryLoadSeedData();
      state.employees = await DB.getAllEmployees();
      const seededRates = await DB.getSetting('rates');
      if (seededRates) state.rates = seededRates;
      const seededFloat = await DB.getSetting('defaultFloatCounts');
      if (seededFloat) state.defaultFloatCounts = seededFloat;
      state.historyRosters = await DB.getAllRosters();
    }

    for (const roster of state.historyRosters) {
      const corrected = mostRecentWednesday(parseLocalDate(roster.weekStartDate));
      if (corrected !== roster.weekStartDate) {
        roster.weekStartDate = corrected;
        await DB.putRoster(roster);
      }
    }
    if (state.historyRosters.length > 0) {
      const forThisWeek = state.historyRosters.find(r => r.weekStartDate === state.weekStartDate);
      if (forThisWeek) state.currentRoster = forThisWeek;
    }

    UI.init({
      onTabChange: UI.showTab,
      onGenerateClick: openFloatPrompt,
      onExportClick: exportCurrentRoster,
      onSwapDays: swapDays,
      onPrintPoster: printPoster,
      onPrevWeek: () => changeWeek(-7),
      onNextWeek: () => changeWeek(7),
      onWeekPicked: onWeekPicked,
      onAddEmployee: () => openEmployeeModal(null),
      onEditEmployee: (id) => openEmployeeModal(id),
      onSaveEmployee: saveEmployeeFromModal,
      onDeleteEmployee: deleteEmployeeFromModal,
      onRatesChange: saveRates,
      onDefaultFloatChange: saveDefaultFloatCounts,
      onExportData: exportAllData,
      onImportData: importAllData,
      onFloatPromptConfirm: runGeneration,
      onCellClick: openAssignPicker,
      onAssignPick: applyManualAssignment,
      onRemoveAssignment: removeAssignment,
      onLoadHistoryRoster: loadHistoryRoster
    });

    renderAll();
  }

  function renderAll() {
    UI.renderWeekLabel(state.weekStartDate);
    UI.renderRosterTable(state.currentRoster, state.employees);
    UI.renderEmployeeList(state.employees);
    UI.renderRatesForm(state.rates);
    UI.renderFloatForm(state.defaultFloatCounts);
    UI.renderDashboard(state.currentRoster, state.historyRosters);
    UI.renderHistory(state.historyRosters);
  }

  // ---------------- Week navigation ----------------
  async function changeWeek(deltaDays) {
    state.weekStartDate = addDays(state.weekStartDate, deltaDays);
    await DB.putSetting('currentWeekStart', state.weekStartDate);
    const existing = state.historyRosters.find(r => r.weekStartDate === state.weekStartDate);
    state.currentRoster = existing || null;
    renderAll();
  }
  async function onWeekPicked(dateStr) {
    // snap to Wednesday of that week
    state.weekStartDate = mostRecentWednesday(parseLocalDate(dateStr));
    await DB.putSetting('currentWeekStart', state.weekStartDate);
    const existing = state.historyRosters.find(r => r.weekStartDate === state.weekStartDate);
    state.currentRoster = existing || null;
    renderAll();
  }

  // ---------------- Employees ----------------
  function openEmployeeModal(id) {
    state.editingEmployeeId = id;
    const emp = id ? state.employees.find(e => e.id === id) : Models.emptyEmployee();
    UI.openEmployeeModal(emp, !!id);
  }

  async function saveEmployeeFromModal(formData) {
    let emp;
    if (state.editingEmployeeId) {
      emp = state.employees.find(e => e.id === state.editingEmployeeId);
      Object.assign(emp, formData);
    } else {
      emp = Object.assign(Models.emptyEmployee(), formData, { id: Models.newId() });
      state.employees.push(emp);
    }
    await DB.putEmployee(emp);
    UI.closeEmployeeModal();
    UI.renderEmployeeList(state.employees);
    toast('Employee saved.');
  }

  async function deleteEmployeeFromModal() {
    if (!state.editingEmployeeId) { UI.closeEmployeeModal(); return; }
    await DB.deleteEmployee(state.editingEmployeeId);
    state.employees = state.employees.filter(e => e.id !== state.editingEmployeeId);
    UI.closeEmployeeModal();
    UI.renderEmployeeList(state.employees);
    toast('Employee deleted.');
  }

  // ---------------- Settings ----------------
  async function saveRates(newRates) {
    state.rates = newRates;
    await DB.putSetting('rates', newRates);
    toast('Pay rates updated.');
  }
  async function saveDefaultFloatCounts(newCounts) {
    state.defaultFloatCounts = newCounts;
    await DB.putSetting('defaultFloatCounts', newCounts);
    toast('Default float requirements updated.');
  }

  // ---------------- Roster generation ----------------
  function openFloatPrompt() {
    if (state.employees.filter(e => e.active).length === 0) {
      toast('Add at least one active employee first.');
      return;
    }
    UI.openFloatPrompt(state.defaultFloatCounts);
  }

  function weekDateRange(weekStartDate) {
    const dates = [];
    for (let i = 0; i < 7; i++) dates.push(addDays(weekStartDate, i));
    return dates;
  }
  function wasAbsentDuringWeek(employee, weekStartDate) {
    const dates = weekDateRange(weekStartDate);
    return dates.some(d => employee.vacationDates.includes(d) || employee.unavailableDates.includes(d));
  }

  // How many weeks it's been since each active employee last had this specific
  // weekend day (Sat or Sun) off, looking back through stored roster history
  // (most recent = 1 week ago). Vacation/unavailable days count as having had
  // that day off too — they weren't working it either way. Employees with no
  // record of ever having that day off within the stored history are treated
  // as maximally overdue, so they're favored first.
  function computeWeekendDayOffRotation(day) {
    const priorWeeks = [...state.historyRosters]
      .filter(r => r.weekStartDate !== state.weekStartDate)
      .sort((a, b) => (b.weekStartDate > a.weekStartDate ? 1 : -1));

    const rotation = {};
    state.employees.filter(e => e.active).forEach(e => {
      let weeksAgo = null;
      for (let i = 0; i < priorWeeks.length; i++) {
        const st = priorWeeks[i].perEmployee && priorWeeks[i].perEmployee[e.id];
        if (st && st.daysOff && st.daysOff.includes(day)) { weeksAgo = i + 1; break; }
      }
      rotation[e.id] = weeksAgo === null ? DB.MAX_ROSTER_HISTORY + 1 : weeksAgo;
    });
    return rotation;
  }


  function buildHistorySeed() {
    // Rolling fairness seed carried from past rosters (up to the last MAX_ROSTER_HISTORY weeks).
    // hoursWorked carries a strong weight so someone who worked extra hours (or had
    // fewer days off) last week is nudged toward fewer hours / more days off this
    // week, and vice versa — compensating week-to-week rather than resetting to zero.
    // Other factors (earnings, weekend shifts, role mix, preferences) carry a lighter
    // weight so this week's own internal balance still dominates day-to-day fairness.
    //
    // EXCEPTION: hours and earnings are averaged only over weeks where the employee
    // was fully available. A week reduced by vacation/unavailability is not treated
    // as a shortfall to "pay back" later — that time off was their own choice, not
    // an imbalance to correct. Saturday/Sunday shift and weekend-days-off balancing
    // still runs over every stored week regardless, exactly as before.
    const priorWeeksOnly = state.historyRosters.filter(r => r.weekStartDate !== state.weekStartDate);
    const agg = Stats.aggregateHistory(priorWeeksOnly);

    const hoursAgg = {};
    priorWeeksOnly.forEach(roster => {
      Object.values(roster.perEmployee || {}).forEach(st => {
        const employee = state.employees.find(e => e.id === st.id);
        if (employee && wasAbsentDuringWeek(employee, roster.weekStartDate)) return; // skip this week
        if (!hoursAgg[st.id]) hoursAgg[st.id] = { hoursSum: 0, earnSum: 0, n: 0 };
        hoursAgg[st.id].hoursSum += (st.hoursWorked || 0);
        hoursAgg[st.id].earnSum += (st.earnings || 0);
        hoursAgg[st.id].n += 1;
      });
    });

    const seed = {};
    const hourEntries = Object.values(hoursAgg).filter(h => h.n > 0);
    const groupAvgHours = hourEntries.length
      ? hourEntries.reduce((sum, h) => sum + h.hoursSum / h.n, 0) / hourEntries.length
      : 0;
    const groupAvgEarnings = hourEntries.length
      ? hourEntries.reduce((sum, h) => sum + h.earnSum / h.n, 0) / hourEntries.length
      : 0;

    Object.keys(agg).forEach(id => {
      const a = agg[id];
      const n = Math.max(1, a.rosterCount);
      const h = hoursAgg[id];
      // If this employee has prior roster history but every one of those
      // weeks was a vacation/unavailable week, fall back to the group's
      // average as a neutral baseline (no debt, no bonus) rather than 0 —
      // seeding at 0 would itself create upward pressure to "catch up" to
      // everyone else's higher average.
      const hoursSeed = (h && h.n > 0) ? (h.hoursSum / h.n) : groupAvgHours;
      const earningsSeed = (h && h.n > 0) ? (h.earnSum / h.n) : groupAvgEarnings;
      seed[id] = {
        earnings: earningsSeed * 0.3,
        hoursWorked: hoursSeed * 0.65,
        satShifts: (a.satShifts / n) * 0.65,
        sunShifts: (a.sunShifts / n) * 0.65,
        weekendOff: (a.weekendOff / n) * 0.3,
        weekdayOff: (a.weekdayOff / n) * 0.3,
        roleCounts: Object.fromEntries(Object.entries(a.roleCounts).map(([k, v]) => [k, (v / n) * 0.3])),
        prefHits: (a.prefHits / n) * 0.3,
        prefMisses: (a.prefMisses / n) * 0.3
      };
    });
    return seed;
  }

  async function runGeneration(floatCounts) {
    try {
      const historySeed = buildHistorySeed();
      const satRotation = computeWeekendDayOffRotation('Sat');
      const sunRotation = computeWeekendDayOffRotation('Sun');
      const result = Scheduler.generate({
        employees: state.employees,
        floatCounts,
        rates: state.rates,
        history: historySeed,
        weekStartDate: state.weekStartDate,
        iterations: 70,
        satRotation,
        sunRotation
      });

      const perEmployee = Stats.computeFromEmployeeDay(state.employees.filter(e => e.active), result.employeeDay, state.rates, state.weekStartDate);
      const quality = Stats.qualityScore(perEmployee, result.warnings);

      // Regenerating an already-generated week replaces that week's single
      // history entry instead of adding a new one (see db.js putRoster).
      const existingForWeek = state.historyRosters.find(r => r.weekStartDate === state.weekStartDate);

      const roster = {
        id: existingForWeek ? existingForWeek.id : Models.newId(),
        createdAt: Date.now(),
        weekStartDate: state.weekStartDate,
        schedule: result.schedule,
        employeeDay: result.employeeDay,
        floatCounts,
        warnings: result.warnings,
        perEmployee,
        qualityScore: quality,
        cost: result.cost
      };

      await DB.putRoster(roster);
      state.historyRosters = await DB.getAllRosters();
      state.currentRoster = roster;

      UI.closeFloatPrompt();
      renderAll();
      UI.showTab('roster');
      toast(`Roster generated. Quality Score: ${quality}/100`);
    } catch (err) {
      console.error(err);
      toast('Error: ' + err.message);
    }
  }

  // ---------------- Manual editing ----------------
  function openAssignPicker(day, role, slotIndex) {
    const qualified = state.employees.filter(e =>
      e.active && Scheduler.isQualifiedForRole(e, role) &&
      Scheduler.isAvailable(e, Scheduler.dateForDay(state.weekStartDate, Models.WEEK_DAYS.indexOf(day)))
    );
    UI.openAssignModal(day, role, slotIndex, qualified);
  }

  async function applyManualAssignment(day, role, slotIndex, employeeId) {
    if (!state.currentRoster) return;
    const roster = state.currentRoster;

    // Remove employee from any existing role that day (single shift enforcement),
    // unless this creates a double shift the user explicitly wants — we warn instead.
    const prevRoles = roster.employeeDay[employeeId] && roster.employeeDay[employeeId][day];
    if (prevRoles && prevRoles.length && role !== 'Day Off') {
      // Remove from previous role slot(s) in schedule
      prevRoles.forEach(prevRole => {
        if (prevRole === 'Day Off') return;
        const arr = roster.schedule[day][prevRole] || [];
        roster.schedule[day][prevRole] = arr.filter(id => id !== employeeId);
      });
    }

    // Place into new role slot
    if (role === 'Day Off') {
      roster.employeeDay[employeeId][day] = ['Day Off'];
    } else {
      roster.schedule[day][role] = roster.schedule[day][role] || [];
      // Replace at slotIndex if provided, else push
      if (typeof slotIndex === 'number' && roster.schedule[day][role][slotIndex] !== undefined) {
        const displaced = roster.schedule[day][role][slotIndex];
        roster.schedule[day][role][slotIndex] = employeeId;
        // if displaced someone, send them to Day Off unless they hold another role today
        if (displaced && displaced !== employeeId) {
          roster.employeeDay[displaced][day] = ['Day Off'];
        }
      } else {
        roster.schedule[day][role].push(employeeId);
      }
      roster.employeeDay[employeeId][day] = [role];
    }

    await recalcAndPersist();
    UI.closeAssignModal();
  }

  async function removeAssignment(day, role, slotIndex) {
    if (!state.currentRoster) return;
    const roster = state.currentRoster;
    const employeeId = roster.schedule[day][role][slotIndex];
    roster.schedule[day][role].splice(slotIndex, 1);
    if (employeeId) roster.employeeDay[employeeId][day] = ['Day Off'];
    await recalcAndPersist();
  }

  async function recalcAndPersist() {
    const roster = state.currentRoster;
    const activeEmps = state.employees.filter(e => e.active);
    // recompute double shift / unfilled warnings
    const warnings = [];
    Models.WORK_ROLES.concat(['Float']).forEach(() => {}); // noop placeholder for clarity
    Models.WEEK_DAYS.forEach(day => {
      Models.WORK_ROLES.forEach(role => {
        const arr = (roster.schedule[day][role] || []);
        if (arr.length === 0) warnings.push(`No qualified/available employee for ${role} on ${day}.`);
      });
      const floatArr = roster.schedule[day]['Float'] || [];
      const required = roster.floatCounts[day] || 0;
      if (floatArr.length < required) {
        warnings.push(`Float understaffed on ${day}: ${floatArr.length}/${required} filled.`);
      }
    });
    activeEmps.forEach(e => {
      Models.WEEK_DAYS.forEach(day => {
        const roles = roster.employeeDay[e.id][day] || ['Day Off'];
        if (roles.length > 1) warnings.push(`${e.name} is double-shifted on ${day} (${roles.join(' + ')}).`);
      });
    });
    roster.warnings = warnings;
    roster.perEmployee = Stats.computeFromEmployeeDay(activeEmps, roster.employeeDay, state.rates, roster.weekStartDate);
    roster.qualityScore = Stats.qualityScore(roster.perEmployee, warnings);

    await DB.putRoster(roster);
    state.historyRosters = await DB.getAllRosters();
    renderAll();
  }

  function loadHistoryRoster(id) {
    const roster = state.historyRosters.find(r => r.id === id);
    if (!roster) return;
    state.currentRoster = roster;
    state.weekStartDate = roster.weekStartDate;
    renderAll();
    UI.showTab('roster');
  }

  // ---------------- Swap days ----------------
  async function swapDays(dayA, dayB) {
    if (!state.currentRoster) { toast('Generate a roster first.'); return; }
    if (dayA === dayB) { toast('Choose two different days to swap.'); return; }
    const roster = state.currentRoster;

    // Swap the whole day's role assignments
    const scheduleA = roster.schedule[dayA];
    const scheduleB = roster.schedule[dayB];
    roster.schedule[dayA] = scheduleB;
    roster.schedule[dayB] = scheduleA;

    // Swap each employee's assignment for those two specific days
    Object.keys(roster.employeeDay).forEach(empId => {
      const a = roster.employeeDay[empId][dayA];
      const b = roster.employeeDay[empId][dayB];
      roster.employeeDay[empId][dayA] = b;
      roster.employeeDay[empId][dayB] = a;
    });

    // Swap that day's Float requirement too, since it travels with the day
    const floatA = roster.floatCounts[dayA];
    const floatB = roster.floatCounts[dayB];
    roster.floatCounts[dayA] = floatB;
    roster.floatCounts[dayB] = floatA;

    await recalcAndPersist();
    toast(`Swapped ${dayA} and ${dayB}.`);
  }

  // ---------------- Print / PDF poster ----------------
  function printPoster() {
    if (!state.currentRoster) { toast('Generate a roster first.'); return; }
    window.print();
  }

  // ---------------- Export ----------------
  function exportCurrentRoster() {
    if (!state.currentRoster) { toast('Generate a roster first.'); return; }
    try {
      ExportXLSX.exportRoster(
        state.currentRoster.schedule,
        state.currentRoster.employeeDay,
        state.employees,
        state.currentRoster.weekStartDate
      );
      toast('Roster exported.');
    } catch (err) {
      console.error('Export failed:', err);
      toast('Export failed: ' + err.message);
    }
  }

  // ---------------- Full data backup / transfer ----------------
  async function exportAllData() {
    try {
      const data = await DB.exportAllData();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = toDateStr(new Date());
      a.href = url;
      a.download = `mundrabilla-roster-backup-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('Data exported successfully.');
    } catch (err) {
      console.error(err);
      toast('Export error: ' + err.message);
    }
  }

  async function importAllData(file) {
    if (!file) return;
    const confirmed = confirm(
      'Importing will replace ALL current data on this device ' +
      '(employees, roster history, and settings) with the data from the file. Continue?'
    );
    if (!confirmed) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await DB.importAllData(data, 'replace');

      // reload state fresh from DB
      state.employees = await DB.getAllEmployees();
      const storedRates = await DB.getSetting('rates');
      if (storedRates) state.rates = storedRates;
      const storedFloat = await DB.getSetting('defaultFloatCounts');
      if (storedFloat) state.defaultFloatCounts = storedFloat;
      state.historyRosters = await DB.getAllRosters();
      const existing = state.historyRosters.find(r => r.weekStartDate === state.weekStartDate);
      state.currentRoster = existing || (state.historyRosters[0] || null);
      if (state.currentRoster) state.weekStartDate = state.currentRoster.weekStartDate;

      renderAll();
      toast('Data imported successfully.');
    } catch (err) {
      console.error(err);
      toast('Import error: invalid or corrupted file.');
    }
  }

  // ---------------- Toast ----------------
  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3200);
  }

  return { init, state };
})();

document.addEventListener('DOMContentLoaded', App.init);
