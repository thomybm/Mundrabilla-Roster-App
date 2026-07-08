/* export.js
 * Exports the current roster to an .xlsx file, preserving the app's
 * role-row layout and colour coding using SheetJS (vendor/xlsx.full.min.js).
 */
'use strict';

const ExportXLSX = (() => {

  const ROLE_COLORS = {
    'Kitchen Morning': 'FFFDE68A',
    'Shop Morning': 'FFBFDBFE',
    'Kitchen Night': 'FFFCA5A5',
    'Shop Night': 'FFC7D2FE',
    'Float': 'FFD9F99D',
    'Housekeeping': 'FFFBCFE8',
    'Day Off': 'FFE5E7EB'
  };

  function exportRoster(schedule, employeeDay, employees, weekStartDate) {
    const wb = XLSX.utils.book_new();
    const wsData = [];
    const header = ['Role', ...Models.WEEK_DAYS];
    wsData.push(header);

    Models.ROLES.forEach(role => {
      const row = [role];
      Models.WEEK_DAYS.forEach(day => {
        if (role === 'Day Off') {
          const names = employees
            .filter(e => ((employeeDay[e.id] && employeeDay[e.id][day]) || []).includes('Day Off'))
            .map(e => e.name);
          row.push(names.join(', '));
        } else {
          const ids = (schedule[day] && schedule[day][role]) || [];
          const names = ids.map(id => {
            const emp = employees.find(e => e.id === id);
            return emp ? emp.name : '(unfilled)';
          });
          row.push(names.join(', '));
        }
      });
      wsData.push(row);
    });

    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Column widths
    ws['!cols'] = [{ wch: 18 }, ...Models.WEEK_DAYS.map(() => ({ wch: 20 }))];

    // Apply fill colour per role row + bold header
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r; R <= range.e.r; R++) {
      for (let C = range.s.c; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        if (!ws[addr]) continue;
        ws[addr].s = ws[addr].s || {};
        if (R === 0) {
          ws[addr].s = {
            font: { bold: true, color: { rgb: 'FF1F2937' } },
            fill: { fgColor: { rgb: 'FFE5E7EB' } },
            alignment: { horizontal: 'center' }
          };
        } else if (C === 0) {
          const role = Models.ROLES[R - 1];
          ws[addr].s = {
            font: { bold: true },
            fill: { fgColor: { rgb: ROLE_COLORS[role] || 'FFFFFFFF' } }
          };
        } else {
          const role = Models.ROLES[R - 1];
          ws[addr].s = {
            fill: { fgColor: { rgb: ROLE_COLORS[role] || 'FFFFFFFF' } },
            alignment: { wrap_text: true, vertical: 'top' }
          };
        }
      }
    }

    XLSX.utils.book_append_sheet(wb, ws, 'Roster');

    const fname = `Mundrabilla_Roster_${weekStartDate}.xlsx`;
    XLSX.writeFile(wb, fname, { bookType: 'xlsx', cellStyles: true });
  }

  return { exportRoster };
})();
