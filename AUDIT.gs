// =============================================================================
// ODOO AUDIT - Extrae apuntes contables de Odoo por diario
// Vuelca en pestaña "ODOO_AUDIT" del sheet activo
// Estados: posted (Contabilizado) y draft (Borrador). Excluye cancel.
// Año en curso completo (1 Jan - 31 Dec del año actual)
// =============================================================================

var AUDIT_SHEET_NAME = "ODOO_AUDIT";

// ── Helpers XML-RPC (mismo patrón que el resto del proyecto) ─────────────────

function getConfig() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!cfg) throw new Error("No se encuentra la pestaña CONFIG");
  var data = cfg.getDataRange().getValues();
  var map = {};
  data.forEach(function(row) {
    if (row[0] === "PARAM" && row[1]) map[row[1]] = row[2];
  });
  return map;
}

function getJournalIds() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = ss.getSheetByName(CONFIG_SHEET_NAME);
  var data = cfg.getDataRange().getValues();
  var ids = [];
  data.forEach(function(row) {
    if (row[0] === "LOCATION" && row[2] !== "" && row[2] !== null) {
      var id = parseInt(row[2]);
      if (!isNaN(id)) ids.push(id);
    }
  });
  return ids;
}

function odooAuthenticate(url, db, user, apiKey) {
  var uid = CacheService.getScriptCache().get("ODOO_UID_CACHED");
  if (uid) return parseInt(uid);

  var stored = PropertiesService.getScriptProperties().getProperty("ODOO_UID_CACHED");
  if (stored) return parseInt(stored);

  var body =
    '<?xml version="1.0"?><methodCall><methodName>authenticate</methodName><params>' +
    '<param><value><string>' + db + '</string></value></param>' +
    '<param><value><string>' + user + '</string></value></param>' +
    '<param><value><string>' + apiKey + '</string></value></param>' +
    '<param><value><struct></struct></value></param>' +
    '</params></methodCall>';

  var resp = UrlFetchApp.fetch(url + "/xmlrpc/2/common", {
    method: "post",
    contentType: "text/xml",
    payload: body,
    muteHttpExceptions: true
  });

  var parsed = parseXmlRpcResponse(resp.getContentText());
  if (!parsed || isNaN(parseInt(parsed))) throw new Error("Auth fallida. Respuesta: " + resp.getContentText().substring(0, 300));

  var uidInt = parseInt(parsed);
  PropertiesService.getScriptProperties().setProperty("ODOO_UID_CACHED", String(uidInt));
  CacheService.getScriptCache().put("ODOO_UID_CACHED", String(uidInt), 21600);
  return uidInt;
}

function odooCall(url, db, uid, apiKey, model, method, args, kwargs) {
  // args = array de argumentos posicionales; cada elemento se serializa por separado
  var argsItemsXml = (args || []).map(jsToXmlRpc).join("");
  var kwargsXml = jsToXmlRpc(kwargs || {});
  var body =
    '<?xml version="1.0"?><methodCall><methodName>execute_kw</methodName><params>' +
    '<param><value><string>' + db + '</string></value></param>' +
    '<param><value><int>' + uid + '</int></value></param>' +
    '<param><value><string>' + apiKey + '</string></value></param>' +
    '<param><value><string>' + model + '</string></value></param>' +
    '<param><value><string>' + method + '</string></value></param>' +
    '<param><value><array><data>' + argsItemsXml + '</data></array></value></param>' +
    '<param>' + kwargsXml + '</param>' +
    '</params></methodCall>';

  var resp = UrlFetchApp.fetch(url + "/xmlrpc/2/object", {
    method: "post",
    contentType: "text/xml",
    payload: body,
    muteHttpExceptions: true
  });

  return parseXmlRpcResponse(resp.getContentText());
}

// ── Conversión JS → XML-RPC ──────────────────────────────────────────────────

function jsToXmlRpc(val) {
  if (val === null || val === undefined) return "<value><boolean>0</boolean></value>";
  if (typeof val === "boolean") return "<value><boolean>" + (val ? "1" : "0") + "</boolean></value>";
  if (typeof val === "number") {
    if (Number.isInteger(val)) return "<value><int>" + val + "</int></value>";
    return "<value><double>" + val + "</double></value>";
  }
  if (typeof val === "string") return "<value><string>" + escXml(val) + "</string></value>";
  if (Array.isArray(val)) {
    return "<value><array><data>" + val.map(jsToXmlRpc).join("") + "</data></array></value>";
  }
  if (typeof val === "object") {
    var members = Object.keys(val).map(function(k) {
      return "<member><" + "name>" + escXml(k) + "</" + "name>" + jsToXmlRpc(val[k]) + "</member>";
    }).join("");
    return "<value><struct>" + members + "</struct></value>";
  }
  return "<value><string>" + escXml(String(val)) + "</string></value>";
}

function escXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ── Parser XML-RPC (XmlService, sin regex) ───────────────────────────────────

function parseXmlRpcResponse(xml) {
  try {
    var doc = XmlService.parse(xml);
    var root = doc.getRootElement();
    var fault = root.getChild("fault");
    if (fault) {
      var faultVal = parseXmlRpcValue(fault.getChild("value"));
      throw new Error("Odoo fault: " + JSON.stringify(faultVal));
    }
    var params = root.getChild("params");
    if (!params) return null;
    var param = params.getChild("param");
    if (!param) return null;
    return parseXmlRpcValue(param.getChild("value"));
  } catch (e) {
    if (e.message && e.message.indexOf("Odoo fault") === 0) throw e;
    throw new Error("Error parseando XML-RPC: " + e.message + "\nXML: " + xml.substring(0, 500));
  }
}

function parseXmlRpcValue(valueEl) {
  if (!valueEl) return null;
  var children = valueEl.getChildren();
  if (children.length === 0) return valueEl.getText();

  var typeEl = children[0];
  var typeName = typeEl.getName();

  if (typeName === "string")  return typeEl.getText();
  if (typeName === "int" || typeName === "i4") return parseInt(typeEl.getText());
  if (typeName === "double")  return parseFloat(typeEl.getText());
  if (typeName === "boolean") return typeEl.getText() === "1";
  if (typeName === "nil")     return null;

  if (typeName === "array") {
    var dataEl = typeEl.getChild("data");
    if (!dataEl) return [];
    return dataEl.getChildren("value").map(parseXmlRpcValue);
  }

  if (typeName === "struct") {
    var obj = {};
    typeEl.getChildren("member").forEach(function(m) {
      // Construimos el nombre del tag dinámicamente para evitar colapso en el editor
      var nTag = String.fromCharCode(110, 97, 109, 101); // "name"
      var keyEl = m.getChild(nTag);
      var key = keyEl ? keyEl.getText() : "";
      var val = parseXmlRpcValue(m.getChild("value"));
      obj[key] = val;
    });
    return obj;
  }

  return typeEl.getText();
}

// ── Función principal ────────────────────────────────────────────────────────

