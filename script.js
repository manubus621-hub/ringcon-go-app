/* ==========================================================
   Ringcon Go - script.js
   Interacción del menú: cantidades, extras, total en vivo
   y envío del pedido por WhatsApp.
   ========================================================== */

/* ----------------------------------------------------------
   1) CONFIGURACIÓN (lo único que necesitás tocar normalmente)
   ---------------------------------------------------------- */

// Número de WhatsApp del local: formato internacional, SOLO números,
// sin "+", espacios ni guiones. Ej. Argentina (celular): 549 + código de área + número.
const WHATSAPP_NUMBER = "5491100000000";

// Símbolo y formato de moneda.
const CURRENCY_SYMBOL = "$";
const LOCALE = "es-AR"; // define los separadores de miles (9.500)

// Texto que se agrega al final del mensaje para que el cliente complete su dirección.
const ADDRESS_PLACEHOLDER = "[escribí tu dirección acá]";

/* ----------------------------------------------------------
   2) PRODUCTOS
   - price: precio base por unidad (número, sin símbolo ni puntos)
   - extras: opciones elegibles. price 0 = sin costo (aclaración)
   ---------------------------------------------------------- */
const PRODUCTS = [
  {
    id: "doble-smash",
    name: "Doble Smash Burger",
    description: "Dos medallones smash, cheddar fundido, pickles y salsa de la casa en pan brioche.",
    price: 9500,
    image: "images/v2_3578.png",
    extras: [
      { id: "extra-cheddar", label: "Extra cheddar", price: 800 },
      { id: "extra-bacon", label: "Extra bacon", price: 1200 },
      { id: "sin-cebolla", label: "Sin cebolla", price: 0 },
      { id: "sin-pickles", label: "Sin pickles", price: 0 },
    ],
  },
  {
    id: "pizza-muzza-aceitunas",
    name: "Pizza Muzzarella & Aceitunas",
    description: "Masa de fermentación lenta, mucho queso, aceitunas negras y orégano.",
    price: 11200,
    image: "images/v2_3579.png",
    extras: [
      { id: "extra-muzza", label: "Extra muzzarella", price: 1500 },
      { id: "sin-aceitunas", label: "Sin aceitunas", price: 0 },
      { id: "con-picante", label: "Con ají picante", price: 0 },
    ],
  },
  {
    id: "empanadas-carne",
    name: "Empanadas de carne",
    description: "Horneadas, con repulgue clásico y chimichurri casero para acompañar. Precio por unidad.",
    price: 2400,
    image: "images/v2_3580.png",
    extras: [
      { id: "extra-chimi", label: "Chimichurri extra", price: 500 },
      { id: "sin-aceituna", label: "Sin aceituna", price: 0 },
    ],
  },
  {
    id: "papas-rusticas",
    name: "Papas rústicas",
    description: "Gajos dorados con sal en escamas, romero y alioli de pimentón.",
    price: 4800,
    image: "images/v2_3581.png",
    extras: [
      { id: "extra-alioli", label: "Alioli extra", price: 600 },
      { id: "con-cheddar", label: "Con cheddar y bacon", price: 1800 },
    ],
  },
  {
    id: "smash-cebolla",
    name: "Smash Cebolla Crispy",
    description: "Doble carne, cheddar, pickles y cebolla picada fresca. Un clásico renovado.",
    price: 9900,
    image: "images/v2_3582.png",
    extras: [
      { id: "extra-cheddar", label: "Extra cheddar", price: 800 },
      { id: "sin-cebolla", label: "Sin cebolla", price: 0 },
      { id: "extra-carne", label: "Medallón extra", price: 2500 },
    ],
  },
  {
    id: "smash-clasica",
    name: "Smash Clásica",
    description: "Doble carne, cheddar, lechuga, pickles y salsa rosa, con papas rústicas.",
    price: 9200,
    image: "images/v2_3583.png",
    extras: [
      { id: "extra-cheddar", label: "Extra cheddar", price: 800 },
      { id: "sin-lechuga", label: "Sin lechuga", price: 0 },
      { id: "sin-salsa", label: "Sin salsa rosa", price: 0 },
    ],
  },
];

/* ----------------------------------------------------------
   3) UTILIDADES
   ---------------------------------------------------------- */

// Formatea un número como moneda: 9500 -> "$9.500"
function formatMoney(amount) {
  return CURRENCY_SYMBOL + amount.toLocaleString(LOCALE);
}

// Busca un producto por su id.
function getProduct(id) {
  return PRODUCTS.find((p) => p.id === id);
}

/* ----------------------------------------------------------
   4) ESTADO DE CADA TARJETA
   Guardamos, por producto, la cantidad y los extras elegidos.
   ---------------------------------------------------------- */
const state = {};

