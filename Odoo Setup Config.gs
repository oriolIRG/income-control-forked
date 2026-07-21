/**
 * Setup inicial de la hoja Odoo_Config para el pipeline Pikes → Odoo.
 *
 * Idempotente:
 *   - No borra valores ya rellenados de claves del template actual.
 *   - Añade claves nuevas del template si no existen.
 *   - Purga filas definidas en CATEGORIAS_OBSOLETAS.
 */

const CONFIG_SHEET_NAME = 'Odoo_Config';

const CATEGORIAS_OBSOLETAS = [
  'LOCATION_CC',
  'ANALITICA_SHIFT',
  'ANALITICA_CC',
  'PAGO_CUENTA|TIPS',
  'INGRESO_CUENTA|PREPAYMENT',
  'INGRESO_TAX|PREPAYMENT',
  'COL_HEADER|NET_PREPAYMENT',
];

const LOCATIONS = [
  'POOLBAR', 'RESTAURANT', 'ROOFTOP', 'SHOP', 'POTTING',
  'PORNO', 'ROOMBAR', 'PLAZA MAYOR', 'GARDEN', 'FREDDIES'
];

const CONFIG_TEMPLATE_BASE = [
  // --- PARAMS: conexión Odoo ---
  { categoria: 'PARAM', clave: 'ODOO_URL',        notas: 'URL base. Ej: https://xxx.odoo.com' },
  { categoria: 'PARAM', clave: 'ODOO_DB',         notas: 'Nombre de la base de datos Odoo' },
  { categoria: 'PARAM', clave: 'ODOO_USER',       notas: 'Email / login del usuario Odoo' },
  { categoria: 'PARAM', clave: 'ODOO_UID',        notas: '(opcional) uid cacheado tras primer login' },

  // --- PARAMS: operativa general ---
  { categoria: 'PARAM', clave: 'DIARIO_DEFAULT',  notas: 'journal_id fallback si una LOCATION no define el suyo' },
  { categoria: 'PARAM', clave: 'UMBRAL_CENTIMOS', notas: 'Máx. desfase tolerado en € al cuadrar bruto. Recom: 0.10' },
  { categoria: 'PARAM', clave: 'SHEET_DATOS',     notas: 'Pestaña fuente con los datos brutos. Ej: SALES DATA PIKES' },
  { categoria: 'PARAM', clave: 'SHEET_PREVIEW',   notas: 'Pestaña donde se construye el asiento. Ej: ASIENTOS' },
  { categoria: 'PARAM', clave: 'FILA_CABECERA',   notas: 'Nº de fila donde está la cabecera real en SHEET_DATOS. Ej: 4' },

  // --- PARAMS: envío a Odoo ---
  { categoria: 'PARAM', clave: 'ODOO_POST_AUTOMATICO', notas: 'TRUE = postear tras crear. FALSE / vacío = enviar en draft.' },
  { categoria: 'PARAM', clave: 'BATCH_SIZE',           notas: 'Máx. asientos a enviar por ejecución. Ej: 15. Vacío = 15.' },
  { categoria: 'PARAM', clave: 'CUENTA_AJUSTE',        notas: 'account_id de la 555 (Partidas pendientes). Positivo en sheet = DEBE; negativo = HABER.' },

  // --- LOCATION → journal_id (vacío = usa DIARIO_DEFAULT) ---
  { categoria: 'LOCATION', clave: 'POOLBAR',     notas: 'journal_id específico (vacío = default)' },
  { categoria: 'LOCATION', clave: 'RESTAURANT',  notas: '' },
  { categoria: 'LOCATION', clave: 'ROOFTOP',     notas: '' },
  { categoria: 'LOCATION', clave: 'SHOP',        notas: '' },
  { categoria: 'LOCATION', clave: 'POTTING',     notas: '' },
  { categoria: 'LOCATION', clave: 'PORNO',       notas: '' },
  { categoria: 'LOCATION', clave: 'ROOMBAR',     notas: '' },
  { categoria: 'LOCATION', clave: 'PLAZA MAYOR', notas: '' },
  { categoria: 'LOCATION', clave: 'GARDEN',      notas: '' },
  { categoria: 'LOCATION', clave: 'FREDDIES',    notas: '' },

  // --- COL_HEADER ---
  { categoria: 'COL_HEADER', clave: 'DATE',            notas: 'Cabecera literal de la columna fecha (ej: DATE)' },
  { categoria: 'COL_HEADER', clave: 'LOCATION',        notas: 'Cabecera de la columna location' },
  { categoria: 'COL_HEADER', clave: 'SHIFT',           notas: 'Cabecera de la columna shift (DAYTIME/EVENT)' },
  { categoria: 'COL_HEADER', clave: 'CASH',            notas: 'Cabecera de la columna CASH bruto' },
  { categoria: 'COL_HEADER', clave: 'CREDIT_CARD',     notas: 'Cabecera del bruto tarjeta (incluye tips)' },
  { categoria: 'COL_HEADER', clave: 'CHARGE_TO_ROOM',  notas: 'Cabecera del bruto charge-to-room' },
  { categoria: 'COL_HEADER', clave: 'PREPAYMENT',      notas: 'Cabecera del cobro vía prepayment (anticipos)' },
  { categoria: 'COL_HEADER', clave: 'NET_FOOD',        notas: 'Cabecera del neto FOOD' },
  { categoria: 'COL_HEADER', clave: 'NET_DRINK',       notas: 'Cabecera del neto DRINK' },
  { categoria: 'COL_HEADER', clave: 'NET_MERCH',       notas: 'Cabecera del neto MERCH' },
  { categoria: 'COL_HEADER', clave: 'NET_SERV_CHARGE', notas: 'Cabecera del neto SERV_CHARGE' },
  { categoria: 'COL_HEADER', clave: 'NET_NO_SHOW',     notas: 'Cabecera del neto NO_SHOW / LATE CNX' },
  { categoria: 'COL_HEADER', clave: 'TIPS',            notas: 'Cabecera de la columna TIPS (importe propinas)' },

  // --- INGRESO_CUENTA ---
  { categoria: 'INGRESO_CUENTA', clave: 'FOOD',        notas: 'account_id Odoo (705.xxx)' },
  { categoria: 'INGRESO_CUENTA', clave: 'DRINK',       notas: 'account_id Odoo (705.xxx)' },
  { categoria: 'INGRESO_CUENTA', clave: 'MERCH',       notas: 'account_id Odoo (700.xxx)' },
  { categoria: 'INGRESO_CUENTA', clave: 'SERV_CHARGE', notas: 'account_id Odoo' },
  { categoria: 'INGRESO_CUENTA', clave: 'NO_SHOW',     notas: 'account_id Odoo (759.xxx?)' },
  { categoria: 'INGRESO_CUENTA', clave: 'TIPS',        notas: 'Pasivo por propinas. 465 / 410 / 419' },

  // --- INGRESO_TAX ---
  { categoria: 'INGRESO_TAX', clave: 'FOOD',        notas: 'tax_id IVA 10% (hostelería)' },
  { categoria: 'INGRESO_TAX', clave: 'DRINK',       notas: 'tax_id IVA 10%' },
  { categoria: 'INGRESO_TAX', clave: 'MERCH',       notas: 'tax_id IVA 21%' },
  { categoria: 'INGRESO_TAX', clave: 'SERV_CHARGE', notas: 'tax_id IVA 10%' },
  { categoria: 'INGRESO_TAX', clave: 'NO_SHOW',     notas: 'vacío = sin IVA' },
  { categoria: 'INGRESO_TAX', clave: 'TIPS',        notas: 'vacío = sin IVA (propinas no repercuten)' },

  // --- PAGO_CUENTA ---
  { categoria: 'PAGO_CUENTA', clave: 'CASH',           notas: 'Default. Override opcional por CASH|<LOCATION>' },
  { categoria: 'PAGO_CUENTA', clave: 'CREDIT_CARD',    notas: 'Default. account_id Odoo (572.x o 430.x Square) — incluye propinas' },
  { categoria: 'PAGO_CUENTA', clave: 'CHARGE_TO_ROOM', notas: 'Default. account_id Odoo (puente MEWS)' },
  { categoria: 'PAGO_CUENTA', clave: 'PREPAYMENT',     notas: 'Cuenta de anticipos de clientes (438 / 485). Forma de pago, no ingreso.' },

  // --- ANALITICA ---
  { categoria: 'ANALITICA', clave: 'POOLBAR|DAYTIME',     notas: 'analytic_account_id Odoo' },
  { categoria: 'ANALITICA', clave: 'POOLBAR|EVENT',       notas: '' },
  { categoria: 'ANALITICA', clave: 'RESTAURANT|DAYTIME',  notas: '' },
  { categoria: 'ANALITICA', clave: 'RESTAURANT|EVENT',    notas: '' },
  { categoria: 'ANALITICA', clave: 'ROOFTOP|DAYTIME',     notas: '' },
  { categoria: 'ANALITICA', clave: 'ROOFTOP|EVENT',       notas: '' },
  { categoria: 'ANALITICA', clave: 'SHOP|DAYTIME',        notas: '' },
  { categoria: 'ANALITICA', clave: 'SHOP|EVENT',          notas: '' },
  { categoria: 'ANALITICA', clave: 'POTTING|DAYTIME',     notas: '' },
  { categoria: 'ANALITICA', clave: 'POTTING|EVENT',       notas: '' },
  { categoria: 'ANALITICA', clave: 'PORNO|DAYTIME',       notas: '' },
  { categoria: 'ANALITICA', clave: 'PORNO|EVENT',         notas: '' },
  { categoria: 'ANALITICA', clave: 'ROOMBAR|DAYTIME',     notas: '' },
  { categoria: 'ANALITICA', clave: 'ROOMBAR|EVENT',       notas: '' },
  { categoria: 'ANALITICA', clave: 'PLAZA MAYOR|DAYTIME', notas: '' },
  { categoria: 'ANALITICA', clave: 'PLAZA MAYOR|EVENT',   notas: '' },
  { categoria: 'ANALITICA', clave: 'GARDEN|DAYTIME',      notas: '' },
  { categoria: 'ANALITICA', clave: 'GARDEN|EVENT',        notas: '' },
  { categoria: 'ANALITICA', clave: 'FREDDIES|DAYTIME',    notas: '' },
  { categoria: 'ANALITICA', clave: 'FREDDIES|EVENT',      notas: '' },
];

