/* Backend Ringcon Go · corre en funciones de Vercel (api/) con Firebase Admin.
   Todo lo que mueve plata o cambia el estado de un pedido pasa por acá:
   el navegador nunca decide precios, pagos ni quién es conductor.

   Variables de entorno (Vercel → Settings → Environment Variables):
     FIREBASE_SERVICE_ACCOUNT  JSON de la cuenta de servicio (Firebase → Configuración → Cuentas de servicio)
     FIREBASE_DATABASE_URL     https://ringcon-go-default-rtdb.firebaseio.com
     MP_ACCESS_TOKEN           Access Token de Mercado Pago
     MP_WEBHOOK_SECRET         Clave secreta de los webhooks de Mercado Pago
     MP_CLIENT_ID              (opcional) ID de la aplicación de Mercado Pago: activa el cobro dividido por local
     MP_CLIENT_SECRET          (opcional) Clave secreta de esa aplicación
     MP_SPLIT_PUBLIC_KEY       (opcional) "vendedor" si el formulario de tarjeta tiene que usar la Public Key del local
     PUBLIC_URL                https://ringcon-go.vercel.app (para el webhook y la vuelta de Mercado Pago)
     OPS_URL                   (opcional) dominio de la app de conductores y del panel del local, para los avisos push */
'use strict';

const crypto = require('crypto');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase, ServerValue } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging');

// Se inicializa en la primera llamada: si falta la clave, la API responde un error claro en vez de caerse.
let db;
function init() {
  if (db) return;
  let account;
  try { account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ''); } catch {}
  if (!account || !account.project_id || !process.env.FIREBASE_DATABASE_URL) fail('unavailable', 'El servidor todavía no está configurado. Probá más tarde.');
  if (!getApps().length) initializeApp({ credential: cert(account), databaseURL: process.env.FIREBASE_DATABASE_URL });
  db = getDatabase();
}

const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://ringcon-go.vercel.app').replace(/\/+$/, '');
const WEBHOOK_URL = `${PUBLIC_URL}/api/mp-webhook`;
const OPS_URL = (process.env.OPS_URL || 'https://ringcon-go-conductores.vercel.app').replace(/\/+$/, '');
const DRIVER_EMAIL_DOMAIN = 'conductores.ringcongo.app';
const TIPS = [0, 1000, 2000, 3000];
const SERVICE_RATE = 0.15;
const ACTIVE = ['pago_pendiente', 'nuevo', 'aceptado', 'en_local', 'recogido'];
const FLOW = { aceptado: 'en_local', en_local: 'recogido', recogido: 'entregado' };
// Cocina (solo locales con panel): pendiente → aceptado → preparando → listo. El local puede rechazar mientras está pendiente.
const KITCHEN_FLOW = { pendiente: ['aceptado', 'rechazado'], aceptado: ['preparando', 'listo'], preparando: ['listo'] };
const KITCHEN_OK = ['aceptado', 'preparando', 'listo'];
const KITCHEN_TTL = 10 * 60e3;          // si el local no responde en 10 minutos, el pedido se cancela y se devuelve el pago
const BIZ_ORDER_TTL = 36 * 3600e3;      // el panel del local conserva lo terminado un día y medio
const OAUTH_REDIRECT = `${PUBLIC_URL}/api/mp-oauth`;
const STATE_TTL = 7 * 86400e3;
const DOCS = ['dni_frente', 'dni_dorso', 'selfie'];
const MAX_DOC_CHARS = 900000;   // ~650 KB de JPEG en base64
const PENDING_PAY_TTL = 30 * 60e3;
const PRESENCE_TTL = 3 * 60e3;
const HOUSEKEEPING_EVERY = 10 * 60e3;

/* ─────────── utilidades ─────────── */
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const STATUS = { 'invalid-argument': 400, unauthenticated: 401, 'permission-denied': 403, 'not-found': 404, 'already-exists': 409, 'failed-precondition': 409, 'out-of-range': 400, 'resource-exhausted': 429, unavailable: 503 };
const fail = (code, msg) => { throw new ApiError(STATUS[code] || 400, msg); };
const isAdmin = async uid => (await db.ref(`admins/${uid}`).get()).val() === true;
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

