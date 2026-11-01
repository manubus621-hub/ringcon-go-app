/* App de clientes Ringcon Go */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, onValue, set } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { FIREBASE, API_URL, MP_PUBLIC_KEY } from './config.js';

const CURRENCY = '$';
const DRIVER_TTL = 120000;
const TIPS = [0, 1000, 2000, 3000];
const SERVICE_RATE = 0.15;
// Caja de búsqueda de direcciones: Rincón de los Sauces y alrededores.
const VIEWBOX = '-69.05,-37.30,-68.80,-37.48';

if (FIREBASE.apiKey === 'COMPLETAR') {
  document.getElementById('app').innerHTML = '<main class="err-page"><div><h1>Falta configurar</h1><p>Completá js/config.js con los datos de tu proyecto de Firebase y tu Public Key de Mercado Pago.</p></div></main>';
  throw new Error('Falta completar js/config.js');
}
const fb = initializeApp(FIREBASE);
const auth = getAuth(fb), db = getDatabase(fb);
const call = name => async data => {
  const u = auth.currentUser;
  if (!u) throw new Error('Iniciá sesión para continuar.');
  let r;
  try {
    r = await fetch(API_URL + '/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await u.getIdToken() },
      body: JSON.stringify({ fn: name, data })
    });
  } catch { throw new Error('Sin conexión. Revisá tu internet.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Algo salió mal. Probá de nuevo.');
  return j.data;
};
const api = { getConfig: call('getConfig'), createOrder: call('createOrder'), payOrder: call('payOrder'), cancelOrder: call('cancelOrder') };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => CURRENCY + String(Math.round(Number(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const arr = x => Array.isArray(x) ? x : Object.values(x || {});
const sorted = o => Object.entries(o || {}).map(([id, v]) => ({ ...v, id })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
let toastT;
function toast(msg, type) { const t = $('#toast'); t.textContent = msg; t.className = 'on ' + (type || ''); clearTimeout(toastT); toastT = setTimeout(() => t.className = '', 3800); }

const state = {
  uid: null, user: null, ready: false,
  address: store.get('rcg:address', null),
  saved: store.get('rcg:addresses', []),
  view: 'home', bizId: null, trackId: null, cat: 'Todo', q: '',
  cart: { bizId: null, items: {} },
  tip: 1000, method: 'efectivo', card: false, notes: '', returnToCheckout: false,
  catalog: null, orders: {}, presence: {}
};
const prev = {}, orderSubs = {};
let closeT, placing = false, geo = null, sugT, sugN = [], brick = null, unsubs = [];

const BUSINESSES = () => sorted(state.catalog).filter(b => b.open !== false).map(b => ({ ...b, menu: sorted(b.menu).filter(m => m.available !== false) }));
const biz = id => BUSINESSES().find(b => b.id === id);
const cartCount = () => Object.values(state.cart.items).reduce((s, q) => s + q, 0);
function cartLines() {
  const b = biz(state.cart.bizId); if (!b) return [];
  return Object.entries(state.cart.items).filter(([, q]) => q > 0).map(([id, q]) => ({ ...b.menu.find(m => m.id === id), qty: q })).filter(l => l.name);
}
// Estimación para mostrar; el total real lo calcula el servidor al crear el pedido.
function totals() {
  const b = biz(state.cart.bizId), lines = cartLines();
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const fee = b && lines.length ? b.fee : 0, service = Math.round(subtotal * SERVICE_RATE), tip = lines.length ? state.tip : 0;
  return { subtotal, fee, service, tip, total: subtotal + fee + service + tip };
}
function addItem(bizId, itemId, d) {
  if (d > 0 && cartCount() > 0 && state.cart.bizId !== bizId) {
    if (!confirm('Tu carrito tiene productos de otro local. ¿Vaciarlo y empezar este pedido?')) return false;
    state.cart = { bizId: null, items: {} };
  }
  if (!cartCount()) state.cart.bizId = bizId;
  const q = Math.max(0, Math.min(20, (state.cart.items[itemId] || 0) + d));
  if (q) state.cart.items[itemId] = q; else delete state.cart.items[itemId];
  if (!cartCount()) state.cart.bizId = null;
  return true;
}
const code = o => o.id.slice(-5).toUpperCase();
const mine = () => Object.values(state.orders).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
const activeOrder = () => mine().find(o => !['entregado', 'cancelado'].includes(o.status));
const onlineDrivers = () => Object.values(state.presence).filter(d => d.online && Date.now() - (d.lastSeen || 0) < DRIVER_TTL);

function statusInfo(o) {
  const d = o.driver ? o.driver.name.split(' ')[0] : 'Tu conductor';
  switch (o.status) {
    case 'pago_pendiente': return o.payment.status === 'in_process'
      ? { t: 'Mercado Pago está revisando tu pago', s: 'Te avisamos apenas se acredite', i: 0 }
      : { t: 'Falta pagar tu pedido', s: 'Completá el pago para enviarlo a los conductores', i: 0 };
    case 'nuevo': return { t: 'Buscando conductor…', s: 'Tu pedido ya les llegó a los conductores', i: 0 };
    case 'aceptado': return { t: `${d} va por tu pedido`, s: 'Va camino al local', i: 1 };
    case 'en_local': return { t: `${d} está en el local`, s: 'Retirando tu pedido', i: 1 };
    case 'recogido': return { t: '¡Tu pedido va en camino!', s: `${d} ya lo tiene`, i: 2 };
    case 'entregado': return { t: '¡Entregado! Buen provecho', s: 'Gracias por pedir con Ringcon Go', i: 3 };
    default: return { t: 'Pedido cancelado', s: o.payment.status === 'refunded' ? 'Te devolvimos el dinero a la tarjeta' : '', i: -1 };
  }
}

function payBadge(o) {
  const p = o.payment || {};
  if (p.method === 'efectivo') return `<span class="badge wait">💵 Efectivo al recibir${p.cashWith ? ` · pagás con ${money(p.cashWith)}` : ''}</span>`;
  if (p.status === 'approved') return '<span class="badge ok">💳 Pagado con tarjeta</span>';
  if (p.status === 'refunded') return '<span class="badge bad">💳 Pago devuelto</span>';
  if (p.status === 'in_process') return '<span class="badge wait">💳 Pago en revisión</span>';
  return '<span class="badge wait">💳 Pago pendiente</span>';
}

const hdr = title => `<header class="top"><div class="top-in"><button class="icon-btn" data-act="back" aria-label="Volver">←</button><strong class="top-title">${esc(title)}</strong></div></header>`;

function render() {
  if (!state.ready) { $('#app').innerHTML = '<div class="loading">Cargando…</div>'; return; }
  if (!state.user) { renderLogin(); renderDock(); return; }
  ({ home: renderHome, biz: renderBiz, track: renderTrack, orders: renderOrders }[state.view] || renderHome)();
  renderDock(); updateLive();
}
function go(v, id) { state.view = v; if (id) state.trackId = id; render(); scrollTo(0, 0); }

function renderLogin() {
  $('#app').innerHTML = `
  <main class="login">
    <div class="login-box">
      <svg class="ico" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#ff3b1f"/><g transform="translate(0 -12)" fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round"><path d="M200 220v-30a56 56 0 0 1 112 0v30" stroke-width="22"/><path d="M160 214H352L384 396H128Z" fill="#fff" stroke-width="36"/></g></svg>
      <h1>Pedí ya.</h1>
      <p class="sub">Delivery en Rincón de los Sauces. Entrá con tu nombre y pedí en segundos.</p>
      <form id="login-form">
        <label class="field">Tu nombre<input id="l-name" autocomplete="name" placeholder="Ej: Ana" required minlength="2" maxlength="40"></label>
        <label class="field">Teléfono <i>(para que el conductor te encuentre)</i><input id="l-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="Ej: 299 123 4567" maxlength="20"></label>
        <button class="btn primary big" id="l-btn">Entrar y pedir</button>
      </form>
    </div>
  </main>`;
}

function renderHome() {
  const n = state.user.name;
  $('#app').innerHTML = `
  <header class="top"><div class="top-in">
    <div class="logo">ringcon<b>go</b></div>
    <button class="addr" data-act="addr"><span>📍</span><span><small>Enviar a</small><strong>${state.address ? esc(state.address.text) : 'Agregá tu dirección'}</strong></span><span>⌄</span></button>
    <button class="avatar" data-act="user" aria-label="Mi cuenta">${esc(n.trim()[0].toUpperCase())}</button>
  </div></header>
  <main class="wrap">
    <section class="hero">
      <p class="hello">Hola, <b>${esc(n.split(' ')[0])}</b> 👋</p>
      <h1>¿Qué se te antoja hoy?</h1>
      <div class="search"><input id="q" type="search" placeholder="Buscá comida o locales" value="${esc(state.q)}" aria-label="Buscar"></div>
      <p class="livep"><i class="dot off"></i><span id="drv-count"></span></p>
    </section>
    ${state.address ? '' : `<button class="promo" data-act="addr"><span class="em">📍</span><span><b>Decinos dónde entregar</b><small>Así vemos quién llega a tu puerta</small></span><span class="go">Agregar</span></button>`}
    <nav class="chips" aria-label="Categorías" id="cats"></nav>
    <section class="grid" id="biz-list"></section>
  </main>`;
  drawBiz();
}
function drawBiz() {
  const el = $('#biz-list'); if (!el) return;
  if (!state.catalog) { el.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>'; return; }
  const all = BUSINESSES(), cats = ['Todo', ...new Set(all.map(b => b.cat))];
  $('#cats').innerHTML = cats.map(c => `<button class="chip ${c === state.cat ? 'on' : ''}" data-act="cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
  const q = state.q.trim().toLowerCase();
  const list = all.filter(b => (state.cat === 'Todo' || b.cat === state.cat) && (!q || (b.name + ' ' + b.cat + ' ' + b.menu.map(m => m.name).join(' ')).toLowerCase().includes(q)));
  el.innerHTML = list.length ? list.map(b => `
    <button class="card" data-act="open-biz" data-id="${esc(b.id)}">
      <div class="tile">${esc(b.emoji)}</div>
      <div class="card-b"><h3>${esc(b.name)}</h3>
        <div class="meta"><span>★ ${esc(b.rating)}</span><span>${esc(b.eta)}</span><span>Envío ${money(b.fee)}</span></div></div>
    </button>`).join('') : '<p class="empty">No encontramos nada. Probá con otra búsqueda.</p>';
}

const ctl = it => {
  const q = state.cart.items[it.id] || 0;
  return q ? `<div class="qty"><button data-act="dec" data-id="${esc(it.id)}" aria-label="Quitar uno">−</button><span>${q}</span><button data-act="add" data-id="${esc(it.id)}" aria-label="Agregar uno">+</button></div>`
    : `<button class="add" data-act="add" data-id="${esc(it.id)}" aria-label="Agregar ${esc(it.name)}">+</button>`;
};
function renderBiz() {
  const b = biz(state.bizId);
  if (!b) { go('home'); return; }
  $('#app').innerHTML = `${hdr(b.name)}
  <main class="wrap narrow">
    <div class="biz-hero">${esc(b.emoji)}</div>
    <h1 class="biz-name">${esc(b.name)}</h1>
    <div class="meta"><span>★ ${esc(b.rating)}</span><span>${esc(b.cat)}</span><span>${esc(b.eta)}</span><span>Envío ${money(b.fee)}</span></div>
    <div class="menu">${b.menu.map(it => `
      <div class="item"><div class="em">${esc(it.emoji)}</div>
        <div class="tx"><b>${esc(it.name)}</b><small>${esc(it.desc)}</small><span class="pr">${money(it.price)}</span></div>
        <div id="ctl-${esc(it.id)}">${ctl(it)}</div></div>`).join('')}</div>
  </main>`;
}
function refreshCtls() { const b = biz(state.bizId); if (state.view === 'biz' && b) b.menu.forEach(it => { const e = $('#ctl-' + it.id); if (e) e.innerHTML = ctl(it); }); }

function renderOrders() {
  const list = mine();
  $('#app').innerHTML = `${hdr('Mis pedidos')}<main class="wrap narrow">${list.length ? list.map(o => `
    <button class="box ord" data-act="track" data-id="${esc(o.id)}">
      <b>${esc(o.business.name)}</b> <span class="badge ${o.status === 'cancelado' ? 'bad' : o.status === 'entregado' ? 'ok' : 'wait'}">${esc(statusInfo(o).t)}</span>
      <div class="meta"><span>#${code(o)}</span><span>${new Date(o.createdAt).toLocaleString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><span>${money(o.totals.total)}</span></div>
    </button>`).join('') : '<p class="empty">Todavía no hiciste pedidos.</p>'}</main>`;
}

function renderTrack() {
  const o = state.orders[state.trackId];
  if (!o) { $('#app').innerHTML = hdr('Tu pedido') + '<main class="wrap narrow"><p class="empty">Cargando tu pedido…</p></main>'; return; }
  const s = statusInfo(o), n = onlineDrivers().length;
  const labels = ['Pedido enviado', 'Conductor asignado', 'En camino', 'Entregado'];
  const t = o.totals, unpaid = o.status === 'pago_pendiente' && o.payment.status !== 'in_process';
  $('#app').innerHTML = `${hdr('Pedido #' + code(o))}
  <main class="wrap narrow">
    <section class="t-head"><small>${esc(o.business.name)}</small><h1>${esc(s.t)}</h1><small>${esc(s.s)}</small></section>
    ${unpaid ? `<button class="btn primary big" data-act="pay" data-id="${esc(o.id)}" style="margin-bottom:16px">Pagar ${money(t.total)}</button>` : ''}
    ${o.status === 'cancelado' || o.status === 'pago_pendiente' ? '' : `<div class="steps">${labels.map((l, k) => {
      const done = k < s.i || o.status === 'entregado', now = !done && k === s.i;
      return `<div class="step ${done ? 'done' : now ? 'now' : ''}"><i>${done ? '✓' : ''}</i><span>${l}</span></div>`;
    }).join('')}</div>`}
    ${o.status === 'nuevo' ? `<p class="box livep"><i class="dot ${n ? '' : 'off'}"></i>${n ? `${n} conductor${n > 1 ? 'es' : ''} en línea ya ven tu pedido` : 'No hay conductores en línea ahora. Tu pedido queda en cola.'}</p>` : ''}
    ${o.driver ? `<div class="box drv"><div class="av">${esc(o.driver.name.trim()[0].toUpperCase())}</div><div><b>${esc(o.driver.name)}</b><small>${esc(o.driver.vehicle || 'Conductor')} · conductor verificado ✓</small></div>${o.driver.phone && o.status !== 'entregado' ? `<a class="icon-btn" href="tel:${esc(String(o.driver.phone).replace(/[^\d+]/g, ''))}" aria-label="Llamar">📞</a>` : ''}</div>` : ''}
    <div class="box">
      ${arr(o.items).map(i => `<div class="tot"><span>${i.qty}× ${esc(i.name)}</span><span>${money(i.price * i.qty)}</span></div>`).join('')}
      <div class="tot"><span>Envío</span><span>${money(t.fee)}</span></div>
      <div class="tot"><span>Servicio</span><span>${money(t.service)}</span></div>
      <div class="tot"><span>Propina</span><span>${money(t.tip)}</span></div>
      <div class="tot big"><span>Total</span><span>${money(t.total)}</span></div>
      ${payBadge(o)}
    </div>
    <div class="box"><small class="meta">Entrega en</small><b>${esc(o.address.text)}</b>${o.address.ref ? `<div class="meta">${esc(o.address.ref)}</div>` : ''}</div>
    ${['pago_pendiente', 'nuevo'].includes(o.status) ? `<button class="btn ghost big" data-act="cancel" data-id="${esc(o.id)}">Cancelar pedido</button>` : ''}
    ${['entregado', 'cancelado'].includes(o.status) ? '<button class="btn primary big" data-act="back">Hacer otro pedido</button>' : ''}
  </main>`;
}

function renderDock() {
  const d = $('#dock'); let h = '';
  const cnt = cartCount(), a = state.user && activeOrder();
  if (state.user && cnt && (state.view === 'home' || state.view === 'biz')) h += `<button class="bar cart" data-act="cart"><span><span class="n">${cnt}</span> Ver pedido</span><span>${money(totals().subtotal)}</span></button>`;
  if (a && state.view !== 'track') h += `<button class="bar trk" data-act="track" data-id="${esc(a.id)}"><span>${esc(statusInfo(a).t)}<small>Pedido #${code(a)}</small></span><span class="go">Ver</span></button>`;
  d.innerHTML = h;
}

function updateLive() {
  const n = onlineDrivers().length, el = $('#drv-count');
  if (!el) return;
  el.textContent = n ? `${n} conductor${n > 1 ? 'es' : ''} en línea ahora` : 'Sin conductores en línea ahora · tu pedido quedará en cola';
  const dot = el.previousElementSibling; if (dot) dot.classList.toggle('off', !n);
}

function openSheet(html, onOpen) {
  unmountBrick();
  const r = $('#sheet-root'); clearTimeout(closeT);
  const was = r.classList.contains('open');
  r.innerHTML = `<div class="scrim" data-act="close"></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  document.body.classList.add('lock');
  if (!was) requestAnimationFrame(() => requestAnimationFrame(() => r.classList.add('open')));
  if (onOpen) onOpen();
}
function closeSheet() {
  unmountBrick();
  const r = $('#sheet-root'); r.classList.remove('open'); document.body.classList.remove('lock');
  clearTimeout(closeT); closeT = setTimeout(() => { if (!r.classList.contains('open')) r.innerHTML = ''; }, 320);
}

const short = s => String(s || '').split(',').slice(0, 3).join(',').trim();
function openAddress() {
  geo = state.address && state.address.lat ? { lat: state.address.lat, lon: state.address.lon } : null;
  openSheet(`
    <div class="sheet-h"><h2>¿Dónde te lo llevamos?</h2><button class="icon-btn" data-act="close" aria-label="Cerrar">✕</button></div>
    <label class="field">Calle y número<input id="a-text" placeholder="Ej: Av. Argentina 450" autocomplete="street-address" maxlength="120" value="${esc(state.address ? state.address.text : '')}"></label>
    <div class="sug" id="a-sug"></div>
    <button class="btn ghost big" data-act="use-loc" style="margin-bottom:14px">📍 Usar mi ubicación actual</button>
    <label class="field">Piso, depto o referencias<input id="a-ref" placeholder="Ej: casa con portón negro" maxlength="80" value="${esc(state.address ? state.address.ref || '' : '')}"></label>
    ${state.saved.length ? `<h3>Direcciones guardadas</h3><div class="saved">${state.saved.map((a, i) => `<button class="pill" data-act="pick-saved" data-i="${i}">${esc(a.text)}</button>`).join('')}</div>` : ''}
    <button class="btn primary big" data-act="save-addr">Confirmar dirección</button>`,
    () => {
      const inp = $('#a-text');
      inp.addEventListener('input', onAddrInput);
      setTimeout(() => inp.focus(), 350);
    });
}
function onAddrInput(e) {
  geo = null; clearTimeout(sugT);
  const q = e.target.value.trim(), box = $('#a-sug');
  if (q.length < 4) { box.innerHTML = ''; return; }
  sugT = setTimeout(async () => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=es&countrycodes=ar&bounded=1&viewbox=${VIEWBOX}&q=${encodeURIComponent(q)}`);
      sugN = await r.json();
      const b = $('#a-sug'); if (b) b.innerHTML = sugN.map((s, i) => `<button type="button" data-act="sug" data-i="${i}">📍 ${esc(short(s.display_name))}</button>`).join('');
    } catch { const b = $('#a-sug'); if (b) b.innerHTML = ''; }
  }, 700);
}

function openCheckout() {
  if (!cartCount()) return;
  if (!state.address) { state.returnToCheckout = true; toast('Primero decinos dónde entregar'); openAddress(); return; }
  const b = biz(state.cart.bizId);
  if (!b) { state.cart = { bizId: null, items: {} }; renderDock(); return; }
  openSheet(`
    <div class="sheet-h"><h2>Tu pedido</h2><button class="icon-btn" data-act="close" aria-label="Cerrar">✕</button></div>
    <div class="meta"><span>${esc(b.name)}</span><span>${esc(b.eta)}</span></div>
    <div id="co-items"></div>
    <div class="co-addr"><span>📍</span><div><small>Entrega en</small><strong>${esc(state.address.text)}</strong>${state.address.ref ? `<small>${esc(state.address.ref)}</small>` : ''}</div><button class="link" data-act="addr">Cambiar</button></div>
    <label class="field">Notas para el local o el conductor<input id="co-notes" maxlength="140" placeholder="Ej: sin cebolla" value="${esc(state.notes)}"></label>
    <h3>Propina para el conductor</h3>
    <div class="tips" id="co-tips">${TIPS.map(v => `<button class="pill" data-act="tip" data-v="${v}">${v ? money(v) : 'No'}</button>`).join('')}</div>
    <h3>¿Cómo pagás?</h3>
    <div class="methods" id="co-methods">
      <button class="method" data-act="method" data-m="tarjeta" ${state.card ? '' : 'disabled'}>💳 Tarjeta<small>${state.card ? 'Débito o crédito' : 'Próximamente'}</small></button>
      <button class="method" data-act="method" data-m="efectivo">💵 Efectivo<small>Pagás al recibir</small></button>
    </div>
    <div id="cash-form" class="hide">
      <label class="field">¿Con cuánto pagás? <i>(opcional, para que el conductor lleve cambio)</i>
        <input id="co-cash" inputmode="numeric" placeholder="Ej: 20000" maxlength="9">
      </label>
    </div>
    <p class="hint" id="co-hint"></p>
    <div id="co-totals"></div>
    <button class="btn primary big" id="co-pay" data-act="place">Continuar</button>
    <p class="secure" id="co-secure"></p>`,
    () => { $('#co-notes').addEventListener('input', e => state.notes = e.target.value); drawCo(); });
}

function drawCo() {
  if (!$('#co-items')) return;
  const lines = cartLines();
  if (!lines.length) { closeSheet(); renderDock(); return; }
  $('#co-items').innerHTML = lines.map(l => `<div class="line"><div class="tx"><b>${esc(l.name)}</b><div class="meta"><span>${money(l.price)}</span></div></div><div class="qty"><button data-act="co-dec" data-id="${esc(l.id)}" aria-label="Quitar uno">−</button><span>${l.qty}</span><button data-act="co-add" data-id="${esc(l.id)}" aria-label="Agregar uno">+</button></div></div>`).join('');
  const t = totals(), isCard = state.method === 'tarjeta';
  $('#co-totals').innerHTML = `
    <div class="tot"><span>Productos</span><span>${money(t.subtotal)}</span></div>
    <div class="tot"><span>Envío</span><span>${money(t.fee)}</span></div>
    <div class="tot"><span>Servicio</span><span>${money(t.service)}</span></div>
    <div class="tot"><span>Propina</span><span>${money(t.tip)}</span></div>
    <div class="tot big"><span>Total</span><span>${money(t.total)}</span></div>`;
  $('#cash-form').classList.toggle('hide', isCard);
  $('#co-pay').textContent = isCard ? `Ir a pagar ${money(t.total)}` : `Pedir ya · ${money(t.total)}`;
  $$('#co-tips .pill').forEach(p => p.classList.toggle('on', +p.dataset.v === state.tip));
  $$('#co-methods .method').forEach(m => m.classList.toggle('on', m.dataset.m === state.method));
  const cardBtn = $('#co-methods [data-m="tarjeta"]');
  cardBtn.disabled = !state.card; cardBtn.querySelector('small').textContent = state.card ? 'Débito o crédito' : 'Próximamente';
  $('#co-hint').textContent = isCard
    ? 'En el siguiente paso cargás la tarjeta en el formulario seguro de Mercado Pago. El pedido sale a los conductores cuando el pago se acredita.'
    : `Pagás ${money(t.total)} en efectivo al conductor cuando recibís tu pedido.`;
  $('#co-secure').textContent = isCard ? '🔒 Ringcon Go nunca ve ni guarda los datos de tu tarjeta' : '';
}

function showPay(title, sub, ok) {
  const p = $('#pay'); p.classList.add('on');
  $('#pay-i').className = ok ? 'okk' : 'spin'; $('#pay-i').textContent = ok ? '✓' : '';
  $('#pay-t').textContent = title; $('#pay-s').textContent = sub || '';
}
const hidePay = () => $('#pay').classList.remove('on');

async function placeOrder() {
  if (placing) return;
  const lines = cartLines(); if (!lines.length) return;
  if (!state.address) { state.returnToCheckout = true; openAddress(); return; }
  const isCard = state.method === 'tarjeta', t = totals();
  let cashWith = 0;
  if (!isCard) {
    const raw = ($('#co-cash').value || '').replace(/\D/g, '');
    cashWith = raw ? Number(raw) : 0;
    if (cashWith && cashWith < t.total) { toast(`El monto tiene que cubrir el total (${money(t.total)})`, 'err'); return; }
  }
  placing = true;
  showPay(isCard ? 'Preparando el pago…' : 'Enviando tu pedido…', '');
  try {
    const a = state.address;
    const res = await api.createOrder({
      bizId: state.cart.bizId, items: state.cart.items, tip: state.tip, method: state.method,
      notes: state.notes.trim(), cashWith: cashWith || null,
      address: { text: a.text, ref: a.ref || '', ...(a.lat ? { lat: a.lat, lon: a.lon } : {}) }
    });
    state.cart = { bizId: null, items: {} }; state.notes = '';
    watchOrder(res.orderId);
    hidePay();
    if (isCard) openPaySheet(res.orderId, res.total);
    else { closeSheet(); go('track', res.orderId); }
  } catch (e) { hidePay(); toast(e.message, 'err'); }
  finally { placing = false; }
}

/* ─────────── Mercado Pago (Card Payment Brick) ─────────── */
let mpReady;
function loadMP() {
  return mpReady ||= new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = 'https://sdk.mercadopago.com/js/v2'; s.onload = ok;
    s.onerror = () => { mpReady = null; ko(new Error('No pudimos cargar Mercado Pago. Revisá tu conexión.')); };
    document.head.append(s);
  });
}
function unmountBrick() { if (brick) { try { brick.unmount(); } catch {} brick = null; } }

