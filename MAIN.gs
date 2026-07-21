// ═══════════════════════════════════════════════════════════════════
// MAIN.GS
// Menú, triggers y orquestación
// ═══════════════════════════════════════════════════════════════════
//
// CAMBIOS — Soporte para offline payments
// ───────────────────────────────────────
// 1. La ventana de fetch se amplía con OFFLINE_LOOKAHEAD_DAYS días
//    POR DELANTE del reporting day, para capturar pagos sincronizados
//    tarde tras un corte de internet en los Square Terminals.
//
// 2. `syncYesterday` ahora re-sincroniza los últimos
//    OFFLINE_LOOKBACK_DAYS días, no solo ayer. El upsert con status
//    UPDATED detecta automáticamente las correcciones offline.
//
// 3. Se construye un mapa order_id → ts_real desde los offline payments
//    y se pasa a buildRows / buildDiscountRows para que los reportes
//    tengan el reporting_date correcto.
// ═══════════════════════════════════════════════════════════════════

// ── Tunables para offline payments ─────────────────────────────────
// Por delante: cuántos días futuros se consultan para capturar pagos
// offline sincronizados tarde. Square típicamente sincroniza en horas,
// pero un terminal apagado durante días puede retrasarlo. 14 = margen
// muy seguro; bájalo a 7 si el coste de API es importante.
const OFFLINE_LOOKAHEAD_DAYS = 4;

// Por detrás: cuántos días pasados re-procesa el sync diario. Esto
// permite que las correcciones offline tardías (registradas hoy pero
// con client_created_at = hace X días) se reflejen en sus reporting
// days correctos.
const OFFLINE_LOOKBACK_DAYS = 4;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🍺 Square Sync')
    .addItem('▶ Sincronizar ayer (+ últimos ' + OFFLINE_LOOKBACK_DAYS + ' días)', 'syncYesterday')
    .addItem('▶ Sincronizar rango…', 'syncRangeDialog')
    .addSeparator()
    .addItem('🔑 Guardar token Square', 'promptSaveToken')
    .addItem('🔄 Reconstruir cabecera', 'promptRebuildHeader')
    .addItem('📋 Crear pestañas de config (si no existen)', 'createConfigSheets')
    .addSeparator()
    .addItem('testOdooAuth', 'testOdooAuth')
    .addItem('sendToOdooDryRun', 'sendToOdooDryRun')
    .addItem('sendToOdoo', 'sendToOdoo')
    .addItem("Actualizar datos desde Odoo", "fetchOdooAudit")
    .addToUi();
}

// ── Trigger diario ────────────────────────────────────────────────
function dailySync() { syncYesterday(); }

// ── Sync re-procesa los últimos N días ────────────────────────────
// CAMBIO: en vez de solo "ayer y antes de ayer", procesa los últimos
// OFFLINE_LOOKBACK_DAYS para capturar correcciones offline tardías.
function syncYesterday() {
  const dates = [];
  for (let i = 1; i <= OFFLINE_LOOKBACK_DAYS; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd'));
  }
  _runSync(dates);
}