// token: Access Token del local cuando el pago entra a su cuenta; si no, el de la plataforma.
async function mp(path, opts = {}) {
  const { token, ...rest } = opts;
  const r = await fetch('https://api.mercadopago.com' + path, {
    ...rest,
    headers: { Authorization: `Bearer ${token || process.env.MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json', ...(rest.headers || {}) }
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('Mercado Pago', path, r.status, body); const e = new Error(`MP ${r.status}`); e.status = r.status; throw e; }
  return body;
}

/* ─────────── Mercado Pago: cada local cobra en su cuenta (split 1:1) ─────────── */
// Con MP_CLIENT_ID y MP_CLIENT_SECRET, el pago con tarjeta entra a la cuenta de Mercado Pago del local y en ese
// mismo pago Mercado Pago le acredita a la plataforma su parte (application_fee = comisión + envío + propina).
// Mercado Pago solo divide un pago entre dos cuentas: la parte del conductor queda anotada en su saldo.
const splitOn = () => Boolean(process.env.MP_CLIENT_ID && process.env.MP_CLIENT_SECRET);
const seller = async bizId => { const s = (await db.ref(`mpSellers/${bizId}`).get()).val(); return s && s.accessToken && !s.error ? s : null; };
const sellerOf = async o => (o && o.payment && o.payment.collector === 'local' ? seller(o.business.id) : null);

async function mpToken(params) {
  const r = await fetch('https://api.mercadopago.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: process.env.MP_CLIENT_ID, client_secret: process.env.MP_CLIENT_SECRET, ...params })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) { console.error('Mercado Pago OAuth', r.status, body.error || body.message || ''); const e = new Error(`MP OAuth ${r.status}`); e.status = r.status; throw e; }
  return body;
}
// Las credenciales del local quedan en mpSellers/, que ninguna regla deja leer desde un navegador.
async function saveSeller(bizId, t) {
  const now = Date.now(), userId = String(t.user_id || '');
  await db.ref().update({
    [`mpSellers/${bizId}`]: { userId, accessToken: t.access_token, refreshToken: t.refresh_token || null, publicKey: t.public_key || null, expiresAt: now + (Number(t.expires_in) || 180 * 86400) * 1000, updatedAt: now },
    ...(/^\d{1,20}$/.test(userId) ? { [`mpUsers/${userId}`]: bizId } : {}),
    [`catalog/${bizId}/mp`]: true
  });
}
// Si Mercado Pago rechaza las credenciales del local, ese local deja de ofrecer tarjeta hasta reconectarse.
async function sellerBroken(bizId, why) {
  await db.ref().update({ [`mpSellers/${bizId}/error`]: { at: Date.now(), why: String(why) }, [`catalog/${bizId}/mp`]: false });
}

// Vuelta de Mercado Pago (GET /api/mp-oauth?code=…&state=…) cuando el dueño del local autoriza a la plataforma.
async function oauthCallback(query) {
  init();
  if (!splitOn()) fail('unavailable', 'El cobro por local todavía no está configurado.');
  const state = str(query.state, 80), code = str(query.code, 400);
  if (!/^[a-f0-9]{48}$/.test(state)) fail('invalid-argument', 'El enlace no es válido. Pedí uno nuevo.');
  const sRef = db.ref(`mpStates/${state}`), st = (await sRef.get()).val();
  if (!st || !(st.exp > Date.now())) fail('permission-denied', 'El enlace venció o ya se usó. Pedí uno nuevo.');
  if (!code) fail('invalid-argument', 'No se autorizó la conexión. Abrí el enlace de nuevo y tocá Autorizar.');
  const b = (await db.ref(`catalog/${st.bizId}`).get()).val();
  if (!b) fail('not-found', 'El local ya no existe.');
  let t;
  try { t = await mpToken({ grant_type: 'authorization_code', code, redirect_uri: OAUTH_REDIRECT }); }
  catch { fail('unavailable', 'Mercado Pago no confirmó la conexión. Abrí el enlace de nuevo.'); }
  await saveSeller(st.bizId, t);
  await sRef.remove();
  return { name: b.name };
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

/* ─────────── avisos push (Firebase Cloud Messaging) ─────────── */
// Cada dispositivo guarda su token al activar los avisos (pushTokens/, que ningún navegador puede leer).
// Un conductor lo guarda al ponerse en línea y lo borra al salir: así solo se avisa a quien está trabajando.
const money = n => '$' + String(Math.round(Number(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const tokenKey = t => crypto.createHash('sha256').update(t).digest('hex').slice(0, 32);
const staffOf = async bizId => Object.keys((await db.ref(`bizStaff/${bizId}`).get()).val() || {});
const driversOf = async townId => Object.entries((await db.ref('drivers').get()).val() || {}).filter(([, d]) => d.status === 'aprobado' && d.townId === townId).map(([uid]) => uid);

// Nunca frena un pedido: si un aviso falla, queda en el registro y nada más.
async function push(uids, { title, body, link, tag }) {
  try {
    const targets = [];
    for (const uid of new Set(uids.filter(Boolean)))
      for (const [k, v] of Object.entries((await db.ref(`pushTokens/${uid}`).get()).val() || {})) if (v && v.token) targets.push({ path: `pushTokens/${uid}/${k}`, token: v.token });
    if (!targets.length) return;
    const res = await getMessaging().sendEachForMulticast({
      tokens: targets.map(t => t.token),
      data: { title: String(title), body: String(body || ''), link: String(link), tag: String(tag) },
      webpush: { headers: { Urgency: 'high', TTL: '900' } }
    });
    // Tokens que ya no existen (app desinstalada o permiso quitado).
    const dead = {};
    res.responses.forEach((r, i) => { if (!r.success && /registration-token-not-registered|invalid-registration-token/.test((r.error && r.error.code) || '')) dead[targets[i].path] = null; });
    if (Object.keys(dead).length) await db.ref().update(dead);
  } catch (e) { console.error('push', e); }
}

// A quién se le avisa según lo que acaba de pasar con el pedido.
async function notify(o, ev) {
  const tag = `pedido-${o.id}`, n = '#' + String(o.id).slice(-5).toUpperCase();
  const customer = (title, body) => push([o.customerUid], { title, body, link: `${PUBLIC_URL}/`, tag });
  const drivers = async () => push(await driversOf(o.townId), { title: 'Nuevo pedido disponible', body: `${o.business.name} · ganás ${money(o.driverPay)}`, link: `${OPS_URL}/`, tag });
  const who = o.driver ? o.driver.name.split(' ')[0] : 'Tu conductor';
  switch (ev) {
    case 'visible': return o.kitchen === 'pendiente'
      ? push(await staffOf(o.business.id), { title: `Pedido nuevo ${n}`, body: 'Abrí el panel para aceptarlo.', link: `${OPS_URL}/local.html`, tag })
      : drivers();
    case 'aceptado': await customer('El local aceptó tu pedido', `${o.business.name} ya lo está preparando.`); return drivers();
    case 'rechazado': return customer('El local no pudo tomar tu pedido', o.cancelNote || 'Podés pedir en otro local.');
    case 'sin_respuesta': return customer('Cancelamos tu pedido', 'El local no confirmó a tiempo.');
    case 'listo': return o.driver ? push([o.driver.uid], { title: 'Pedido listo para retirar', body: `${o.business.name} ${n}`, link: `${OPS_URL}/`, tag }) : null;
    case 'conductor': return customer(`${who} va por tu pedido`, 'Podés seguirlo en la app.');
    case 'recogido': return customer('Tu pedido va en camino', `${who} ya lo retiró.`);
    case 'entregado': return customer('¡Entregado! Buen provecho', 'Gracias por pedir con Ringcon Go.');
    case 'liberado': return drivers();
    case 'cancelado': return customer('Cancelamos tu pedido', 'Escribinos si necesitás ayuda.');
    default: return null;
  }
}

/* ─────────── tablero público para conductores y panel del local ─────────── */
// Lo que ve el local de un pedido suyo: sin teléfono ni dirección del cliente.
const bizView = o => ({
  id: o.id, createdAt: o.createdAt, at: o.t_nuevo || o.createdAt, updatedAt: o.updatedAt || o.createdAt,
  status: o.status, kitchen: o.kitchen, method: o.payment.method, collector: o.payment.collector || 'plataforma',
  customer: String(o.customer.name || '').split(' ')[0], notes: o.notes || '',
  items: Object.values(o.items || {}).map(i => ({ name: i.name, qty: i.qty, price: i.price })), subtotal: o.totals.subtotal,
  ...(o.driver ? { driver: { name: o.driver.name, vehicle: o.driver.vehicle || '' } } : {}),
  ...(o.cancelledBy ? { cancelledBy: o.cancelledBy } : {}),
  ...(o.kitchen === 'pendiente' ? { deadline: (o.t_nuevo || o.createdAt) + KITCHEN_TTL } : {})   // hasta cuándo puede aceptarlo
});
// Se llama después de cada cambio de un pedido. A los conductores solo les llegan los pedidos "nuevo" (sin teléfono
// ni datos del cliente) y, si el local usa el panel, recién cuando el local lo aceptó.
async function syncOpen(id) {
  const o = (await db.ref(`orders/${id}`).get()).val(), ref = db.ref(`openOrders/${id}`);
  if (!o) { await ref.remove(); return; }
  if (o.status === 'nuevo' && (!o.kitchen || KITCHEN_OK.includes(o.kitchen))) await ref.set({
    id: o.id, createdAt: o.createdAt, business: o.business, townId: o.townId,
    address: { text: o.address.text, ...(o.address.lat ? { lat: o.address.lat, lon: o.address.lon } : {}) },
    items: Object.values(o.items || {}).reduce((s, i) => s + i.qty, 0),
    driverPay: o.driverPay, total: o.totals.total, method: o.payment.method, ...(o.kitchen ? { kitchen: o.kitchen } : {})
  });
  else await ref.remove();
  // El local ve el pedido recién cuando está confirmado (efectivo) o pagado (tarjeta).
  if (o.kitchen && o.t_nuevo) await db.ref(`bizOrders/${o.business.id}/${id}`).set(bizView(o));
}

/* ─────────── pagos ─────────── */
// Aplica el estado real de un pago de Mercado Pago a su pedido (lo usan payOrder y el webhook).
async function applyPayment(orderId, p) {
  if (!/^[\w-]{1,40}$/.test(orderId) || String(p.external_reference) !== orderId) return;
  let refundNeeded = false, paid = false;
  const sel = await sellerOf((await db.ref(`orders/${orderId}`).get()).val());
  const res = await db.ref(`orders/${orderId}`).transaction(o => {
    if (!o) return o;
    if (Math.round(Number(p.transaction_amount)) !== Math.round(o.totals.total)) { o.payment.flag = 'monto_distinto'; return o; }
    // Pago dividido: tiene que haber entrado a la cuenta del local de este pedido.
    if (sel && p.collector_id != null && String(p.collector_id) !== sel.userId) { o.payment.flag = 'cobrador_distinto'; return o; }
    const now = Date.now();
    o.payment = { ...o.payment, mpId: String(p.id), status: p.status, detail: p.status_detail || '', updatedAt: now };
    paid = p.status === 'approved' && o.status === 'pago_pendiente';
    if (paid) { o.status = 'nuevo'; o.t_nuevo = now; o.updatedAt = now; }
    refundNeeded = p.status === 'approved' && o.status === 'cancelado';
    return o;
  });
  if (refundNeeded && res.committed) await refund(res.snapshot.val());
  await syncOpen(orderId);
  if (paid && res.committed) await notify(res.snapshot.val(), 'visible');
}

// En un pago dividido lo pide el local (su token) y Mercado Pago descuenta de cada cuenta su parte.
async function refund(o) {
  try {
    const sel = await sellerOf(o);
    if (o.payment.collector === 'local' && !sel) throw new Error('el local ya no está conectado a Mercado Pago');
    await mp(`/v1/payments/${o.payment.mpId}/refunds`, { method: 'POST', token: sel && sel.accessToken, headers: { 'X-Idempotency-Key': `refund-${o.id}` }, body: '{}' });
    await db.ref(`orders/${o.id}/payment`).update({ status: 'refunded', updatedAt: Date.now() });
  } catch (e) {
    console.error('Reembolso fallido', o.id, e);
    await db.ref(`orders/${o.id}/payment/flag`).set('reembolso_fallido');
  }
}

function validSignature(headers, dataId, secret) {
  const sig = String(headers['x-signature'] || ''), rid = String(headers['x-request-id'] || '');
  const parts = Object.fromEntries(sig.split(',').map(s => s.trim().split('=')));
  if (!secret || !parts.ts || !parts.v1) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${rid};ts:${parts.ts};`;
  const want = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return want.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(parts.v1));
}

async function webhook(query, body, headers) {
  init();
  const type = query.type || query.topic || (body && body.type);
  const id = String(query['data.id'] || (body && body.data && body.data.id) || '');
  if (type !== 'payment' || !/^\d{1,20}$/.test(id)) return 'ignorado';
  if (!validSignature(headers, id, process.env.MP_WEBHOOK_SECRET)) fail('unauthenticated', 'firma inválida');
  // Nunca confiamos en el cuerpo del aviso: consultamos el pago a Mercado Pago, con la cuenta que lo cobró.
  const orderId = /^[\w-]{1,40}$/.test(String(query.order || '')) ? String(query.order) : null;
  let sel = orderId ? await sellerOf((await db.ref(`orders/${orderId}`).get()).val()) : null;
  if (!sel && body && /^\d{1,20}$/.test(String(body.user_id || ''))) {
    const bizId = (await db.ref(`mpUsers/${body.user_id}`).get()).val();
    if (bizId) sel = await seller(bizId);
  }
  const p = await mp(`/v1/payments/${id}`, { token: sel && sel.accessToken });
  if (p.external_reference) await applyPayment(String(p.external_reference), p);
  return 'ok';
}

/* ─────────── mantenimiento ─────────── */
// Sin tareas programadas en el plan gratuito: se ejecuta como mucho cada 10 minutos, al usar la API.
async function housekeeping() {
  const now = Date.now();
  const tick = await db.ref('meta/housekeepingAt').transaction(t => (t && now - t < HOUSEKEEPING_EVERY) ? undefined : now);
  if (!tick.committed) return;
  const pend = (await db.ref('orders').orderByChild('status').equalTo('pago_pendiente').get()).val() || {};
  for (const o of Object.values(pend)) {
    if (now - (o.createdAt || 0) < PENDING_PAY_TTL) continue;
    await db.ref(`orders/${o.id}`).update({ status: 'cancelado', cancelledBy: 'sistema', t_cancelado: now, updatedAt: now });
  }
  const pres = (await db.ref('presence').get()).val() || {};
  const stale = {};
  for (const [uid, p] of Object.entries(pres)) if (now - (p.lastSeen || 0) > PRESENCE_TTL) stale[uid] = null;
  if (Object.keys(stale).length) await db.ref('presence').update(stale);
  // Locales que no respondieron a tiempo.
  const fresh = (await db.ref('orders').orderByChild('status').equalTo('nuevo').get()).val() || {};
  for (const o of Object.values(fresh)) if (o.kitchen === 'pendiente') await expireKitchen(o.id).catch(e => console.error('cocina', o.id, e));
  // Panel del local: fuera lo terminado hace más de un día y medio.
  const old = {};
  for (const [b, list] of Object.entries((await db.ref('bizOrders').get()).val() || {}))
    for (const [id, v] of Object.entries(list || {}))
      if (['entregado', 'cancelado'].includes(v.status) && now - (v.updatedAt || v.createdAt || 0) > BIZ_ORDER_TTL) old[`${b}/${id}`] = null;
  if (Object.keys(old).length) await db.ref('bizOrders').update(old);
  // Las credenciales de Mercado Pago de cada local duran 180 días: se renuevan solas un mes antes.
  if (splitOn()) for (const [b, sel] of Object.entries((await db.ref('mpSellers').get()).val() || {})) {
    if (sel.error || !sel.refreshToken || sel.expiresAt - now > 30 * 86400e3) continue;
    try { await saveSeller(b, await mpToken({ grant_type: 'refresh_token', refresh_token: sel.refreshToken })); }
    catch (e) { console.error('renovación Mercado Pago', b, e.status); if (sel.expiresAt < now) await sellerBroken(b, 'vencido'); }
  }
}

// El local tiene 10 minutos para aceptar. Pasado ese tiempo el pedido se cancela solo y, si se pagó, se devuelve.
async function expireKitchen(id) {
  const now = Date.now();
  const res = await db.ref(`orders/${id}`).transaction(o => {
    if (!o) return o;
    if (o.status !== 'nuevo' || o.kitchen !== 'pendiente' || now - (o.t_nuevo || o.createdAt || now) < KITCHEN_TTL) return;
    o.status = 'cancelado'; o.cancelledBy = 'sistema'; o.kitchen = 'sin_respuesta'; o.t_cancelado = now; o.updatedAt = now;
    return o;
  });
  const o = res.snapshot.val();
  if (!res.committed || !o || o.kitchen !== 'sin_respuesta') return false;
  if (o.payment.method === 'tarjeta' && o.payment.status === 'approved') await refund(o);
  await syncOpen(id);
  await notify(o, 'sin_respuesta');
  return true;
}

/* ─────────── operaciones (las llama el navegador por /api/call) ─────────── */
const H = {};

// card: hay pago con tarjeta. split: cada local cobra en su cuenta, así que solo ofrecen tarjeta los locales conectados.
H.getConfig = async () => ({ card: splitOn() || Boolean(process.env.MP_ACCESS_TOKEN), split: splitOn() });

H.createOrder = async ({ uid, data: d }) => {
  await rateLimit(`${uid}/order`, 12, 3600e3);
  const profile = (await db.ref(`customers/${uid}`).get()).val();
  if (!profile || !profile.name) fail('failed-precondition', 'Completá tu nombre antes de pedir.');

  const mineSnap = await db.ref(`userOrders/${uid}`).limitToLast(10).get();
  const recent = await Promise.all(Object.keys(mineSnap.val() || {}).map(id => db.ref(`orders/${id}/status`).get()));
  if (recent.filter(s => ACTIVE.includes(s.val())).length >= 2) fail('failed-precondition', 'Ya tenés pedidos en curso. Esperá a que lleguen.');

  const bizId = key(d.bizId);
  const b = (await db.ref(`catalog/${bizId}`).get()).val();
  if (!b || b.open === false) fail('not-found', 'El local no está disponible ahora.');
  // El pueblo lo define el local, no el navegador: su zona de entrega es la del pueblo.
  const townId = /^[\w-]{1,40}$/.test(b.townId || '') ? b.townId : null;
  const town = townId ? (await db.ref(`towns/${townId}`).get()).val() : null;
  if (!town) fail('unavailable', 'Este local todavía no tiene zona de entrega. Probá más tarde.');

  const items = [];
  for (const [id, q] of Object.entries(d.items || {})) {
    const m = b.menu && b.menu[id], qty = Math.floor(Number(q));
    if (!m || m.available === false || !(qty >= 1 && qty <= 20)) fail('invalid-argument', 'Algún producto ya no está disponible. Revisá el carrito.');
    items.push({ id, name: m.name, qty, price: Number(m.price) });
  }
  if (!items.length || items.length > 30) fail('invalid-argument', 'El carrito está vacío.');

  const method = d.method === 'tarjeta' || d.method === 'efectivo' ? d.method : fail('invalid-argument', 'Elegí cómo pagar.');
  const sel = method === 'tarjeta' && splitOn() ? await seller(bizId) : null;
  if (method === 'tarjeta' && splitOn() && !sel) fail('failed-precondition', 'Este local todavía no cobra con tarjeta. Elegí efectivo.');
  if (method === 'tarjeta' && !splitOn() && !process.env.MP_ACCESS_TOKEN) fail('failed-precondition', 'El pago con tarjeta todavía no está disponible. Elegí efectivo.');
  const tip = TIPS.includes(Number(d.tip)) ? Number(d.tip) : 0;

  const a = d.address || {}, text = str(a.text, 120);
  if (text.length < 5) fail('invalid-argument', 'Escribí tu dirección completa.');
  const address = { text, ref: str(a.ref, 80) };
  if (Number.isFinite(a.lat) && Number.isFinite(a.lon)) {
    if (distKm(town, { lat: a.lat, lon: a.lon }) > town.km) fail('out-of-range', `Por ahora no llegamos a esa dirección desde ${town.name}.`);
    address.lat = a.lat; address.lon = a.lon;
  }

  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const fee = Number(b.fee) || 0, service = Math.round(subtotal * SERVICE_RATE);
  const totals = { subtotal, fee, service, tip, total: subtotal + fee + service + tip };

  const payment = { method, status: method === 'tarjeta' ? 'pendiente' : 'a_cobrar' };
  if (sel) {
    payment.collector = 'local';   // la tarjeta entra a la cuenta de Mercado Pago del local
    if (process.env.MP_SPLIT_PUBLIC_KEY === 'vendedor' && sel.publicKey) payment.pk = sel.publicKey;
  }
  if (method === 'efectivo' && d.cashWith) {
    const cash = Math.floor(Number(d.cashWith));
    if (!(cash >= totals.total && cash <= totals.total + 100000)) fail('invalid-argument', `El monto en efectivo tiene que cubrir ${totals.total}.`);
    payment.cashWith = cash;
  }

  const ref = db.ref('orders').push(), id = ref.key;
  const status = method === 'tarjeta' ? 'pago_pendiente' : 'nuevo';
  const order = {
    id, status, customerUid: uid, townId,
    createdAt: ServerValue.TIMESTAMP, updatedAt: ServerValue.TIMESTAMP, [`t_${status}`]: ServerValue.TIMESTAMP,
    customer: { name: profile.name, phone: profile.phone || '' },
    business: { id: bizId, name: b.name },
    items, address, notes: str(d.notes, 140), totals,
    driverPay: fee + tip,
    split: { restaurant: subtotal, driver: fee + tip, commission: service },
    payment,
    ...(b.panel === true ? { kitchen: 'pendiente' } : {})   // el local lo tiene que aceptar en su panel
  };
  await db.ref().update({ [`orders/${id}`]: order, [`userOrders/${uid}/${id}`]: true });
  await syncOpen(id);
  if (status === 'nuevo') await notify(order, 'visible');
  return { orderId: id, status, total: totals.total, ...(payment.pk ? { mpKey: payment.pk } : {}) };
};

H.payOrder = async ({ uid, data }) => {
  await rateLimit(`${uid}/pay`, 10, 3600e3);
  const { orderId, form } = data;
  const ref = db.ref(`orders/${key(orderId)}`);
  const o = (await ref.get()).val();
  if (!o || o.customerUid !== uid) fail('not-found', 'Pedido no encontrado.');
  if (o.payment.method !== 'tarjeta' || o.status !== 'pago_pendiente') fail('failed-precondition', 'Este pedido ya no espera un pago.');
  if (!form || !str(form.token, 200) || !str(form.payment_method_id, 40)) fail('invalid-argument', 'Faltan datos de la tarjeta.');
  const split = o.payment.collector === 'local', sel = split ? await seller(o.business.id) : null;
  if (split && !sel) fail('failed-precondition', 'Este local dejó de cobrar con tarjeta. Cancelá el pedido y hacelo de nuevo en efectivo.');
  const platformPart = o.split.commission + o.split.driver;   // comisión + envío + propina

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
    notification_url: `${WEBHOOK_URL}?order=${o.id}`,
    // Pago dividido: el cobro entra a la cuenta del local y Mercado Pago le pasa esta parte a la plataforma.
    ...(split && platformPart > 0 ? { application_fee: platformPart } : {}),
    payer: {
      email: str(form.payer && form.payer.email, 120),
      ...(ident ? { identification: { type: str(ident.type, 10), number: str(ident.number, 20) } } : {})
    }
  };
  let p;
  try { p = await mp('/v1/payments', { method: 'POST', token: sel && sel.accessToken, headers: { 'X-Idempotency-Key': `${o.id}-${attempt}` }, body: JSON.stringify(body) }); }
  catch (e) {
    // Mercado Pago no reconoce las credenciales del local: ese local deja de ofrecer tarjeta hasta reconectarse.
    if (split && (e.status === 401 || e.status === 403)) await sellerBroken(o.business.id, e.status);
    fail('unavailable', 'No pudimos procesar el pago. Revisá los datos o probá otra tarjeta.');
  }

  await applyPayment(o.id, p);
  return { status: p.status, message: p.status === 'rejected' ? (REJECT[p.status_detail] || 'El pago fue rechazado. Probá con otra tarjeta.') : '' };
};

H.cancelOrder = async ({ uid, data }) => {
  const admin = await isAdmin(uid);
  const id = key(data.orderId);
  const res = await db.ref(`orders/${id}`).transaction(o => {
    if (!o) return o;
    if (!admin && (o.customerUid !== uid || !['pago_pendiente', 'nuevo'].includes(o.status))) return;
    if (!admin && o.kitchen && o.kitchen !== 'pendiente') return;   // el local ya lo está preparando
    if (['entregado', 'cancelado'].includes(o.status)) return;
    const now = Date.now();
    o.status = 'cancelado'; o.cancelledBy = admin ? 'admin' : 'cliente'; o.updatedAt = now; o.t_cancelado = now;
    return o;
  });
  const o = res.snapshot.val();
  if (!res.committed || !o || o.status !== 'cancelado') fail('failed-precondition', 'Ya no se puede cancelar: el pedido ya está en marcha.');
  if (o.driver) await db.ref(`driverActive/${o.driver.uid}`).remove();
  if (o.payment.method === 'tarjeta' && o.payment.status === 'approved') await refund(o);
  await syncOpen(id);
  if (admin && o.customerUid !== uid) await notify(o, 'cancelado');
  return { ok: true };
};

// Avisos push de este dispositivo. Se guardan como mucho 5 por usuario.
H.savePushToken = async ({ uid, data }) => {
  await rateLimit(`${uid}/push`, 30, 3600e3);
  const token = str(data.token, 500);
  if (token.length < 20) fail('invalid-argument', 'Token inválido.');
  const ref = db.ref(`pushTokens/${uid}`);
  await ref.child(tokenKey(token)).set({ token, at: Date.now() });
  const all = Object.entries((await ref.get()).val() || {}).sort((a, b) => b[1].at - a[1].at);
  if (all.length > 5) await ref.update(Object.fromEntries(all.slice(5).map(([k]) => [k, null])));
  return { ok: true };
};
H.removePushToken = async ({ uid, data }) => {
  const token = str(data.token, 500);
  if (token) await db.ref(`pushTokens/${uid}/${tokenKey(token)}`).remove();
  return { ok: true };
};

// La pide la app del cliente mientras espera: si el local no respondió a tiempo, cancela y devuelve el pago.
H.checkOrder = async ({ uid, data }) => {
  const id = key(data.orderId), o = (await db.ref(`orders/${id}`).get()).val();
  if (!o || o.customerUid !== uid) fail('not-found', 'Pedido no encontrado.');
  return { expired: await expireKitchen(id) };
};

/* locales: panel de pedidos */
async function staffBiz(uid) {
  const bizId = (await db.ref(`bizUsers/${uid}`).get()).val();
  if (!bizId) fail('permission-denied', 'Esta cuenta no es de un local.');
  return bizId;
}

// Aceptar → En preparación → Listo para despachar (o rechazar mientras está pendiente).
H.bizAdvance = async ({ uid, data }) => {
  const bizId = await staffBiz(uid), id = key(data.orderId), to = data.to;
  const res = await db.ref(`orders/${id}`).transaction(o => {
    if (!o) return o;
    if (o.business.id !== bizId || !(KITCHEN_FLOW[o.kitchen] || []).includes(to)) return;
    if (['pago_pendiente', 'entregado', 'cancelado'].includes(o.status)) return;
    const now = Date.now();
    o.kitchen = to; o[`k_${to}`] = now; o.updatedAt = now;
    if (to === 'rechazado') { o.status = 'cancelado'; o.cancelledBy = 'local'; o.t_cancelado = now; o.cancelNote = str(data.nota, 140) || null; }
    return o;
  });
  const o = res.snapshot.val();
  if (!res.committed || !o || o.kitchen !== to) fail('failed-precondition', 'El pedido cambió. Actualizá la pantalla.');
  if (to === 'rechazado' && o.payment.method === 'tarjeta' && o.payment.status === 'approved') await refund(o);
  await syncOpen(id);
  await notify(o, to);
  return { kitchen: to };
};

// El local se abre o se cierra solo desde su panel.
H.bizSetOpen = async ({ uid, data }) => {
  const bizId = await staffBiz(uid), open = data.open === true;
  await db.ref(`catalog/${bizId}/open`).set(open);
  return { open };
};

/* administración: accesos de locales y Mercado Pago */
H.bizCreateUser = async ({ uid, data }) => {
  if (!(await isAdmin(uid))) fail('permission-denied', 'Solo administradores.');
  const bizId = key(data.bizId), b = (await db.ref(`catalog/${bizId}`).get()).val();
  if (!b) fail('not-found', 'Local no encontrado.');
  const email = str(data.email, 120).toLowerCase(), password = typeof data.password === 'string' ? data.password : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.endsWith('@' + DRIVER_EMAIL_DOMAIN)) fail('invalid-argument', 'Escribí un email válido.');
  if (password.length < 8 || password.length > 64) fail('invalid-argument', 'La contraseña tiene que tener al menos 8 caracteres.');
  let user;
  try { user = await getAuth().createUser({ email, password, displayName: b.name }); }
  catch (e) { fail('already-exists', e.code === 'auth/email-already-exists' ? 'Ese email ya tiene una cuenta. Usá otro.' : 'No pudimos crear la cuenta.'); }
  // Desde ahora los pedidos de este local esperan su confirmación en el panel.
  await db.ref().update({ [`bizUsers/${user.uid}`]: bizId, [`bizStaff/${bizId}/${user.uid}`]: email, [`catalog/${bizId}/panel`]: true });
  return { uid: user.uid };
};

