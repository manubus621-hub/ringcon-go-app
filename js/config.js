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
export const REGION = 'us-central1';

// Mercado Pago → Tus integraciones → Credenciales → Public Key (empieza con APP_USR- o TEST-).
export const MP_PUBLIC_KEY = 'COMPLETAR';
