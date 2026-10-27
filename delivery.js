(() => {
'use strict';

/* ═══════════════ CONFIGURACIÓN ═══════════════
   FIREBASE_URL: URL de tu Firebase Realtime Database (la MISMA en la app de conductores).
   Vacío = modo demo local: solo sincroniza entre pestañas del mismo navegador.
   ROOM: nombre de tu "sala"; debe ser igual en ambos archivos. */
const CONFIG = {
  FIREBASE_URL: "",
  ROOM: "ringcon-go",
  CURRENCY: "$",
  DRIVER_TTL: 120000,      // un conductor cuenta como "en línea" si latió hace menos de 2 min
  PAYMENT_MODE: "demo"     // "demo" = pasarela simulada (ver PaymentGateway más abajo)
};

/* ═══════════════ SINCRONIZACIÓN EN TIEMPO REAL ═══════════════ */
const Sync = (() => {
  const remote = !!CONFIG.FIREBASE_URL;
  const base = remote ? CONFIG.FIREBASE_URL.replace(/\/+$/, '') + '/' + CONFIG.ROOM : '';
  const cols = ['orders', 'drivers'];
  const cache = { orders: {}, drivers: {} };
  const subs = { orders: new Set(), drivers: new Set() };
  const statusSubs = new Set();
  let status = remote ? 'connecting' : 'local';
  let done; const loaded = new Promise(r => (done = r));
  const key = c => `rcg:${CONFIG.ROOM}:${c}`;
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('rcg:' + CONFIG.ROOM) : null;
  const setStatus = s => { if (s !== status) { status = s; statusSubs.forEach(f => f(s)); } };
  const emit = c => subs[c].forEach(f => { try { f(cache[c]); } catch (e) { console.error(e); } });
  const readLocal = c => { try { return JSON.parse(localStorage.getItem(key(c)) || '{}') || {}; } catch { return {}; } };
  const refreshLocal = c => { cache[c] = readLocal(c); emit(c); };

  async function pull(c) {
    try {
      const r = await fetch(`${base}/${c}.json`, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      cache[c] = (await r.json()) || {};
      setStatus('live'); emit(c);
    } catch (e) { setStatus('offline'); }
  }
  function start() {
    if (!remote) {
      cols.forEach(refreshLocal);
      if (bc) bc.onmessage = e => refreshLocal(e.data.c);
      addEventListener('storage', e => cols.forEach(c => { if (e.key === key(c)) refreshLocal(c); }));
      done(); return;
    }
    Promise.all(cols.map(pull)).then(done);
    cols.forEach(c => {
      try {
        const es = new EventSource(`${base}/${c}.json`);
        let t; const kick = () => { clearTimeout(t); t = setTimeout(() => pull(c), 120); };
        es.addEventListener('put', kick); es.addEventListener('patch', kick);
        es.onerror = () => setStatus('offline');
      } catch {}
    });
    setInterval(() => cols.forEach(pull), 8000);   // respaldo por si el stream se corta
  }
  async function patch(c, id, data) {
    if (!remote) {
      const all = readLocal(c); all[id] = Object.assign({}, all[id], data);
      try { localStorage.setItem(key(c), JSON.stringify(all)); } catch {}
      cache[c] = all; emit(c); if (bc) bc.postMessage({ c }); return;
    }
    cache[c][id] = Object.assign({}, cache[c][id], data); emit(c);
    const r = await fetch(`${base}/${c}/${id}.json`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), keepalive: true });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  }
  return {
    remote, loaded, start, patch,
    get: (c, id) => cache[c][id],
    refresh: c => remote ? pull(c) : Promise.resolve(refreshLocal(c)),
    subscribe(c, fn) { subs[c].add(fn); fn(cache[c]); },
    onStatus(fn) { statusSubs.add(fn); fn(status); },
    status: () => status
  };
})();

/* ═══════════════ UTILIDADES ═══════════════ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => CONFIG.CURRENCY + Number(n || 0).toFixed(2).replace('.', ',');
const wait = ms => new Promise(r => setTimeout(r, ms));
const arr = x => Array.isArray(x) ? x : Object.values(x || {});
const rid = () => Math.random().toString(36).slice(2, 8);
const hash = s => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
let toastT;
function toast(msg, type) { const t = $('#toast'); t.textContent = msg; t.className = 'on ' + (type || ''); clearTimeout(toastT); toastT = setTimeout(() => t.className = '', 3400); }

/* ═══════════════ CATÁLOGO DE EJEMPLO ═══════════════ */
const BUSINESSES = [
  { id: 'burger', name: 'Burger Lab', cat: 'Burgers', emoji: '🍔', color: '#ffe8d4', eta: '20–30 min', fee: 1.5, rating: 4.8, menu: [
    { id: 'bu1', name: 'Classic Lab', desc: 'Doble carne, cheddar, pepinillos', price: 9.5, emoji: '🍔' },
    { id: 'bu2', name: 'Crispy Chicken', desc: 'Pollo crujiente, mayo de limón', price: 8.9, emoji: '🍗' },
    { id: 'bu3', name: 'Papas rústicas', desc: 'Con sal de ajo', price: 3.8, emoji: '🍟' },
    { id: 'bu4', name: 'Limonada', desc: 'Con menta, 500 ml', price: 2.9, emoji: '🍋' } ] },
  { id: 'pizza', name: 'Pizza Nonna', cat: 'Pizza', emoji: '🍕', color: '#ffe3e0', eta: '25–35 min', fee: 1.8, rating: 4.7, menu: [
    { id: 'pi1', name: 'Margherita', desc: 'Tomate, mozzarella, albahaca', price: 10.5, emoji: '🍕' },
    { id: 'pi2', name: 'Pepperoni', desc: 'Doble pepperoni', price: 12.0, emoji: '🍕' },
    { id: 'pi3', name: 'Focaccia', desc: 'Romero y aceite de oliva', price: 4.5, emoji: '🥖' },
    { id: 'pi4', name: 'Tiramisú', desc: 'Receta de la casa', price: 4.9, emoji: '🍰' } ] },
  { id: 'sushi', name: 'Sushi Kai', cat: 'Sushi', emoji: '🍣', color: '#e3f1ff', eta: '30–40 min', fee: 2.2, rating: 4.9, menu: [
    { id: 'su1', name: 'Roll Salmón (8)', desc: 'Salmón, palta, queso crema', price: 11.9, emoji: '🍣' },
    { id: 'su2', name: 'Roll Crunchy (8)', desc: 'Langostino tempura', price: 12.5, emoji: '🍤' },
    { id: 'su3', name: 'Gyozas (5)', desc: 'Cerdo y vegetales', price: 6.5, emoji: '🥟' },
    { id: 'su4', name: 'Té helado', desc: 'Jazmín', price: 2.8, emoji: '🧋' } ] },
  { id: 'tacos', name: 'Tacos El Güero', cat: 'Tacos', emoji: '🌮', color: '#fff3c9', eta: '15–25 min', fee: 1.2, rating: 4.6, menu: [
    { id: 'ta1', name: 'Tacos al pastor (3)', desc: 'Piña y cilantro', price: 7.5, emoji: '🌮' },
    { id: 'ta2', name: 'Burrito de res', desc: 'Frijoles, arroz, guacamole', price: 9.2, emoji: '🌯' },
    { id: 'ta3', name: 'Nachos', desc: 'Queso y jalapeños', price: 5.9, emoji: '🧀' },
    { id: 'ta4', name: 'Agua de jamaica', desc: '500 ml', price: 2.5, emoji: '🥤' } ] },
  { id: 'bowl', name: 'Green Bowl', cat: 'Saludable', emoji: '🥗', color: '#e0f7e6', eta: '15–25 min', fee: 1.4, rating: 4.7, menu: [
    { id: 'bo1', name: 'Poke de pollo', desc: 'Arroz, edamame, palta', price: 9.9, emoji: '🥗' },
    { id: 'bo2', name: 'Bowl vegano', desc: 'Quinoa, garbanzos, tahini', price: 9.4, emoji: '🥙' },
    { id: 'bo3', name: 'Smoothie verde', desc: 'Espinaca, manzana, jengibre', price: 4.6, emoji: '🥬' } ] },
  { id: 'dulce', name: 'Dulce Mía', cat: 'Postres', emoji: '🍩', color: '#fde4f1', eta: '20–30 min', fee: 1.3, rating: 4.8, menu: [
    { id: 'du1', name: 'Donas glaseadas (4)', desc: 'Surtidas', price: 6.8, emoji: '🍩' },
    { id: 'du2', name: 'Brownie tibio', desc: 'Con helado de vainilla', price: 5.5, emoji: '🍫' },
    { id: 'du3', name: 'Cheesecake', desc: 'Frutos rojos', price: 5.9, emoji: '🍰' } ] },
  { id: 'cafe', name: 'Café Alba', cat: 'Café', emoji: '☕', color: '#efe6dc', eta: '10–20 min', fee: 1.0, rating: 4.9, menu: [
    { id: 'ca1', name: 'Flat white', desc: 'Doble espresso, leche cremosa', price: 3.6, emoji: '☕' },
    { id: 'ca2', name: 'Croissant de almendras', desc: 'Horneado hoy', price: 3.9, emoji: '🥐' },
    { id: 'ca3', name: 'Tostón de palta', desc: 'Con huevo pochado', price: 6.5, emoji: '🍞' } ] },
  { id: 'pollo', name: 'Pollo Crunch', cat: 'Burgers', emoji: '🍗', color: '#ffeccc', eta: '20–30 min', fee: 1.6, rating: 4.5, menu: [
    { id: 'po1', name: 'Combo 6 piezas', desc: 'Con papas y salsa', price: 12.9, emoji: '🍗' },
    { id: 'po2', name: 'Wrap crujiente', desc: 'Lechuga, tomate, salsa ranch', price: 7.2, emoji: '🌯' },
    { id: 'po3', name: 'Ensalada coleslaw', desc: 'Porción individual', price: 2.9, emoji: '🥗' } ] }
];
const biz = id => BUSINESSES.find(b => b.id === id);
const CATS = ['Todo', ...new Set(BUSINESSES.map(b => b.cat))];

/* ═══════════════ PASARELA DE PAGO ═══════════════
   DEMO: simula la autorización. Para cobrar de verdad hay que usar el SDK de un proveedor
   (Stripe Elements, Mercado Pago Bricks, etc.) que tokeniza la tarjeta en el navegador y
   un servidor propio que crea el cobro con la clave secreta. Reemplaza el cuerpo de charge(). */
const PaymentGateway = {
  async charge({ amount, card, onPhase }) {
    onPhase('Verificando tarjeta…'); await wait(800);
    onPhase('Autorizando con el banco…'); await wait(1000);
    if (card.number.endsWith('0002')) return { ok: false, msg: 'Tarjeta rechazada. Prueba con otra.' };
    return { ok: true, ref: 'PAY-' + rid().toUpperCase(), brand: card.brand, last4: card.number.slice(-4), amount };
  }
};
const luhn = n => { if (!/^\d{13,19}$/.test(n)) return false; let s = 0, alt = false; for (let i = n.length - 1; i >= 0; i--) { let d = +n[i]; if (alt) { d *= 2; if (d > 9) d -= 9; } s += d; alt = !alt; } return s % 10 === 0; };
const brandOf = v => /^4/.test(v) ? 'Visa' : /^(5[1-5]|2[2-7])/.test(v) ? 'Mastercard' : /^3[47]/.test(v) ? 'Amex' : v.length > 1 ? 'Tarjeta' : '';

/* ═══════════════ ESTADO ═══════════════ */
const state = {
  user: store.get('rcg:customer', null),
  address: store.get('rcg:address', null),
  saved: store.get('rcg:addresses', []),
  view: 'home', bizId: null, trackId: null, cat: 'Todo', q: '',
  cart: { bizId: null, items: {} },
  tip: 1, method: 'tarjeta', notes: '', returnToCheckout: false,
  orders: {}, drivers: {}
};
const prev = {};
let closeT, placing = false, geo = null, sugT, sugN = [];

const cartCount = () => Object.values(state.cart.items).reduce((s, q) => s + q, 0);
function cartLines() {
  const b = biz(state.cart.bizId); if (!b) return [];
  return Object.entries(state.cart.items).filter(([, q]) => q > 0).map(([id, q]) => ({ ...b.menu.find(m => m.id === id), qty: q }));
}
function totals() {
  const b = biz(state.cart.bizId), lines = cartLines();
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const fee = b && lines.length ? b.fee : 0;
  const service = +(subtotal * 0.05).toFixed(2);
  const tip = lines.length ? state.tip : 0;
  return { subtotal: +subtotal.toFixed(2), fee, service, tip, total: +(subtotal + fee + service + tip).toFixed(2) };
}
function addItem(bizId, itemId, d) {
  if (d > 0 && cartCount() > 0 && state.cart.bizId !== bizId) {
    if (!confirm('Tu carrito tiene productos de otro local. ¿Vaciarlo y empezar este pedido?')) return false;
    state.cart = { bizId: null, items: {} };
  }
  if (!cartCount()) state.cart.bizId = bizId;
  const q = Math.max(0, (state.cart.items[itemId] || 0) + d);
  if (q) state.cart.items[itemId] = q; else delete state.cart.items[itemId];
  if (!cartCount()) state.cart.bizId = null;
  return true;
}
const code = o => o.id.slice(-5).toUpperCase();
const mine = () => Object.values(state.orders).filter(o => o.customer && o.customer.id === state.user.id).sort((a, b) => b.createdAt - a.createdAt);
const activeOrder = () => state.user ? mine().find(o => !['entregado', 'cancelado'].includes(o.status)) : null;
const onlineDrivers = () => Object.values(state.drivers).filter(d => d.online && Date.now() - (d.lastSeen || 0) < CONFIG.DRIVER_TTL);

function statusInfo(o) {
  const d = o.driver ? o.driver.name : 'Tu conductor';
  switch (o.status) {
    case 'nuevo': return { t: 'Buscando conductor…', s: 'Tu pedido ya está en la app de conductores', i: 0 };
    case 'aceptado': return { t: `${d} va por tu pedido`, s: 'Va camino al local', i: 1 };
    case 'en_local': return { t: `${d} está en el local`, s: 'Recogiendo tu pedido', i: 1 };
    case 'recogido': return { t: '¡Tu pedido va en camino!', s: `${d} ya lo tiene`, i: 2 };
    case 'entregado': return { t: '¡Entregado! Buen provecho', s: 'Gracias por pedir con Ringcon Go', i: 3 };
    default: return { t: 'Pedido cancelado', s: '', i: -1 };
  }
}
function payBadge(o) {
  const p = o.payment || {};
  if (p.status === 'reembolso') return '<span class="badge bad">Reembolso solicitado</span>';
  if (p.method === 'tarjeta') return `<span class="badge ok">Pagado · ${esc(p.brand || 'Tarjeta')} ••••${esc(p.last4 || '')}</span>`;
  return p.status === 'pagado' ? '<span class="badge ok">Pagado en efectivo</span>' : '<span class="badge wait">Pagas en efectivo al recibir</span>';
}

/* ═══════════════ VISTAS ═══════════════ */
const hdr = title => `<header class="top"><div class="top-in"><button class="icon-btn" data-act="back" aria-label="Volver">←</button><strong class="top-title">${esc(title)}</strong></div></header>`;

function render() {
  if (!state.user) { renderLogin(); renderDock(); return; }
  ({ home: renderHome, biz: renderBiz, track: renderTrack, orders: renderOrders }[state.view] || renderHome)();
  renderDock(); updateLive(); updateChip();
}
function go(v, id) { state.view = v; if (id) state.trackId = id; render(); scrollTo(0, 0); }

function renderLogin() {
  $('#app').innerHTML = `
  <main class="login">
    <div class="login-art" aria-hidden="true"><span>🛵</span></div>
    <div class="login-box">
      <div class="logo">ringcon<b>go</b></div>
      <h1>Pide ya.<br>Llega ya.</h1>
      <p class="sub">Entra con tu nombre y pide en segundos.</p>
      <form id="login-form">
        <label class="field">Tu nombre<input id="l-name" autocomplete="name" placeholder="Ej: Ana" required maxlength="30"></label>
        <label class="field">Teléfono <i>(para que el conductor te encuentre)</i><input id="l-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="Opcional" maxlength="20"></label>
        <button class="btn primary big">Entrar y pedir</button>
      </form>
    </div>
  </main>`;
}

function renderHome() {
  const n = state.user.name;
  $('#app').innerHTML = `
  <header class="top"><div class="top-in">
    <div class="logo">ringcon<b>go</b></div>
    <button class="addr" data-act="addr"><span>📍</span><span><small>Enviar a</small><strong>${state.address ? esc(state.address.text) : 'Agrega tu dirección'}</strong></span><span>⌄</span></button>
    <button class="avatar" data-act="user" aria-label="Mi cuenta">${esc(n.trim()[0].toUpperCase())}</button>
  </div></header>
  <main class="wrap">
    <section class="hero">
      <p class="hello">Hola, <b>${esc(n)}</b> 👋</p>
      <h1>¿Qué se te antoja hoy?</h1>
      <div class="search"><input id="q" type="search" placeholder="Busca comida o restaurantes" value="${esc(state.q)}" aria-label="Buscar"></div>
      <p class="livep"><i class="dot off"></i><span id="drv-count"></span></p>
    </section>
    ${state.address ? '' : `<button class="promo" data-act="addr"><span class="em">📍</span><span><b>Dinos dónde entregar</b><small>Así vemos quién llega a tu puerta</small></span><span class="go">Agregar</span></button>`}
    <nav class="chips" aria-label="Categorías">${CATS.map(c => `<button class="chip ${c === state.cat ? 'on' : ''}" data-act="cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</nav>
    <section class="grid" id="biz-list"></section>
    <p class="foot" id="sync-chip"></p>
  </main>`;
  drawBiz();
}
function drawBiz() {
  const el = $('#biz-list'); if (!el) return;
  const q = state.q.trim().toLowerCase();
  const list = BUSINESSES.filter(b => (state.cat === 'Todo' || b.cat === state.cat) && (!q || (b.name + ' ' + b.cat + ' ' + b.menu.map(m => m.name).join(' ')).toLowerCase().includes(q)));
  el.innerHTML = list.length ? list.map(b => `
    <button class="card" data-act="open-biz" data-id="${b.id}">
      <div class="tile" style="--tile:${b.color}">${b.emoji}</div>
      <div class="card-b"><h3>${esc(b.name)}</h3>
        <div class="meta"><span>★ ${b.rating}</span><span>${esc(b.eta)}</span><span>Envío ${money(b.fee)}</span></div></div>
    </button>`).join('') : '<p class="empty">No encontramos nada. Prueba con otra búsqueda.</p>';
}

const ctl = it => {
  const q = state.cart.items[it.id] || 0;
  return q ? `<div class="qty"><button data-act="dec" data-id="${it.id}" aria-label="Quitar uno">−</button><span>${q}</span><button data-act="add" data-id="${it.id}" aria-label="Agregar uno">+</button></div>`
    : `<button class="add" data-act="add" data-id="${it.id}" aria-label="Agregar ${esc(it.name)}">+</button>`;
};
function renderBiz() {
  const b = biz(state.bizId);
  $('#app').innerHTML = `${hdr(b.name)}
  <main class="wrap narrow">
    <div class="biz-hero" style="--tile:${b.color}">${b.emoji}</div>
    <h1 class="biz-name">${esc(b.name)}</h1>
    <div class="meta"><span>★ ${b.rating}</span><span>${esc(b.cat)}</span><span>${esc(b.eta)}</span><span>Envío ${money(b.fee)}</span></div>
    <div class="menu">${b.menu.map(it => `
      <div class="item"><div class="em">${it.emoji}</div>
        <div class="tx"><b>${esc(it.name)}</b><small>${esc(it.desc)}</small><span class="pr">${money(it.price)}</span></div>
        <div id="ctl-${it.id}">${ctl(it)}</div></div>`).join('')}</div>
  </main>`;
}
function refreshCtls() { const b = biz(state.bizId); if (state.view === 'biz' && b) b.menu.forEach(it => { const e = $('#ctl-' + it.id); if (e) e.innerHTML = ctl(it); }); }

function renderOrders() {
  const list = mine();
  $('#app').innerHTML = `${hdr('Mis pedidos')}<main class="wrap narrow">${list.length ? list.map(o => `
    <button class="box ord" data-act="track" data-id="${o.id}">
      <b>${esc(o.business.emoji)} ${esc(o.business.name)}</b> <span class="badge ${o.status === 'cancelado' ? 'bad' : o.status === 'entregado' ? 'ok' : 'wait'}">${esc(statusInfo(o).t)}</span>
      <div class="meta"><span>#${code(o)}</span><span>${new Date(o.createdAt).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><span>${money(o.totals.total)}</span></div>
    </button>`).join('') : '<p class="empty">Aún no has hecho pedidos.</p>'}</main>`;
}

function renderTrack() {
  const o = Sync.get('orders', state.trackId);
  if (!o) { $('#app').innerHTML = hdr('Tu pedido') + '<main class="wrap narrow"><p class="empty">Cargando tu pedido…</p></main>'; return; }
  const s = statusInfo(o), n = onlineDrivers().length;
  const labels = ['Pedido enviado', 'Conductor asignado', 'En camino', 'Entregado'];
  const items = arr(o.items), t = o.totals;
  $('#app').innerHTML = `${hdr('Pedido #' + code(o))}
  <main class="wrap narrow">
    <section class="t-head"><small>${esc(o.business.emoji)} ${esc(o.business.name)}</small><h1>${esc(s.t)}</h1><small>${esc(s.s)}</small></section>
    ${o.status === 'cancelado' ? '' : `<div class="steps">${labels.map((l, k) => {
      const done = k < s.i || (o.status === 'entregado');
      const now = !done && k === s.i;
      return `<div class="step ${done ? 'done' : now ? 'now' : ''}"><i>${done ? '✓' : ''}</i><span>${l}</span></div>`;
    }).join('')}</div>`}
    ${o.status === 'nuevo' ? `<p class="box livep"><i class="dot ${n ? '' : 'off'}"></i>${n ? `${n} conductor${n > 1 ? 'es' : ''} en línea ya vieron tu pedido` : 'No hay conductores en línea ahora. Tu pedido queda en cola.'}</p>` : ''}
    ${o.driver ? `<div class="box drv"><div class="av">${esc(o.driver.name.trim()[0].toUpperCase())}</div><div><b>${esc(o.driver.name)}</b><small>${esc(o.driver.vehicle || 'Conductor')} · tu conductor</small></div>${o.driver.phone && o.status !== 'entregado' ? `<a class="icon-btn" href="tel:${esc(String(o.driver.phone).replace(/[^\d+]/g, ''))}" aria-label="Llamar">📞</a>` : ''}</div>` : ''}
    <div class="box">
      ${items.map(i => `<div class="tot"><span>${i.qty}× ${esc(i.name)}</span><span>${money(i.price * i.qty)}</span></div>`).join('')}
      <div class="tot"><span>Envío</span><span>${money(t.fee)}</span></div>
      <div class="tot"><span>Servicio</span><span>${money(t.service)}</span></div>
      <div class="tot"><span>Propina</span><span>${money(t.tip)}</span></div>
      <div class="tot big"><span>Total</span><span>${money(t.total)}</span></div>
      ${payBadge(o)}
    </div>
    <div class="box"><small class="meta">Entrega en</small><b>${esc(o.address.text)}</b>${o.address.ref ? `<div class="meta">${esc(o.address.ref)}</div>` : ''}</div>
    ${o.status === 'nuevo' ? `<button class="btn ghost big" data-act="cancel" data-id="${o.id}">Cancelar pedido</button>` : ''}
    ${['entregado', 'cancelado'].includes(o.status) ? '<button class="btn primary big" data-act="back">Hacer otro pedido</button>' : ''}
  </main>`;
}

function renderDock() {
  const d = $('#dock'); let h = '';
  const cnt = cartCount(), a = activeOrder();
  if (state.user && cnt && (state.view === 'home' || state.view === 'biz')) h += `<button class="bar cart" data-act="cart"><span><span class="n">${cnt}</span> Ver pedido</span><span>${money(totals().subtotal)}</span></button>`;
  if (a && state.view !== 'track') h += `<button class="bar trk" data-act="track" data-id="${a.id}"><span>${esc(a.business.emoji)}</span><span>${esc(statusInfo(a).t)}<small>Pedido #${code(a)}</small></span><span class="go">Ver</span></button>`;
  d.innerHTML = h;
}

function updateLive() {
  const n = onlineDrivers().length, el = $('#drv-count');
  if (el) {
    el.textContent = n ? `${n} conductor${n > 1 ? 'es' : ''} en línea ahora` : 'Sin conductores en línea ahora · tu pedido quedará en cola';
    const dot = el.previousElementSibling; if (dot) dot.classList.toggle('off', !n);
  }
}
function updateChip() {
  const el = $('#sync-chip'); if (!el) return;
  const s = Sync.status();
  el.textContent = s === 'live' ? 'Sincronización en vivo activa' : s === 'local' ? 'Modo demo local · conecta Firebase para tiempo real entre dispositivos' : s === 'offline' ? 'Sin conexión · reintentando…' : 'Conectando…';
}

/* ═══════════════ SHEETS ═══════════════ */
function openSheet(html, onOpen) {
  const r = $('#sheet-root'); clearTimeout(closeT);
  const was = r.classList.contains('open');
  r.innerHTML = `<div class="scrim" data-act="close"></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  document.body.classList.add('lock');
  if (!was) requestAnimationFrame(() => requestAnimationFrame(() => r.classList.add('open')));
  if (onOpen) onOpen();
}
function closeSheet() {
  const r = $('#sheet-root'); r.classList.remove('open'); document.body.classList.remove('lock');
  clearTimeout(closeT); closeT = setTimeout(() => { if (!r.classList.contains('open')) r.innerHTML = ''; }, 320);
}

const short = s => String(s || '').split(',').slice(0, 3).join(',').trim();
function openAddress() {
  geo = state.address && state.address.lat ? { lat: state.address.lat, lon: state.address.lon } : null;
  openSheet(`
    <div class="sheet-h"><h2>¿Dónde te lo llevamos?</h2><button class="icon-btn" data-act="close" aria-label="Cerrar">✕</button></div>
    <label class="field">Calle y número<input id="a-text" placeholder="Ej: Av. Libertador 1234" autocomplete="street-address" value="${esc(state.address ? state.address.text : '')}"></label>
    <div class="sug" id="a-sug"></div>
    <button class="btn ghost big" data-act="use-loc" style="margin-bottom:14px">📍 Usar mi ubicación actual</button>
    <label class="field">Piso, depto o referencias<input id="a-ref" placeholder="Ej: 3B, portón negro" value="${esc(state.address ? state.address.ref || '' : '')}"></label>
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
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=es&q=' + encodeURIComponent(q));
      sugN = await r.json();
      const b = $('#a-sug'); if (b) b.innerHTML = sugN.map((s, i) => `<button type="button" data-act="sug" data-i="${i}">📍 ${esc(short(s.display_name))}</button>`).join('');
    } catch { const b = $('#a-sug'); if (b) b.innerHTML = ''; }
  }, 700);
}