H.bizRemoveUser = async ({ uid, data }) => {
  if (!(await isAdmin(uid))) fail('permission-denied', 'Solo administradores.');
  const bizId = key(data.bizId), staffUid = key(data.uid);
  if ((await db.ref(`bizUsers/${staffUid}`).get()).val() !== bizId) fail('not-found', 'Esa cuenta no es de este local.');
  await getAuth().deleteUser(staffUid).catch(() => {});
  await db.ref().update({ [`bizUsers/${staffUid}`]: null, [`bizStaff/${bizId}/${staffUid}`]: null });
  // Sin nadie que atienda el panel, los pedidos vuelven a ir directo a los conductores.
  const left = (await db.ref(`bizStaff/${bizId}`).get()).val();
  if (!left) await db.ref(`catalog/${bizId}/panel`).remove();
  return { panel: !!left };
};

// Enlace para que el dueño del local autorice a la plataforma en su Mercado Pago. Sirve una semana y una sola vez.
H.mpConnectLink = async ({ uid, data }) => {
  if (!(await isAdmin(uid))) fail('permission-denied', 'Solo administradores.');
  if (!splitOn()) fail('failed-precondition', 'Falta configurar MP_CLIENT_ID y MP_CLIENT_SECRET en Vercel.');
  const bizId = key(data.bizId);
  if (!(await db.ref(`catalog/${bizId}`).get()).val()) fail('not-found', 'Local no encontrado.');
  const state = crypto.randomBytes(24).toString('hex');
  await db.ref(`mpStates/${state}`).set({ bizId, exp: Date.now() + STATE_TTL });
  return { url: `https://auth.mercadopago.com/authorization?client_id=${encodeURIComponent(process.env.MP_CLIENT_ID)}&response_type=code&platform_id=mp&state=${state}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}` };
};