const CONFIG_TEMPLATE = (function() {
  const result = CONFIG_TEMPLATE_BASE.slice();
  const insertIdx = result.findIndex(x => x.categoria === 'PAGO_CUENTA' && x.clave === 'PREPAYMENT') + 1;
  const overrides = LOCATIONS.map(loc => ({
    categoria: 'PAGO_CUENTA',
    clave: 'CASH|' + loc,
    notas: 'Cuenta caja específica para ' + loc + ' (vacío = usa CASH default)'
  }));
  result.splice(insertIdx, 0, ...overrides);
  return result;
})();


function setupConfigSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG_SHEET_NAME);
    Logger.log('Creada pestaña "' + CONFIG_SHEET_NAME + '"');
  } else {
    Logger.log('Pestaña "' + CONFIG_SHEET_NAME + '" ya existe — se actualizará');
  }

  if (sheet.getLastRow() > 0 && sheet.getLastColumn() > 0) {
    sheet.getDataRange().clearDataValidations();
  }
  sheet.setConditionalFormatRules([]);

  const HEADERS = ['CATEGORIA', 'CLAVE', 'VALOR', 'NOTAS'];
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS])
      .setFontWeight('bold')
      .setBackground('#cfe2f3');
    sheet.setFrozenRows(1);
  }

  const obsoletoCategorias = {};
  const obsoletoClaves = {};
  CATEGORIAS_OBSOLETAS.forEach(entry => {
    if (entry.indexOf('|') === -1) obsoletoCategorias[entry] = true;
    else obsoletoClaves[entry] = true;
  });

  const lastRowBefore = sheet.getLastRow();
  let purged = 0;
  if (lastRowBefore > 1 && CATEGORIAS_OBSOLETAS.length > 0) {
    const rangeAll = sheet.getRange(2, 1, lastRowBefore - 1, 4).getValues();
    for (let i = rangeAll.length - 1; i >= 0; i--) {
      const categoria = rangeAll[i][0];
      const clave = rangeAll[i][1];
      const keyFull = categoria + '|' + clave;
      if (obsoletoCategorias[categoria] || obsoletoClaves[keyFull]) {
        sheet.deleteRow(i + 2);
        purged++;
      }
    }
  }
  if (purged > 0) Logger.log('Filas obsoletas eliminadas: ' + purged);

  const existingKeys = {};
  let sheetDatosValue = null;
  const lastRowAfterPurge = sheet.getLastRow();
  if (lastRowAfterPurge > 1) {
    const existing = sheet.getRange(2, 1, lastRowAfterPurge - 1, 3).getValues();
    existing.forEach(row => {
      if (row[0] && row[1]) existingKeys[row[0] + '|' + row[1]] = true;
      if (row[0] === 'PARAM' && row[1] === 'SHEET_DATOS') sheetDatosValue = row[2];
    });
  }

  if (sheetDatosValue && String(sheetDatosValue).trim().toUpperCase() === 'ASIENTOS') {
    Logger.log('AVISO: SHEET_DATOS = "ASIENTOS". La pestaña fuente debería ser '
             + '"SALES DATA PIKES". Revisa el valor en la hoja Odoo_Config.');
  }

  const rowsToAppend = [];
  let added = 0;
  let skipped = 0;
  let lastCategoria = null;

  CONFIG_TEMPLATE.forEach(item => {
    const key = item.categoria + '|' + item.clave;
    if (existingKeys[key]) { skipped++; return; }
    if (lastCategoria !== null && lastCategoria !== item.categoria && rowsToAppend.length > 0) {
      rowsToAppend.push(['', '', '', '']);
    }
    lastCategoria = item.categoria;
    rowsToAppend.push([item.categoria, item.clave, '', item.notas]);
    added++;
  });

  if (rowsToAppend.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rowsToAppend.length, 4).setValues(rowsToAppend);
  }
  Logger.log('Filas añadidas: ' + added + '. Saltadas (ya existían): ' + skipped);

  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 200);
  sheet.setColumnWidth(3, 220);
  sheet.setColumnWidth(4, 420);

  const dataLastRow = Math.max(sheet.getLastRow(), 2);
  const rule = SpreadsheetApp.newConditionalFormatRule()
    .whenCellEmpty()
    .setBackground('#fce5cd')
    .setRanges([sheet.getRange(2, 3, dataLastRow - 1, 1)])
    .build();
  sheet.setConditionalFormatRules([rule]);

  Logger.log('OK. Rellena la columna VALOR en las filas naranjas y luego ejecuta setOdooApiKey.');
}


function setOdooApiKey() {
  const API_KEY = '';  // <-- pega aquí, ejecuta, borra
  if (!API_KEY) throw new Error('Edita la constante API_KEY antes de ejecutar.');
  PropertiesService.getScriptProperties().setProperty('ODOO_API_KEY', API_KEY);
  Logger.log('ODOO_API_KEY guardada en Script Properties.');
}


function checkConfigPendientes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) { Logger.log('No existe la pestaña Odoo_Config. Ejecuta setupConfigSheet primero.'); return; }

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
  const pendientes = data.filter(r => r[0] && r[1] && (r[2] === '' || r[2] === null));
  if (pendientes.length === 0) {
    Logger.log('Todo rellenado. Odoo_Config lista para usar.');
    return;
  }
  Logger.log('Claves pendientes de rellenar (' + pendientes.length + '):');
  pendientes.forEach(r => Logger.log('  ' + r[0] + ' | ' + r[1] + '   (' + r[3] + ')'));
}