function openCheckout() {
  if (!cartCount()) return;
  if (!state.address) { state.returnToCheckout = true; toast('Primero dinos dónde entregar'); openAddress(); return; }
  const b = biz(state.cart.bizId);
  openSheet(`
    <div class="sheet-h"><h2>Tu pedido</h2><button class="icon-btn" data-act="close" aria-label="Cerrar">✕</button></div>
    <div class="meta"><span>${b.emoji} ${esc(b.name)}</span><span>${esc(b.eta)}</span></div>
    <div id="co-items"></div>
    <div class="co-addr"><span>📍</span><div><small>Entrega en</small><strong>${esc(state.address.text)}</strong>${state.address.ref ? `<small>${esc(state.address.ref)}</small>` : ''}</div><button class="link" data-act="addr">Cambiar</button></div>
    <label class="field">Notas para el local o el conductor<input id="co-notes" maxlength="140" placeholder="Ej: sin cebolla" value="${esc(state.notes)}"></label>
    <h3>Propina para el conductor</h3>
    <div class="tips" id="co-tips">${[0, 1, 2, 3].map(v => `<button class="pill" data-act="tip" data-v="${v}">${v ? money(v) : 'No'}</button>`).join('')}</div>
    <h3>¿Cómo pagas?</h3>
    <div class="methods" id="co-methods">
      <button class="method" data-act="method" data-m="tarjeta">💳 Tarjeta<small>Pago en línea</small></button>
      <button class="method" data-act="method" data-m="efectivo">💵 Efectivo<small>Pagas al recibir</small></button>
    </div>
    <div id="card-form">
      <label class="field">Número de tarjeta <i id="c-brand"></i><input id="c-num" inputmode="numeric" autocomplete="cc-number" placeholder="0000 0000 0000 0000" maxlength="23"></label>
      <div class="row2">
        <label class="field">Vence<input id="c-exp" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/AA" maxlength="5"></label>
        <label class="field">CVV<input id="c-cvv" type="password" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4"></label>
      </div>
      <label class="field">Nombre en la tarjeta<input id="c-name" autocomplete="cc-name" placeholder="Como aparece en la tarjeta"></label>
      ${CONFIG.PAYMENT_MODE === 'demo' ? '<p class="hint">Modo prueba: usa 4242 4242 4242 4242. Si termina en 0002 se rechaza.</p>' : ''}
    </div>
    <div id="cash-form" class="hide"><label class="field">¿Con cuánto pagas? <i>(opcional, para llevarte el cambio)</i><input id="co-cash" inputmode="decimal" placeholder="Ej: 50"></label></div>
    <div id="co-totals"></div>
    <button class="btn primary big" id="co-pay" data-act="place">Pedir ya</button>
    <p class="secure">🔒 Pago cifrado. No guardamos los datos de tu tarjeta.</p>`,
    () => { bindCard(); $('#co-notes').addEventListener('input', e => state.notes = e.target.value); drawCo(); });
}
function bindCard() {
  $('#c-num').addEventListener('input', e => { const v = e.target.value.replace(/\D/g, '').slice(0, 19); e.target.value = v.replace(/(.{4})/g, '$1 ').trim(); $('#c-brand').textContent = brandOf(v); });
  $('#c-exp').addEventListener('input', e => { let v = e.target.value.replace(/\D/g, '').slice(0, 4); if (v.length > 2) v = v.slice(0, 2) + '/' + v.slice(2); e.target.value = v; });
  $('#c-cvv').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
}
function drawCo() {
  if (!$('#co-items')) return;
  const lines = cartLines();
  if (!lines.length) { closeSheet(); renderDock(); return; }
  $('#co-items').innerHTML = lines.map(l => `<div class="line"><div class="tx"><b>${esc(l.name)}</b><div class="meta"><span>${money(l.price)}</span></div></div><div class="qty"><button data-act="co-dec" data-id="${l.id}" aria-label="Quitar uno">−</button><span>${l.qty}</span><button data-act="co-add" data-id="${l.id}" aria-label="Agregar uno">+</button></div></div>`).join('');
  const t = totals();
  $('#co-totals').innerHTML = `
    <div class="tot"><span>Productos</span><span>${money(t.subtotal)}</span></div>
    <div class="tot"><span>Envío</span><span>${money(t.fee)}</span></div>
    <div class="tot"><span>Servicio</span><span>${money(t.service)}</span></div>
    <div class="tot"><span>Propina</span><span>${money(t.tip)}</span></div>
    <div class="tot big"><span>Total</span><span>${money(t.total)}</span></div>`;
  $('#co-pay').textContent = `Pedir ya · ${money(t.total)}`;
  $$('#co-tips .pill').forEach(p => p.classList.toggle('on', +p.dataset.v === state.tip));
  $$('#co-methods .method').forEach(m => m.classList.toggle('on', m.dataset.m === state.method));
  $('#card-form').classList.toggle('hide', state.method !== 'tarjeta');
  $('#cash-form').classList.toggle('hide', state.method !== 'efectivo');
}