H.mpDisconnect = async ({ uid, data }) => {
  if (!(await isAdmin(uid))) fail('permission-denied', 'Solo administradores.');
  const bizId = key(data.bizId);
  await db.ref().update({ [`mpSellers/${bizId}`]: null, [`catalog/${bizId}/mp`]: null });
  return { ok: true };
};

// Saldo de un conductor: lo que la plataforma le debe (envío y propina de pedidos con tarjeta) menos lo que él
// tiene que rendir (comisión de pedidos en efectivo). Se usa después de hacer la transferencia.
const owedToDriver = st => st.fromPlatform ?? (st.method === 'tarjeta' ? st.earning || 0 : 0);
H.settleDriver = async ({ uid, data }) => {
  if (!(await isAdmin(uid))) fail('permission-denied', 'Solo administradores.');
  const drv = key(data.uid);
  const open = Object.entries((await db.ref(`settlements/${drv}`).get()).val() || {}).filter(([, st]) => !st.paidAt);
  if (!open.length) fail('failed-precondition', 'Este conductor no tiene nada para liquidar.');
  const now = Date.now(), net = open.reduce((sum, [, st]) => sum + owedToDriver(st) - (st.toPlatform || 0), 0);
  const upd = { [`payouts/${drv}/${db.ref(`payouts/${drv}`).push().key}`]: { at: now, net, count: open.length, by: uid } };
  for (const [id] of open) upd[`settlements/${drv}/${id}/paidAt`] = now;
  await db.ref().update(upd);
  return { net, count: open.length };
};

