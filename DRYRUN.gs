/**
 * Dry-run del pipeline Pikes → Odoo (Paso 1A + 1C ajuste céntimos).
 *
 * Lee Odoo_Config + una fila de SALES DATA PIKES, construye el asiento contable
 * en memoria con cuadre GROSS exacto (ajuste fino sobre la base más grande con IVA)
 * y loggea todos los detalles. NO escribe en Odoo ni en la sheet.
 *
 * Uso:
 *   - Desde la sheet (con menú externo) ejecutar dryRunRow → popup de fila.
 *   - Desde el editor: ajustar TEST_ROW y ejecutar dryRunRowConst.
 */

const CONFIG_SHEET = 'Odoo_Config';

// Para ejecutar desde el editor sin popup: cambia este número y ejecuta dryRunRowConst().
const TEST_ROW = 11;

// Mapa local de % IVA por tipo. Se usa para validar el cuadre y para el ajuste fino.
// En el envío real a Odoo, el IVA lo calcula Odoo a partir del tax_id; aquí solo
// reproducimos su matemática para asegurarnos de que el asiento cuadrará.
const TAX_PERCENT_BY_TIPO = {
  FOOD: 10, DRINK: 10, MERCH: 21, SERV_CHARGE: 10, NO_SHOW: 0
};


// =============================================================
// 1. Carga de config
// =============================================================

function loadConfig() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG_SHEET);
  if (!sh) throw new Error('No existe la pestaña ' + CONFIG_SHEET);

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  const data = {};
  rows.forEach(r => {
    const cat = String(r[0]).trim();
    const key = String(r[1]).trim();
    const val = r[2];
    if (!cat || !key) return;
    if (!data[cat]) data[cat] = {};
    data[cat][key] = val;
  });

  return {
    raw: data,
    require: function(cat, key) {
      const v = data[cat] && data[cat][key];
      if (v === undefined || v === '' || v === null) {
        throw new Error('CONFIG falta: ' + cat + ' | ' + key);
      }
      return v;
    },
    get: function(cat, key, defaultVal) {
      const v = data[cat] && data[cat][key];
      if (v === undefined || v === '' || v === null) return defaultVal;
      return v;
    },
    getPagoCuenta: function(forma, location) {
      const specific = data['PAGO_CUENTA'] && data['PAGO_CUENTA'][forma + '|' + location];
      if (specific !== undefined && specific !== '' && specific !== null) return specific;
      const def = data['PAGO_CUENTA'] && data['PAGO_CUENTA'][forma];
      if (def !== undefined && def !== '' && def !== null) return def;
      throw new Error('PAGO_CUENTA no resuelto para ' + forma + ' (location ' + location + ')');
    },
    getJournal: function(location) {
      const specific = data['LOCATION'] && data['LOCATION'][location];
      if (specific !== undefined && specific !== '' && specific !== null) return specific;
      return this.require('PARAM', 'DIARIO_DEFAULT');
    },
    getAnalytic: function(location, shift) {
      const v = data['ANALITICA'] && data['ANALITICA'][location + '|' + shift];
      if (v === undefined || v === '' || v === null) {
        throw new Error('ANALITICA no definida para ' + location + '|' + shift);
      }
      return v;
    }
  };
}


// =============================================================
// 2. Lectura de la fila fuente
// =============================================================