function validateCard() {
  const num = $('#c-num').value.replace(/\s/g, ''), exp = $('#c-exp').value, cvv = $('#c-cvv').value, name = $('#c-name').value.trim();
  if (!luhn(num)) return { ok: false, msg: 'Número de tarjeta inválido' };
  const m = /^(\d\d)\/(\d\d)$/.exec(exp);
  if (!m || +m[1] < 1 || +m[1] > 12) return { ok: false, msg: 'Fecha de vencimiento inválida' };
  if (new Date(2000 + Number(m[2]), Number(m[1]), 1) <= new Date()) return { ok: false, msg: 'La tarjeta está vencida' };
  if (!/^\d{3,4}$/.test(cvv)) return { ok: false, msg: 'CVV inválido' };
  if (name.length < 3) return { ok: false, msg: 'Escribe el nombre que aparece en la tarjeta' };
  return { ok: true, card: { number: num, brand: brandOf(num), name } };
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
  const b = biz(state.cart.bizId), t = totals(); let payment;
  if (state.method === 'tarjeta') {
    const v = validateCard(); if (!v.ok) { toast(v.msg, 'err'); return; }
    placing = true; showPay('Procesando tu pago…', 'No cierres esta pantalla');
    let res;
    try { res = await PaymentGateway.charge({ amount: t.total, card: v.card, onPhase: m => showPay(m, 'No cierres esta pantalla') }); }
    catch { res = { ok: false, msg: 'No pudimos procesar el pago. Intenta de nuevo.' }; }
    ['c-num', 'c-cvv', 'c-exp', 'c-name'].forEach(id => { const e = $('#' + id); if (e) e.value = ''; });  // nunca conservamos datos de tarjeta
    if (!res.ok) { placing = false; hidePay(); toast(res.msg, 'err'); return; }
    payment = { method: 'tarjeta', status: 'pagado', brand: res.brand, last4: res.last4, ref: res.ref };
    showPay('¡Pago aprobado!', 'Enviando tu pedido a los conductores…', true); await wait(700);
  } else {
    const raw = ($('#co-cash').value || '').replace(',', '.'), cash = raw ? Number(raw) : 0;
    if (raw && (!isFinite(cash) || cash < t.total)) { toast(`El monto debe cubrir el total (${money(t.total)})`, 'err'); return; }
    placing = true; showPay('Enviando tu pedido…', '');
    payment = { method: 'efectivo', status: 'pendiente' }; if (cash) payment.cashWith = cash;
  }
  const now = Date.now(), id = 'o' + now.toString(36) + rid();
  const order = {
    id, status: 'nuevo', createdAt: now, updatedAt: now, t_nuevo: now,
    customer: { id: state.user.id, name: state.user.name, phone: state.user.phone || '' },
    business: { id: b.id, name: b.name, emoji: b.emoji },
    items: lines.map(l => ({ name: l.name, qty: l.qty, price: l.price })),
    address: { text: state.address.text, ref: state.address.ref || '', ...(state.address.lat ? { lat: state.address.lat, lon: state.address.lon } : {}) },
    notes: state.notes.trim(), totals: t, driverPay: +(t.fee + t.tip).toFixed(2), payment
  };
  try { await Sync.patch('orders', id, order); }
  catch {
    placing = false; hidePay();
    toast(payment.method === 'tarjeta' ? `Pago aprobado (${payment.ref}) pero no se pudo enviar el pedido. Guarda esta referencia y contáctanos.` : 'No pudimos enviar tu pedido. Revisa tu conexión.', 'err'); return;
  }
  placing = false; state.cart = { bizId: null, items: {} }; state.notes = '';
  hidePay(); closeSheet(); go('track', id);
}

