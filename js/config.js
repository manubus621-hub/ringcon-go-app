/* Configuración pública (no hay secretos acá: la seguridad la ponen las reglas y las Cloud Functions).
   Copiá los valores de Firebase Console → Configuración del proyecto → Tus apps → App web.
   Tiene que ser IGUAL en la app de clientes y en la de conductores. */
export const FIREBASE = {
  apiKey: 'COMPLETAR',
  authDomain: 'ringcon-go-e7f62.firebaseapp.com',
  databaseURL: 'https://ringcon-go-e7f62-default-rtdb.firebaseio.com',
  projectId: 'ringcon-go-e7f62',
  storageBucket: 'ringcon-go-e7f62.appspot.com',
  appId: 'COMPLETAR'
};
export const REGION = 'us-central1';

// Mercado Pago → Tus integraciones → Credenciales → Public Key (empieza con APP_USR- o TEST-).
export const MP_PUBLIC_KEY = 'COMPLETAR';