function parseDataRow(config, rowNum) {
  const sheetName = config.require('PARAM', 'SHEET_DATOS');
  const headerRow = parseInt(config.require('PARAM', 'FILA_CABECERA'), 10);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sh) throw new Error('No existe la pestaña ' + sheetName);

  if (rowNum <= headerRow) {
    throw new Error('Fila ' + rowNum + ' está en o por encima de la cabecera (fila ' + headerRow + ')');
  }

  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(headerRow, 1, 1, lastCol).getValues()[0]
                    .map(h => String(h).trim());

  // Tolerar saltos de línea y espacios múltiples al matchear cabeceras
  const normalize = s => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const normalizedHeaders = headers.map(normalize);

  const colMap = {};
  Object.keys(config.raw['COL_HEADER'] || {}).forEach(field => {
    const expectedRaw = String(config.raw['COL_HEADER'][field]).trim();
    if (!expectedRaw) {
      throw new Error('COL_HEADER | ' + field + ' está vacío en Odoo_Config. '
                    + 'Pon el texto exacto de la cabecera en SHEET_DATOS.');
    }
    const expected = normalize(expectedRaw);
    const idx = normalizedHeaders.indexOf(expected);
    if (idx === -1) {
      throw new Error('Cabecera "' + expectedRaw + '" (campo ' + field
                    + ') no encontrada en fila ' + headerRow + ' de ' + sheetName
                    + '. Cabeceras encontradas: ' + JSON.stringify(headers.filter(h => h)));
    }
    const lastIdx = normalizedHeaders.lastIndexOf(expected);
    if (lastIdx !== idx) {
      Logger.log('AVISO: cabecera "' + expectedRaw + '" aparece varias veces (cols '
               + (idx+1) + ' y ' + (lastIdx+1) + '). Usando la primera.');
    }
    colMap[field] = idx;
  });

  const rowVals = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];
  const rec = {};
  Object.keys(colMap).forEach(field => {
    rec[field] = rowVals[colMap[field]];
  });

  ['CASH','CREDIT_CARD','CHARGE_TO_ROOM','PREPAYMENT','NET_FOOD','NET_DRINK',
   'NET_MERCH','NET_SERV_CHARGE','NET_NO_SHOW','TIPS'].forEach(f => {
    rec[f] = toNumber(rec[f]);
  });
  rec.LOCATION = String(rec.LOCATION || '').trim();
  rec.SHIFT = String(rec.SHIFT || '').trim().toUpperCase();
  rec._rowNum = rowNum;

  if (!rec.LOCATION) {
    throw new Error('Fila ' + rowNum + ': LOCATION está vacía. '
                  + '¿Es una fila con datos reales? ¿Es correcta la cabecera "'
                  + config.raw['COL_HEADER']['LOCATION'] + '"?');
  }
  if (!rec.SHIFT) {
    throw new Error('Fila ' + rowNum + ': SHIFT está vacío. '
                  + '¿Es una fila con datos reales? ¿Es correcta la cabecera "'
                  + config.raw['COL_HEADER']['SHIFT'] + '"?');
  }
  return rec;
}

function toNumber(v) {
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/€/g, '').replace(/\s/g, '');
  let normalized;
  if (s.indexOf('.') !== -1 && s.indexOf(',') !== -1) {
    normalized = s.replace(/,/g, '');
  } else if (s.indexOf(',') !== -1) {
    normalized = s.replace(',', '.');
  } else {
    normalized = s;
  }
  const n = parseFloat(normalized);
  return isNaN(n) ? 0 : n;
}


// =============================================================
// 3. Construcción del asiento + cuadre GROSS
// =============================================================