/* ═══════════════ ACCIONES ═══════════════ */
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
  logout: () => { if (activeOrder() && !confirm('Tienes un pedido en curso. ¿Cerrar sesión igual?')) return; store.del('rcg:customer'); state.user = null; state.cart = { bizId: null, items: {} }; state.view = 'home'; closeSheet(); render(); },
  cat: t => { state.cat = t.dataset.cat; $$('.chip').forEach(c => c.classList.toggle('on', c.dataset.cat === state.cat)); drawBiz(); },
  'open-biz': t => { state.bizId = t.dataset.id; go('biz'); },
  add: t => { if (addItem(state.bizId, t.dataset.id, 1)) { refreshCtls(); renderDock(); } },
  dec: t => { addItem(state.bizId, t.dataset.id, -1); refreshCtls(); renderDock(); },
  'co-add': t => { addItem(state.cart.bizId, t.dataset.id, 1); drawCo(); refreshCtls(); renderDock(); },
  'co-dec': t => { addItem(state.cart.bizId, t.dataset.id, -1); drawCo(); refreshCtls(); renderDock(); },
  cart: () => openCheckout(),
  tip: t => { state.tip = +t.dataset.v; drawCo(); },
  method: t => { state.method = t.dataset.m; drawCo(); },
  place: () => placeOrder(),
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
    }, () => { t.textContent = label; toast('No pudimos obtener tu ubicación. Escribe tu dirección.', 'err'); }, { enableHighAccuracy: true, timeout: 10000 });
  },
  'save-addr': () => {
    const text = $('#a-text').value.trim();
    if (text.length < 5) { toast('Escribe tu dirección completa', 'err'); return; }
    state.address = { text, ref: $('#a-ref').value.trim(), ...(geo || {}) };
    store.set('rcg:address', state.address);
    state.saved = [state.address, ...state.saved.filter(a => a.text !== text)].slice(0, 4);
    store.set('rcg:addresses', state.saved);
    closeSheet(); render();
    if (state.returnToCheckout) { state.returnToCheckout = false; setTimeout(openCheckout, 340); }
  },
  cancel: async t => {
    await Sync.refresh('orders');
    const o = Sync.get('orders', t.dataset.id);
    if (!o || o.status !== 'nuevo') { toast('Un conductor ya aceptó tu pedido; ya no se puede cancelar', 'err'); return; }
    if (!confirm('¿Cancelar este pedido?')) return;
    const now = Date.now(), p = { status: 'cancelado', updatedAt: now, t_cancelado: now, cancelledBy: 'cliente' };
    if (o.payment && o.payment.method === 'tarjeta') p.payment = { ...o.payment, status: 'reembolso' };
    try { await Sync.patch('orders', o.id, p); toast('Pedido cancelado'); } catch { toast('No pudimos cancelar. Intenta de nuevo.', 'err'); }
  }
};
document.addEventListener('click', e => { const t = e.target.closest('[data-act]'); if (!t) return; const f = A[t.dataset.act]; if (f) f(t, e); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#sheet-root').classList.contains('open')) closeSheet(); });
document.addEventListener('input', e => { if (e.target.id === 'q') { state.q = e.target.value; drawBiz(); } });
document.addEventListener('submit', e => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  const name = $('#l-name').value.trim().replace(/\s+/g, ' '), phone = $('#l-phone').value.trim();
  if (!name) return;
  state.user = { id: 'c' + hash(name.toLowerCase() + '|' + phone), name, phone };
  store.set('rcg:customer', state.user);
  render();
  if (!state.address) setTimeout(openAddress, 250);
});

/* ═══════════════ TIEMPO REAL ═══════════════ */
function onOrders(data) {
  state.orders = data || {};
  if (!state.user) return;
  mine().forEach(o => {
    const p = prev[o.id];
    if (p && p !== o.status) { toast(statusInfo(o).t); if (navigator.vibrate) navigator.vibrate(200); }
    prev[o.id] = o.status;
  });
  if (state.view === 'track') renderTrack(); else if (state.view === 'orders') renderOrders();
  renderDock();
}
function onDrivers(data) { state.drivers = data || {}; updateLive(); if (state.view === 'track') renderTrack(); }

Sync.subscribe('orders', onOrders);
Sync.subscribe('drivers', onDrivers);
Sync.onStatus(updateChip);
Sync.start();
setInterval(() => { updateLive(); }, 10000);
addEventListener('online', () => toast('Conexión recuperada'));
addEventListener('offline', () => toast('Sin conexión a internet', 'err'));
render();
})();
