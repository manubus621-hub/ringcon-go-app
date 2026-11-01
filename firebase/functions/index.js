/* Backend Ringcon Go · Cloud Functions (2ª gen)
   Todo lo que mueve plata o cambia el estado de un pedido pasa por acá:
   el navegador nunca decide precios, pagos ni quién es conductor. */
'use strict';

const crypto = require('crypto');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase, ServerValue } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onValueWritten } = require('firebase-functions/v2/database');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');

initializeApp();
// Misma región que la Realtime Database (los triggers de base lo exigen).
const REGION = 'us-central1';
setGlobalOptions({ region: REGION, maxInstances: 10 });

const db = getDatabase();
const MP_TOKEN = defineSecret('MP_ACCESS_TOKEN');
const MP_WEBHOOK_SECRET = defineSecret('MP_WEBHOOK_SECRET');

const PROJECT = process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId;
const WEBHOOK_URL = `https://${REGION}-${PROJECT}.cloudfunctions.net/mpWebhook`;
const DRIVER_EMAIL_DOMAIN = 'conductores.ringcongo.app';
const TIPS = [0, 1000, 2000, 3000];
const SERVICE_RATE = 0.15;
const ZONE = { lat: -37.3906, lon: -68.9298, km: 15 };   // Rincón de los Sauces
const ACTIVE = ['pago_pendiente', 'nuevo', 'aceptado', 'en_local', 'recogido'];
const FLOW = { aceptado: 'en_local', en_local: 'recogido', recogido: 'entregado' };
const DOCS = ['dni_frente', 'dni_dorso', 'selfie'];
const PENDING_PAY_TTL = 30 * 60e3;
const PRESENCE_TTL = 3 * 60e3;

