/**
 * Envío de asientos de la pestaña ASIENTOS a Odoo (vía XML-RPC).
 *
 * Filosofía:
 *   - Lee la pestaña SHEET_PREVIEW (ASIENTOS).
 *   - Procesa filas con ESTADO = "PENDIENTE" o "PENDIENTE_MANUAL".
 *   - Para cada una construye un account.move y lo crea en Odoo.
 *   - Si ODOO_POST_AUTOMATICO = TRUE, también lo postea.
 *   - Escribe el ESTADO resultante (ENVIADO_DRAFT / ENVIADO_POSTED / ERROR_ENVIO)
 *     y el move_id en la fila de ASIENTOS.
 *   - Procesa hasta BATCH_SIZE asientos por ejecución.
 *
 * Funciones públicas:
 *   - sendToOdoo()       : envío principal (popup confirmación + ejecución)
 *   - sendToOdooDryRun() : log de qué enviaría sin llamar a Odoo
 *   - testOdooAuth()     : prueba la conexión XML-RPC y devuelve el uid
 *
 * Idempotencia:
 *   - Solo procesa filas con ESTADO PENDIENTE/PENDIENTE_MANUAL.
 *   - Tras envío correcto, el ESTADO cambia y la fila no se reprocesa.
 *   - Tras envío con error, el ESTADO pasa a ERROR_ENVIO con el mensaje
 *     en NOTAS. Tú decides si lo vuelves a poner como PENDIENTE para reintentar.
 */

const ESTADOS_PROCESABLES = ['PENDIENTE', 'PENDIENTE_MANUAL'];
const COLOR_ENVIADO_DRAFT  = '#a4c2f4';   // azul
const COLOR_ENVIADO_POSTED = '#3c78d8';   // azul oscuro
const COLOR_ERROR_ENVIO    = '#ea9999';   // rojo


// =============================================================
// 1. Cliente XML-RPC mínimo
// =============================================================

/**
 * Llama a un método XML-RPC de Odoo y devuelve el resultado parseado.
 * Wrapper sobre /xmlrpc/2/common (autenticación) y /xmlrpc/2/object (operaciones).
 */
function _odooCall(endpoint, methodName, params) {
  const url = endpoint;
  const body = _buildXmlRpcRequest(methodName, params);
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'text/xml',
    payload: body,
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code !== 200) {
    throw new Error('HTTP ' + code + ' al llamar ' + endpoint + ': ' + text.substring(0, 500));
  }
  return _parseXmlRpcResponse(text);
}

/**
 * Construye XML para una llamada XML-RPC.
 * Soporta: int, float, string, boolean, array, struct (object), null (omitido).
 */
function _buildXmlRpcRequest(methodName, params) {
  const paramsXml = params.map(p => '<param><value>' + _encodeXmlRpcValue(p) + '</value></param>').join('');
  return '<?xml version="1.0"?><methodCall>'
       + '<methodName>' + _xmlEscape(methodName) + '</methodName>'
       + '<params>' + paramsXml + '</params>'
       + '</methodCall>';
}

function _encodeXmlRpcValue(v) {
  if (v === null || v === undefined) return '<string></string>';
  if (typeof v === 'boolean') return '<boolean>' + (v ? '1' : '0') + '</boolean>';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return '<int>' + v + '</int>';
    return '<double>' + v + '</double>';
  }
  if (typeof v === 'string') return '<string>' + _xmlEscape(v) + '</string>';
  if (Array.isArray(v)) {
    const items = v.map(x => '<value>' + _encodeXmlRpcValue(x) + '</value>').join('');
    return '<array><data>' + items + '</data></array>';
  }
  if (typeof v === 'object') {
    const members = Object.keys(v).map(k =>
      '<member><name>' + _xmlEscape(k) + '</name>'
      + '<value>' + _encodeXmlRpcValue(v[k]) + '</value>'
      + '</member>'
    ).join('');
    return '<struct>' + members + '</struct>';
  }
  return '<string>' + _xmlEscape(String(v)) + '</string>';
}

function _xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Parser muy básico de respuesta XML-RPC.
 * Devuelve el value del primer <param>, o lanza con el faultString si hay fault.
 */
