/* db.js
 * IndexedDB storage layer. All persistence goes through this module.
 * Object stores:
 *  - employees
 *  - rosters (history, keep last N)
 *  - settings (rates, floatRequirements, etc, key/value)
 */
'use strict';

const DB_NAME = 'mundrabilla_roster_db';
const DB_VERSION = 1;
const MAX_ROSTER_HISTORY = 10;

const DB = (() => {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('employees')) {
          db.createObjectStore('employees', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('rosters')) {
          const s = db.createObjectStore('rosters', { keyPath: 'id' });
          s.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
  }

  async function tx(storeName, mode) {
    const db = await open();
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---- Employees ----
  async function getAllEmployees() {
    const store = await tx('employees', 'readonly');
    return reqToPromise(store.getAll());
  }
  async function putEmployee(emp) {
    const store = await tx('employees', 'readwrite');
    return reqToPromise(store.put(emp));
  }
  async function deleteEmployee(id) {
    const store = await tx('employees', 'readwrite');
    return reqToPromise(store.delete(id));
  }

  // ---- Settings (key/value) ----
  async function getSetting(key, fallback = null) {
    const store = await tx('settings', 'readonly');
    const res = await reqToPromise(store.get(key));
    return res ? res.value : fallback;
  }
  async function putSetting(key, value) {
    const store = await tx('settings', 'readwrite');
    return reqToPromise(store.put({ key, value }));
  }

  // ---- Rosters (history) ----
  // One roster per calendar week is kept: regenerating the same week replaces
  // its existing entry instead of adding a new one, so re-running the
  // generator several times in one week doesn't crowd out older weeks or
  // over-weight that week in the fairness history.
  async function getAllRosters() {
    const store = await tx('rosters', 'readonly');
    const all = await reqToPromise(store.getAll());
    return all.sort((a, b) => (b.weekStartDate > a.weekStartDate ? 1 : b.weekStartDate < a.weekStartDate ? -1 : b.createdAt - a.createdAt));
  }
  async function putRoster(roster) {
    const store = await tx('rosters', 'readwrite');
    // Remove any other entry for the same calendar week before saving
    // (covers the case where a fresh id was generated for a week that
    // already had a roster stored).
    const all = await reqToPromise(store.getAll());
    const duplicates = all.filter(r => r.weekStartDate === roster.weekStartDate && r.id !== roster.id);
    for (const dup of duplicates) store.delete(dup.id);
    await reqToPromise(store.put(roster));

    // trim history beyond MAX_ROSTER_HISTORY distinct calendar weeks
    const updated = await getAllRosters();
    if (updated.length > MAX_ROSTER_HISTORY) {
      const toRemove = updated.slice(MAX_ROSTER_HISTORY);
      const delStore = await tx('rosters', 'readwrite');
      for (const r of toRemove) delStore.delete(r.id);
    }
    return true;
  }
  async function getRosterByWeek(weekStartDate) {
    const store = await tx('rosters', 'readonly');
    const all = await reqToPromise(store.getAll());
    return all.find(r => r.weekStartDate === weekStartDate) || null;
  }
  async function getRoster(id) {
    const store = await tx('rosters', 'readonly');
    return reqToPromise(store.get(id));
  }

  // ---- Full data export / import (for moving data between devices) ----
  async function exportAllData() {
    const employees = await getAllEmployees();
    const rosters = await getAllRosters();
    const store = await tx('settings', 'readonly');
    const settings = await reqToPromise(store.getAll());
    return {
      exportedAt: Date.now(),
      appVersion: 1,
      employees,
      rosters,
      settings
    };
  }

  async function importAllData(data, mode = 'replace') {
    if (!data || !Array.isArray(data.employees) || !Array.isArray(data.rosters)) {
      throw new Error('Invalid or corrupted data file.');
    }
    if (mode === 'replace') {
      const empStore = await tx('employees', 'readwrite');
      await reqToPromise(empStore.clear());
      const rosterStore = await tx('rosters', 'readwrite');
      await reqToPromise(rosterStore.clear());
      const settingsStore = await tx('settings', 'readwrite');
      await reqToPromise(settingsStore.clear());
    }
    const empStore2 = await tx('employees', 'readwrite');
    for (const emp of data.employees) empStore2.put(emp);
    const rosterStore2 = await tx('rosters', 'readwrite');
    for (const roster of data.rosters) rosterStore2.put(roster);
    const settingsStore2 = await tx('settings', 'readwrite');
    for (const setting of (data.settings || [])) settingsStore2.put(setting);
    return true;
  }

  return {
    getAllEmployees, putEmployee, deleteEmployee,
    getSetting, putSetting,
    getAllRosters, putRoster, getRoster, getRosterByWeek,
    exportAllData, importAllData,
    MAX_ROSTER_HISTORY
  };
})();