// ── Sync por rango de fechas ──────────────────────────────────────
function syncRangeDialog() {
  const ui  = SpreadsheetApp.getUi();
  const res = ui.prompt(
    'Sincronizar rango de fechas',
    'Formato: 2026-01-01:2026-01-31',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const parts = res.getResponseText().split(':').map(s => s.trim());
  if (parts.length !== 2) { ui.alert('❌ Formato incorrecto.'); return; }

  const dates = _buildDateRange(parts[0], parts[1]);
  _runSync(dates);
  ui.alert(`✅ Sincronizados ${dates.length} días para todas las locations activas.`);
}

function _buildDateRange(startStr, endStr) {
  const dates = [];
  const s = new Date(startStr + 'T12:00:00Z');
  const e = new Date(endStr   + 'T12:00:00Z');
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

// ── Core sync ─────────────────────────────────────────────────────
function _runSync(reportingDates) {
  if (PropertiesService.getScriptProperties().getProperty('SYNC_ACTIVE') === 'true') {
    logMessage('WARN', 'Había un checkpoint activo — se sobreescribe con el nuevo sync.');
    ScriptApp.getProjectTriggers()
      .filter(t => t.getHandlerFunction() === 'continueSyncFromCheckpoint')
      .forEach(t => ScriptApp.deleteTrigger(t));
  }
  _clearCheckpoint();
  _runSyncFromCheckpoint(reportingDates, 0, 0);
}

function _runSyncFromCheckpoint(reportingDates, startLocIdx, startDateIdx) {
  if (!getSquareToken()) throw new Error('No hay SQUARE_TOKEN.');

  const locations        = getLocations();
  const shifts           = getShifts();
  const configCategories = getCategories();

  if (!locations.length) throw new Error('No hay locations activas.');

  ensureDataSheetHeader(configCategories);

  logMessage('INFO', `═══ Sync: ${reportingDates.length} día(s), ${locations.length} location(s) ═══`);

  logMessage('INFO', 'Descargando catálogo...');
  const catalog       = fetchCatalog();
  const itemCatMap    = buildItemCategoryMap(catalog);
  const catResMap     = buildCategoryResolutionMap(catalog, configCategories);

  const startTime = Date.now();
  const MAX_MS    = 5 * 60 * 1000;

  for (let li = startLocIdx; li < locations.length; li++) {
    const loc         = locations[li];
    const startDi     = (li === startLocIdx) ? startDateIdx : 0;

    for (let di = startDi; di < reportingDates.length; di++) {
      if (Date.now() - startTime > MAX_MS) {
        _saveCheckpoint(reportingDates, li, di);
        _scheduleContinuation();
        logMessage('INFO', `⏸ Pausado en ${loc.name} / ${reportingDates[di]}`);
        return;
      }

      try {
        _syncOneDay(loc, reportingDates[di], shifts, configCategories, itemCatMap, catResMap);
      } catch (e) {
        logMessage('ERROR', `[${loc.name}][${reportingDates[di]}] ${e.message}`);
      }
    }
  }

  _clearCheckpoint();
  logMessage('INFO', '═══ Sync completado ═══');
}

function _syncOneDay(loc, reportingDate, shifts, configCategories, itemCatMap, catResMap) {
  const [y, m, day] = reportingDate.split('-').map(Number);

  // ── Ventana UTC AMPLIADA por delante ─────────────────────────
  // Captura pagos sincronizados tarde (offline mode) cuyo client_created_at
  // pueda corresponder a este reporting_date.
  // - Por detrás: 1 día (margen para tickets cerca de la frontera 06:00).
  // - Por delante: OFFLINE_LOOKAHEAD_DAYS (14 por defecto).
  const beginUTC = new Date(Date.UTC(y, m - 1, day - 1, 0, 0, 0)).toISOString();
  const endUTC   = new Date(Date.UTC(y, m - 1, day + OFFLINE_LOOKAHEAD_DAYS, 23, 59, 59)).toISOString();

  logMessage('INFO', `▸ ${loc.name} / ${reportingDate}  (fetch UTC ${beginUTC.substring(0,10)} → ${endUTC.substring(0,10)})`);

  const allOrders   = fetchOrders(loc.id, beginUTC, endUTC);
  const allPayments = fetchPayments(loc.id, beginUTC, endUTC);
  const allRefunds  = fetchRefunds(loc.id, beginUTC, endUTC);

  // ── Mapa order_id → ts_real desde offline payments ─────────────
  const orderEffTsMap = buildOrderEffectiveTsMap(allPayments);
  const offlineCount  = Object.keys(orderEffTsMap).length;
  if (offlineCount) {
    logMessage('INFO', `  ${offlineCount} order(s) con offline payment detectados — usando client_created_at`);
  }

  // ── Filtrado al reporting_date usando timestamps efectivos ─────
  const orders = allOrders.filter(o => {
    const ts = getOrderEffectiveTs(o, orderEffTsMap);
    return ts && getReportingDate(ts) === reportingDate;
  });
  const payments = allPayments.filter(p => {
    const ts = getPaymentEffectiveTs(p);
    return ts && getReportingDate(ts) === reportingDate;
  });
  const refunds = allRefunds.filter(r => r.created_at && getReportingDate(r.created_at) === reportingDate);

  logMessage('INFO', `  órdenes:${orders.length} payments:${payments.length} refunds:${refunds.length}`);

  if (!orders.length && !payments.length && !refunds.length) {
    logMessage('INFO', '  Sin datos para este día/location. Saltando.');
    return;
  }

  const rows = buildRows(orders, payments, refunds, loc, shifts, configCategories, itemCatMap, catResMap, orderEffTsMap);
  upsertRows(rows, configCategories);

  const discountRows = buildDiscountRows(orders, loc, shifts, itemCatMap, catResMap, orderEffTsMap);
  if (discountRows.length) upsertDiscountRows(discountRows);
}

// ── Helpers de menú ───────────────────────────────────────────────
function promptSaveToken() {
  const ui  = SpreadsheetApp.getUi();
  const res = ui.prompt('Square Token', 'Pega tu SQUARE_ACCESS_TOKEN (se guardará en PropertiesService, no en el código):', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  setSquareToken(res.getResponseText().trim());
  ui.alert('✅ Token guardado de forma segura en PropertiesService.');
}

function promptRebuildHeader() {
  ensureDataSheetHeader(getCategories());
  SpreadsheetApp.getUi().alert('✅ Cabecera reconstruida con la configuración actual de categorías.');
}

function createConfigSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  function createIfMissing(name, headers, sampleRow) {
    if (ss.getSheetByName(name)) return;
    const sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#f3f3f3');
    if (sampleRow) sh.getRange(2, 1, 1, sampleRow.length).setValues([sampleRow]).setFontStyle('italic').setFontColor('#999999');
    sh.setFrozenRows(1);
  }

  createIfMissing('📍 Locations',
    ['Nombre', 'Square Location ID', 'Activa'],
    ['Poolbar', 'LHXWC3DTV5D8V', 'TRUE']
  );

  createIfMissing('🕐 Shifts',
    ['Location', 'DOW (0=Dom…6=Sáb)', 'Desde (HH:mm)', 'Hasta (HH:mm)', 'Nombre Shift'],
    ['Poolbar', 0, '06:00', '11:00', 'DAYTIME']
  );

  createIfMissing('📋 Categorías',
    ['Etiqueta (tu nombre)', 'IDs Square (coma si hay varios)'],
    ['BEBIDAS', 'abc123,def456']
  );

  createIfMissing(DATA_SHEET, [], null);
  createIfMissing(LOG_SHEET, ['Timestamp', 'Level', 'Mensaje'], null);

  SpreadsheetApp.getUi().alert(
    '✅ Pestañas creadas:\n\n' +
    '📍 Locations — añade tus locations de Square\n' +
    '🕐 Shifts    — define los shifts por día y location\n' +
    '📋 Categorías — mapea tus categorías top-level\n' +
    '📊 Datos     — aquí aparecerán los datos\n' +
    '📝 Log       — registro de ejecuciones\n\n' +
    'Guarda el token desde el menú 🍺 Square Sync → 🔑 Guardar token Square'
  );
}

function syncDiscountsRangeDialog() {
  const ui  = SpreadsheetApp.getUi();
  const res = ui.prompt(
    'Sincronizar descuentos por rango',
    'Formato: 2026-04-01:2026-04-15',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const parts = res.getResponseText().split(':').map(s => s.trim());
  if (parts.length !== 2) { ui.alert('❌ Formato incorrecto.'); return; }

  const dates = _buildDateRange(parts[0], parts[1]);
  _runDiscountsOnly(dates);
  ui.alert(`✅ Descuentos sincronizados: ${dates.length} días.`);
}

function _runDiscountsOnly(reportingDates) {
  if (!getSquareToken()) throw new Error('No hay SQUARE_TOKEN.');

  const locations = getLocations();
  const shifts    = getShifts();

  logMessage('INFO', `═══ Sync descuentos: ${reportingDates.length} día(s) ═══`);

  logMessage('INFO', 'Descargando catálogo...');
  const catalog    = fetchCatalog();
  const itemCatMap = buildItemCategoryMap(catalog);
  const catResMap  = buildCategoryResolutionMap(catalog, getCategories());

  for (const loc of locations) {
    for (const date of reportingDates) {
      try {
        const [y, m, day] = date.split('-').map(Number);
        const beginUTC = new Date(Date.UTC(y, m - 1, day - 1, 0, 0, 0)).toISOString();
        const endUTC   = new Date(Date.UTC(y, m - 1, day + OFFLINE_LOOKAHEAD_DAYS, 23, 59, 59)).toISOString();

        const allOrders   = fetchOrders(loc.id, beginUTC, endUTC);
        const allPayments = fetchPayments(loc.id, beginUTC, endUTC);

        const orderEffTsMap = buildOrderEffectiveTsMap(allPayments);

        const orders = allOrders.filter(o => {
          const ts = getOrderEffectiveTs(o, orderEffTsMap);
          return ts && getReportingDate(ts) === date;
        });

        if (!orders.length) continue;

        logMessage('INFO', `▸ ${loc.name} / ${date} — ${orders.length} órdenes`);
        const discountRows = buildDiscountRows(orders, loc, shifts, itemCatMap, catResMap, orderEffTsMap);
        if (discountRows.length) upsertDiscountRows(discountRows);

      } catch(e) {
        logMessage('ERROR', `[${loc.name}][${date}] ${e.message}`);
      }
    }
  }

  logMessage('INFO', '═══ Sync descuentos completado ═══');
}

// ── Checkpoint helpers ─────────────────────────────────────────────
function _saveCheckpoint(dates, locationIndex, dateIndex) {
  PropertiesService.getScriptProperties().setProperties({
    'SYNC_DATES'    : JSON.stringify(dates),
    'SYNC_LOC_IDX'  : String(locationIndex),
    'SYNC_DATE_IDX' : String(dateIndex),
    'SYNC_ACTIVE'   : 'true'
  });
}

function _clearCheckpoint() {
  PropertiesService.getScriptProperties().deleteProperty('SYNC_DATES');
  PropertiesService.getScriptProperties().deleteProperty('SYNC_LOC_IDX');
  PropertiesService.getScriptProperties().deleteProperty('SYNC_DATE_IDX');
  PropertiesService.getScriptProperties().deleteProperty('SYNC_ACTIVE');
}

function _loadCheckpoint() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SYNC_ACTIVE') !== 'true') return null;
  return {
    dates    : JSON.parse(props.getProperty('SYNC_DATES') || '[]'),
    locIdx   : parseInt(props.getProperty('SYNC_LOC_IDX')  || '0'),
    dateIdx  : parseInt(props.getProperty('SYNC_DATE_IDX') || '0')
  };
}

function _scheduleContinuation() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'continueSyncFromCheckpoint')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('continueSyncFromCheckpoint')
    .timeBased()
    .after(60 * 1000)
    .create();
  logMessage('INFO', '⏸ Tiempo límite cercano — continuación programada en 1 minuto');
}

function continueSyncFromCheckpoint() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'continueSyncFromCheckpoint')
    .forEach(t => ScriptApp.deleteTrigger(t));

  const checkpoint = _loadCheckpoint();
  if (!checkpoint) {
    logMessage('INFO', 'No hay checkpoint activo.');
    return;
  }
  logMessage('INFO', `▶ Continuando sync desde checkpoint: loc[${checkpoint.locIdx}] date[${checkpoint.dateIdx}]`);
  _runSyncFromCheckpoint(checkpoint.dates, checkpoint.locIdx, checkpoint.dateIdx);
}