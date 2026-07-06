/* stats.js
 * Fairness statistics, historical aggregation, and Roster Quality Score.
 * Kept separate from the scheduler so the dashboard can recompute stats
 * after manual edits without re-running optimization.
 */
'use strict';

const Stats = (() => {

  function computeFromEmployeeDay(employees, employeeDay, rates) {
    const perEmployee = {};
    employees.forEach(e => {
      const roleCounts = {};
      Models.ROLES.forEach(r => roleCounts[r] = 0);
      perEmployee[e.id] = {
        id: e.id, name: e.name,
        earnings: 0, hoursWorked: 0, satShifts: 0, sunShifts: 0,
        weekendOff: 0, weekdayOff: 0,
        roleCounts, prefHits: 0, prefMisses: 0,
        doubleShifts: 0, daysOff: []
      };
    });

    Models.WEEK_DAYS.forEach(day => {
      employees.forEach(e => {
        const roles = (employeeDay[e.id] && employeeDay[e.id][day]) || ['Day Off'];
        const st = perEmployee[e.id];
        roles.forEach((role, idx) => {
          st.roleCounts[role] = (st.roleCounts[role] || 0) + 1;
          if (role === 'Day Off') {
            st.daysOff.push(day);
            if (Models.WEEKEND_DAYS.includes(day)) st.weekendOff += 1;
            else st.weekdayOff += 1;
          } else {
            const rate = rates[day] || 8;
            st.earnings += rate * Models.SHIFT_HOURS;
            st.hoursWorked += Models.SHIFT_HOURS;
            if (day === 'Sat') st.satShifts += 1;
            if (day === 'Sun') st.sunShifts += 1;
            if (e.preferredRoles.includes(role)) st.prefHits += 1;
            if (e.avoidRoles.includes(role)) st.prefMisses += 1;
            if (idx > 0) st.doubleShifts += 1;
          }
        });
      });
    });
    return perEmployee;
  }

  function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
  function stddev(arr) {
    if (arr.length === 0) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length);
  }

  // Roster Quality Score: 0-100, higher is better.
  function qualityScore(perEmployee, warnings) {
    const ids = Object.keys(perEmployee);
    if (ids.length === 0) return 0;
    const earnings = ids.map(id => perEmployee[id].earnings);
    const sat = ids.map(id => perEmployee[id].satShifts);
    const sun = ids.map(id => perEmployee[id].sunShifts);
    const doubleShifts = ids.reduce((a, id) => a + perEmployee[id].doubleShifts, 0);
    const prefHits = ids.reduce((a, id) => a + perEmployee[id].prefHits, 0);
    const prefMisses = ids.reduce((a, id) => a + perEmployee[id].prefMisses, 0);
    const unfilled = (warnings || []).filter(w => w.startsWith('No qualified')).length;

    const earnMean = mean(earnings) || 1;
    const earnCV = stddev(earnings) / earnMean; // coefficient of variation
    const satSpread = stddev(sat);
    const sunSpread = stddev(sun);

    let score = 100;
    score -= Math.min(40, earnCV * 100);      // earnings balance
    score -= Math.min(15, satSpread * 10);
    score -= Math.min(15, sunSpread * 10);
    score -= Math.min(15, doubleShifts * 5);
    score -= Math.min(10, prefMisses * 2);
    score += Math.min(5, prefHits * 0.5);
    score -= unfilled * 25;

    return Math.max(0, Math.round(score * 10) / 10);
  }

  // Combine current + historical rosters (up to 5) for long-term fairness view
  function aggregateHistory(historyRosters) {
    const agg = {};
    historyRosters.forEach(roster => {
      Object.values(roster.perEmployee || {}).forEach(st => {
        if (!agg[st.id]) {
          agg[st.id] = {
            id: st.id, name: st.name, earnings: 0, hoursWorked: 0, satShifts: 0, sunShifts: 0,
            weekendOff: 0, weekdayOff: 0, roleCounts: {}, prefHits: 0, prefMisses: 0,
            doubleShifts: 0, rosterCount: 0
          };
          Models.ROLES.forEach(r => agg[st.id].roleCounts[r] = 0);
        }
        const a = agg[st.id];
        a.earnings += st.earnings;
        a.hoursWorked += (st.hoursWorked || 0);
        a.satShifts += st.satShifts;
        a.sunShifts += st.sunShifts;
        a.weekendOff += st.weekendOff;
        a.weekdayOff += st.weekdayOff;
        a.prefHits += st.prefHits;
        a.prefMisses += st.prefMisses;
        a.doubleShifts += st.doubleShifts;
        a.rosterCount += 1;
        Models.ROLES.forEach(r => a.roleCounts[r] += (st.roleCounts[r] || 0));
      });
    });
    return agg;
  }

  return { computeFromEmployeeDay, qualityScore, aggregateHistory, mean, stddev };
})();
