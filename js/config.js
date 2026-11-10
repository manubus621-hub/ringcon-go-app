/* Configuración pública (no hay secretos acá: la seguridad la ponen las reglas y las Cloud Functions).
   Copiá los valores de Firebase Console → Configuración del proyecto → Tus apps → App web.
   Tiene que ser IGUAL en la app de clientes y en la de conductores. */
export const FIREBASE = {
  apiKey: 'AIzaSyDKrQcRn5zbW9VDiGBsgdAh6UlbOGAP4Ps',
  authDomain: 'ringcon-go.firebaseapp.com',
  databaseURL: 'https://ringcon-go-default-rtdb.firebaseio.com',
  projectId: 'ringcon-go',
  storageBucket: 'ringcon-go.firebasestorage.app',
  messagingSenderId: '868935005608',
  appId: '1:868935005608:web:82b9d581ffeaf689f2d99d'
};
// Dónde corre la API (funciones de Vercel del repo ringcon-go-app). Vacío = mismo dominio que la app.
export const API_URL = '';

// Mercado Pago → Tus integraciones → Credenciales → Public Key (empieza con APP_USR- o TEST-).
export const MP_PUBLIC_KEY = 'APP_USR-bf311144-d518-472b-b4f4-9542b16b9392';

// Avisos push: Firebase Console → Configuración del proyecto → Cloud Messaging → Certificados push web → Generar par de claves.
// Pegá acá la clave (empieza con B). Mientras diga COMPLETAR, los avisos push quedan apagados.
export const VAPID_KEY = 'COMPLETAR';