function fetchOdooAudit() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();

  // Config
  var cfg = getConfig();
  var url    = cfg["ODOO_URL"].replace(/\/$/, "");
  var db     = cfg["ODOO_DB"];
  var user   = cfg["ODOO_USER"];
  var apiKey = PropertiesService.getScriptProperties().getProperty("ODOO_API_KEY");
  if (!apiKey) throw new Error("ODOO_API_KEY no encontrada en las propiedades del script");

  var journalIds = getJournalIds();
  if (journalIds.length === 0) throw new Error("No se encontraron IDs de diario en CONFIG (filas LOCATION)");

  // Rango de fechas: año en curso
  var now    = new Date();
  var year   = now.getFullYear();
  var dateFrom = year + "-01-01";
  var dateTo   = year + "-12-31";

  Logger.log("Diarios a consultar: " + journalIds.join(", "));
  Logger.log("Rango de fechas: " + dateFrom + " a " + dateTo);

  // Autenticar
  var uid = odooAuthenticate(url, db, user, apiKey);

  // Dominio de búsqueda en account.move.line
  // - Diarios de la lista
  // - Estado del move: posted o draft (excluye cancel)
  // - Fecha en año en curso
  var domain = [
    ["journal_id", "in", journalIds],
    ["move_id.state", "in", ["posted", "draft"]],
    ["date", ">=", dateFrom],
    ["date", "<=", dateTo]
  ];

  var fields = [
    "move_id",          // → id + name del asiento (estado se obtiene aparte)
    "account_id",       // cuenta contable
    "date",             // fecha
    "name",             // descripción de la línea
    "ref",              // referencia
    "debit",            // debe
    "credit",           // haber
    "journal_id",       // diario
    "company_id"        // compañía
  ];

  // Odoo devuelve máx por defecto; usamos limit alto + offset para paginar si hace falta
  var BATCH = 500;
  var offset = 0;
  var allLines = [];

  while (true) {
    Utilities.sleep(300);
    var batch = odooCall(url, db, uid, apiKey, "account.move.line", "search_read",
      [domain],
      {
        fields: fields,
        limit: BATCH,
        offset: offset,
        order: "date asc, move_id asc, id asc"
      }
    );

    if (!batch || batch.length === 0) break;
    allLines = allLines.concat(batch);
    Logger.log("Obtenidos " + allLines.length + " apuntes hasta ahora...");
    if (batch.length < BATCH) break;
    offset += BATCH;
  }

  Logger.log("Total apuntes obtenidos: " + allLines.length);

  // ── Obtener estado de los account.move únicos ──────────────────────────────
  var moveStateMap = {};
  if (allLines.length > 0) {
    var uniqueMoveIds = [];
    var seenIds = {};
    allLines.forEach(function(l) {
      var mid = l["move_id"] ? l["move_id"][0] : null;
      if (mid && !seenIds[mid]) { seenIds[mid] = true; uniqueMoveIds.push(mid); }
    });
    // Paginar en grupos de 200 para no saturar
    for (var mi = 0; mi < uniqueMoveIds.length; mi += 200) {
      Utilities.sleep(300);
      var chunk = uniqueMoveIds.slice(mi, mi + 200);
      var moves = odooCall(url, db, uid, apiKey, "account.move", "search_read",
        [[["id", "in", chunk]]],
        { fields: ["id", "state"], limit: 200 }
      );
      if (moves) moves.forEach(function(m) { moveStateMap[String(m["id"])] = m["state"]; });
    }
    Logger.log("Estados de asientos obtenidos: " + Object.keys(moveStateMap).length);

  }

  // ── Obtener código de cuentas contables ───────────────────────────────────
  var accountCodeMap = {};
  if (allLines.length > 0) {
    var uniqueAccountIds = [];
    var seenAcc = {};
    allLines.forEach(function(l) {
      var aid = l["account_id"] ? l["account_id"][0] : null;
      if (aid && !seenAcc[aid]) { seenAcc[aid] = true; uniqueAccountIds.push(aid); }
    });
    // Obtener company_id del primer apunte para contexto multi-compañía
    var companyIdForCtx = (allLines[0] && allLines[0]["company_id"]) ? allLines[0]["company_id"][0] : 1;
    for (var ai = 0; ai < uniqueAccountIds.length; ai += 200) {
      Utilities.sleep(300);
      var achunk = uniqueAccountIds.slice(ai, ai + 200);
      var accounts = odooCall(url, db, uid, apiKey, "account.account", "read",
        [achunk, ["id", "code", "code_store", "name"]],
        { context: { allowed_company_ids: [companyIdForCtx] } }
      );
      if (accounts) {

        accounts.forEach(function(a) {
          var cod = a["code"] || a["code_store"] || "";
          // Si sigue false, fallback a display_name que suele incluir el código
          if (!cod || cod === false) cod = "";
          accountCodeMap[String(a["id"])] = cod;
        });
      }
    }
    Logger.log("Códigos de cuentas obtenidos: " + Object.keys(accountCodeMap).length);

  }

  // ── Preparar / limpiar pestaña ODOO_AUDIT ──────────────────────────────────

  var auditSheet = ss.getSheetByName(AUDIT_SHEET_NAME);
  if (!auditSheet) {
    auditSheet = ss.insertSheet(AUDIT_SHEET_NAME);
  } else {
    auditSheet.clearContents();
    auditSheet.clearFormats();
  }

  // Cabecera
  var headers = [
    "ASIENTO",        // move_id[1] (nombre del asiento)
    "ESTADO",         // move_id.state
    "FECHA",          // date
    "DIARIO",         // journal_id[1]
    "CUENTA",         // account_id[1] (código + nombre)
    "DESCRIPCION",    // name
    "REFERENCIA",     // ref
    "DEBE",           // debit
    "HABER",          // credit
    "BALANCE",        // debe - haber (fórmula)
    "COMPAÑIA",       // company_id[1]
    "MOVE_ID"         // id interno Odoo (útil para cruzar)
  ];

  var rows = [headers];

  allLines.forEach(function(line, i) {
    var rowNum = i + 3; // fila real en sheet (cabecera en fila 1, datos desde fila 2)
    var moveState = (line["move_id"] ? moveStateMap[String(line["move_id"][0])] : "") || "";
    var estadoLabel = moveState === "posted" ? "Contabilizado" : moveState === "draft" ? "Borrador" : moveState;

    rows.push([
      line["move_id"]    ? line["move_id"][1]    : "",
      estadoLabel,
      line["date"]       || "",
      line["journal_id"] ? line["journal_id"][1] : "",
      line["account_id"] ? (accountCodeMap[String(line["account_id"][0])] || "") : "",
      line["name"]       || "",
      line["ref"]        || "",
      line["debit"]      || 0,
      line["credit"]     || 0,
      "",                // BALANCE: fórmula se añade después
      line["company_id"] ? line["company_id"][1] : "",
      line["move_id"]    ? line["move_id"][0]    : ""  // ID numérico
    ]);
  });

  // Escribir de golpe
  if (rows.length > 1) {
    auditSheet.getRange(1, 1, rows.length, headers.length).setValues(rows);
  } else {
    auditSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  // Fórmulas BALANCE (col J = 10)
  if (allLines.length > 0) {
    var balanceFormulas = [];
    for (var r = 2; r <= allLines.length + 1; r++) {
      balanceFormulas.push(["=H" + r + "-I" + r]);
    }
    auditSheet.getRange(2, 10, balanceFormulas.length, 1).setFormulas(balanceFormulas);
  }

  // ── Formato ────────────────────────────────────────────────────────────────

  // Cabecera: fondo azul oscuro, texto blanco, negrita
  var headerRange = auditSheet.getRange(1, 1, 1, headers.length);
  headerRange.setBackground("#1a3a5c");
  headerRange.setFontColor("#ffffff");
  headerRange.setFontWeight("bold");
  headerRange.setFontFamily("Arial");
  headerRange.setFontSize(10);

  // Datos
  if (allLines.length > 0) {
    var dataRange = auditSheet.getRange(2, 1, allLines.length, headers.length);
    dataRange.setFontFamily("Arial");
    dataRange.setFontSize(9);

    // Formato numérico para DEBE, HABER, BALANCE
    auditSheet.getRange(2, 8, allLines.length, 3).setNumberFormat("#,##0.00");

    // Fecha
    auditSheet.getRange(2, 3, allLines.length, 1).setNumberFormat("dd/mm/yyyy");

    // Color filas alternas
    for (var row = 2; row <= allLines.length + 1; row++) {
      if (row % 2 === 0) {
        auditSheet.getRange(row, 1, 1, headers.length).setBackground("#f0f4f8");
      }
    }

    // ESTADO: colorear celdas
    for (var si = 0; si < allLines.length; si++) {
      var stateVal = rows[si + 1][1];
      var stateCell = auditSheet.getRange(si + 2, 2);
      if (stateVal === "Contabilizado") {
        stateCell.setBackground("#d4edda").setFontColor("#155724");
      } else if (stateVal === "Borrador") {
        stateCell.setBackground("#fff3cd").setFontColor("#856404");
      }
    }
  }

  // Anchos de columna
  var colWidths = [180, 110, 90, 150, 220, 250, 150, 90, 90, 90, 130, 80];
  colWidths.forEach(function(w, i) {
    auditSheet.setColumnWidth(i + 1, w);
  });

  // Fila superior fija
  auditSheet.setFrozenRows(1);

  // ── Nota de última actualización en celda A encima de cabecera ─────────────
  // La ponemos en una fila 0... no existe. La ponemos como nota en A1.
  var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss");
  auditSheet.getRange(1, 1).setNote("Última actualización: " + ts + "\nDiarios consultados: " + journalIds.join(", ") + "\nTotal apuntes: " + allLines.length);

  // ── Resumen rápido al final ─────────────────────────────────────────────────
  if (allLines.length > 0) {
    var summaryRow = allLines.length + 3;
    auditSheet.getRange(summaryRow, 1).setValue("TOTAL").setFontWeight("bold");
    auditSheet.getRange(summaryRow, 8).setFormula("=SUM(H2:H" + (allLines.length + 1) + ")").setNumberFormat("#,##0.00").setFontWeight("bold");
    auditSheet.getRange(summaryRow, 9).setFormula("=SUM(I2:I" + (allLines.length + 1) + ")").setNumberFormat("#,##0.00").setFontWeight("bold");
    auditSheet.getRange(summaryRow, 10).setFormula("=SUM(J2:J" + (allLines.length + 1) + ")").setNumberFormat("#,##0.00").setFontWeight("bold");
    auditSheet.getRange(summaryRow, 1, 1, headers.length).setBackground("#1a3a5c").setFontColor("#ffffff");
  }

  Logger.log("✅ ODOO_AUDIT actualizada. " + allLines.length + " apuntes volcados.");

  ui.alert(
    "✅ Auditoría actualizada",
    allLines.length + " apuntes cargados desde Odoo.\n" +
    "Diarios: " + journalIds.join(", ") + "\n" +
    "Periodo: " + dateFrom + " → " + dateTo,
    ui.ButtonSet.OK
  );
}