function _parseXmlRpcResponse(xml) {
  // Detectar fault primero
  const faultMatch = xml.match(/<fault>[\s\S]*?<member>[\s\S]*?<name>faultString<\/name>[\s\S]*?<string>([\s\S]*?)<\/string>/);
  if (faultMatch) throw new Error('Odoo fault: ' + faultMatch[1]);

  // Parser recursivo de <value>...</value>
  const paramMatch = xml.match(/<params>\s*<param>\s*<value>([\s\S]*)<\/value>\s*<\/param>\s*<\/params>/);
  if (!paramMatch) throw new Error('Respuesta XML-RPC inesperada: ' + xml.substring(0, 300));
  return _parseValue(paramMatch[1]);
}

function _parseValue(content) {
  content = content.trim();
  // <int>...</int> o <i4>...</i4>
  let m = content.match(/^<(?:int|i4)>(-?\d+)<\/(?:int|i4)>$/);
  if (m) return parseInt(m[1], 10);
  // <double>...</double>
  m = content.match(/^<double>(-?\d+(?:\.\d+)?)<\/double>$/);
  if (m) return parseFloat(m[1]);
  // <boolean>0|1</boolean>
  m = content.match(/^<boolean>([01])<\/boolean>$/);
  if (m) return m[1] === '1';
  // <string>...</string> (puede estar vacío)
  m = content.match(/^<string>([\s\S]*)<\/string>$/);
  if (m) return _xmlUnescape(m[1]);
  // <array><data>...</data></array>
  m = content.match(/^<array>\s*<data>([\s\S]*)<\/data>\s*<\/array>$/);
  if (m) {
    const items = _splitTopLevel(m[1], 'value');
    return items.map(_parseValue);
  }
  // <struct>...</struct>
  m = content.match(/^<struct>([\s\S]*)<\/struct>$/);
  if (m) {
    const members = _splitTopLevel(m[1], 'member');
    const obj = {};
    members.forEach(mem => {
      const nameM = mem.match(/<name>([\s\S]*?)<\/name>/);
      const valM = mem.match(/<value>([\s\S]*)<\/value>/);
      if (nameM && valM) obj[nameM[1]] = _parseValue(valM[1]);
    });
    return obj;
  }
  // Sin tipo explícito → string
  return _xmlUnescape(content);
}

function _splitTopLevel(s, tag) {
  const result = [];
  const open = '<' + tag + '>';
  const close = '</' + tag + '>';
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf(open, i);
    if (start === -1) break;
    // Buscar el </tag> correspondiente respetando anidamiento
    let depth = 1;
    let j = start + open.length;
    while (j < s.length && depth > 0) {
      const nextOpen = s.indexOf(open, j);
      const nextClose = s.indexOf(close, j);
      if (nextClose === -1) throw new Error('XML mal formado en _splitTopLevel');
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        j = nextOpen + open.length;
      } else {
        depth--;
        if (depth === 0) {
          result.push(s.substring(start + open.length, nextClose));
          j = nextClose + close.length;
        } else {
          j = nextClose + close.length;
        }
      }
    }
    i = j;
  }
  return result;
}

function _xmlUnescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}


// =============================================================
// 2. Autenticación con cache de uid
// =============================================================

/**
 * Devuelve { url, db, user, apiKey, uid }, autenticando si hace falta.
 * Cachea uid en Script Properties (key: ODOO_UID_CACHED) para no llamar a
 * authenticate cada ejecución.
 */
function _getOdooSession(config) {
  const url = String(config.require('PARAM', 'ODOO_URL')).replace(/\/+$/, '');
  const db = config.require('PARAM', 'ODOO_DB');
  const user = config.require('PARAM', 'ODOO_USER');
  const apiKey = PropertiesService.getScriptProperties().getProperty('ODOO_API_KEY');
  if (!apiKey) throw new Error('No hay ODOO_API_KEY en Script Properties. Ejecuta setOdooApiKey.');

  // ¿uid cacheado en config o en Script Properties?
  let uid = parseInt(config.get('PARAM', 'ODOO_UID', '') || '0', 10);
  if (!uid) {
    const cached = PropertiesService.getScriptProperties().getProperty('ODOO_UID_CACHED');
    if (cached) uid = parseInt(cached, 10);
  }
  if (!uid) {
    Logger.log('Autenticando contra Odoo...');
    uid = _odooCall(url + '/xmlrpc/2/common', 'authenticate', [db, user, apiKey, {}]);
    if (!uid || uid === false) {
      throw new Error('Autenticación falló. Revisa ODOO_USER y ODOO_API_KEY.');
    }
    PropertiesService.getScriptProperties().setProperty('ODOO_UID_CACHED', String(uid));
    Logger.log('Autenticado, uid = ' + uid);
  }
  return { url: url, db: db, user: user, apiKey: apiKey, uid: uid };
}

