document.addEventListener('DOMContentLoaded', () => {
  const NUMERO_WHATSAPP = "5491100000000"; // Reemplazar con tu número real (formato internacional)
  let carrito = {};

  // 1. Manejo de selectores de cantidad en las tarjetas
  document.querySelectorAll('.card').forEach(card => {
    const btnMinus = card.querySelector('[data-action="minus"]');
    const btnPlus = card.querySelector('[data-action="plus"]');
    const qtyValue = card.querySelector('.qty__value');
    const subtotalEl = card.querySelector('[data-subtotal]');
    const btnAdd = card.querySelector('[data-action="add"]');

    const price = parseFloat(card.dataset.price);
    let qty = 1;

    function updateCard() {
      qtyValue.textContent = qty;
      const subtotal = price * qty;
      subtotalEl.textContent = `$${subtotal.toLocaleString('es-AR')}`;
    }

    btnMinus.addEventListener('click', () => {
      if (qty > 1) {
        qty--;
        updateCard();
      }
    });

    btnPlus.addEventListener('click', () => {
      qty++;
      updateCard();
    });

    btnAdd.addEventListener('click', () => {
      const id = card.dataset.id;
      const name = card.dataset.name;

      if (carrito[id]) {
        carrito[id].cantidad += qty;
      } else {
        carrito[id] = {
          nombre: name,
          precio: price,
          cantidad: qty
        };
      }

      // Resetear la tarjeta a 1
      qty = 1;
      updateCard();

      // Renderizar carrito
      renderCart();
    });
  });

  // 2. Renderizar el carrito de compras
  function renderCart() {
    const cartList = document.getElementById('cart-items');
    const cartTotal = document.getElementById('cart-total');

    cartList.innerHTML = '';
    let total = 0;
    const items = Object.keys(carrito);

    if (items.length === 0) {
      cartList.innerHTML = '<li>Tu carrito está vacío.</li>';
      cartTotal.textContent = '$0';
      return;
    }

    items.forEach(id => {
      const item = carrito[id];
      const subtotal = item.precio * item.cantidad;
      total += subtotal;

      const li = document.createElement('li');
      li.className = 'cart__item';
      li.innerHTML = `
        <span>${item.cantidad}x ${item.nombre}</span>
        <span>$${subtotal.toLocaleString('es-AR')}</span>
        <button type="button" class="cart__btn-remove" data-id="${id}">✕</button>
      `;

      cartList.appendChild(li);
    });

    cartTotal.textContent = `$${total.toLocaleString('es-AR')}`;

    // Evento para eliminar ítems
    cartList.querySelectorAll('.cart__btn-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idToRemove = e.target.dataset.id;
        delete carrito[idToRemove];
        renderCart();
      });
    });
  }

  // 3. Envío del pedido a WhatsApp
  document.getElementById('btn-whatsapp').addEventListener('click', () => {
    const items = Object.keys(carrito);
    if (items.length === 0) {
      alert('Tu carrito está vacío. Agrega algún producto antes de pedir.');
      return;
    }

    let mensaje = "¡Hola! Quisiera realizar el siguiente pedido en *Ringcon Go*:\n\n";
    let total = 0;

    items.forEach(id => {
      const item = carrito[id];
      const subtotal = item.precio * item.cantidad;
      total += subtotal;
      mensaje += `• ${item.cantidad}x ${item.nombre} - $${subtotal.toLocaleString('es-AR')}\n`;
    });

    mensaje += `\n*Total:* $${total.toLocaleString('es-AR')}`;

    const url = `https://wa.me/${NUMERO_WHATSAPP}?text=${encodeURIComponent(mensaje)}`;
    window.open(url, '_blank');
  });

  // Inicializar estado del carrito
  renderCart();
});
