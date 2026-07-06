/* models.js
 * Central definitions for roles, days, defaults.
 * Extend here to add new roles / days / pay rules in future.
 */
'use strict';

const ROLES = Object.freeze([
  'Kitchen Morning',
  'Shop Morning',
  'Kitchen Night',
  'Shop Night',
  'Float',
  'Housekeeping',
  'Day Off'
]);

// Roles that actually require staffing coverage (Day Off & Float are special)
const WORK_ROLES = Object.freeze([
  'Kitchen Morning',
  'Shop Morning',
  'Kitchen Night',
  'Shop Night',
  'Housekeeping'
]);

const FLOAT_SUPPORTS = Object.freeze(['Kitchen', 'Housekeeping']);

// Week: Wednesday -> Tuesday
const WEEK_DAYS = Object.freeze(['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue']);
const WEEKEND_DAYS = Object.freeze(['Sat', 'Sun']);

const DEFAULT_RATES = Object.freeze({
  Mon: 32.31, Tue: 32.31, Wed: 32.31, Thu: 32.31, Fri: 32.31,
  Sat: 38.78,
  Sun: 45.24
});

const SHIFT_HOURS = 8;

function isMorningRole(role) {
  return role.includes('Morning');
}
function isNightRole(role) {
  return role.includes('Night');
}
function roleFamily(role) {
  if (role.startsWith('Kitchen')) return 'Kitchen';
  if (role.startsWith('Shop')) return 'Shop';
  if (role === 'Housekeeping') return 'Housekeeping';
  if (role === 'Float') return 'Float';
  return 'Other';
}

function emptyEmployee() {
  return {
    id: null,
    name: '',
    active: true,
    qualifiedRoles: [],   // subset of WORK_ROLES (+ 'Float' implicit if qualified for Kitchen/Housekeeping)
    preferredRoles: [],
    avoidRoles: [],
    shiftPreference: 'None', // 'Morning' | 'Night' | 'None'
    vacationDates: [],    // array of 'YYYY-MM-DD'
    unavailableDates: [],
    notes: ''
  };
}

function newId() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

// eslint-disable-next-line no-unused-vars
const Models = {
  ROLES, WORK_ROLES, FLOAT_SUPPORTS, WEEK_DAYS, WEEKEND_DAYS,
  DEFAULT_RATES, SHIFT_HOURS,
  isMorningRole, isNightRole, roleFamily,
  emptyEmployee, newId
};