/**
 * Wrapper de execute_kw (API de operaciones).
 */
function _executeKw(session, model, method, args, kwargs) {
  return _odooCall(
    session.url + '/xmlrpc/2/object',
    'execute_kw',
    [session.db, session.uid, session.apiKey, model, method, args, kwargs || {}]
  );
}


// =============================================================
// 3. Construcción del payload de un account.move desde una fila ASIENTOS
// =============================================================

/**
 * Lee la cabecera y los valores de la fila, identifica las columnas de cuentas
 * (ingresos / pagos) y construye el array line_ids para Odoo.
 *
 * Reglas:
 *   - Si la columna lleva un account_id reconocido como ingreso (en config),
 *     la línea va al HABER (credit) con tax_ids correspondiente y analytic.
 *   - Si la columna es un account_id reconocido como pago / caja,
 *     la línea va al DEBE (debit), sin tax, sin analytic.
 *   - Columnas IVA y totales se ignoran (Odoo recalcula IVA).
 */
function _buildMovePayload(rowValues, headerRow, config) {
  const accountTypeMap = _buildAccountTypeMap(config);
  // Helpers de lookup en la fila por nombre de cabecera
  const idxByHeader = {};
  headerRow.forEach((h, i) => {
    // Cabecera multilinea: "9617\nDRINK". Tomamos solo la primera línea (el ID).
    const firstLine = String(h || '').split('\n')[0].trim();
    if (firstLine !== '') idxByHeader[firstLine] = i;
  });

  const get = name => {
    const i = idxByHeader[name];
    if (i === undefined) return undefined;
    return rowValues[i];
  };
  const getNum = name => {
    const v = get(name);
    if (v === '' || v === null || v === undefined) return 0;
    const n = Number(v);
    return isNaN(n) ? 0 : n;
  };

  const filaOrig = getNum('FILA_ORIG');
  const fecha = get('FECHA');
  const location = String(get('LOCATION') || '').trim();
  const shift = String(get('SHIFT') || '').trim();
  const journalId = parseInt(getNum('JOURNAL_ID'), 10);
  const analyticId = parseInt(getNum('ANALYTIC_ID'), 10);

  if (!journalId) throw new Error('JOURNAL_ID vacío en la fila');
  if (!analyticId) throw new Error('ANALYTIC_ID vacío en la fila');

  // Recorrer cabecera buscando IDs de cuenta numéricos
  const lines = [];
  headerRow.forEach((h, i) => {
    const firstLine = String(h || '').split('\n')[0].trim();
    if (firstLine === '' || !/^\d+$/.test(firstLine)) return;
    const accId = parseInt(firstLine, 10);
    const importe = Number(rowValues[i]);
    if (!importe || isNaN(importe)) return;
    // Filtrar también residuos numéricos de fórmulas (ej. 1e-10) que al
    // redondear a 2 decimales son 0 — generarían líneas fantasma con todo a 0.
    if (round2(Math.abs(importe)) === 0) return;

    const meta = accountTypeMap[accId];
    if (!meta) {
      throw new Error('Cuenta ' + accId + ' (col ' + (i+1) + ') no está mapeada en CONFIG');
    }

    const lineVals = {
      account_id: accId,
      name: meta.label
    };
    if (meta.lado === 'HABER') {
      const abs = round2(Math.abs(importe));
      if (importe >= 0) { lineVals.debit = 0; lineVals.credit = abs; }
      else { lineVals.debit = abs; lineVals.credit = 0; }
    } else if (meta.lado === 'DEBE') {
      const abs = round2(Math.abs(importe));
      if (importe >= 0) { lineVals.debit = abs; lineVals.credit = 0; }
      else { lineVals.debit = 0; lineVals.credit = abs; }
    } else if (meta.lado === 'AJUSTE') {
      const abs = round2(Math.abs(importe));
      if (importe > 0) { lineVals.debit = abs; lineVals.credit = 0; }
      else { lineVals.debit = 0; lineVals.credit = abs; }
    } else {
      throw new Error('Lado de cuenta desconocido para ' + accId + ': ' + meta.lado);
    }
    if (meta.taxId) {
      // tax_ids es many2many: [[6, 0, [ids]]]  → "set" (reemplaza por estos ids)
      lineVals.tax_ids = [[6, 0, [meta.taxId]]];
    }
    if (meta.lado === 'HABER' && analyticId) {
      // analytic_distribution es un dict {analytic_id: percent}
      // En XML-RPC los keys de struct son strings.
      lineVals.analytic_distribution = {};
      lineVals.analytic_distribution[String(analyticId)] = 100;
    }
    // line_ids usa la convención [0, 0, vals] para crear nuevas líneas
    lines.push([0, 0, lineVals]);
  });

  if (lines.length === 0) throw new Error('Sin líneas que enviar (todas las cuentas a 0)');

  // Fecha en formato yyyy-mm-dd
  const fechaStr = _toIsoDate(fecha);
  const ref = '528 ' + (fechaStr || '?') + ' ' + location + ' ' + shift;

  const moveVals = {
    move_type: 'entry',           // asiento contable manual
    journal_id: journalId,
    date: fechaStr,
    ref: ref,
    line_ids: lines
  };
  return { moveVals: moveVals, ref: ref };
}