function buildAccountMove(rec, config) {
  const loc = rec.LOCATION;
  const shift = rec.SHIFT;
  const analyticId = parseInt(config.getAnalytic(loc, shift), 10);
  const journalId  = parseInt(config.getJournal(loc), 10);

  const debe = [];
  const haber = [];

  // ---- DEBE: cobros ----
  if (rec.CASH > 0) {
    debe.push({
      label: 'CASH',
      account_id: parseInt(config.getPagoCuenta('CASH', loc), 10),
      debit: round2(rec.CASH), credit: 0,
      tax_ids: [], analytic_distribution: null
    });
  }
  if (rec.CREDIT_CARD > 0) {
    debe.push({
      label: 'CREDIT_CARD (incluye tips)',
      account_id: parseInt(config.getPagoCuenta('CREDIT_CARD', loc), 10),
      debit: round2(rec.CREDIT_CARD), credit: 0,
      tax_ids: [], analytic_distribution: null
    });
  }
  if (rec.CHARGE_TO_ROOM > 0) {
    debe.push({
      label: 'CHARGE_TO_ROOM',
      account_id: parseInt(config.getPagoCuenta('CHARGE_TO_ROOM', loc), 10),
      debit: round2(rec.CHARGE_TO_ROOM), credit: 0,
      tax_ids: [], analytic_distribution: null
    });
  }
  if (rec.PREPAYMENT > 0) {
    debe.push({
      label: 'PREPAYMENT',
      account_id: parseInt(config.getPagoCuenta('PREPAYMENT', loc), 10),
      debit: round2(rec.PREPAYMENT), credit: 0,
      tax_ids: [], analytic_distribution: null
    });
  }

  // ---- HABER: ingresos con IVA ----
  const ingresosConIVA = [
    { field: 'NET_FOOD',        tipo: 'FOOD' },
    { field: 'NET_DRINK',       tipo: 'DRINK' },
    { field: 'NET_MERCH',       tipo: 'MERCH' },
    { field: 'NET_SERV_CHARGE', tipo: 'SERV_CHARGE' },
    { field: 'NET_NO_SHOW',     tipo: 'NO_SHOW' }
  ];

  ingresosConIVA.forEach(ing => {
    const net = rec[ing.field];
    if (net === 0) return;
    const taxIdRaw = config.get('INGRESO_TAX', ing.tipo, '');
    const taxId = taxIdRaw === '' ? null : parseInt(taxIdRaw, 10);
    const accountId = parseInt(config.require('INGRESO_CUENTA', ing.tipo), 10);
    const tasa = TAX_PERCENT_BY_TIPO[ing.tipo] || 0;
    haber.push({
      label: ing.tipo,
      account_id: accountId,
      debit: 0, credit: round2(net),
      tax_ids: taxId ? [taxId] : [],
      analytic_distribution: { [String(analyticId)]: 100 },
      _meta: { tasa: tasa, tipo: ing.tipo }
    });
  });

  // TIPS: HABER, sin IVA, sin analítica
  if (rec.TIPS > 0) {
    haber.push({
      label: 'TIPS',
      account_id: parseInt(config.require('INGRESO_CUENTA', 'TIPS'), 10),
      debit: 0, credit: round2(rec.TIPS),
      tax_ids: [], analytic_distribution: null,
      _meta: { tasa: 0, tipo: 'TIPS' }
    });
  }

  // ---- Cuadre GROSS + ajuste fino ----
  const debeTotal = sumLines(debe, 'debit');
  const umbral = parseFloat(config.require('PARAM', 'UMBRAL_CENTIMOS'));
  const ajuste = ajustarCuadre(haber, debeTotal, umbral);

  // Cálculo final del cuadre. IMPORTANTE: IVA redondeado POR LÍNEA, como Odoo.
  const haberBaseTotal = sumLines(haber, 'credit');
  const ivaTotal = round2(haber.reduce((s, l) => {
    const tasa = (l._meta && l._meta.tasa) || 0;
    return s + round2(l.credit * tasa / 100);
  }, 0));
  const haberConIVATotal = round2(haberBaseTotal + ivaTotal);
  const desfase = round2(debeTotal - haberConIVATotal);

  return {
    journal_id: journalId,
    location: loc,
    shift: shift,
    analytic_id: analyticId,
    debe: debe,
    haber: haber,
    cuadre: {
      debeTotal: debeTotal,
      haberBases: haberBaseTotal,
      ivaEstimado: ivaTotal,
      haberConIVA: haberConIVATotal,
      desfase: desfase,
      ajuste: ajuste
    }
  };
}


/**
 * Heurística de ajuste de céntimos. Replica la matemática de Odoo:
 * IVA redondeado POR LÍNEA, no agregado.
 *
 * Pasos:
 *   - Calcular desfase = DEBE - (HABER bases + IVA por línea redondeado).
 *   - Si |desfase| > umbral: no ajustar (devuelve fueraUmbral=true).
 *   - Si |desfase| ≤ umbral y ≠ 0:
 *       1. Identifica la base más grande del haber con IVA > 0.
 *       2. Calcula el delta exacto en céntimos para mover el bruto el desfase.
 *       3. Como solo podemos sumar céntimos discretos, prueba floor y ceil
 *          del delta y elige el que mejor cuadre.
 *
 * Modifica `haber` in-place. Devuelve metadata, incluyendo `desfaseFinal`
 * real (puede ser ≠ 0 si el redondeo no permite cuadre exacto, p.ej. 5cts al 10%).
 */
