# Ringcon Go · App de clientes

Delivery para Rincón de los Sauces (Neuquén). HTML, CSS y JavaScript puro con Firebase
(Auth, Realtime Database, Storage y Cloud Functions) y cobros con Mercado Pago.

La app de conductores y el panel de administración están en
[ringcon-go-conductores](https://github.com/manubus621-hub/ringcon-go-conductores).
El backend compartido (reglas y funciones) vive en la carpeta `firebase/` de este repo.

## Cómo está armada la seguridad

- **El navegador no decide nada que valga plata.** Los pedidos se crean en la función `createOrder`,
  que toma los precios del catálogo en la base. El cliente solo manda qué productos y cuántos.
- **Pagos con tarjeta por Mercado Pago (Card Payment Brick).** La tarjeta se carga en el formulario
  de Mercado Pago, que devuelve un token. `payOrder` cobra con el Access Token secreto, que vive solo
  en el servidor. El pedido les llega a los conductores recién cuando el pago queda `approved`.
  El webhook `mpWebhook` verifica la firma y vuelve a consultar el pago a Mercado Pago.
- **Reembolso automático** si un pedido pagado se cancela.
- **Reglas de base de datos por rol:** cada cliente lee solo sus pedidos. Los conductores aprobados
  ven el tablero `openOrders`, sin teléfono ni datos del cliente, y el pedido completo solo cuando lo toman.
  El padrón y los conductores son visibles solo para administradores.
- **Conductores verificados:** DNI en el padrón, apellido y fecha de nacimiento, fotos del DNI y
  selfie, y aprobación manual. Además hay límite de intentos por DNI y licencia vigente para ponerse en línea.

## Puesta en marcha (una sola vez)

1. **Firebase Console** (proyecto `ringcon-go-e7f62`):
   - Pasá el proyecto al plan **Blaze**. Cloud Functions lo exige; con poco uso, el costo es casi nulo.
   - Authentication → Método de acceso: activá **Anónimo** y **Correo/contraseña**.
   - Activá **Storage**.
   - Configuración del proyecto → Tus apps → App web: copiá `apiKey`, `appId` y `storageBucket` en
     `js/config.js`, en este repo y en el de conductores.
2. **Mercado Pago** → Tus integraciones → Credenciales:
   - Copiá la **Public Key** en `js/config.js` (`MP_PUBLIC_KEY`).
   - En Webhooks configurá la URL `https://us-central1-ringcon-go-e7f62.cloudfunctions.net/mpWebhook`
     con el evento *Pagos*, y copiá la **clave secreta** que te muestra.
   - Probá primero con las credenciales de **prueba** y sus tarjetas de prueba.
3. **Desplegar el backend** (necesitás Node 20 y `npm i -g firebase-tools`):
   ```bash
   cd firebase/functions && npm install && cd ..
   firebase login
   firebase functions:secrets:set MP_ACCESS_TOKEN
   firebase functions:secrets:set MP_WEBHOOK_SECRET
   firebase deploy
   ```
4. **Cargar el catálogo:** Realtime Database → ⋮ → Importar JSON → `firebase/seed/catalog.json`
   (importalo en la raíz). Los precios están en pesos.
5. **Crear tu usuario administrador:** en Authentication creá un usuario con email y contraseña,
   copiá su UID y en la base agregá `admins/<UID> = true`. Con ese usuario entrás a `admin.html`
   de la app de conductores.

## Estructura

```
index.html            HTML principal (CSP, manifest)
css/app.css           Estilos
js/config.js          Configuración pública (Firebase + Public Key MP)
js/app.js             Lógica de la app
sw.js, manifest.webmanifest, icon.svg   PWA / APK
firebase/
  database.rules.json   Reglas de Realtime Database
  storage.rules         Reglas de Storage (fotos de conductores)
  functions/index.js    Pedidos, pagos, webhook, conductores
  seed/catalog.json     Catálogo inicial
```

Estados de un pedido: `pago_pendiente` → `nuevo` → `aceptado` → `en_local` → `recogido` → `entregado`
(o `cancelado`). Los pedidos con tarjeta que no se pagan en 30 minutos se cancelan solos.
