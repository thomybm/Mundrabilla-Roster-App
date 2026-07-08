/* scheduler.js
 * Roster optimization engine.
 * Generates multiple candidate rosters via randomized greedy construction
 * + local-search swap improvement, scores each against weighted priority
 * tiers, and returns the best solution found.
 *
 * Public entry point: Scheduler.generate(options)
 *   options = {
 *     employees: [...active employees...],
 *     floatCounts: { Wed:0, Thu:0, ... },
 *     rates: { Mon:.., Tue:.., ... , Sat:.., Sun:.. },
 *     history: [ {employeeId: {earnings, satShifts, sunShifts, ...}}, ... ] // fairness carry-over
 *     iterations: number (candidate solutions to try)
 *   }
 * Returns: { schedule, score, breakdown, warnings }
 *   schedule[day][role] = [employeeId,...]   (role -> list, usually length 1; Float length = floatCount)
 *   employeeDay[employeeId][day] = [role,...] (usually length 1; length 2 = double shift)
 */
'use strict';

const Scheduler = (() => {

  function isAvailable(emp, dateStr) {
    if (emp.vacationDates.includes(dateStr)) return false;
    if (emp.unavailableDates.includes(dateStr)) return false;
    return true;
  }

  function isQualifiedForRole(emp, role) {
    if (role === 'Day Off') return true;
    if (role === 'Float') {
      // qualifies for float if qualified for Kitchen (any) or Housekeeping
      return emp.qualifiedRoles.some(r => r.startsWith('Kitchen') || r === 'Housekeeping');
    }
    return emp.qualifiedRoles.includes(role);
  }

  function prefScore(emp, role) {
    // +1 preferred, -1 avoid, 0 neutral; also shift preference morning/night
    let s = 0;
    if (emp.preferredRoles.includes(role)) s += 1;
    if (emp.avoidRoles.includes(role)) s -= 2;
    if (emp.shiftPreference === 'Morning' && Models.isMorningRole(role)) s += 0.5;
    if (emp.shiftPreference === 'Night' && Models.isNightRole(role)) s += 0.5;
    return s;
  }

  function dateForDay(weekStartDate, dayIndex) {
    const d = new Date(weekStartDate + 'T00:00:00');
    d.setDate(d.getDate() + dayIndex);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function weekdayNameForDay(dayIndex) {
    return Models.WEEK_DAYS[dayIndex];
  }

  // ---------- Candidate construction (randomized greedy) ----------
  function buildCandidate(employees, floatCounts, rates, history, weekStartDate, rng) {
    const empIds = employees.map(e => e.id);
    const stats = {};
    empIds.forEach(id => {
      const h = (history && history[id]) || {};
      stats[id] = {
        earnings: h.earnings || 0,
        hoursWorked: h.hoursWorked || 0,
        satShifts: h.satShifts || 0,
        sunShifts: h.sunShifts || 0,
        weekendOff: h.weekendOff || 0,
        weekdayOff: h.weekdayOff || 0,
        roleCounts: Object.assign({}, h.roleCounts || {}),
        prefHits: h.prefHits || 0,
        prefMisses: h.prefMisses || 0,
        doubleShifts: 0,
        daysOffThisWeek: [],
        shiftsThisWeek: 0
      };
      Models.ROLES.forEach(r => { if (!(r in stats[id].roleCounts)) stats[id].roleCounts[r] = 0; });
    });

    const employeeDay = {};
    empIds.forEach(id => { employeeDay[id] = {}; });
    const schedule = {};

    const warnings = [];

    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const dayName = weekdayNameForDay(dayIdx);
      const dateStr = dateForDay(weekStartDate, dayIdx);
      schedule[dayName] = {};
      const assignedToday = new Set();

      // Build slot list: work roles first (random tie-break order), then float
      const slots = [...Models.WORK_ROLES];
      const floatN = floatCounts[dayName] || 0;
      for (let f = 0; f < floatN; f++) slots.push('Float');

      for (const role of slots) {
        // candidate employees: available, qualified, not already assigned today (unless double shift needed later)
        let candidates = employees.filter(e =>
          isAvailable(e, dateStr) &&
          isQualifiedForRole(e, role) &&
          !assignedToday.has(e.id)
        );

        if (candidates.length === 0) {
          // Try double-shift fallback: allow already-assigned employees today
          candidates = employees.filter(e =>
            isAvailable(e, dateStr) && isQualifiedForRole(e, role)
          );
          if (candidates.length === 0) {
            warnings.push(`No qualified/available employee for ${role} on ${dayName}.`);
            schedule[dayName][role] = schedule[dayName][role] || [];
            continue;
          }
        }

        // score candidates: lower running load = more likely picked; add randomness + prefs
        const scored = candidates.map(e => {
          const st = stats[e.id];
          const rate = rates[dayName] || 8;
          const loadScore = st.hoursWorked * 0.5 + st.earnings / 100 + st.roleCounts[role] * 2 - prefScore(e, role);
          const doublePenalty = assignedToday.has(e.id) ? 1000 : 0; // heavily discourage double shift
          const noise = rng() * 3;
          return { emp: e, cost: loadScore + doublePenalty + noise };
        });
        scored.sort((a, b) => a.cost - b.cost);
        // pick from top few with weighted randomness for diversity
        const poolSize = Math.min(3, scored.length);
        const pick = scored[Math.floor(rng() * poolSize)].emp;

        schedule[dayName][role] = schedule[dayName][role] || [];
        schedule[dayName][role].push(pick.id);

        const wasAlreadyToday = assignedToday.has(pick.id);
        assignedToday.add(pick.id);

        employeeDay[pick.id][dayName] = employeeDay[pick.id][dayName] || [];
        employeeDay[pick.id][dayName].push(role);

        const st = stats[pick.id];
        const rate = rates[dayName] || 8;
        st.earnings += rate * Models.SHIFT_HOURS;
        st.hoursWorked += Models.SHIFT_HOURS;
        st.roleCounts[role] += 1;
        if (dayName === 'Sat') st.satShifts += 1;
        if (dayName === 'Sun') st.sunShifts += 1;
        if (pick.preferredRoles.includes(role)) st.prefHits += 1;
        if (pick.avoidRoles.includes(role)) st.prefMisses += 1;
        st.shiftsThisWeek += 1;
        if (wasAlreadyToday) {
          st.doubleShifts += 1;
          warnings.push(`${pick.name} double-shifted on ${dayName} (${role}).`);
        }
      }

      // Remaining employees today -> Day Off
      for (const e of employees) {
        if (!assignedToday.has(e.id)) {
          employeeDay[e.id][dayName] = ['Day Off'];
          stats[e.id].roleCounts['Day Off'] += 1;
          stats[e.id].daysOffThisWeek.push(dayName);
          if (Models.WEEKEND_DAYS.includes(dayName)) stats[e.id].weekendOff += 1;
          else stats[e.id].weekdayOff += 1;
        }
      }
    }

    return { schedule, employeeDay, stats, warnings };
  }

  // ---------- Scoring ----------
  function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
  function coefVar(arr) {
    // Coefficient of variation: stddev / mean. Unit-less, so metrics on very
    // different scales (hours vs shift-counts) can be weighted against each
    // other fairly, instead of raw variance (which is dominated by whichever
    // metric happens to have larger absolute numbers).
    const m = mean(arr);
    if (m === 0) return 0;
    return Math.sqrt(variance(arr)) / m;
  }

  function variance(arr) {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length;
  }

  function scoreCandidate(candidate, employees) {
    const { stats, warnings } = candidate;
    const ids = employees.map(e => e.id);

    const unfilled = warnings.filter(w => w.startsWith('No qualified')).length;
    const doubleShifts = ids.reduce((a, id) => a + stats[id].doubleShifts, 0);

    const earningsArr = ids.map(id => stats[id].earnings);
    const hoursArr = ids.map(id => stats[id].hoursWorked);
    const satArr = ids.map(id => stats[id].satShifts);
    const sunArr = ids.map(id => stats[id].sunShifts);
    const weekendOffArr = ids.map(id => stats[id].weekendOff);
    const weekdayOffArr = ids.map(id => stats[id].weekdayOff);

    const earningsVar = variance(earningsArr);
    const hoursVar = variance(hoursArr);
    const satVar = variance(satArr);
    const sunVar = variance(sunArr);
    const offVar = variance(weekendOffArr) + variance(weekdayOffArr);

    // Weekend (Sat+Sun combined) shift distribution, and a normalized comparison
    // between "hours worked per week" and "weekend shift distribution" so neither
    // dominates the other just because it happens to be on a larger numeric scale.
    const weekendArr = ids.map(id => stats[id].satShifts + stats[id].sunShifts);
    const weekendVar = variance(weekendArr);
    const hoursCV = coefVar(hoursArr);
    const weekendCV = coefVar(weekendArr);

    // role distribution variance across all roles
    let roleVarSum = 0;
    Models.ROLES.forEach(r => {
      const arr = ids.map(id => stats[id].roleCounts[r] || 0);
      roleVarSum += variance(arr);
    });

    const prefHits = ids.reduce((a, id) => a + stats[id].prefHits, 0);
    const prefMisses = ids.reduce((a, id) => a + stats[id].prefMisses, 0);

    // consecutive days off bonus
    let consecutiveBonus = 0;
    ids.forEach(id => {
      const offs = stats[id].daysOffThisWeek;
      if (offs.length === 2) {
        const i0 = Models.WEEK_DAYS.indexOf(offs[0]);
        const i1 = Models.WEEK_DAYS.indexOf(offs[1]);
        if (Math.abs(i0 - i1) === 1) consecutiveBonus += 1;
      }
    });

    // Rest-maximizing bonus: for every day off, working a Morning shift the day
    // before (finishes early) and a Night shift the day after (starts late)
    // stretches the unbroken rest window around that day off. Only checked
    // within this week's 7 days (no visibility into the adjoining weeks).
    let restBonus = 0;
    ids.forEach(id => {
      Models.WEEK_DAYS.forEach((day, idx) => {
        const rolesToday = candidate.employeeDay[id][day] || ['Day Off'];
        if (!rolesToday.includes('Day Off')) return;
        if (idx > 0) {
          const prevRoles = candidate.employeeDay[id][Models.WEEK_DAYS[idx - 1]] || ['Day Off'];
          if (prevRoles.some(r => Models.isMorningRole(r))) restBonus += 1;
        }
        if (idx < Models.WEEK_DAYS.length - 1) {
          const nextRoles = candidate.employeeDay[id][Models.WEEK_DAYS[idx + 1]] || ['Day Off'];
          if (nextRoles.some(r => Models.isNightRole(r))) restBonus += 1;
        }
      });
    });

    // Weighted cost: lower is better. Tiers separated by orders of magnitude.
    // "hoursCV * BALANCE_WEIGHT" and "weekendCV * BALANCE_WEIGHT" share the exact
    // same weight on purpose: hours-worked-per-week and weekend (Sat+Sun) shift
    // distribution are treated as equally important, per explicit request — rather
    // than one silently overpowering the other. Sat/Sun still get a small separate
    // nudge below so that, all else equal, each is individually spread out too.
    const BALANCE_WEIGHT = 4000;
    const cost =
      unfilled * 1e9 +
      doubleShifts * 1e4 +
      hoursCV * BALANCE_WEIGHT +
      weekendCV * BALANCE_WEIGHT +
      earningsVar * 50 +
      satVar * 300 +
      sunVar * 300 +
      offVar * 300 +
      roleVarSum * 50 -
      prefHits * 40 +
      prefMisses * 60 -
      consecutiveBonus * 25 -
      restBonus * 15;

    return {
      cost,
      breakdown: {
        unfilled, doubleShifts, earningsVar, hoursVar, hoursCV,
        satVar, sunVar, weekendVar, weekendCV, offVar,
        roleVarSum, prefHits, prefMisses, consecutiveBonus, restBonus
      }
    };
  }

  // simple seeded PRNG for reproducibility per run (optional)
  function mulberry32(seed) {
    return function () {
      let t = (seed += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function generate(options) {
    const {
      employees, floatCounts, rates, history = {}, weekStartDate,
      iterations = 60
    } = options;

    const activeEmployees = employees.filter(e => e.active);
    if (activeEmployees.length === 0) {
      throw new Error('No active employees available to build a roster.');
    }

    let best = null;
    const rng = mulberry32(Date.now() % 2147483647);

    for (let i = 0; i < iterations; i++) {
      const candidate = buildCandidate(activeEmployees, floatCounts, rates, history, weekStartDate, rng);
      const scored = scoreCandidate(candidate, activeEmployees);
      if (!best || scored.cost < best.scored.cost) {
        best = { candidate, scored };
      }
    }

    // Local search: attempt swaps between two employees on the same day to reduce cost
    best = localSearchImprove(best, activeEmployees, floatCounts, rates, history, weekStartDate, 40);

    // Targeted pass: for each day-off, try to swap in a Morning shift the day
    // before and a Night shift the day after (maximizes unbroken rest time).
    best = restOptimizationPass(best, activeEmployees, rates, weekStartDate);

    return {
      schedule: best.candidate.schedule,
      employeeDay: best.candidate.employeeDay,
      stats: best.candidate.stats,
      warnings: best.candidate.warnings,
      cost: best.scored.cost,
      breakdown: best.scored.breakdown
    };
  }

  // Attempts, for every employee's day off, to arrange a Morning shift the day
  // before and a Night shift the day after — by swapping roles with a
  // colleague already working that shift that day, only if both remain
  // qualified for what they end up doing, and only if the swap doesn't make
  // the overall roster worse.
  function restOptimizationPass(best, employees, rates, weekStartDate) {
    const morningRoles = Models.WORK_ROLES.filter(Models.isMorningRole);
    const nightRoles = Models.WORK_ROLES.filter(Models.isNightRole);

    employees.forEach(emp => {
      Models.WEEK_DAYS.forEach((day, idx) => {
        const rolesToday = best.candidate.employeeDay[emp.id][day] || ['Day Off'];
        if (!rolesToday.includes('Day Off')) return;

        // Day before -> aim for a Morning role
        if (idx > 0) {
          best = tryRestSwap(best, employees, emp, Models.WEEK_DAYS[idx - 1], morningRoles, rates, weekStartDate);
        }
        // Day after -> aim for a Night role
        if (idx < Models.WEEK_DAYS.length - 1) {
          best = tryRestSwap(best, employees, emp, Models.WEEK_DAYS[idx + 1], nightRoles, rates, weekStartDate);
        }
      });
    });
    return best;
  }

  function tryRestSwap(best, employees, emp, targetDay, targetRoles, rates, weekStartDate) {
    const currentRoles = best.candidate.employeeDay[emp.id][targetDay] || ['Day Off'];
    if (currentRoles.some(r => targetRoles.includes(r))) return best; // already satisfied
    if (currentRoles.includes('Day Off')) return best; // don't disturb another day off

    const currentRole = currentRoles[0];
    if (!isQualifiedForRole(emp, targetRoles[0]) && !targetRoles.some(r => isQualifiedForRole(emp, r))) return best;

    for (const targetRole of targetRoles) {
      if (!isQualifiedForRole(emp, targetRole)) continue;
      const occupants = best.candidate.schedule[targetDay][targetRole] || [];
      for (const otherId of occupants) {
        if (!otherId || otherId === emp.id) continue;
        const other = employees.find(e => e.id === otherId);
        if (!other || !isQualifiedForRole(other, currentRole)) continue;

        const trial = cloneCandidate(best.candidate);
        // swap: emp takes targetRole, other takes currentRole (on targetDay)
        const roleArr = trial.schedule[targetDay][targetRole];
        const idxInRole = roleArr.indexOf(otherId);
        if (idxInRole === -1) continue;
        roleArr[idxInRole] = emp.id;

        trial.schedule[targetDay][currentRole] = trial.schedule[targetDay][currentRole] || [];
        const currentArr = trial.schedule[targetDay][currentRole];
        const empIdxInCurrent = currentArr.indexOf(emp.id);
        if (empIdxInCurrent !== -1) currentArr[empIdxInCurrent] = otherId;
        else currentArr.push(otherId);

        trial.employeeDay[emp.id][targetDay] = [targetRole];
        trial.employeeDay[otherId][targetDay] = [currentRole];

        recomputeRoleCounts(trial, employees, rates, weekStartDate);
        const scored = scoreCandidate(trial, employees);
        if (scored.cost < best.scored.cost) {
          return { candidate: trial, scored };
        }
      }
    }
    return best;
  }

  function cloneCandidate(c) {
    return JSON.parse(JSON.stringify(c));
  }

  function localSearchImprove(best, employees, floatCounts, rates, history, weekStartDate, tries) {
    const rng = mulberry32(12345);
    for (let t = 0; t < tries; t++) {
      const days = Object.keys(best.candidate.schedule);
      const day = days[Math.floor(rng() * days.length)];
      const roles = Object.keys(best.candidate.schedule[day]).filter(r => best.candidate.schedule[day][r].length > 0);
      if (roles.length < 2) continue;
      const r1 = roles[Math.floor(rng() * roles.length)];
      const r2 = roles[Math.floor(rng() * roles.length)];
      if (r1 === r2) continue;

      const trial = cloneCandidate(best.candidate);
      const id1 = trial.schedule[day][r1][0];
      const id2 = trial.schedule[day][r2][0];
      if (!id1 || !id2 || id1 === id2) continue;

      const e1 = employees.find(e => e.id === id1);
      const e2 = employees.find(e => e.id === id2);
      if (!e1 || !e2) continue;
      if (!isQualifiedForRole(e1, r2) || !isQualifiedForRole(e2, r1)) continue;

      // perform swap in trial
      trial.schedule[day][r1][0] = id2;
      trial.schedule[day][r2][0] = id1;
      trial.employeeDay[id1][day] = [r2];
      trial.employeeDay[id2][day] = [r1];

      // recompute stats roughly by rebuilding role counts (cheap approximation)
      recomputeRoleCounts(trial, employees, rates, weekStartDate);

      const scored = scoreCandidate(trial, employees);
      if (scored.cost < best.scored.cost) {
        best = { candidate: trial, scored };
      }
    }
    return best;
  }

  function recomputeRoleCounts(candidate, employees, rates, weekStartDate) {
    employees.forEach(e => {
      Models.ROLES.forEach(r => { candidate.stats[e.id].roleCounts[r] = 0; });
      candidate.stats[e.id].satShifts = 0;
      candidate.stats[e.id].sunShifts = 0;
      candidate.stats[e.id].earnings = 0;
      candidate.stats[e.id].hoursWorked = 0;
      candidate.stats[e.id].prefHits = 0;
      candidate.stats[e.id].prefMisses = 0;
      candidate.stats[e.id].doubleShifts = 0;
    });
    Models.WEEK_DAYS.forEach(day => {
      employees.forEach(e => {
        const roles = candidate.employeeDay[e.id][day] || ['Day Off'];
        roles.forEach((role, idx) => {
          candidate.stats[e.id].roleCounts[role] = (candidate.stats[e.id].roleCounts[role] || 0) + 1;
          if (role !== 'Day Off') {
            const rate = rates[day] || 8;
            candidate.stats[e.id].earnings += rate * Models.SHIFT_HOURS;
            candidate.stats[e.id].hoursWorked += Models.SHIFT_HOURS;
            if (day === 'Sat') candidate.stats[e.id].satShifts += 1;
            if (day === 'Sun') candidate.stats[e.id].sunShifts += 1;
            if (e.preferredRoles.includes(role)) candidate.stats[e.id].prefHits += 1;
            if (e.avoidRoles.includes(role)) candidate.stats[e.id].prefMisses += 1;
            if (idx > 0) candidate.stats[e.id].doubleShifts += 1;
          }
        });
      });
    });
  }

  return { generate, isQualifiedForRole, isAvailable, dateForDay };
})();