/**
 * { account_id (int): {lado, label, taxId} } construido desde el config.
 */
function _buildAccountTypeMap(config) {
  const map = {};

  // Ingresos (HABER)
  const tiposIngreso = ['FOOD', 'DRINK', 'MERCH', 'SERV_CHARGE', 'NO_SHOW','DOOR_TICKETS', 'TIPS'];
  tiposIngreso.forEach(tipo => {
    const acc = config.get('INGRESO_CUENTA', tipo, '');
    if (acc !== '' && acc !== null) {
      const taxRaw = config.get('INGRESO_TAX', tipo, '');
      map[parseInt(acc, 10)] = {
        lado: 'HABER',
        label: tipo,
        taxId: taxRaw === '' ? null : parseInt(taxRaw, 10)
      };
    }
  });

  // Pagos generales (DEBE)
  ['CREDIT_CARD', 'CHARGE_TO_ROOM', 'PREPAYMENT'].forEach(tipo => {
    const acc = config.get('PAGO_CUENTA', tipo, '');
    if (acc !== '' && acc !== null) {
      const accId = parseInt(acc, 10);
      // Si ya estaba asignado como ingreso, se queda con el primer valor (raro).
      if (!map[accId]) map[accId] = { lado: 'DEBE', label: tipo, taxId: null };
    }
  });

  // Cajas por location (DEBE) — todas comparten label "CASH"
  const pagoCuenta = config.raw['PAGO_CUENTA'] || {};
  Object.keys(pagoCuenta).forEach(key => {
    if (key.indexOf('CASH|') === 0) {
      const acc = pagoCuenta[key];
      if (acc !== '' && acc !== null && acc !== undefined) {
        const accId = parseInt(acc, 10);
        if (!map[accId]) map[accId] = { lado: 'DEBE', label: 'CASH ' + key.substring(5), taxId: null };
      }
    }
  });
  // Default CASH
  const cashDef = config.get('PAGO_CUENTA', 'CASH', '');
  if (cashDef !== '' && cashDef !== null) {
    const accId = parseInt(cashDef, 10);
    if (!map[accId]) map[accId] = { lado: 'DEBE', label: 'CASH', taxId: null };
  }

  // Cuenta de ajuste (555 / partidas pendientes). Lado='AJUSTE': se decide por signo.
  // Positivo = DEBE, negativo = HABER (convención acordada).
  const ajuste = config.get('PARAM', 'CUENTA_AJUSTE', '');
  if (ajuste !== '' && ajuste !== null) {
    const accId = parseInt(ajuste, 10);
    map[accId] = { lado: 'AJUSTE', label: 'AJUSTE_555', taxId: null };
  }

  return map;
}