function ajustarCuadre(haber, debeTotal, umbral) {
  // Bruto como hace Odoo: IVA redondeado por línea
  const calcHaberBruto = () => {
    return round2(haber.reduce((s, l) => {
      const tasa = (l._meta && l._meta.tasa) || 0;
      const ivaLinea = round2(l.credit * tasa / 100);
      return s + l.credit + ivaLinea;
    }, 0));
  };

  const desfaseInicial = round2(debeTotal - calcHaberBruto());

  if (Math.abs(desfaseInicial) < 0.005) {
    return { aplicado: false, importe: 0, sobre: null, fueraUmbral: false,
             desfaseInicial: 0, desfaseFinal: 0, motivo: 'ya cuadra' };
  }
  if (Math.abs(desfaseInicial) > umbral + 0.0001) {
    return { aplicado: false, importe: 0, sobre: null, fueraUmbral: true,
             desfaseInicial: desfaseInicial, desfaseFinal: desfaseInicial };
  }

  const candidatas = haber
    .map((l, idx) => ({ l: l, idx: idx, tasa: (l._meta && l._meta.tasa) || 0 }))
    .filter(c => c.tasa > 0 && c.l.credit > 0);

  if (candidatas.length === 0) {
    return { aplicado: false, importe: 0, sobre: null, fueraUmbral: false,
             motivo: 'sin candidatas con IVA',
             desfaseInicial: desfaseInicial, desfaseFinal: desfaseInicial };
  }

  candidatas.sort((a, b) => b.l.credit - a.l.credit);
  const target = candidatas[0];
  const tasa = target.tasa;

  // delta exacto necesario para mover el bruto en `desfaseInicial`
  const deltaExacto = desfaseInicial / (1 + tasa / 100);
  const deltaCentLo = Math.floor(deltaExacto * 100) / 100;
  const deltaCentHi = Math.ceil(deltaExacto * 100) / 100;

  const baseOriginal = target.l.credit;
  let mejorDelta = 0;
  let mejorDesfaseAbs = Math.abs(desfaseInicial);

  [deltaCentLo, deltaCentHi].forEach(d => {
    target.l.credit = round2(baseOriginal + d);
    const desfase = round2(debeTotal - calcHaberBruto());
    if (Math.abs(desfase) < mejorDesfaseAbs) {
      mejorDesfaseAbs = Math.abs(desfase);
      mejorDelta = d;
    }
  });

  target.l.credit = round2(baseOriginal + mejorDelta);
  const desfaseFinal = round2(debeTotal - calcHaberBruto());

  return {
    aplicado: mejorDelta !== 0,
    importe: round2(mejorDelta),
    sobre: target.l._meta.tipo,
    fueraUmbral: false,
    desfaseInicial: desfaseInicial,
    desfaseFinal: desfaseFinal
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function sumLines(lines, field) {
  return round2(lines.reduce((s, l) => s + (l[field] || 0), 0));
}


// =============================================================
// 4. Debug helper
// =============================================================

const DEBUG_ROW = 8;

function debugRow() {
  const config = loadConfig();
  const sheetName = config.require('PARAM', 'SHEET_DATOS');
  const headerRow = parseInt(config.require('PARAM', 'FILA_CABECERA'), 10);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sh) { Logger.log('No existe pestaña ' + sheetName); return; }

  const lastCol = sh.getLastColumn();
  Logger.log('Pestaña: ' + sheetName + ' | última columna: ' + lastCol);
  Logger.log('Fila cabecera (fila ' + headerRow + '):');
  const headers = sh.getRange(headerRow, 1, 1, lastCol).getValues()[0];
  headers.forEach((h, i) => {
    if (h !== '' && h !== null) Logger.log('  col ' + (i+1) + ' = ' + JSON.stringify(h));
  });

  Logger.log('');
  Logger.log('Fila ' + DEBUG_ROW + ' (todos los valores no vacíos):');
  const rowVals = sh.getRange(DEBUG_ROW, 1, 1, lastCol).getValues()[0];
  rowVals.forEach((v, i) => {
    if (v !== '' && v !== null) Logger.log('  col ' + (i+1) + ' = ' + JSON.stringify(v));
  });

  Logger.log('');
  Logger.log('COL_HEADER configurados:');
  const ch = config.raw['COL_HEADER'] || {};
  Object.keys(ch).forEach(field => {
    const expected = String(ch[field]).trim();
    const idx = headers.indexOf(expected);
    const val = idx === -1 ? '(NO ENCONTRADA)' : JSON.stringify(rowVals[idx]);
    Logger.log('  ' + field + ' -> "' + expected + '" -> col ' + (idx+1) + ' = ' + val);
  });
}


// =============================================================
// 5. Orquestación: dry-run con popup
// =============================================================

/**
 * Dry-run principal: pide la fila por popup. Solo funciona desde el menú
 * de la Sheet (no desde el editor de Apps Script).
 */
function dryRunRow() {
  let rowNum;
  try {
    const ui = SpreadsheetApp.getUi();
    const resp = ui.prompt(
      'Dry-run de asiento',
      'Introduce el nº de fila de SALES DATA PIKES a procesar (ej: 8):',
      ui.ButtonSet.OK_CANCEL
    );
    if (resp.getSelectedButton() !== ui.Button.OK) {
      Logger.log('Dry-run cancelado');
      return;
    }
    rowNum = parseInt(resp.getResponseText().trim(), 10);
    if (isNaN(rowNum) || rowNum < 2) {
      ui.alert('Número de fila inválido: ' + resp.getResponseText());
      return;
    }
  } catch (e) {
    Logger.log('Sin contexto de UI (¿ejecutado desde el editor?). Usando TEST_ROW = ' + TEST_ROW);
    Logger.log('Tip: abre la Sheet y usa el menú para usar el popup.');
    rowNum = TEST_ROW;
  }
  _dryRunForRow(rowNum);
}

/**
 * Variante sin popup: usa la constante TEST_ROW.
 */
function dryRunRowConst() {
  _dryRunForRow(TEST_ROW);
}

function _dryRunForRow(rowNum) {
  try {
    const config = loadConfig();
    const rec = parseDataRow(config, rowNum);

    Logger.log('=== FILA ' + rowNum + ' ===');
    Logger.log('  DATE     = ' + rec.DATE);
    Logger.log('  LOCATION = ' + rec.LOCATION);
    Logger.log('  SHIFT    = ' + rec.SHIFT);
    Logger.log('  CASH=' + rec.CASH + '  CARD=' + rec.CREDIT_CARD
             + '  ROOM=' + rec.CHARGE_TO_ROOM + '  PREPAY=' + rec.PREPAYMENT
             + '  TIPS=' + rec.TIPS);
    Logger.log('  NETs: FOOD=' + rec.NET_FOOD + ' DRINK=' + rec.NET_DRINK
             + ' MERCH=' + rec.NET_MERCH + ' SERV=' + rec.NET_SERV_CHARGE
             + ' NOSHOW=' + rec.NET_NO_SHOW);

    const move = buildAccountMove(rec, config);
    Logger.log('');
    Logger.log('=== ASIENTO CONSTRUIDO ===');
    Logger.log('  journal_id = ' + move.journal_id);
    Logger.log('  analytic_id (' + move.location + '|' + move.shift + ') = ' + move.analytic_id);
    Logger.log('');
    Logger.log('  DEBE:');
    move.debe.forEach(l => Logger.log('    ' + padRight(l.label, 22)
             + ' acc=' + l.account_id + '  debit=' + l.debit.toFixed(2)));
    Logger.log('  HABER:');
    move.haber.forEach(l => {
      const tasa = (l._meta && l._meta.tasa) || 0;
      const iva  = round2(l.credit * tasa / 100);
      const meta = tasa > 0 ? '  [tasa=' + tasa + '%  iva≈' + iva.toFixed(2) + ']' : '';
      const tax  = l.tax_ids.length ? '  tax=' + l.tax_ids.join(',') : '  tax=-';
      const ana  = l.analytic_distribution ? '  ana=' + JSON.stringify(l.analytic_distribution) : '  ana=-';
      Logger.log('    ' + padRight(l.label, 22)
             + ' acc=' + l.account_id + '  credit=' + l.credit.toFixed(2)
             + tax + ana + meta);
    });

    Logger.log('');
    Logger.log('=== CUADRE GROSS ===');
    Logger.log('  DEBE total          = ' + move.cuadre.debeTotal.toFixed(2));
    Logger.log('  HABER bases (sum)   = ' + move.cuadre.haberBases.toFixed(2));
    Logger.log('  IVA estimado (sum)  = ' + move.cuadre.ivaEstimado.toFixed(2));
    Logger.log('  HABER con IVA       = ' + move.cuadre.haberConIVA.toFixed(2));
    Logger.log('  DESFASE final       = ' + move.cuadre.desfase.toFixed(2));

    const aj = move.cuadre.ajuste;
    if (aj.fueraUmbral) {
      const umbral = parseFloat(config.require('PARAM', 'UMBRAL_CENTIMOS'));
      Logger.log('  ESTADO: FUERA DE UMBRAL (' + umbral + ' €) — desfase '
               + aj.desfaseInicial.toFixed(2) + ' € — revisar datos');
    } else if (aj.aplicado) {
      Logger.log('  AJUSTE: ' + aj.importe.toFixed(2) + ' € sobre ' + aj.sobre
               + ' (desfase inicial ' + aj.desfaseInicial.toFixed(2) + ' -> '
               + aj.desfaseFinal.toFixed(2) + ')');
      if (Math.abs(aj.desfaseFinal) < 0.005) {
        Logger.log('  ESTADO: OK (cuadrado exacto con ajuste fino)');
      } else {
        Logger.log('  ESTADO: OK (ajustado, residuo ' + aj.desfaseFinal.toFixed(2)
                 + ' € no eliminable por discretización de céntimos)');
      }
    } else {
      Logger.log('  ESTADO: OK (cuadre exacto sin ajuste)');
    }
  } catch (e) {
    Logger.log('ERROR: ' + e.message);
    Logger.log(e.stack);
    try {
      SpreadsheetApp.getUi().alert('Error en dry-run', e.message, SpreadsheetApp.getUi().ButtonSet.OK);
    } catch (e2) {
      // Sin UI, ya está en el log
    }
  }
}

function padRight(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}