/* conductores: identidad */
H.driverLookup = async ({ uid, data }) => {
  await rateLimit(`${uid}/lookup`, 20, 3600e3);
  const dni = cleanDni(data.dni);
  if (!dni) fail('invalid-argument', 'El DNI tiene que tener 7 u 8 números.');
  const p = (await db.ref(`padron/${dni}`).get()).val();
  if (!p) return { found: false };
  // Devolvemos el nombre enmascarado: confirma el registro sin exponer datos a terceros.
  return { found: true, active: p.activo !== false, claimed: !!p.uid, name: mask(`${p.nombre} ${p.apellido}`) };
};

H.driverRegister = async ({ uid, data: d }) => {
  const dni = cleanDni(d.dni);
  if (!dni) fail('invalid-argument', 'DNI inválido.');
  await rateLimit(`${uid}/register`, 6, 3600e3);
  await rateLimit(`dni_${dni}`, 5, 24 * 3600e3);   // por DNI: aunque cambien de cuenta, no pueden adivinar la fecha

  const pRef = db.ref(`padron/${dni}`), p = (await pRef.get()).val();
  if (!p || p.activo === false) fail('not-found', 'Tu DNI no está habilitado en el padrón de conductores.');
  if (!p.townId) fail('failed-precondition', 'Tu DNI no tiene pueblo asignado. Contactá a la administración.');
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
    licenciaVence: p.licenciaVence, townId: p.townId, status: 'docs_pendientes', createdAt: ServerValue.TIMESTAMP
  });
  return { email: driverEmail(dni) };
};