/* ─────────── utilidades ─────────── */
const fail = (code, msg) => { throw new HttpsError(code, msg); };
const needAuth = req => { if (!req.auth) fail('unauthenticated', 'Iniciá sesión para continuar.'); return req.auth.uid; };
const isAdmin = async uid => (await db.ref(`admins/${uid}`).get()).val() === true;
async function needAdmin(req) { const uid = needAuth(req); if (!(await isAdmin(uid))) fail('permission-denied', 'Solo administradores.'); return uid; }
const str = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const key = v => { const s = str(v, 40); if (!/^[\w-]{1,40}$/.test(s)) fail('invalid-argument', 'Identificador inválido.'); return s; };
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanDni = v => { const d = String(v ?? '').replace(/\D/g, ''); return /^\d{7,8}$/.test(d) && Number(d) >= 1000000 ? d : null; };
const mask = s => norm(s).split(' ').map(w => w[0] + '•'.repeat(Math.max(2, w.length - 1))).join(' ');
const driverEmail = dni => `${dni}@${DRIVER_EMAIL_DOMAIN}`;
function distKm(a, b) {
  const r = x => x * Math.PI / 180, dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Ventana fija por usuario (o por DNI) para frenar abuso y fuerza bruta.
async function rateLimit(bucket, max, windowMs) {
  const now = Date.now();
  const res = await db.ref(`rate/${bucket}`).transaction(cur => {
    const c = cur && now - cur.t < windowMs ? cur : { t: now, n: 0 };
    c.n += 1; return c;
  });
  if (res.snapshot.val().n > max) fail('resource-exhausted', 'Demasiados intentos. Probá de nuevo más tarde.');
}

async function mp(path, opts = {}) {
  const r = await fetch('https://api.mercadopago.com' + path, {
    ...opts,
    headers: { Authorization: `Bearer ${MP_TOKEN.value()}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { logger.error('Mercado Pago', path, r.status, body); throw new Error(`MP ${r.status}`); }
  return body;
}

const REJECT = {
  cc_rejected_insufficient_amount: 'La tarjeta no tiene fondos suficientes.',
  cc_rejected_bad_filled_security_code: 'El código de seguridad es incorrecto.',
  cc_rejected_bad_filled_date: 'La fecha de vencimiento es incorrecta.',
  cc_rejected_bad_filled_card_number: 'Revisá el número de la tarjeta.',
  cc_rejected_call_for_authorize: 'Tenés que autorizar el pago con tu banco.',
  cc_rejected_card_disabled: 'La tarjeta está inhabilitada. Llamá a tu banco.',
  cc_rejected_duplicated_payment: 'Ya hiciste un pago igual hace instantes.',
  cc_rejected_high_risk: 'El pago fue rechazado por seguridad. Probá con otra tarjeta.',
  cc_rejected_max_attempts: 'Llegaste al límite de intentos. Probá con otra tarjeta.'
};

/* ─────────── pedidos ─────────── */
exports.createOrder = onCall(async req => {
  const uid = needAuth(req);
  await rateLimit(`${uid}/order`, 12, 3600e3);
  const d = req.data || {};

  const profile = (await db.ref(`customers/${uid}`).get()).val();
  if (!profile || !profile.name) fail('failed-precondition', 'Completá tu nombre antes de pedir.');

  const mineSnap = await db.ref(`userOrders/${uid}`).limitToLast(10).get();
  const recent = await Promise.all(Object.keys(mineSnap.val() || {}).map(id => db.ref(`orders/${id}/status`).get()));
  if (recent.filter(s => ACTIVE.includes(s.val())).length >= 2) fail('failed-precondition', 'Ya tenés pedidos en curso. Esperá a que lleguen.');

  const bizId = key(d.bizId);
  const b = (await db.ref(`catalog/${bizId}`).get()).val();
  if (!b || b.open === false) fail('not-found', 'El local no está disponible ahora.');

  const items = [];
  for (const [id, q] of Object.entries(d.items || {})) {
    const m = b.menu && b.menu[id], qty = Math.floor(Number(q));
    if (!m || m.available === false || !(qty >= 1 && qty <= 20)) fail('invalid-argument', 'Algún producto ya no está disponible. Revisá el carrito.');
    items.push({ id, name: m.name, qty, price: Number(m.price) });
  }
  if (!items.length || items.length > 30) fail('invalid-argument', 'El carrito está vacío.');

  const method = d.method === 'tarjeta' || d.method === 'efectivo' ? d.method : fail('invalid-argument', 'Elegí cómo pagar.');
  const tip = TIPS.includes(Number(d.tip)) ? Number(d.tip) : 0;

  const a = d.address || {}, text = str(a.text, 120);
  if (text.length < 5) fail('invalid-argument', 'Escribí tu dirección completa.');
  const address = { text, ref: str(a.ref, 80) };
  if (Number.isFinite(a.lat) && Number.isFinite(a.lon)) {
    if (distKm(ZONE, { lat: a.lat, lon: a.lon }) > ZONE.km) fail('out-of-range', 'Por ahora solo entregamos en Rincón de los Sauces.');
    address.lat = a.lat; address.lon = a.lon;
  }

  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const fee = Number(b.fee) || 0, service = Math.round(subtotal * SERVICE_RATE);
  const totals = { subtotal, fee, service, tip, total: subtotal + fee + service + tip };

  const payment = { method, status: method === 'tarjeta' ? 'pendiente' : 'a_cobrar' };
  if (method === 'efectivo' && d.cashWith) {
    const cash = Math.floor(Number(d.cashWith));
    if (!(cash >= totals.total && cash <= totals.total + 100000)) fail('invalid-argument', `El monto en efectivo tiene que cubrir ${totals.total}.`);
    payment.cashWith = cash;
  }

  const ref = db.ref('orders').push(), id = ref.key;
  const status = method === 'tarjeta' ? 'pago_pendiente' : 'nuevo';
  const order = {
    id, status, customerUid: uid,
    createdAt: ServerValue.TIMESTAMP, updatedAt: ServerValue.TIMESTAMP, [`t_${status}`]: ServerValue.TIMESTAMP,
    customer: { name: profile.name, phone: profile.phone || '' },
    business: { id: bizId, name: b.name },
    items, address, notes: str(d.notes, 140), totals,
    driverPay: fee + tip,
    split: { restaurant: subtotal, driver: fee + tip, commission: service },
    payment
  };
  await db.ref().update({ [`orders/${id}`]: order, [`userOrders/${uid}/${id}`]: true });
  return { orderId: id, status, total: totals.total };
});

exports.payOrder = onCall({ secrets: [MP_TOKEN] }, async req => {
  const uid = needAuth(req);
  await rateLimit(`${uid}/pay`, 10, 3600e3);
  const { orderId, form } = req.data || {};
  const ref = db.ref(`orders/${key(orderId)}`);
  const o = (await ref.get()).val();
  if (!o || o.customerUid !== uid) fail('not-found', 'Pedido no encontrado.');
  if (o.payment.method !== 'tarjeta' || o.status !== 'pago_pendiente') fail('failed-precondition', 'Este pedido ya no espera un pago.');
  if (!form || !str(form.token, 200) || !str(form.payment_method_id, 40)) fail('invalid-argument', 'Faltan datos de la tarjeta.');

  const attempt = (o.payment.attempts || 0) + 1;
  await ref.child('payment/attempts').set(attempt);
  const ident = form.payer && form.payer.identification;
  const body = {
    transaction_amount: o.totals.total,               // el monto sale del servidor, nunca del navegador
    token: str(form.token, 200),
    installments: Math.min(12, Math.max(1, parseInt(form.installments, 10) || 1)),
    payment_method_id: str(form.payment_method_id, 40),
    ...(form.issuer_id ? { issuer_id: String(form.issuer_id).slice(0, 20) } : {}),
    description: `Ringcon Go · ${o.business.name}`,
    statement_descriptor: 'RINGCONGO',
    external_reference: o.id,
    notification_url: WEBHOOK_URL,
    payer: {
      email: str(form.payer && form.payer.email, 120),
      ...(ident ? { identification: { type: str(ident.type, 10), number: str(ident.number, 20) } } : {})
    }
  };
  let p;
  try { p = await mp('/v1/payments', { method: 'POST', headers: { 'X-Idempotency-Key': `${o.id}-${attempt}` }, body: JSON.stringify(body) }); }
  catch { fail('unavailable', 'No pudimos procesar el pago. Revisá los datos o probá otra tarjeta.'); }

  await applyPayment(o.id, p);
  return { status: p.status, message: p.status === 'rejected' ? (REJECT[p.status_detail] || 'El pago fue rechazado. Probá con otra tarjeta.') : '' };
});

// Aplica el estado real de un pago de Mercado Pago a su pedido (lo usan payOrder y el webhook).
async function applyPayment(orderId, p) {
  if (!/^[\w-]{1,40}$/.test(orderId) || String(p.external_reference) !== orderId) return;
  let refundNeeded = false;
  const res = await db.ref(`orders/${orderId}`).transaction(o => {
    if (!o) return o;
    if (Math.round(Number(p.transaction_amount)) !== Math.round(o.totals.total)) { o.payment.flag = 'monto_distinto'; return o; }
    const now = Date.now();
    o.payment = { ...o.payment, mpId: String(p.id), status: p.status, detail: p.status_detail || '', updatedAt: now };
    if (p.status === 'approved' && o.status === 'pago_pendiente') { o.status = 'nuevo'; o.t_nuevo = now; o.updatedAt = now; }
    refundNeeded = p.status === 'approved' && o.status === 'cancelado';
    return o;
  });
  if (refundNeeded && res.committed) await refund(res.snapshot.val());
}

async function refund(o) {
  try {
    await mp(`/v1/payments/${o.payment.mpId}/refunds`, { method: 'POST', headers: { 'X-Idempotency-Key': `refund-${o.id}` }, body: '{}' });
    await db.ref(`orders/${o.id}/payment`).update({ status: 'refunded', updatedAt: Date.now() });
  } catch (e) {
    logger.error('Reembolso fallido', o.id, e);
    await db.ref(`orders/${o.id}/payment/flag`).set('reembolso_fallido');
  }
}

function validSignature(req, dataId, secret) {
  const sig = String(req.get('x-signature') || ''), rid = String(req.get('x-request-id') || '');
  const parts = Object.fromEntries(sig.split(',').map(s => s.trim().split('=')));
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${rid};ts:${parts.ts};`;
  const want = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return want.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(parts.v1));
}

exports.mpWebhook = onRequest({ secrets: [MP_TOKEN, MP_WEBHOOK_SECRET] }, async (req, res) => {
  const type = req.query.type || req.query.topic || (req.body && req.body.type);
  const id = String(req.query['data.id'] || (req.body && req.body.data && req.body.data.id) || '');
  if (type !== 'payment' || !/^\d{1,20}$/.test(id)) { res.status(200).send('ignorado'); return; }
  if (!validSignature(req, id, MP_WEBHOOK_SECRET.value())) { res.status(401).send('firma inválida'); return; }
  try {
    // Nunca confiamos en el cuerpo del aviso: consultamos el pago a Mercado Pago.
    const p = await mp(`/v1/payments/${id}`);
    if (p.external_reference) await applyPayment(String(p.external_reference), p);
    res.status(200).send('ok');
  } catch (e) {
    logger.error('Webhook', e);
    res.status(500).send('error');
  }
});

exports.cancelOrder = onCall({ secrets: [MP_TOKEN] }, async req => {
  const uid = needAuth(req), admin = await isAdmin(uid);
  const id = key(req.data && req.data.orderId);
  const res = await db.ref(`orders/${id}`).transaction(o => {
    if (!o) return o;
    if (!admin && (o.customerUid !== uid || !['pago_pendiente', 'nuevo'].includes(o.status))) return;
    if (['entregado', 'cancelado'].includes(o.status)) return;
    const now = Date.now();
    o.status = 'cancelado'; o.cancelledBy = admin ? 'admin' : 'cliente'; o.updatedAt = now; o.t_cancelado = now;
    return o;
  });
  const o = res.snapshot.val();
  if (!res.committed || !o || o.status !== 'cancelado') fail('failed-precondition', 'Ya no se puede cancelar: un conductor tomó el pedido.');
  if (o.driver) await db.ref(`driverActive/${o.driver.uid}`).remove();
  if (o.payment.method === 'tarjeta' && o.payment.status === 'approved') await refund(o);
  return { ok: true };
});

/* ─────────── conductores: identidad ─────────── */
exports.driverLookup = onCall(async req => {
  const uid = needAuth(req);
  await rateLimit(`${uid}/lookup`, 20, 3600e3);
  const dni = cleanDni(req.data && req.data.dni);
  if (!dni) fail('invalid-argument', 'El DNI tiene que tener 7 u 8 números.');
  const p = (await db.ref(`padron/${dni}`).get()).val();
  if (!p) return { found: false };
  // Devolvemos el nombre enmascarado: confirma el registro sin exponer datos a terceros.
  return { found: true, active: p.activo !== false, claimed: !!p.uid, name: mask(`${p.nombre} ${p.apellido}`) };
});

exports.driverRegister = onCall(async req => {
  const uid = needAuth(req);
  const d = req.data || {}, dni = cleanDni(d.dni);
  if (!dni) fail('invalid-argument', 'DNI inválido.');
  await rateLimit(`${uid}/register`, 6, 3600e3);
  await rateLimit(`dni_${dni}`, 5, 24 * 3600e3);   // por DNI: aunque cambien de cuenta, no pueden adivinar la fecha

  const pRef = db.ref(`padron/${dni}`), p = (await pRef.get()).val();
  if (!p || p.activo === false) fail('not-found', 'Tu DNI no está habilitado en el padrón de conductores.');
  if (p.uid) fail('already-exists', 'Este DNI ya tiene una cuenta. Ingresá con tu contraseña.');
  if (norm(d.apellido) !== norm(p.apellido) || str(d.nacimiento, 10) !== p.nacimiento) fail('permission-denied', 'Los datos no coinciden con el padrón. Revisalos con tu DNI en la mano.');
  const password = typeof d.password === 'string' ? d.password : '';
  if (password.length < 8 || password.length > 64) fail('invalid-argument', 'La contraseña tiene que tener al menos 8 caracteres.');

  let user;
  try { user = await getAuth().createUser({ email: driverEmail(dni), password, displayName: `${p.nombre} ${p.apellido}` }); }
  catch (e) { fail('already-exists', e.code === 'auth/email-already-exists' ? 'Este DNI ya tiene una cuenta. Ingresá con tu contraseña.' : 'No pudimos crear tu cuenta.'); }

  const claim = await pRef.child('uid').transaction(cur => cur ? undefined : user.uid);
  if (!claim.committed) { await getAuth().deleteUser(user.uid); fail('already-exists', 'Este DNI ya tiene una cuenta.'); }

  await db.ref(`drivers/${user.uid}`).set({
    dni, nombre: p.nombre, apellido: p.apellido,
    telefono: p.telefono || str(d.telefono, 20), vehiculo: p.vehiculo || '', patente: p.patente || '',
    licenciaVence: p.licenciaVence, status: 'docs_pendientes', createdAt: ServerValue.TIMESTAMP
  });
  return { email: driverEmail(dni) };
});

exports.driverSubmitDocs = onCall(async req => {
  const uid = needAuth(req);
  const ref = db.ref(`drivers/${uid}`), d = (await ref.get()).val();
  if (!d || !['docs_pendientes', 'rechazado'].includes(d.status)) fail('failed-precondition', 'Tu cuenta no está esperando documentos.');
  const bucket = getStorage().bucket();
  for (const f of DOCS) {
    const [ok] = await bucket.file(`driverDocs/${uid}/${f}.jpg`).exists();
    if (!ok) fail('failed-precondition', 'Faltan fotos por subir.');
  }
  await ref.update({ status: 'en_revision', submittedAt: ServerValue.TIMESTAMP, nota: null });
  return { ok: true };
});

exports.getDriverDocs = onCall(async req => {
  await needAdmin(req);
  const uid = key(req.data && req.data.uid), bucket = getStorage().bucket(), out = {};
  for (const f of DOCS) {
    const file = bucket.file(`driverDocs/${uid}/${f}.jpg`);
    const [ok] = await file.exists();
    out[f] = ok ? 'data:image/jpeg;base64,' + (await file.download())[0].toString('base64') : null;
  }
  return out;
});

exports.reviewDriver = onCall(async req => {
  const adminUid = await needAdmin(req);
  const uid = key(req.data && req.data.uid), action = req.data && req.data.action;
  const ref = db.ref(`drivers/${uid}`), d = (await ref.get()).val();
  if (!d) fail('not-found', 'Conductor no encontrado.');
  const next = { aprobar: 'aprobado', rechazar: 'rechazado', suspender: 'suspendido' }[action] || fail('invalid-argument', 'Acción inválida.');
  if (next === 'aprobado' && !(d.licenciaVence > Date.now())) fail('failed-precondition', 'La licencia de conducir está vencida en el padrón.');
  await ref.update({ status: next, nota: str(req.data.nota, 200) || null, reviewedAt: ServerValue.TIMESTAMP, reviewedBy: adminUid });
  if (next !== 'aprobado') await db.ref(`presence/${uid}`).remove();
  return { status: next };
});

/* ─────────── conductores: operativa ─────────── */
async function approvedDriver(uid) {
  const d = (await db.ref(`drivers/${uid}`).get()).val();
  if (!d || d.status !== 'aprobado') fail('permission-denied', 'Tu cuenta de conductor no está aprobada.');
  if (!(d.licenciaVence > Date.now())) fail('failed-precondition', 'Tu licencia está vencida. Actualizala con la administración.');
  return d;
}

exports.driverAccept = onCall(async req => {
  const uid = needAuth(req), d = await approvedDriver(uid);
  const id = key(req.data && req.data.orderId);
  const lock = await db.ref(`driverActive/${uid}`).transaction(cur => cur ? undefined : id);
  if (!lock.committed) fail('failed-precondition', 'Terminá tu pedido actual antes de tomar otro.');
  const res = await db.ref(`orders/${id}`).transaction(o => {
    if (!o) return o;
    if (o.status !== 'nuevo') return;
    const now = Date.now();
    o.status = 'aceptado'; o.t_aceptado = now; o.updatedAt = now;
    o.driver = { uid, name: `${d.nombre} ${d.apellido}`, phone: d.telefono || '', vehicle: [d.vehiculo, d.patente].filter(Boolean).join(' · ') };
    return o;
  });
  if (!res.committed || !res.snapshot.val() || res.snapshot.val().driver.uid !== uid) {
    await db.ref(`driverActive/${uid}`).remove();
    fail('failed-precondition', 'Otro conductor tomó este pedido.');
  }
  return { ok: true };
});

exports.driverAdvance = onCall(async req => {
  const uid = needAuth(req); await approvedDriver(uid);
  const id = key(req.data && req.data.orderId), to = req.data && req.data.to;
  const res = await db.ref(`orders/${id}`).transaction(o => {
    if (!o) return o;
    if (!o.driver || o.driver.uid !== uid || FLOW[o.status] !== to) return;
    const now = Date.now();
    o.status = to; o[`t_${to}`] = now; o.updatedAt = now;
    if (to === 'entregado' && o.payment.method === 'efectivo') o.payment.status = 'cobrado';
    return o;
  });
  if (!res.committed || !res.snapshot.val() || res.snapshot.val().status !== to) fail('failed-precondition', 'El pedido cambió. Actualizá la pantalla.');
  const o = res.snapshot.val();
  if (to === 'entregado') {
    const cash = o.payment.method === 'efectivo';
    await db.ref().update({
      [`driverActive/${uid}`]: null,
      [`settlements/${uid}/${id}`]: {
        at: o.t_entregado, business: o.business.name, method: o.payment.method,
        collected: cash ? o.totals.total : 0,             // lo que cobró en puerta
        toRestaurant: cash ? o.split.restaurant : 0,      // lo que le paga al local
        toPlatform: cash ? o.split.commission : 0,        // lo que rinde a Ringcon Go
        earning: o.driverPay                              // envío + propina
      }
    });
  }
  return { status: to };
});

exports.driverRelease = onCall(async req => {
  const uid = needAuth(req);
  const id = key(req.data && req.data.orderId);
  const res = await db.ref(`orders/${id}`).transaction(o => {
    if (!o) return o;
    if (!o.driver || o.driver.uid !== uid || !['aceptado', 'en_local'].includes(o.status)) return;
    o.status = 'nuevo'; o.driver = null; o.updatedAt = Date.now();
    return o;
  });
  if (!res.committed) fail('failed-precondition', 'Ya no podés liberar este pedido.');
  await db.ref(`driverActive/${uid}`).remove();
  return { ok: true };
});

/* ─────────── tablero público para conductores ─────────── */
// Solo los pedidos "nuevo" se publican, sin teléfono ni datos del cliente.
exports.syncOpenOrders = onValueWritten({ ref: '/orders/{id}', region: REGION }, async event => {
  const o = event.data.after.val(), ref = db.ref(`openOrders/${event.params.id}`);
  if (!o || o.status !== 'nuevo') { await ref.remove(); return; }
  await ref.set({
    id: o.id, createdAt: o.createdAt, business: o.business,
    address: { text: o.address.text, ...(o.address.lat ? { lat: o.address.lat, lon: o.address.lon } : {}) },
    items: Object.values(o.items || {}).reduce((s, i) => s + i.qty, 0),
    driverPay: o.driverPay, total: o.totals.total, method: o.payment.method
  });
});

exports.housekeeping = onSchedule({ schedule: 'every 10 minutes', secrets: [MP_TOKEN] }, async () => {
  const now = Date.now();
  const pend = (await db.ref('orders').orderByChild('status').equalTo('pago_pendiente').get()).val() || {};
  for (const o of Object.values(pend)) {
    if (now - (o.createdAt || 0) < PENDING_PAY_TTL) continue;
    await db.ref(`orders/${o.id}`).update({ status: 'cancelado', cancelledBy: 'sistema', t_cancelado: now, updatedAt: now });
  }
  const pres = (await db.ref('presence').get()).val() || {};
  const stale = {};
  for (const [uid, p] of Object.entries(pres)) if (now - (p.lastSeen || 0) > PRESENCE_TTL) stale[uid] = null;
  if (Object.keys(stale).length) await db.ref('presence').update(stale);
});
