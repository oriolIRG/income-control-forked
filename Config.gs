// ╔══════════════════════════════════════════════════════════════════╗
// ║  SQUARE DAILY SYNC — Google Apps Script                        ║
// ║  Archivos: Config.gs · SquareAPI.gs · DataProcessor.gs         ║
// ║            Sheets.gs · Main.gs                                 ║
// ║  Crea un archivo .gs por sección en tu proyecto GAS            ║
// ╚══════════════════════════════════════════════════════════════════╝


// ═══════════════════════════════════════════════════════════════════
// CONFIG.GS
// Lee pestañas de configuración y PropertiesService
// ═══════════════════════════════════════════════════════════════════

const TIMEZONE       = 'Europe/Madrid';
const DAY_START_HOUR = 6;          // Los días van de 06:00 a 05:59 del día siguiente
const SQ_VERSION     = '2026-01-22';
const DATA_SHEET     = '📊 Datos';
const LOG_SHEET      = '📝 Log';

// ── Token ──────────────────────────────────────────────────────────
function getSquareToken() {
  return PropertiesService.getScriptProperties().getProperty('SQUARE_TOKEN');
}
function setSquareToken(t) {
  PropertiesService.getScriptProperties().setProperty('SQUARE_TOKEN', t);
}

// ── Locations ──────────────────────────────────────────────────────
// Pestaña "📍 Locations" — columnas: Nombre | Square ID | Activa
function getLocations() {
  return _sheetRows('📍 Locations')
    .filter(r => String(r[2]).toUpperCase() === 'TRUE' || r[2] === true)
    .map(r => ({ name: String(r[0]).trim(), id: String(r[1]).trim() }));
}

// ── Shifts ─────────────────────────────────────────────────────────
// Pestaña "🕐 Shifts" — columnas: Location | DOW (0=Dom) | Desde | Hasta | Nombre
// DOW = día de reporte (el del rango que empieza a las 06:00)
// Si Desde > Hasta el rango cruza la medianoche (ej: 22:00 → 06:00)
function getShifts() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('🕐 Shifts');
  if (!sh) throw new Error('Pestaña "🕐 Shifts" no encontrada.');
  
  // getDisplayValues() devuelve los valores TAL COMO SE VEN en la celda
  // Evita la conversión a Date que introduce el offset histórico de Madrid 1899
  const rows = sh.getDataRange().getDisplayValues();
  
  return rows.slice(1) // sin cabecera
    .filter(r => r[0])
    .map(r => ({
      location : String(r[0]).trim(),
      dow      : parseInt(r[1]),
      from     : String(r[2]).trim(),  // "20:00" directamente, sin conversión
      to       : String(r[3]).trim(),  // "06:00" directamente
      shift    : String(r[4]).trim()
    }));
}

// ── Categorías ─────────────────────────────────────────────────────
// Pestaña "📋 Categorías" — columnas: Etiqueta | IDs Square (coma)
// Solo categorías SIN padre (top-level). Los hijos se resuelven automáticamente.
function getCategories() {
  return _sheetRows('📋 Categorías')
    .filter(r => r[0])
    .map(r => ({
      label            : String(r[0]).trim(),
      squareCategoryIds: String(r[1]).split(',').map(s => s.trim()).filter(Boolean)
    }));
}

// ── Helpers ────────────────────────────────────────────────────────
function _sheetRows(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error(`Pestaña "${name}" no encontrada en el spreadsheet.`);
  const data = sh.getDataRange().getValues();
  return data.slice(1); // Sin cabecera
}

function _sheetTimeToStr(val) {
  if (val instanceof Date) {
    // Usar el timezone del script, NO 'UTC'
    // El epoch de Sheets (30/12/1899) tiene offset histórico en Europe/Madrid
    // que desplaza ~10 min si usamos UTC — formatear en local lo compensa
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'HH:mm');
  }
  return String(val).trim();
}
