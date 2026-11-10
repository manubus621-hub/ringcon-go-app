# Ringcon Go · App de clientes y API

Delivery para pueblos aislados que no tienen una app de delivery propia (hoy, Rincón de los Sauces, Neuquén).
Una sola app para todos los pueblos. HTML, CSS y JavaScript puro, con Firebase en el plan
gratuito (Auth y Realtime Database), una API en funciones de Vercel y cobros con Mercado Pago.

**Para dejarla operando, seguí [PUESTA-EN-MARCHA.md](PUESTA-EN-MARCHA.md).**

La app de conductores, el panel de cada local y el panel de administración están en
[ringcon-go-conductores](https://github.com/manubus621-hub/ringcon-go-conductores) y usan la API de este repo.

## Cómo está armada la seguridad

- **El navegador no decide nada que valga plata.** Los pedidos se crean en la API (`createOrder`),
  que toma los precios del catálogo en la base. El cliente solo manda qué productos y cuántos.
  Cada llamada lleva el token de Firebase del usuario y la API lo verifica.
- **Pagos con tarjeta por Mercado Pago (Card Payment Brick).** La tarjeta se carga en el formulario
  de Mercado Pago, que devuelve un token. `payOrder` cobra con el Access Token secreto, que vive solo
  en Vercel. El pedido les llega a los conductores recién cuando el pago queda `approved`.
  El webhook `/api/mp-webhook` verifica la firma y vuelve a consultar el pago a Mercado Pago.
- **Reembolso automático** si un pedido pagado se cancela.
- **Reglas de base de datos por rol:** cada cliente lee solo sus pedidos. Los conductores aprobados
  ven el tablero `openOrders`, sin teléfono ni datos del cliente, y el pedido completo solo cuando lo toman.
  El padrón, los conductores y las fotos de DNI son visibles solo para administradores.
- **Conductores verificados:** DNI en el padrón, apellido y fecha de nacimiento, fotos del DNI y
  selfie, y aprobación manual. Además hay límite de intentos por DNI y licencia vigente para ponerse en línea.

## Pueblos

La app es una sola y los pueblos son datos, no código. Hoy están Rincón de los Sauces (Neuquén) y Puerto Iguazú (Misiones).

- Cada pueblo tiene nombre, centro (latitud y longitud) y radio de entrega en km. Se cargan y editan en el panel
  admin, pestaña **Pueblos** (quedan en `towns/{id}`).
- Cada **local** pertenece a un pueblo. El pedido toma el pueblo del local y la API valida la dirección con el
  radio de ese pueblo; el navegador no decide el pueblo.
- Cada **conductor** tiene el pueblo que figura en el padrón y solo ve y toma pedidos de ese pueblo. La API lo
  vuelve a verificar al aceptar.
- El cliente elige su pueblo al entrar y puede cambiarlo arriba en la pantalla principal. La elección queda
  guardada en su teléfono.
- El radio es un círculo. En un pueblo de frontera (Puerto Iguazú) el círculo también cubre parte del país vecino:
  la búsqueda de direcciones solo sugiere direcciones de Argentina, pero "Usar mi ubicación actual" no distingue país.
  Una dirección escrita a mano, sin elegir una sugerencia, no tiene coordenadas y no pasa por el control de zona.

**Pasar a varios pueblos una base que ya tenía datos** (una sola vez, en un momento sin pedidos en curso):
1. Publicá las reglas nuevas: `cd firebase && firebase deploy --only database`, o pegá `firebase/database.rules.json`
   en Firebase Console → Realtime Database → Reglas → Publicar.
2. Publicá esta versión de la API y de las dos apps.
3. Panel admin → **Pueblos**: agregá Rincón de los Sauces (`-37.3906, -68.9298`, 15 km) y
   Puerto Iguazú (`-25.5978, -54.5736`, 10 km).
4. Panel admin → **Locales**: los locales anteriores aparecen con el aviso "Falta elegir pueblo". Editá cada uno,
   elegí el pueblo y guardá. Hasta entonces no se muestran a los clientes ni se pueden modificar.
5. Panel admin → **Padrón**: lo mismo con cada DNI. Si el conductor ya tenía cuenta, al guardar se actualiza sola.

## Puesta en marcha (una sola vez)

1. **Firebase Console** (proyecto `ringcon-go`, plan gratuito Spark):
   - Authentication → Método de acceso: activá **Anónimo** y **Correo/contraseña**.
   - Realtime Database en **Estados Unidos (us-central1)**: `https://ringcon-go-default-rtdb.firebaseio.com`.
   - Configuración del proyecto → **Cuentas de servicio** → **Generar nueva clave privada**.
     Se descarga un JSON: es secreto, no lo subas a GitHub ni lo compartas.
2. **Vercel** → tu proyecto de esta app → Settings → **Environment Variables**
   (para *Production* y *Preview*):

   | Variable | Valor |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT` | El contenido completo del JSON de la cuenta de servicio |
   | `FIREBASE_DATABASE_URL` | `https://ringcon-go-default-rtdb.firebaseio.com` |
   | `MP_ACCESS_TOKEN` | Access Token de Mercado Pago (de la misma app que la Public Key) |
   | `MP_WEBHOOK_SECRET` | Clave secreta de webhooks de Mercado Pago |
   | `PUBLIC_URL` | `https://ringcon-go.vercel.app` |
   | `MP_CLIENT_ID`, `MP_CLIENT_SECRET` | (opcional) Client ID y Client Secret de la aplicación de Mercado Pago. Activan el cobro dividido por local |
   | `MP_SPLIT_PUBLIC_KEY` | (opcional) `vendedor` si el formulario de tarjeta tiene que usar la Public Key del local |
   | `OPS_URL` | (opcional) dominio de la app de conductores, para los avisos push. Por defecto `https://ringcon-go-conductores.vercel.app` |

3. **Mercado Pago** → Tus integraciones → tu aplicación:
   - La **Public Key** va en `js/config.js` (`MP_PUBLIC_KEY`).
   - En **Webhooks**, configurá `https://ringcon-go.vercel.app/api/mp-webhook` con el evento *Pagos*
     y copiá la clave secreta en `MP_WEBHOOK_SECRET`.
4. **Reglas de la base:** `cd firebase && firebase deploy --only database`.
5. **Pueblos y catálogo de ejemplo** (solo en una base vacía): Realtime Database → ⋮ → Importar JSON en la raíz con
   `firebase/seed/catalog.json`. Importar en la raíz reemplaza todo lo que haya: en una base con datos no lo uses y
   cargá los pueblos y locales desde el panel admin. Los precios están en pesos.
6. **Usuario administrador:** en Authentication creá un usuario con email y contraseña, copiá su UID
   y en la base agregá `admins/<UID> = true`. Con ese usuario entrás a `admin.html` de la app de conductores.

Después de cambiar variables en Vercel hay que volver a desplegar (Deployments → ⋯ → Redeploy).

## Estructura

```
index.html            HTML principal (CSP, manifest)
css/app.css           Estilos
js/config.js          Configuración pública (Firebase, API y Public Key MP)
js/app.js             Lógica de la app
sw.js, manifest.webmanifest, icon.svg   PWA / APK
api/call.js           POST /api/call {fn, data}: pedidos, pagos y conductores
api/mp-webhook.js     Notificaciones de Mercado Pago
api/mp-oauth.js       Vuelta de Mercado Pago cuando un local autoriza el cobro en su cuenta
server/backend.js     Lógica del backend (Firebase Admin)
firebase/
  database.rules.json   Reglas de Realtime Database
  seed/catalog.json     Catálogo inicial
```

Estados de un pedido: `pago_pendiente` → `nuevo` → `aceptado` → `en_local` → `recogido` → `entregado`
(o `cancelado`). Los pedidos con tarjeta que no se pagan en 30 minutos se cancelan solos.

## Local, pagos y avisos

- **Panel del local.** Si un local tiene cuentas de acceso (`bizUsers/`), cada pedido nace con `kitchen: pendiente`
  y lo tiene que aceptar: `pendiente` → `aceptado` → `preparando` → `listo` (o `rechazado`). Los conductores lo ven
  recién desde `aceptado`. Sin respuesta en 10 minutos se cancela solo (`sin_respuesta`) y se devuelve el pago.
  El local lee `bizOrders/{local}`, una copia del pedido sin teléfono ni dirección del cliente.
- **Cobro dividido.** Con `MP_CLIENT_ID` y `MP_CLIENT_SECRET`, cada local autoriza una vez por OAuth y sus
  credenciales quedan en `mpSellers/` (solo servidor). El pago se crea con el token del local y
  `application_fee` = comisión + envío + propina, que Mercado Pago acredita a la plataforma. Solo ofrecen tarjeta
  los locales conectados. Sin esas variables todo sigue como antes: cobra la cuenta de la plataforma.
- **Saldo de conductores.** Mercado Pago divide un pago solo entre dos cuentas, así que la parte del conductor en
  pedidos con tarjeta queda en `settlements/` como `fromPlatform`, contra lo que rinde por efectivo
  (`toPlatform`). El admin liquida desde la pestaña Liquidaciones (`payouts/`).
- **Avisos push.** Con `VAPID_KEY` en `js/config.js`, el servidor avisa por Firebase Cloud Messaging al local, a
  los conductores en línea del pueblo y al cliente según el momento del pedido. Los tokens quedan en `pushTokens/`
  (solo servidor).

> El plan Hobby de Vercel es para uso no comercial. Sirve para lanzar y probar; cuando la app
> empiece a facturar, conviene pasar a Vercel Pro.

## App para Android (APK)

1. Entrá a https://www.pwabuilder.com, pegá `https://ringcon-go.vercel.app` y tocá **Start**.
2. **Package for stores** → **Android** → **Generate Package**. Para instalarla directo en teléfonos usá el
   **APK de prueba**; para publicarla en Google Play, el **AAB**.
3. Guardá bien el archivo de firma (`signing.keystore`) y sus claves: los vas a necesitar para cada actualización.

La app usa el manifest, el service worker y los íconos de `icons/`, así que las actualizaciones de la web
llegan solas a la app instalada.
