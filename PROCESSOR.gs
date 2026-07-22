// ═══════════════════════════════════════════════════════════════════
// DATA_PROCESSOR.GS
// Lógica de día de reporte, shifts, categorías y agregación
// ═══════════════════════════════════════════════════════════════════
//
// CAMBIOS — Soporte para offline payments
// ───────────────────────────────────────
// Cuando un Square Terminal pierde internet, sigue cobrando en modo
// offline y guarda los pagos localmente. Al recuperar conexión, los
// sincroniza pero les pone como `created_at` la HORA DE SYNC, no la
// hora real del cobro. Lo mismo le pasa a la order asociada.
//
// Square nos da la hora real en `payment.offline_payment_details.client_created_at`.
//
// La función `getPaymentEffectiveTs` resuelve el timestamp correcto.
// La función `buildOrderEffectiveTsMap` construye order_id → ts_real
// usando la correspondencia 1-a-1 con sus payments offline.
// ═══════════════════════════════════════════════════════════════════

// ── Día de reporte ─────────────────────────────────────────────────
// Los días van de 06:00 a 05:59 del siguiente día (hora local).
// Un pedido a las 03:15 del lunes tiene reporting_date = domingo.
function getReportingDate(utcStr) {
  const d = new Date(utcStr);
  const local = Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  const hour  = parseInt(local.split(' ')[1]);
  const date  = local.split(' ')[0];
  if (hour >= DAY_START_HOUR) return date;
  const prev = new Date(d.getTime() - 24 * 3600 * 1000);
  return Utilities.formatDate(prev, TIMEZONE, 'yyyy-MM-dd');
}

// Día de la semana del reporting_date (0=Dom … 6=Sáb)
function getReportingDow(reportingDateStr) {
  const [y, m, day] = reportingDateStr.split('-').map(Number);
  return new Date(y, m - 1, day).getDay();
}

// ── NUEVO: Resolución de timestamp efectivo ─────────────────────────
// Para un payment, devuelve la hora REAL del cobro:
//   - si es offline → offline_payment_details.client_created_at
//   - si no → created_at
function getPaymentEffectiveTs(payment) {
  if (payment &&
      payment.offline_payment_details &&
      payment.offline_payment_details.client_created_at) {
    return payment.offline_payment_details.client_created_at;
  }
  return payment ? payment.created_at : null;
}

// Construye un mapa { order_id → effective_ts } usando los payments offline.
// Para una order asociada a un payment offline, su closed_at/created_at miente,
// pero podemos derivar el timestamp real desde su payment correspondiente.
function buildOrderEffectiveTsMap(payments) {
  const map = {};
  for (const p of payments) {
    if (!p.order_id) continue;
    if (p.offline_payment_details && p.offline_payment_details.client_created_at) {
      map[p.order_id] = p.offline_payment_details.client_created_at;
    }
  }
  return map;
}

// Devuelve el timestamp efectivo de una order: si está en el mapa de
// offline overrides, usa ese; si no, usa closed_at o updated_at (fallback).
function getOrderEffectiveTs(order, orderEffectiveTsMap) {
  if (orderEffectiveTsMap && orderEffectiveTsMap[order.id]) {
    return orderEffectiveTsMap[order.id];
  }
  return order.closed_at || order.updated_at;
}

