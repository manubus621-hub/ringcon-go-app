# Ringcon Go · App de clientes y API

Delivery para Rincón de los Sauces (Neuquén). HTML, CSS y JavaScript puro, con Firebase en el plan
gratuito (Auth y Realtime Database), una API en funciones de Vercel y cobros con Mercado Pago.

La app de conductores y el panel de administración están en
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

3. **Mercado Pago** → Tus integraciones → tu aplicación:
   - La **Public Key** va en `js/config.js` (`MP_PUBLIC_KEY`).
   - En **Webhooks**, configurá `https://ringcon-go.vercel.app/api/mp-webhook` con el evento *Pagos*
     y copiá la clave secreta en `MP_WEBHOOK_SECRET`.
4. **Reglas de la base:** `cd firebase && firebase deploy --only database`.
5. **Catálogo:** `firebase database:set /catalog` con el contenido de `catalog` en `firebase/seed/catalog.json`,
   o Realtime Database → ⋮ → Importar JSON en la raíz. Los precios están en pesos.
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
server/backend.js     Lógica del backend (Firebase Admin)
firebase/
  database.rules.json   Reglas de Realtime Database
  seed/catalog.json     Catálogo inicial
```

Estados de un pedido: `pago_pendiente` → `nuevo` → `aceptado` → `en_local` → `recogido` → `entregado`
(o `cancelado`). Los pedidos con tarjeta que no se pagan en 30 minutos se cancelan solos.

> El plan Hobby de Vercel es para uso no comercial. Sirve para lanzar y probar; cuando la app
> empiece a facturar, conviene pasar a Vercel Pro.