async function openPaySheet(orderId, amount) {
  openSheet(`
    <div class="sheet-h"><h2>Pagá con tarjeta</h2><button class="icon-btn" data-act="close" aria-label="Cerrar">✕</button></div>
    <div class="pay-sum"><span>Total a pagar</span><b>${money(amount)}</b></div>
    <div id="mp-brick"><div class="loading">Cargando formulario seguro…</div></div>
    <p class="secure">🔒 Procesado por Mercado Pago. Ringcon Go no ve ni guarda los datos de tu tarjeta.</p>`);
  try {
    if (MP_PUBLIC_KEY === 'COMPLETAR') throw new Error('Falta la Public Key de Mercado Pago en js/config.js.');
    await loadMP();
    if (!$('#mp-brick')) return;
    $('#mp-brick').innerHTML = '';
    const mp = new window.MercadoPago(MP_PUBLIC_KEY, { locale: 'es-AR' });
    brick = await mp.bricks().create('cardPayment', 'mp-brick', {
      initialization: { amount },
      customization: {
        paymentMethods: { maxInstallments: 1 },
        visual: { style: { theme: 'default', customVariables: { baseColor: '#ff3b1f', borderRadiusLarge: '18px', borderRadiusMedium: '14px' } } }
      },
      callbacks: {
        onReady: () => {},
        onError: e => { console.error('Brick', e); if (!brick) showBrickError(); },
        onSubmit: form => pay(orderId, form)
      }
    });
  } catch (e) { showBrickError(e.message); }
}