// Las fotos se guardan comprimidas en la base (Storage requiere el plan pago de Firebase).
H.driverUploadDoc = async ({ uid, data }) => {
  await rateLimit(`${uid}/upload`, 30, 3600e3);
  const d = (await db.ref(`drivers/${uid}/status`).get()).val();
  if (!['docs_pendientes', 'rechazado'].includes(d)) fail('failed-precondition', 'Tu cuenta no está esperando documentos.');
  const doc = DOCS.includes(data.doc) ? data.doc : fail('invalid-argument', 'Documento inválido.');
  const img = typeof data.image === 'string' ? data.image : '';
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > MAX_DOC_CHARS) fail('invalid-argument', 'La foto no es válida o es muy pesada.');
  await db.ref(`driverDocs/${uid}/${doc}`).set(img);
  return { ok: true };
};

H.driverSubmitDocs = async ({ uid }) => {
  const ref = db.ref(`drivers/${uid}`), d = (await ref.get()).val();
  if (!d || !['docs_pendientes', 'rechazado'].includes(d.status)) fail('failed-precondition', 'Tu cuenta no está esperando documentos.');
  const docs = (await db.ref(`driverDocs/${uid}`).get()).val() || {};
  if (!DOCS.every(f => docs[f])) fail('failed-precondition', 'Faltan fotos por subir.');
  await ref.update({ status: 'en_revision', submittedAt: ServerValue.TIMESTAMP, nota: null });
  return { ok: true };
};

