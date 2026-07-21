// ═══════════════════════════════════════════════════════════════════
// SHEETS.GS
// Gestión de la pestaña de datos con upsert
// ═══════════════════════════════════════════════════════════════════

// ── Cabecera ───────────────────────────────────────────────────────
// Estructura: fecha | location | shift | [CAT | CAT_IVA]... | OTHER | OTHER_IVA |
//             discounts | CASH | CARD | GIFT_CARD | OTHER_PAY |
//             tips | fees | refunds | order_count | last_synced | status
function buildHeader(configCategories) {
  const catCols = [];
  for (const cc of configCategories) {
    catCols.push(cc.label);
    catCols.push(cc.label + '_IVA');
  }
  catCols.push('OTHER', 'OTHER_IVA');

  return [
    'reporting_date', 'location', 'shift',
    ...catCols,
    // Formas de pago (el total de cada columna ya neta refunds)
    'CASH', 'CARD', 'GIFT_CARD', 'WALLET', 'CHECK_PMT', 'BANK_TRANSFER', 'OTHER_PAY',
    // Informativos
    'discounts', 'tips', 'fees', 'refunds',
    // Check de cuadre
    'total_ventas', 'total_cobros', 'CUADRE',
    'order_count', 'last_synced', 'status'
  ];
}

function ensureDataSheetHeader(configCategories) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(DATA_SHEET);
  if (!sh) sh = ss.insertSheet(DATA_SHEET);
  const header = buildHeader(configCategories);
  const headerRange = sh.getRange(1, 1, 1, header.length);
  headerRange.setValues([header]);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#f3f3f3');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 120); // reporting_date
  return sh;
}

// ── Upsert ─────────────────────────────────────────────────────────
// Clave: reporting_date + location + shift (columnas 1–3)
// - Si la clave ya existe y los datos cambiaron → UPDATE + status = 'UPDATED'
// - Si no existe → INSERT + status = 'NEW'
// - Si existe y es idéntica → UPDATE last_synced, status = 'OK'
function upsertRows(rows, configCategories) {
  if (!rows || !rows.length) return;

  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const sh     = ss.getSheetByName(DATA_SHEET) || ensureDataSheetHeader(configCategories);
  const header = buildHeader(configCategories);
  const now    = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

  const lastRow = sh.getLastRow();

  // ── 1. Leer SOLO las 3 columnas clave para el lookup por (date, loc, shift) ──
  // Esto es robusto a reordenaciones del sheet: la posición física de cada
  // fila se recalcula cada vez que sincronizamos.
  const keyToRow = {};
  if (lastRow >= 2) {
    const keysData = sh.getRange(2, 1, lastRow - 1, 3).getValues();
    keysData.forEach((kr, i) => {
      const dateStr = kr[0] instanceof Date
        ? Utilities.formatDate(kr[0], TIMEZONE, 'yyyy-MM-dd')
        : String(kr[0]).trim();
      keyToRow[`${dateStr}||${kr[1]}||${kr[2]}`] = i + 2;
    });
  }

  // ── 2. Para cada row, decidir si es UPDATE o INSERT ─────────────
  // Para los UPDATE, leemos la fila actual del sheet para detectar cambios
  // (no podemos basarnos en el array 'existing' porque puede estar reordenado).
  const toInsert = [];
  const toUpdate = {}; // { sheetRowIdx → newRowArray }

  for (const row of rows) {
    const k = `${row.reporting_date}||${row.location}||${row.shift}`;

    if (keyToRow[k]) {
      const sheetRowIdx = keyToRow[k];
      // Leer la fila ACTUAL desde el sheet (por si fue reordenada)
      const oldRow = sh.getRange(sheetRowIdx, 1, 1, header.length).getValues()[0];
      const oldCore = oldRow.map(v =>
        v instanceof Date ? Utilities.formatDate(v, TIMEZONE, 'yyyy-MM-dd') : v
      ).slice(0, -2); // sin last_synced y status

      const newCore = _rowToArray(row, header, now, 'PLACEHOLDER').slice(0, -2);

      const changed = newCore.some((v, i) => {
        if (typeof v === 'number' && typeof oldCore[i] === 'number')
          return Math.abs(v - oldCore[i]) > 0.001;
        return String(v) !== String(oldCore[i]);
      });

      toUpdate[sheetRowIdx] = _rowToArray(row, header, now, changed ? 'UPDATED' : 'OK');
    } else {
      toInsert.push(_rowToArray(row, header, now, 'NEW'));
    }
  }

  // ── 3. Escribir updates uno a uno (sin batching por contigüidad) ──
  // Antes batcheábamos filas físicamente contiguas, pero eso era frágil:
  // dos filas con índices 50 y 51 podían pertenecer a días distintos
  // tras una reordenación. Escribir una por una es más lento pero
  // 100% correcto. Para pocos cientos de filas el coste es asumible.
  Object.entries(toUpdate).forEach(([sheetRowIdx, arr]) => {
    sh.getRange(parseInt(sheetRowIdx), 1, 1, header.length).setValues([arr]);
  });

  // ── 4. Insertar nuevas filas al final ───────────────────────────
  if (toInsert.length) {
    sh.getRange(sh.getLastRow() + 1, 1, toInsert.length, header.length).setValues(toInsert);
  }

  logMessage('INFO', `  Upsert: ${toInsert.length} nuevas, ${Object.keys(toUpdate).length} actualizadas/revisadas`);
}