function showBrickError(msg) {
  const el = $('#mp-brick');
  if (el) el.innerHTML = `<div class="notice bad"><span>⚠️</span><span>${esc(msg || 'No pudimos cargar el formulario de pago. Probá de nuevo en un momento o pagá en efectivo.')}</span></div>`;
}

async function pay(orderId, form) {
  showPay('Procesando tu pago…', 'No cierres esta pantalla');
  try {
    const r = await api.payOrder({ orderId, form });
    if (r.status === 'approved') {
      showPay('¡Pago acreditado!', 'Tu pedido ya les llegó a los conductores', true);
      await new Promise(ok => setTimeout(ok, 1300));
      hidePay(); closeSheet(); go('track', orderId);
    } else if (r.status === 'in_process' || r.status === 'pending') {
      hidePay(); closeSheet(); go('track', orderId);
      toast('Mercado Pago está revisando tu pago. Te avisamos al acreditarse.');
    } else {
      hidePay(); toast(r.message || 'El pago fue rechazado.', 'err');
      throw new Error(r.status);   // el Brick queda listo para reintentar
    }
  } catch (e) {
    hidePay();
    if (!/^rejected$/.test(e.message)) toast(e.message, 'err');
    throw e;
  }
}

/* ─────────── acciones ─────────── */
const A = {
  close: () => closeSheet(),
  back: () => go('home'),
  addr: () => { if ($('#co-items')) state.returnToCheckout = true; openAddress(); },
  user: () => openSheet(`
    <div class="sheet-h"><h2>Hola, ${esc(state.user.name)}</h2><button class="icon-btn" data-act="close" aria-label="Cerrar">✕</button></div>
    ${state.user.phone ? `<p class="sub">${esc(state.user.phone)}</p>` : ''}
    <button class="btn ghost big" data-act="orders" style="margin-bottom:10px">Mis pedidos</button>
    <button class="btn ghost big" data-act="logout">Cerrar sesión</button>`),
  orders: () => { closeSheet(); go('orders'); },
  logout: async () => {
    if (!confirm(activeOrder() ? 'Tenés un pedido en curso y no vas a poder seguirlo desde otra sesión. ¿Cerrar sesión igual?' : 'Al cerrar sesión se borra tu historial de pedidos en este dispositivo. ¿Seguir?')) return;
    closeSheet(); state.cart = { bizId: null, items: {} }; state.view = 'home';
    await signOut(auth);
  },
  cat: t => { state.cat = t.dataset.cat; drawBiz(); },
  'open-biz': t => { state.bizId = t.dataset.id; go('biz'); },
  add: t => { if (addItem(state.bizId, t.dataset.id, 1)) { refreshCtls(); renderDock(); } },
  dec: t => { addItem(state.bizId, t.dataset.id, -1); refreshCtls(); renderDock(); },
  'co-add': t => { addItem(state.cart.bizId, t.dataset.id, 1); drawCo(); refreshCtls(); renderDock(); },
  'co-dec': t => { addItem(state.cart.bizId, t.dataset.id, -1); drawCo(); refreshCtls(); renderDock(); },
  cart: () => openCheckout(),
  tip: t => { state.tip = +t.dataset.v; drawCo(); },
  method: t => { if (t.dataset.m === 'tarjeta' && !state.card) return; state.method = t.dataset.m; drawCo(); },
  place: () => placeOrder(),
  pay: t => { const o = state.orders[t.dataset.id]; if (o) openPaySheet(o.id, o.totals.total); },
  track: t => { closeSheet(); go('track', t.dataset.id); },
  'pick-saved': t => { const a = state.saved[+t.dataset.i]; if (!a) return; $('#a-text').value = a.text; $('#a-ref').value = a.ref || ''; geo = a.lat ? { lat: a.lat, lon: a.lon } : null; $('#a-sug').innerHTML = ''; },
  sug: t => { const s = sugN[+t.dataset.i]; if (!s) return; $('#a-text').value = short(s.display_name); geo = { lat: +s.lat, lon: +s.lon }; $('#a-sug').innerHTML = ''; },
  'use-loc': t => {
    if (!navigator.geolocation) { toast('Tu navegador no permite usar la ubicación', 'err'); return; }
    const label = t.textContent; t.textContent = 'Buscando tu ubicación…';
    navigator.geolocation.getCurrentPosition(async p => {
      geo = { lat: p.coords.latitude, lon: p.coords.longitude };
      let txt = `${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)}`;
      try { const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=es&lat=${geo.lat}&lon=${geo.lon}`); const j = await r.json(); if (j.display_name) txt = short(j.display_name); } catch {}
      const i = $('#a-text'); if (i) i.value = txt; t.textContent = label;
    }, () => { t.textContent = label; toast('No pudimos obtener tu ubicación. Escribí tu dirección.', 'err'); }, { enableHighAccuracy: true, timeout: 10000 });
  },
  'save-addr': () => {
    const text = $('#a-text').value.trim();
    if (text.length < 5) { toast('Escribí tu dirección completa', 'err'); return; }
    state.address = { text, ref: $('#a-ref').value.trim(), ...(geo || {}) };
    store.set('rcg:address', state.address);
    state.saved = [state.address, ...state.saved.filter(a => a.text !== text)].slice(0, 4);
    store.set('rcg:addresses', state.saved);
    closeSheet(); render();
    if (state.returnToCheckout) { state.returnToCheckout = false; setTimeout(openCheckout, 340); }
  },
  cancel: async t => {
    if (!confirm('¿Cancelar este pedido?')) return;
    try { await api.cancelOrder({ orderId: t.dataset.id }); toast('Pedido cancelado'); }
    catch (e) { toast(e.message, 'err'); }
  }
};

document.addEventListener('click', e => { const t = e.target.closest('[data-act]'); if (!t) return; const f = A[t.dataset.act]; if (f) f(t, e); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#sheet-root').classList.contains('open')) closeSheet(); });
document.addEventListener('input', e => { if (e.target.id === 'q') { state.q = e.target.value; drawBiz(); } });
document.addEventListener('submit', async e => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  const name = $('#l-name').value.trim().replace(/\s+/g, ' '), phone = $('#l-phone').value.trim();
  if (name.length < 2) return;
  const btn = $('#l-btn'); btn.disabled = true;
  try {
    const cred = auth.currentUser || (await signInAnonymously(auth)).user;
    const profile = { name, ...(phone ? { phone } : {}) };
    await set(ref(db, `customers/${cred.uid}`), profile);
    state.user = profile; render();
    if (!state.address) setTimeout(openAddress, 250);
  } catch { btn.disabled = false; toast('No pudimos conectarte. Revisá tu conexión.', 'err'); }
});

/* ─────────── datos en tiempo real ─────────── */
function watchOrder(id) {
  if (orderSubs[id]) return;
  orderSubs[id] = onValue(ref(db, `orders/${id}`), s => {
    const o = s.val(); if (!o) return;
    const p = prev[id];
    if (p && p !== o.status) { toast(statusInfo(o).t); if (navigator.vibrate) navigator.vibrate(200); }
    prev[id] = o.status; state.orders[id] = o;
    if (state.view === 'track') renderTrack(); else if (state.view === 'orders') renderOrders();
    renderDock();
  });
}
function stopWatching() {
  unsubs.forEach(u => u()); unsubs = [];
  Object.values(orderSubs).forEach(u => u());
  for (const k in orderSubs) delete orderSubs[k];
  state.orders = {};
}

onValue(ref(db, 'catalog'), s => { state.catalog = s.val() || {}; if (state.view === 'home') drawBiz(); else if (state.view === 'biz') renderBiz(); },
  () => { state.catalog = {}; drawBiz(); });

onAuthStateChanged(auth, async u => {
  stopWatching();
  state.uid = u ? u.uid : null; state.user = null;
  if (u) {
    try { state.user = (await new Promise((ok, ko) => onValue(ref(db, `customers/${u.uid}`), s => ok(s.val()), ko, { onlyOnce: true }))) || null; } catch {}
    // La tarjeta aparece sola cuando el servidor tiene configurado Mercado Pago.
    api.getConfig().then(c => { state.card = !!c.card; state.method = state.card ? 'tarjeta' : 'efectivo'; drawCo(); }).catch(() => {});
    unsubs.push(onValue(ref(db, `userOrders/${u.uid}`), s => Object.keys(s.val() || {}).forEach(watchOrder)));
    unsubs.push(onValue(ref(db, 'presence'), s => { state.presence = s.val() || {}; updateLive(); if (state.view === 'track') renderTrack(); }, () => {}));
  }
  state.ready = true; render();
});
setInterval(updateLive, 10000);
render();
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
