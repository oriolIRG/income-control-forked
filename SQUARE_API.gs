// ═══════════════════════════════════════════════════════════════════
// SQUARE_API.GS
// Todas las llamadas a la API de Square con paginación automática
// ═══════════════════════════════════════════════════════════════════
//
// SIN CAMBIOS respecto a la versión anterior.
// El soporte de offline payments se gestiona aguas abajo (DataProcessor + Main).
// ═══════════════════════════════════════════════════════════════════

function _sqHeaders() {
  return {
    'Authorization' : 'Bearer ' + getSquareToken(),
    'Square-Version': SQ_VERSION,
    'Content-Type'  : 'application/json'
  };
}

function _sqFetchWithRetry(url, options, maxRetries) {
  maxRetries = maxRetries || 3;
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const r = UrlFetchApp.fetch(url, options);
      if (r.getResponseCode() === 429) {
        const wait = Math.pow(2, attempt) * 2000;
        logMessage('WARN', `Rate limit (429) en ${url} — esperando ${wait/1000}s`);
        Utilities.sleep(wait);
        continue;
      }
      return r;
    } catch (e) {
      lastError = e;
      if (e.message && e.message.includes('Bandwidth quota')) {
        const wait = Math.pow(2, attempt) * 5000;
        logMessage('WARN', `Bandwidth quota exceeded — esperando ${wait/1000}s (intento ${attempt + 1}/${maxRetries})`);
        Utilities.sleep(wait);
      } else {
        throw e;
      }
    }
  }
  throw lastError;
}

function _sqGet(path, params) {
  let url = 'https://connect.squareup.com/v2' + path;
  if (params) {
    url += '?' + Object.keys(params)
      .map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  }
  const r = _sqFetchWithRetry(url, {
    method: 'get', headers: _sqHeaders(), muteHttpExceptions: true
  });
  return JSON.parse(r.getContentText());
}

function _sqPost(path, body) {
  const r = _sqFetchWithRetry('https://connect.squareup.com/v2' + path, {
    method  : 'post',
    headers : _sqHeaders(),
    payload : JSON.stringify(body),
    muteHttpExceptions: true
  });
  return JSON.parse(r.getContentText());
}

// ── Orders ─────────────────────────────────────────────────────────
function fetchOrders(locationId, beginTime, endTime) {
  const orders = [];
  let cursor;
  do {
    const body = {
      location_ids: [locationId],
      query: {
        filter: {
          date_time_filter: { closed_at: { start_at: beginTime, end_at: endTime } },
          state_filter    : { states: ['COMPLETED'] }
        },
        sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' }
      },
      limit: 500
    };
    if (cursor) body.cursor = cursor;
    const d = _sqPost('/orders/search', body);
    if (d.errors) logMessage('ERROR', 'fetchOrders: ' + JSON.stringify(d.errors));
    if (d.orders) orders.push(...d.orders);
    cursor = d.cursor;
  } while (cursor);
  return orders;
}

// ── Payments ───────────────────────────────────────────────────────
function fetchPayments(locationId, beginTime, endTime) {
  const payments = [];
  let cursor;
  do {
    const params = { begin_time: beginTime, end_time: endTime, location_id: locationId, limit: 200 };
    if (cursor) params.cursor = cursor;
    const d = _sqGet('/payments', params);
    if (d.payments) payments.push(...d.payments.filter(p => p.status === 'COMPLETED'));
    cursor = d.cursor;
  } while (cursor);
  return payments;
}

// ── Refunds ────────────────────────────────────────────────────────
function fetchRefunds(locationId, beginTime, endTime) {
  const refunds = [];
  let cursor;
  do {
    const params = { begin_time: beginTime, end_time: endTime, location_id: locationId, limit: 200 };
    if (cursor) params.cursor = cursor;
    const d = _sqGet('/refunds', params);
    if (d.refunds) refunds.push(...d.refunds.filter(r => r.status === 'COMPLETED'));
    cursor = d.cursor;
  } while (cursor);
  return refunds;
}

// ── Catálogo ───────────────────────────────────────────────────────
function fetchCatalog() {
  function listType(type) {
    const objs = [];
    let cursor;
    do {
      const params = { types: type, limit: 1000, include_deleted_objects: true };
      if (cursor) params.cursor = cursor;
      const d = _sqGet('/catalog/list', params);
      if (d.objects) objs.push(...d.objects);
      cursor = d.cursor;
    } while (cursor);
    return objs;
  }

  // Para ITEM_VARIATION usar search que devuelve más objetos borrados
  function searchType(type) {
    const objs = [];
    let cursor;
    do {
      const body = {
        object_types: [type],
        include_deleted_objects: true,
        limit: 1000
      };
      if (cursor) body.cursor = cursor;
      const d = _sqPost('/catalog/search', body);
      if (d.objects) objs.push(...d.objects);
      cursor = d.cursor;
    } while (cursor);
    return objs;
  }

  return {
    items      : listType('ITEM'),
    variations : searchType('ITEM_VARIATION'),  // ← search en vez de list
    categories : listType('CATEGORY')
  };
}