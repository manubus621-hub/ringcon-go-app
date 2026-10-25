// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDGdMSsEi8Vx4sR8-SvTpZ3DTfDoryLyzs",
  authDomain: "ringcon-go-e7f62.firebaseapp.com",
  projectId: "ringcon-go-e7f62",
  storageBucket: "ringcon-go-e7f62.firebasestorage.app",
  messagingSenderId: "1020050374581",
  appId: "1:1020050374581:web:c44865aa4d2067a47ae3fc",
  measurementId: "G-GQL5L8Z7TT"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
document.addEventListener('DOMContentLoaded', () => {
  let carrito = {};
  let currentProductBeingEdited = null;
  let tempExtraQty = 1;

  // --- CONTROL DE VISTAS ---
  function switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    window.scrollTo(0, 0);
  }

  // --- VISTA 1: CATALOGO Y CARRITO ---
  document.querySelectorAll('.card').forEach(card => {
    const btnSelect = card.querySelector('[data-action="select-item"]');
    
    btnSelect.addEventListener('click', () => {
      currentProductBeingEdited = {
        id: card.dataset.id,
        name: card.dataset.name,
        basePrice: parseFloat(card.dataset.price)
      };
      tempExtraQty = 1;
      document.getElementById('extras-product-name').textContent = currentProductBeingEdited.name;
      document.getElementById('extra-qty').textContent = tempExtraQty;
      
      // Limpiar checkboxes previos
      document.querySelectorAll('input[name="extra"]').forEach(chk => chk.checked = false);

      // Cambiar a la vista de extras
      switchView('view-extras');
    });
  });

  // --- VISTA 2: EXTRAS ---
  document.getElementById('extra-plus').addEventListener('click', () => {
    tempExtraQty++;
    document.getElementById('extra-qty').textContent = tempExtraQty;
  });

  document.getElementById('extra-minus').addEventListener('click', () => {
    if (tempExtraQty > 1) {
      tempExtraQty--;
      document.getElementById('extra-qty').textContent = tempExtraQty;
    }
  });

  document.getElementById('btn-cancel-extras').addEventListener('click', () => {
    switchView('view-catalog');
  });

  document.getElementById('btn-confirm-extras').addEventListener('click', () => {
    if (!currentProductBeingEdited) return;

    let unitPrice = currentProductBeingEdited.basePrice;
    let selectedExtrasText = [];

    document.querySelectorAll('input[name="extra"]:checked').forEach(chk => {
      unitPrice += parseFloat(chk.dataset.price);
      selectedExtrasText.push(chk.value);
    });

    const cartKey = `${currentProductBeingEdited.id}-${selectedExtrasText.join('-')}`;
    const displayName = selectedExtrasText.length > 0 
      ? `${currentProductBeingEdited.name} (${selectedExtrasText.join(', ')})` 
      : currentProductBeingEdited.name;

    if (carrito[cartKey]) {
      carrito[cartKey].cantidad += tempExtraQty;
    } else {
      carrito[cartKey] = {
        nombre: displayName,
        precio: unitPrice,
        cantidad: tempExtraQty
      };
    }

    renderCart();
    switchView('view-catalog');
  });

  // Renderizar Carrito
  function renderCart() {
    const cartList = document.getElementById('cart-items');
    const cartTotal = document.getElementById('cart-total');
    cartList.innerHTML = '';
    let total = 0;
    const keys = Object.keys(carrito);

    if (keys.length === 0) {
      cartList.innerHTML = '<li>Tu carrito está vacío.</li>';
      cartTotal.textContent = '$0';
      return;
    }

    keys.forEach(key => {
      const item = carrito[key];
      const subtotal = item.precio * item.cantidad;
      total += subtotal;

      const li = document.createElement('li');
      li.className = 'cart__item';
      li.innerHTML = `
        <span>${item.cantidad}x ${item.nombre}</span>
        <span>$${subtotal.toLocaleString('es-AR')}</span>
        <button type="button" data-key="${key}" style="background:none; border:none; color:red; cursor:pointer;">✕</button>
      `;
      cartList.appendChild(li);
    });

    cartTotal.textContent = `$${total.toLocaleString('es-AR')}`;

    // Eliminar ítem del carrito
    cartList.querySelectorAll('button[data-key]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        delete carrito[e.target.dataset.key];
        renderCart();
      });
    });
  }

  // Botón Terminar Pedido -> Ir al Checkout
  document.getElementById('btn-terminar').addEventListener('click', () => {
    if (Object.keys(carrito).length === 0) {
      alert('Tu carrito está vacío.');
      return;
    }
    checkSavedCard();
    switchView('view-checkout');
  });

  document.getElementById('btn-back-to-cart').addEventListener('click', () => {
    switchView('view-catalog');
  });

  // --- VISTA 3: TARJETA Y PAGO ---
  function checkSavedCard() {
    const savedCard = localStorage.getItem('ringcon_card');
    const container = document.getElementById('saved-card-container');
    const form = document.getElementById('new-card-form');

    if (savedCard) {
      const cardData = JSON.parse(savedCard);
      document.getElementById('saved-card-info').textContent = `Terminada en **** ${cardData.number.slice(-4)}`;
      container.style.display = 'block';
      form.style.display = 'none';
    } else {
      container.style.display = 'none';
      form.style.display = 'block';
    }
  }

  document.getElementById('link-change-card').addEventListener('click', (e) => {
    e.preventDefault();
    localStorage.removeItem('ringcon_card');
    document.getElementById('saved-card-container').style.display = 'none';
    document.getElementById('new-card-form').style.display = 'block';
  });

  // Guardar nueva tarjeta
  document.getElementById('card-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const number = document.getElementById('card-number').value;
    const name = document.getElementById('card-name').value;

    const cardData = { number, name };
    localStorage.setItem('ringcon_card', JSON.stringify(cardData));

    alert('¡Tarjeta guardada y pago exitoso! Gracias por tu pedido.');
    carrito = {};
    renderCart();
    switchView('view-catalog');
  });

  // Pagar con tarjeta ya guardada
  document.getElementById('btn-pay-saved').addEventListener('click', () => {
    alert('¡Pago procesado con éxito usando tu tarjeta guardada! Tu pedido está en camino.');
    carrito = {};
    renderCart();
    switchView('view-catalog');
  });

});