PRODUCTS.forEach((product) => {
  state[product.id] = { qty: 1, extras: new Set() };
});

// Precio de UNA unidad = base + extras seleccionados.
function getUnitPrice(product) {
  const extrasTotal = product.extras
    .filter((extra) => state[product.id].extras.has(extra.id))
    .reduce((sum, extra) => sum + extra.price, 0);
  return product.price + extrasTotal;
}

// Total = (base + extras) x cantidad.
function getTotal(product) {
  return getUnitPrice(product) * state[product.id].qty;
}

/* ----------------------------------------------------------
   5) RENDER DEL MENÚ
   Genera las tarjetas dentro de <div id="menu-grid">.
   ---------------------------------------------------------- */
function renderMenu() {
  const grid = document.getElementById("menu-grid");
  if (!grid) return; // esta página no tiene menú

  grid.innerHTML = PRODUCTS.map(
    (product) => `
    <article class="card" data-id="${product.id}">
      <img src="${product.image}" alt="${product.name}">
      <div class="card__body">
        <h3>${product.name}</h3>
        <p>${product.description}</p>
        <span class="price">${formatMoney(product.price)}</span>

        <fieldset class="extras">
          <legend>Opciones y extras</legend>
          ${product.extras
            .map(
              (extra) => `
            <label class="extra">
              <input type="checkbox" data-extra="${extra.id}">
              <span class="extra__name">${extra.label}</span>
              <span class="extra__price">${extra.price > 0 ? "+" + formatMoney(extra.price) : "Gratis"}</span>
            </label>`
            )
            .join("")}
        </fieldset>

        <div class="qty" aria-label="Cantidad">
          <button type="button" class="qty__btn" data-action="minus" aria-label="Restar una unidad">−</button>
          <span class="qty__value" aria-live="polite">1</span>
          <button type="button" class="qty__btn" data-action="plus" aria-label="Sumar una unidad">+</button>
        </div>

        <button type="button" class="btn btn--order" data-action="order">
          Pedir ahora · <span class="order-total">${formatMoney(product.price)}</span>
        </button>
      </div>
    </article>`
  ).join("");
}

// Refresca en pantalla la cantidad y el total de UNA tarjeta.
function updateCard(card) {
  const product = getProduct(card.dataset.id);
  card.querySelector(".qty__value").textContent = state[product.id].qty;
  card.querySelector(".order-total").textContent = formatMoney(getTotal(product));
}

/* ----------------------------------------------------------
   6) WHATSAPP
   ---------------------------------------------------------- */
function buildWhatsAppMessage(product) {
  const { qty, extras } = state[product.id];

  // Lista de opciones elegidas (con su costo si lo tiene).
  const chosen = product.extras
    .filter((extra) => extras.has(extra.id))
    .map((extra) => (extra.price > 0 ? `${extra.label} (+${formatMoney(extra.price)})` : extra.label));

  const options = chosen.length ? chosen.join(", ") : "Sin opciones adicionales";

  return [
    "¡Hola! Quiero hacer un pedido en Ringcon Go:",
    `- Producto: ${product.name}`,
    `- Opciones: ${options}`,
    `- Cantidad: ${qty}`,
    `- Total: ${formatMoney(getTotal(product))}`,
    "",
    `Dirección de entrega: ${ADDRESS_PLACEHOLDER}`,
  ].join("\n");
}

function sendToWhatsApp(product) {
  const message = buildWhatsAppMessage(product);
  const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
  // Abre WhatsApp Web (computadora) o la app (celular) en una pestaña nueva.
  window.open(url, "_blank", "noopener");
}

/* ----------------------------------------------------------
   7) EVENTOS (delegación: un solo listener para todo el menú)
   ---------------------------------------------------------- */
function setupEvents() {
  const grid = document.getElementById("menu-grid");
  if (!grid) return;

  // Clicks: botones +, − y "Pedir ahora"
  grid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    const card = button.closest(".card");
    const product = getProduct(card.dataset.id);
    const action = button.dataset.action;

    if (action === "plus") {
      state[product.id].qty += 1;
    } else if (action === "minus") {
      // La cantidad mínima es 1.
      state[product.id].qty = Math.max(1, state[product.id].qty - 1);
    } else if (action === "order") {
      sendToWhatsApp(product);
      return;
    }

    updateCard(card);
  });

  // Cambios: checkboxes de extras
  grid.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-extra]");
    if (!checkbox) return;

    const card = checkbox.closest(".card");
    const product = getProduct(card.dataset.id);
    const extraId = checkbox.dataset.extra;

    if (checkbox.checked) {
      state[product.id].extras.add(extraId);
    } else {
      state[product.id].extras.delete(extraId);
    }

    updateCard(card);
  });
}

/* ----------------------------------------------------------
   8) INICIO
   ---------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  renderMenu();
  setupEvents();
});
