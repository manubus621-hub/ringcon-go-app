// ==========================================
// RINCÓN GO DELIVERY - LÓGICA PRINCIPAL
// ==========================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, query, where, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Configuración de Firebase (Tus credenciales reales)
const firebaseConfig = {
    apiKey: "AIzaSyDKrQcRn5zbW9VD1GBsgdAh6U1bOG...",
    authDomain: "ringcon-go.firebaseapp.com",
    projectId: "ringcon-go",
    storageBucket: "ringcon-go.firebasestorage.app",
    messagingSenderId: "868935005608",
    appId: "1:868935005608:web:82b9d581ffeaf689f2d99d",
    measurementId: "G-E628RBVYP"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Referencias del DOM
const authScreen = document.getElementById('auth-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const btnIngresar = document.getElementById('btn-ingresar');
const btnLogout = document.getElementById('btn-logout');
const btnCrearPedido = document.getElementById('btn-crear-pedido');
const inputNombre = document.getElementById('input-nombre');
const inputDireccion = document.getElementById('input-direccion');
const inputDescripcion = document.getElementById('input-descripcion');
const inputPrecio = document.getElementById('input-precio'); // Opcional si agregas campo de costo/precio
const clientNameDisplay = document.getElementById('client-name-display');
const clientAddressDisplay = document.getElementById('client-address-display');
const listaPedidos = document.getElementById('lista-pedidos');

let unsubscribeOrders = null;
let clienteActual = null;

// Formateador de moneda para Pesos Argentinos (ARS)
const formatearARS = (monto) => {
    return new Intl.NumberFormat('es-AR', {
        style: 'currency',
        currency: 'ARS',
        minimumFractionDigits: 0
    }).format(monto || 0);
};

// Comprobar sesión guardada en localStorage
const sessionGuardada = localStorage.getItem('ringcon_client_session');
if (sessionGuardada) {
    try {
        clienteActual = JSON.parse(sessionGuardada);
        if (clienteActual && clienteActual.nombre) {
            iniciarPanel(clienteActual);
        }
    } catch (e) {
        localStorage.removeItem('ringcon_client_session');
    }
}

// Botón de Ingreso
if (btnIngresar) {
    btnIngresar.addEventListener('click', () => {
        const nombre = inputNombre.value.trim();
        const direccion = inputDireccion.value.trim();

        if (!nombre || !direccion) {
            alert("Por favor completa tu nombre y dirección.");
            return;
        }

        clienteActual = { nombre, direccion };
        localStorage.setItem('ringcon_client_session', JSON.stringify(clienteActual));
        iniciarPanel(clienteActual);
    });
}

// Botón de Cerrar Sesión / Cambiar Datos
if (btnLogout) {
    btnLogout.addEventListener('click', () => {
        localStorage.removeItem('ringcon_client_session');
        if (unsubscribeOrders) unsubscribeOrders();
        dashboardScreen.style.display = 'none';
        authScreen.style.display = 'flex';
        inputNombre.value = '';
        inputDireccion.value = '';
    });
}

function iniciarPanel(datos) {
    authScreen.style.display = 'none';
    dashboardScreen.style.display = 'block';

    clientNameDisplay.textContent = datos.nombre;
    clientAddressDisplay.textContent = datos.direccion;

    escucharMisPedidos(datos.nombre);
}

// Crear un pedido nuevo en Firestore
if (btnCrearPedido) {
    btnCrearPedido.addEventListener('click', async () => {
        const descripcion = inputDescripcion.value.trim();
        if (!descripcion) {
            alert("Por favor escribe qué deseas pedir o enviar.");
            return;
        }

        try {
            await addDoc(collection(db, "ordenes"), {
                cliente: clienteActual.nombre,
                direccion: clienteActual.direccion,
                descripcion: descripcion,
                estado: "PENDIENTE",
                createdAt: serverTimestamp()
            });

            inputDescripcion.value = "";
            alert("¡Pedido realizado con éxito!");
        } catch (e) {
            console.error("Error al crear pedido:", e);
            alert("No se pudo enviar el pedido. Revisa la consola.");
        }
    });
}

// Escuchar los pedidos del cliente en tiempo real
function escucharMisPedidos(nombreCliente) {
    const q = query(collection(db, "ordenes"), where("cliente", "==", nombreCliente));

    unsubscribeOrders = onSnapshot(q, (querySnapshot) => {
        listaPedidos.innerHTML = "";

        if (querySnapshot.empty) {
            listaPedidos.innerHTML = '<div class="empty-state">No tienes pedidos activos en este momento.</div>';
            return;
        }

        querySnapshot.forEach((docSnap) => {
            const pedido = docSnap.data();
            const idPedido = docSnap.id;
            const estado = pedido.estado || "PENDIENTE";

            const badgeClass = estado === "PENDIENTE" ? "badge-pending" : "badge-camino";
            const badgeText = estado === "PENDIENTE" ? "PENDIENTE" : "EN CAMINO";

            const card = document.createElement("div");
            card.className = "order-card";
            card.innerHTML = `
                <div class="order-header">
                    <span class="order-id">Orden #${idPedido.substring(0, 8)}</span>
                    <span class="${badgeClass}">${badgeText}</span>
                </div>
                <div class="order-details">
                    <p><strong>Pedido:</strong> ${pedido.descripcion}</p>
                    <p><strong>Destino:</strong> ${pedido.direccion}</p>
                    ${pedido.conductor ? `<p style="margin-top: 6px; color: #10b981;"><strong>Conductor asignado:</strong> ${pedido.conductor}</p>` : ''}
                </div>
            `;
            listaPedidos.appendChild(card);
        });
    }, (error) => {
        console.error("Error al escuchar pedidos:", error);
    });
}