// ── Shift ──────────────────────────────────────────────────────────
function resolveShift(utcStr, locationName, shifts) {
  const d   = new Date(utcStr);
  const hm  = Utilities.formatDate(d, TIMEZONE, 'HH:mm');
  const repDate = getReportingDate(utcStr);
  const dow = getReportingDow(repDate);
  const cur = _toMins(hm);

  // ¿Hay override fechado para este reporting day? (aplica a TODAS las locations)
  const hasOverride = shifts.some(s => s.date === repDate);
  const pool = hasOverride
    ? shifts.filter(s => s.date === repDate)  // solo el mapping especial de ese día
    : shifts.filter(s => !s.date);            // solo el mapping por defecto

  for (const s of pool) {
    if (s.location !== locationName || s.dow !== dow) continue;
    const from = _toMins(s.from);
    const to   = _toMins(s.to);
    if (from < to) {
      if (cur >= from && cur < to) return s.shift;
    } else {
      if (cur >= from || cur < to) return s.shift;
    }
  }
  return 'UNKNOWN';
}
function _toMins(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

// ── Catálogo: mapas de resolución ──────────────────────────────────
function buildItemCategoryMap(catalog) {
  const map = {};
  for (const item of catalog.items) {
    const d = item.item_data;
    if (!d) continue;
    let catId = null;
    if (d.reporting_category && d.reporting_category.id) catId = d.reporting_category.id;
    else if (d.categories    && d.categories.length)      catId = d.categories[0].id;
    else if (d.category_id)                               catId = d.category_id;
    if (!catId) continue;
    map[item.id] = catId;
    (d.variations || []).forEach(v => { map[v.id] = catId; });
  }

  for (const variation of (catalog.variations || [])) {
    if (map[variation.id]) continue;
    const vd = variation.item_variation_data;
    if (!vd || !vd.item_id) continue;
    if (map[vd.item_id]) {
      map[variation.id] = map[vd.item_id];
    }
  }

  return map;
}

function buildCategoryResolutionMap(catalog, configCategories) {
  const parentOf = {};
  for (const cat of catalog.categories) {
    parentOf[cat.id] = cat.category_data && cat.category_data.parent_category
      ? cat.category_data.parent_category.id
      : null;
  }

  function rootOf(id) {
    let cur = id;
    const seen = new Set();
    while (parentOf[cur] && !seen.has(cur)) { seen.add(cur); cur = parentOf[cur]; }
    return cur;
  }

  const configById = {};
  for (const cc of configCategories) {
    for (const sqId of cc.squareCategoryIds) configById[sqId] = cc.label;
  }

  const res = {};
  for (const cat of catalog.categories) {
    const root = rootOf(cat.id);
    res[cat.id] = configById[root] || configById[cat.id] || 'OTHER';
  }
  return res;
}

// ── Agregación ─────────────────────────────────────────────────────
// CAMBIO: ahora recibe `orderEffectiveTsMap` para resolver timestamps de
// orders/payments offline, y usa los timestamps efectivos en todos los buckets.
function buildRows(orders, payments, refunds, location, shifts, configCategories, itemCategoryMap, catResMap, orderEffectiveTsMap) {
  const rows = {};
  orderEffectiveTsMap = orderEffectiveTsMap || {};

  function key(date, shift) { return `${date}||${shift}`; }

  function ensure(date, shift) {
    const k = key(date, shift);
    if (!rows[k]) {
      const catGross = { OTHER: 0 };
      const catTax   = { OTHER: 0 };
      configCategories.forEach(c => { catGross[c.label] = 0; catTax[c.label] = 0; });
      rows[k] = {
        reporting_date: date,
        location      : location.name,
        shift,
        catGross,
        catTax,
        discounts    : 0,
        cash         : 0,
        card         : 0,
        gift_card    : 0,
        wallet       : 0,
        check_pmt    : 0,
        bank_transfer: 0,
        other_pay    : 0,
        tips         : 0,
        fees         : 0,
        refunds      : 0,
        order_count  : 0
      };
    }
    return rows[k];
  }

  // ── Órdenes → categorías, IVA, descuentos, returns ────────────
  for (const order of orders) {
    // CAMBIO: usar el ts efectivo (offline-aware)
    const ts = getOrderEffectiveTs(order, orderEffectiveTsMap);
    if (!ts) continue;
    const date  = getReportingDate(ts);
    const shift = resolveShift(ts, location.name, shifts);
    const row   = ensure(date, shift);
    row.order_count++;

    // Ventas
    for (const li of (order.line_items || [])) {
      if (li.quantity && parseFloat(li.quantity) < 0) continue;

      const varId    = li.catalog_object_id;
      const sqCatId  = varId ? itemCategoryMap[varId] : null;
      const catLabel = sqCatId ? (catResMap[sqCatId] || 'OTHER') : 'OTHER';

      const charged  = li.total_money          ? li.total_money.amount          : 0;
      const discount = li.total_discount_money ? li.total_discount_money.amount : 0;
      let   tax      = 0;
      for (const at of (li.applied_taxes || [])) {
        tax += at.applied_money ? at.applied_money.amount : 0;
      }

      row.catGross[catLabel] = (row.catGross[catLabel] || 0) + charged;
      row.catTax[catLabel]   = (row.catTax[catLabel]   || 0) + tax;
      row.discounts         += discount;
    }

    // Returns → restan de la categoría e IVA correspondientes
    for (const ret of (order.returns || [])) {
      for (const rli of (ret.return_line_items || [])) {
        const varId    = rli.catalog_object_id;
        const sqCatId  = varId ? itemCategoryMap[varId] : null;
        const catLabel = sqCatId ? (catResMap[sqCatId] || 'OTHER') : 'OTHER';

        const returned = rli.total_money ? rli.total_money.amount : 0;
        let   taxBack  = 0;
        for (const at of (rli.applied_taxes || [])) {
          taxBack += at.applied_money ? at.applied_money.amount : 0;
        }

        row.catGross[catLabel] = (row.catGross[catLabel] || 0) - returned;
        row.catTax[catLabel]   = (row.catTax[catLabel]   || 0) - taxBack;
      }

      if (ret.return_amounts && ret.return_amounts.total_money) {
        row.refunds -= ret.return_amounts.total_money.amount;
      }
    }

    // Tip refunds
    if (order.return_amounts && order.return_amounts.tip_money) {
      row.tips -= order.return_amounts.tip_money.amount;
    } else {
      (order.returns || []).forEach(ret => {
        (ret.return_tips || []).forEach(rt => {
          if (rt.applied_money) row.tips -= rt.applied_money.amount;
        });
      });
    }
  }

  // ── Payments → métodos de pago, tips, fees ─────────────────────
  for (const pmt of payments) {
    // CAMBIO: usar ts efectivo (offline-aware)
    const ts    = getPaymentEffectiveTs(pmt);
    const date  = getReportingDate(ts);
    const shift = resolveShift(ts, location.name, shifts);
    const row   = ensure(date, shift);

    const amount = pmt.amount_money ? pmt.amount_money.amount : 0;
    const tip    = pmt.tip_money    ? pmt.tip_money.amount    : 0;
    row.tips += tip;

    switch (pmt.source_type) {
      case 'CASH':
        row.cash      += amount; break;
      case 'CARD':
        row.card      += amount + tip; break;
      case 'SQUARE_GIFT_CARD':
        row.gift_card += amount; break;
      case 'WALLET':
        row.wallet    += amount; break;
      case 'EXTERNAL': {
        const extType = pmt.external_details && pmt.external_details.type
          ? pmt.external_details.type : 'UNKNOWN';
        switch (extType) {
          case 'CHECK':         row.check_pmt     += amount; break;
          case 'BANK_TRANSFER': row.bank_transfer += amount; break;
          default:              row.other_pay     += amount;
        }
        break;
      }
      default:
        row.other_pay += amount;
    }

    for (const fee of (pmt.processing_fee || [])) {
      row.fees += fee.amount_money ? fee.amount_money.amount : 0;
    }
  }

  // ── Refunds ────────────────────────────────────────────────────
  // Para refunds nos quedamos con created_at (no hay equivalente offline_*).
  // Si llegan a darse refunds offline en el futuro, se ajusta aquí.
  for (const ref of refunds) {
    const date   = getReportingDate(ref.created_at);
    const shift  = resolveShift(ref.created_at, location.name, shifts);
    const row    = ensure(date, shift);
    const amount = ref.amount_money ? ref.amount_money.amount : 0;

    const dest = ref.destination_type || '';
    if      (dest === 'CASH')             row.cash      -= amount;
    else if (dest === 'CARD')             row.card      -= amount;
    else if (dest === 'SQUARE_GIFT_CARD') row.gift_card -= amount;
    else if (dest === 'WALLET')           row.wallet    -= amount;
    else                                  row.other_pay -= amount;
  }

  return Object.values(rows);
}

// ── Discount rows: también offline-aware ───────────────────────────
function buildDiscountRows(orders, location, shifts, itemCategoryMap, catResMap, orderEffectiveTsMap) {
  const rows = {};
  orderEffectiveTsMap = orderEffectiveTsMap || {};

  const orderTenderMap = {};
  orders.forEach(o => {
    orderTenderMap[o.id] = o.tenders && o.tenders.length > 0 ? 'Y' : 'N';
  });

  function accumulateDiscount(date, shift, li, isReturn, order, ret, hasTender) {
    const varId    = li.catalog_object_id;
    const sqCatId  = varId ? itemCategoryMap[varId] : null;
    const category = sqCatId ? (catResMap[sqCatId] || 'OTHER') : 'OTHER';

    for (const ad of (li.applied_discounts || [])) {
      let discountDef = (order.discounts || []).find(d => d.uid === ad.discount_uid);

      if (!discountDef && isReturn && ret) {
        discountDef = (ret.return_discounts || []).find(d =>
          d.uid === ad.discount_uid ||
          d.source_discount_uid === ad.discount_uid
        );
      }

      const name   = discountDef ? (discountDef.name || 'Sin nombre') : 'MANUAL';
      const type   = discountDef ? (discountDef.type || 'UNKNOWN')    : 'MANUAL';
      const amount = ad.applied_money ? ad.applied_money.amount : 0;
      const k      = `${date}||${shift}||${name}||${category}||${hasTender}`;

      if (!rows[k]) {
        rows[k] = {
          reporting_date: date,
          location      : location.name,
          shift,
          discount_name : name,
          discount_type : type,
          category,
          has_tender    : hasTender,
          gross_amount  : 0,
          order_count   : new Set()
        };
      }
      rows[k].gross_amount += isReturn ? -amount : amount;
      rows[k].order_count.add(order.id);
    }
  }

  for (const order of orders) {
    // CAMBIO: usar ts efectivo
    const ts = getOrderEffectiveTs(order, orderEffectiveTsMap);
    if (!ts) continue;

    const hasTender = order.tenders && order.tenders.length > 0 ? 'Y' : 'N';
    const date      = getReportingDate(ts);
    const shift     = resolveShift(ts, location.name, shifts);

    for (const li of (order.line_items || [])) {
      if (li.quantity && parseFloat(li.quantity) < 0) continue;
      accumulateDiscount(date, shift, li, false, order, null, hasTender);
    }

    for (const ret of (order.returns || [])) {
      const sourceHasTender = ret.source_order_id
        ? (orderTenderMap[ret.source_order_id] || hasTender)
        : hasTender;

      for (const rli of (ret.return_line_items || [])) {
        accumulateDiscount(date, shift, rli, true, order, ret, sourceHasTender);
      }
    }
  }

  return Object.values(rows).map(r => ({ ...r, order_count: r.order_count.size }));
}