H.getDriverDocs = async ({ uid, data }) => {
  if (!(await isAdmin(uid))) fail('permission-denied', 'Solo administradores.');
  const docs = (await db.ref(`driverDocs/${key(data.uid)}`).get()).val() || {};
  return Object.fromEntries(DOCS.map(f => [f, docs[f] || null]));
};

H.reviewDriver = async ({ uid: adminUid, data }) => {
  if (!(await isAdmin(adminUid))) fail('permission-denied', 'Solo administradores.');
  const uid = key(data.uid), action = data.action;
  const ref = db.ref(`drivers/${uid}`), d = (await ref.get()).val();
  if (!d) fail('not-found', 'Conductor no encontrado.');
  const next = { aprobar: 'aprobado', rechazar: 'rechazado', suspender: 'suspendido' }[action] || fail('invalid-argument', 'Acción inválida.');
  if (next === 'aprobado' && !(d.licenciaVence > Date.now())) fail('failed-precondition', 'La licencia de conducir está vencida en el padrón.');
  // Si el admin cambió el pueblo en el padrón, el conductor lo toma al revisar su cuenta.
  const pad = (await db.ref(`padron/${d.dni}`).get()).val();
  await ref.update({ status: next, nota: str(data.nota, 200) || null, reviewedAt: ServerValue.TIMESTAMP, reviewedBy: adminUid, ...(pad && pad.townId ? { townId: pad.townId } : {}) });
  if (next !== 'aprobado') await db.ref(`presence/${uid}`).remove();
  return { status: next };
};