function _rowToArray(row, header, nowStr, status) {
  // total_ventas = ventas netas de producto (con refunds descontados)
  const catGrossTotal = Object.values(row.catGross).reduce((s, v) => s + v, 0);
  const payMethodsTotal = row.cash + row.card + row.gift_card + row.wallet
    + row.check_pmt + row.bank_transfer + row.other_pay;

  const totalVentas = _cents(catGrossTotal + row.tips); // (47750+393)/100 = 481.43
  const totalCobros = _cents(payMethodsTotal);           // 48143/100 = 481.43
  const cuadre      = Math.round((totalVentas - totalCobros) * 100) / 100; // 0.00 ✓

  return header.map(col => {
    switch (col) {
      case 'reporting_date': return row.reporting_date;
      case 'location': return row.location;
      case 'shift': return row.shift;
      case 'discounts': return _cents(row.discounts);
      case 'CASH': return _cents(row.cash);
      case 'CARD': return _cents(row.card);
      case 'GIFT_CARD': return _cents(row.gift_card);
      case 'WALLET': return _cents(row.wallet);
      case 'CHECK_PMT': return _cents(row.check_pmt);
      case 'BANK_TRANSFER': return _cents(row.bank_transfer);
      case 'OTHER_PAY': return _cents(row.other_pay);
      case 'tips': return _cents(row.tips);
      case 'fees': return _cents(row.fees);
      case 'refunds': return _cents(row.refunds);
      case 'total_ventas': return totalVentas;
      case 'total_cobros': return totalCobros;
      case 'CUADRE': return cuadre;
      case 'order_count': return row.order_count;
      case 'last_synced': return nowStr;
      case 'status': return status;
      default:
        if (col.endsWith('_IVA')) return _cents(row.catTax[col.slice(0, -4)] || 0);
        return _cents(row.catGross[col] || 0);
    }
  });
}

function _cents(v) { return Math.round(v || 0) / 100; }

// ── Log ────────────────────────────────────────────────────────────
function logMessage(level, message) {
  Logger.log(`[${level}] ${message}`);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh   = ss.getSheetByName(LOG_SHEET);
    if (!sh) sh = ss.insertSheet(LOG_SHEET);
    const ts = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    sh.appendRow([ts, level, message]);
    // Mantener máximo 1000 filas de log
    if (sh.getLastRow() > 1001) sh.deleteRow(2);
  } catch(e) { Logger.log('Error en log: ' + e); }
}

const DISCOUNT_SHEET = '📊 Descuentos';

function upsertDiscountRows(rows) {
  if (!rows || !rows.length) return;

  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  let sh       = ss.getSheetByName(DISCOUNT_SHEET);
  const header = ['reporting_date','location','shift','discount_name','discount_type','category','has_tender','gross_amount','order_count','last_synced'];

  if (!sh) {
    sh = ss.insertSheet(DISCOUNT_SHEET);
  }
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#f3f3f3');
  sh.setFrozenRows(1);

  const now     = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  const lastRow = sh.getLastRow();

  // Leer solo las columnas clave para el lookup: date, loc, shift, name, category, has_tender
  // (índices 0,1,2,3,5,6 — saltamos discount_type que no es parte de la clave)
  const keyToRow = {};
  if (lastRow >= 2) {
    const keysData = sh.getRange(2, 1, lastRow - 1, 7).getValues();
    keysData.forEach((kr, i) => {
      const dateStr = kr[0] instanceof Date
        ? Utilities.formatDate(kr[0], TIMEZONE, 'yyyy-MM-dd')
        : String(kr[0]).trim();
      keyToRow[`${dateStr}||${kr[1]}||${kr[2]}||${kr[3]}||${kr[5]}||${kr[6]}`] = i + 2;
    });
  }

  const toInsert = [];
  const toUpdate = {};

  for (const row of rows) {
    const k   = `${row.reporting_date}||${row.location}||${row.shift}||${row.discount_name}||${row.category}||${row.has_tender}`;
    const arr = [
      row.reporting_date, row.location, row.shift,
      row.discount_name, row.discount_type, row.category,
      row.has_tender, _cents(row.gross_amount), row.order_count, now
    ];

    if (keyToRow[k]) {
      toUpdate[keyToRow[k]] = arr;
    } else {
      toInsert.push(arr);
    }
  }

  // Escribir updates uno a uno (robusto a reordenaciones)
  Object.entries(toUpdate).forEach(([sheetRowIdx, arr]) => {
    sh.getRange(parseInt(sheetRowIdx), 1, 1, header.length).setValues([arr]);
  });

  if (toInsert.length) {
    sh.getRange(sh.getLastRow() + 1, 1, toInsert.length, header.length).setValues(toInsert);
  }

  logMessage('INFO', `  Descuentos: ${toInsert.length} nuevas, ${Object.keys(toUpdate).length} actualizadas`);
}