function _toIsoDate(v) {
  if (!v) return '';
  if (v instanceof Date) {
    return v.getFullYear() + '-'
         + String(v.getMonth() + 1).padStart(2, '0') + '-'
         + String(v.getDate()).padStart(2, '0');
  }
  // String "dd/mm/yyyy" → yyyy-mm-dd
  const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return String(v);
}

function round2(n) { return Math.round(n * 100) / 100; }


// =============================================================
// 4. Helpers de la sheet
// =============================================================

function _getAsientosSheetForSend(config) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = config.require('PARAM', 'SHEET_PREVIEW');
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('No existe la pestaña ' + name);
  return sh;
}

/**
 * Localiza columnas clave (ESTADO, NOTAS, ODOO_MOVE_ID) en la cabecera.
 * Acepta cabeceras multilinea ("9617\nDRINK"), trabajando con la primera línea.
 */
function _findColumns(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => {
    const firstLine = String(h || '').split('\n')[0].trim();
    if (firstLine !== '') idx[firstLine] = i + 1;  // 1-based
  });
  return idx;
}


// =============================================================
// 5. Entry points públicos
// =============================================================

function testOdooAuth() {
  const config = loadConfig();
  const session = _getOdooSession(config);
  Logger.log('OK. Conectado a ' + session.url + ' como uid=' + session.uid);
  try {
    SpreadsheetApp.getUi().alert('Test Odoo', 'Conectado: uid = ' + session.uid + '\nURL: ' + session.url, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {}
}

/**
 * Dry-run: NO llama a Odoo. Solo recorre las filas procesables y loggea
 * el payload que enviaría. Útil para verificar antes de tirar.
 */
function sendToOdooDryRun() {
  const config = loadConfig();
  const sh = _getAsientosSheetForSend(config);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) { Logger.log('Sin filas en ASIENTOS'); return; }

  const headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const cols = _findColumns(headerRow);
  if (!cols['ESTADO']) throw new Error('Columna ESTADO no encontrada');

  const allData = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  let count = 0;
  let mostrados = 0;
  for (let i = 0; i < allData.length; i++) {
    const row = allData[i];
    const estado = String(row[cols['ESTADO'] - 1] || '').trim();
    if (ESTADOS_PROCESABLES.indexOf(estado) === -1) continue;
    count++;
    if (mostrados >= 3) continue;  // sigue contando, solo deja de loggear detalle
    if (mostrados === 0) {
      // marcador la primera vez
    }
    try {
      const payload = _buildMovePayload(row, headerRow, config);
      Logger.log('=== Fila sheet ' + (i + 2) + ' (FILA_ORIG=' + row[cols['FILA_ORIG'] - 1] + ') ===');
      Logger.log(JSON.stringify(payload.moveVals, null, 2));
    } catch (e) {
      Logger.log('Fila sheet ' + (i + 2) + ' ERROR: ' + e.message);
    }
    mostrados++;
  }
  Logger.log('Total filas procesables encontradas: ' + count
           + (count > 3 ? ' (mostradas las primeras 3 con detalle)' : ''));
}

/**
 * Envío real. Confirma con popup, procesa hasta BATCH_SIZE filas,
 * actualiza ESTADO y ODOO_MOVE_ID en cada fila.
 */
function sendToOdoo() {
  const config = loadConfig();
  const sh = _getAsientosSheetForSend(config);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) { Logger.log('Sin filas en ASIENTOS'); return; }

  const headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const cols = _findColumns(headerRow);
  ['ESTADO', 'NOTAS', 'ODOO_MOVE_ID', 'FILA_ORIG'].forEach(c => {
    if (!cols[c]) throw new Error('Columna ' + c + ' no encontrada en ASIENTOS');
  });

  const batchSize = parseInt(config.get('PARAM', 'BATCH_SIZE', '15'), 10) || 15;
  const postAuto = String(config.get('PARAM', 'ODOO_POST_AUTOMATICO', '')).trim().toUpperCase() === 'TRUE';

  // Listar filas procesables
  const allData = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const procesables = [];
  for (let i = 0; i < allData.length; i++) {
    const row = allData[i];
    const estado = String(row[cols['ESTADO'] - 1] || '').trim();
    if (ESTADOS_PROCESABLES.indexOf(estado) !== -1) {
      procesables.push({ sheetRow: i + 2, values: row });
    }
  }

  if (procesables.length === 0) {
    Logger.log('No hay filas procesables (PENDIENTE / PENDIENTE_MANUAL)');
    try { SpreadsheetApp.getUi().alert('Sin filas a enviar', 'No hay PENDIENTE / PENDIENTE_MANUAL', SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
    return;
  }

  const aProcesar = procesables.slice(0, batchSize);

  // Confirmación
  try {
    const ui = SpreadsheetApp.getUi();
    const resp = ui.alert(
      'Enviar a Odoo',
      'Procesables: ' + procesables.length + '\n' +
      'Se van a enviar ahora: ' + aProcesar.length + ' (BATCH_SIZE=' + batchSize + ')\n' +
      'Modo: ' + (postAuto ? 'POSTEAR automático' : 'DRAFT (sin postear)') + '\n\n' +
      '¿Continuar?',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp !== ui.Button.OK) { Logger.log('Cancelado'); return; }
  } catch (e) {}

  // Sesión Odoo
  const session = _getOdooSession(config);
  Logger.log('Sesión OK. Procesando ' + aProcesar.length + ' filas...');

  let okDraft = 0, okPosted = 0, errores = 0;
  for (let k = 0; k < aProcesar.length; k++) {
    const item = aProcesar[k];
    const sheetRow = item.sheetRow;
    const row = item.values;
    const filaOrig = row[cols['FILA_ORIG'] - 1];

    try {
      const payload = _buildMovePayload(row, headerRow, config);

      // 1. Crear el move
      const moveId = _executeKw(session, 'account.move', 'create', [payload.moveVals]);
      if (!moveId || typeof moveId !== 'number') {
        throw new Error('Respuesta inesperada al create: ' + JSON.stringify(moveId));
      }

      let estadoFinal = 'ENVIADO_DRAFT';
      let color = COLOR_ENVIADO_DRAFT;

      // 2. Postear si toca
      if (postAuto) {
        try {
          _executeKw(session, 'account.move', 'action_post', [[moveId]]);
          estadoFinal = 'ENVIADO_POSTED';
          color = COLOR_ENVIADO_POSTED;
        } catch (eP) {
          // Posteo falló pero el move existe en draft. Marcar como draft con aviso.
          estadoFinal = 'ENVIADO_DRAFT';
          color = COLOR_ENVIADO_DRAFT;
          sh.getRange(sheetRow, cols['NOTAS']).setValue('Creado en draft. Posteo falló: ' + eP.message.substring(0, 200));
        }
      }

      // 3. Actualizar fila
      sh.getRange(sheetRow, cols['ESTADO']).setValue(estadoFinal);
      sh.getRange(sheetRow, cols['ODOO_MOVE_ID']).setValue(moveId);
      sh.getRange(sheetRow, 1, 1, lastCol).setBackground(color);

      if (estadoFinal === 'ENVIADO_POSTED') okPosted++;
      else okDraft++;

      Logger.log('  fila ' + sheetRow + ' (orig=' + filaOrig + ') → ' + estadoFinal + ' (move_id=' + moveId + ')');
    } catch (e) {
      errores++;
      sh.getRange(sheetRow, cols['ESTADO']).setValue('ERROR_ENVIO');
      sh.getRange(sheetRow, cols['NOTAS']).setValue(String(e.message).substring(0, 500));
      sh.getRange(sheetRow, 1, 1, lastCol).setBackground(COLOR_ERROR_ENVIO);
      Logger.log('  fila ' + sheetRow + ' (orig=' + filaOrig + ') → ERROR: ' + e.message);
    }
  }

  const restantes = procesables.length - aProcesar.length;
  Logger.log('=== sendToOdoo — resumen ===');
  Logger.log('  Enviados en draft:  ' + okDraft);
  Logger.log('  Enviados posteados: ' + okPosted);
  Logger.log('  Errores:            ' + errores);
  Logger.log('  Restantes en cola:  ' + restantes);

  try {
    SpreadsheetApp.getUi().alert('Envío completado',
      'Draft: ' + okDraft + '\nPosted: ' + okPosted + '\nErrores: ' + errores + '\n' +
      (restantes > 0 ? 'Pendientes (siguiente ejecución): ' + restantes : 'Sin más pendientes'),
      SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {}
}