// El padrón manda: al guardarlo en el panel, el pueblo y la licencia pasan a la cuenta del conductor (si ya tiene una).
H.syncDriver = async ({ uid, data }) => {
  if (!(await isAdmin(uid))) fail('permission-denied', 'Solo administradores.');
  const dni = cleanDni(data.dni);
  if (!dni) fail('invalid-argument', 'DNI inválido.');
  const p = (await db.ref(`padron/${dni}`).get()).val();
  if (!p || !p.uid) return { synced: false };
  const ref = db.ref(`drivers/${p.uid}`);
  if (!(await ref.get()).val()) return { synced: false };
  await ref.update({ licenciaVence: p.licenciaVence, ...(p.townId ? { townId: p.townId } : {}) });
  if (!(p.licenciaVence > Date.now())) await db.ref(`presence/${p.uid}`).remove();
  return { synced: true };
};

/* conductores: operativa */
async function approvedDriver(uid) {
  const d = (await db.ref(`drivers/${uid}`).get()).val();
  if (!d || d.status !== 'aprobado') fail('permission-denied', 'Tu cuenta de conductor no está aprobada.');
  if (!(d.licenciaVence > Date.now())) fail('failed-precondition', 'Tu licencia está vencida. Actualizala con la administración.');
  return d;
}

H.driverAccept = async ({ uid, data }) => {
  const d = await approvedDriver(uid);
  if (!d.townId) fail('failed-precondition', 'Tu cuenta no tiene pueblo asignado. Contactá a la administración.');
  const id = key(data.orderId);
  const peek = (await db.ref(`orders/${id}`).get()).val();
  if (peek && peek.townId !== d.townId) fail('permission-denied', 'Ese pedido es de otro pueblo.');
  const lock = await db.ref(`driverActive/${uid}`).transaction(cur => cur ? undefined : id);
  if (!lock.committed) fail('failed-precondition', 'Terminá tu pedido actual antes de tomar otro.');
  const res = await db.ref(`orders/${id}`).transaction(o => {
    if (!o) return o;
    if (o.status !== 'nuevo' || (o.kitchen && !KITCHEN_OK.includes(o.kitchen))) return;
    const now = Date.now();
    o.status = 'aceptado'; o.t_aceptado = now; o.updatedAt = now;
    o.driver = { uid, name: `${d.nombre} ${d.apellido}`, phone: d.telefono || '', vehicle: [d.vehiculo, d.patente].filter(Boolean).join(' · ') };
    return o;
  });
  if (!res.committed || !res.snapshot.val() || res.snapshot.val().driver.uid !== uid) {
    await db.ref(`driverActive/${uid}`).remove();
    fail('failed-precondition', 'Otro conductor tomó este pedido.');
  }
  await syncOpen(id);
  await notify(res.snapshot.val(), 'conductor');
  return { ok: true };
};

H.driverAdvance = async ({ uid, data }) => {
  await approvedDriver(uid);
  const id = key(data.orderId), to = data.to;
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
        fromPlatform: cash ? 0 : o.driverPay,             // lo que Ringcon Go le debe: con tarjeta, su parte la cobró la plataforma
        earning: o.driverPay                              // envío + propina
      }
    });
  }
  await syncOpen(id);
  await notify(o, to);
  return { status: to };
};

H.driverRelease = async ({ uid, data }) => {
  const id = key(data.orderId);
  const res = await db.ref(`orders/${id}`).transaction(o => {
    if (!o) return o;
    if (!o.driver || o.driver.uid !== uid || !['aceptado', 'en_local'].includes(o.status)) return;
    o.status = 'nuevo'; o.driver = null; o.updatedAt = Date.now();
    return o;
  });
  if (!res.committed) fail('failed-precondition', 'Ya no podés liberar este pedido.');
  await db.ref(`driverActive/${uid}`).remove();
  await syncOpen(id);
  await notify(res.snapshot.val(), 'liberado');
  return { ok: true };
};

/* ─────────── entrada HTTP ─────────── */
async function call(fn, data, idToken) {
  init();
  if (!Object.prototype.hasOwnProperty.call(H, fn)) fail('not-found', 'Operación desconocida.');
  if (!idToken) fail('unauthenticated', 'Iniciá sesión para continuar.');
  let uid;
  try { uid = (await getAuth().verifyIdToken(idToken)).uid; }
  catch { fail('unauthenticated', 'Tu sesión venció. Volvé a entrar.'); }
  // Se espera: Vercel congela la función apenas responde.
  await housekeeping().catch(e => console.error('housekeeping', e));
  return H[fn]({ uid, data: data && typeof data === 'object' ? data : {} });
}

module.exports = { call, webhook, oauthCallback, ApiError };
