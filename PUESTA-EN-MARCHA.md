# Ringcon Go · Puesta en marcha paso a paso

Qué hacer, en orden, para dejar la plataforma operando sola. Todo lo que es código ya está hecho; acá solo hay
pasos en paneles (GitHub, Firebase, Vercel, Mercado Pago, Google Play) y en el panel admin.

Las dos apps, para no confundirlas:

| App | Paquete Android | Sitio | Archivo AAB |
|---|---|---|---|
| **Ringcon Go Delivery** (clientes) | `com.ringcongo.app` | `ringcon-go.vercel.app` | `Ringcon_Go_Delivery.aab` |
| **Ringcon Go Conductores** (repartidores) | `com.ringcongo.conductores` | `ringcon-go-conductores.vercel.app` | `Ringcon_Go_Conductores.aab` |

Cada una tiene su propio `signing.keystore` y sus claves. Guardalos en dos carpetas separadas: sin ellos no se
puede subir una actualización.

## 0. Publicar esta versión

1. En GitHub, uní la rama `claude/ringongo-delivery-mq05ff` a `main` en `ringcon-go-app` y en
   `ringcon-go-conductores`. Vercel publica solo cada repo.
2. Firebase Console → Realtime Database → **Reglas**: pegá el contenido de `firebase/database.rules.json` y tocá
   **Publicar**. Sin esto, el panel del local y la pestaña Pueblos no pueden leer ni guardar.
3. Panel admin (`ringcon-go-conductores.vercel.app/admin.html`) → **Pueblos**: agregá Puerto Iguazú
   (`-25.5978, -54.5736`, 10 km). Después, en **Locales** y **Padrón**, elegí el pueblo en cada uno que diga
   "Falta elegir pueblo".
4. Completá `privacidad.html`: tiene tres campos sin llenar (`[nombre o razón social del titular]` y
   `[correo de contacto]`, dos veces). Google Play la pide y la revisa.

## 1. assetlinks.json

Ya está subido en los dos sitios (carpeta `.well-known/` de cada repo) y coincide con los AAB.

1. Abrí en el navegador y confirmá que se ve el JSON con el nombre del paquete:
   - `https://ringcon-go.vercel.app/.well-known/assetlinks.json`
   - `https://ringcon-go-conductores.vercel.app/.well-known/assetlinks.json`
2. **Después de subir cada AAB a Google Play** (paso 2.5), Google firma la app con su propia clave. Hay que agregar
   esa huella al archivo:
   - Play Console → la app → **Integridad de la app** → **Firma de apps** → copiá la **huella SHA-256 del
     certificado de la clave de firma de la app**.
   - En `.well-known/assetlinks.json` del repo de esa app, agregala dentro de `sha256_cert_fingerprints`, separada
     por coma de la que ya está. No borres la actual.
   - Si esa huella falta, la app abre con la barra de direcciones del navegador arriba.

## 2. Google Play Console

Se hace dos veces, una por app. Los nombres de los menús pueden cambiar; el contenido es el mismo.

1. **Cuenta de desarrollador** en `play.google.com/console`: pago único de USD 25 y verificación de identidad.
   Una cuenta **personal** nueva tiene que hacer una prueba cerrada con al menos 12 testers durante 14 días
   seguidos antes de poder publicar en producción. Una cuenta de **organización** no tiene ese requisito, pero pide
   número D-U-N-S. Confirmá en la consola cuál es tu caso.
2. **Crear app**: nombre (`Ringcon Go Delivery` o `Ringcon Go Conductores`), idioma español (Latinoamérica),
   tipo App, Gratis.
3. **Contenido de la app** (panel "Configurar tu app"):
   - Política de privacidad: `https://ringcon-go.vercel.app/privacidad.html`.
   - Acceso a la app: en Delivery, "toda la funcionalidad está disponible sin acceso especial" (se entra con el
     nombre). En Conductores, "requiere acceso": cargá en el padrón un DNI de prueba, registralo, aprobalo y
     pasale a Google ese DNI y su contraseña.
   - Anuncios: no. Clasificación de contenido: completá el cuestionario. Público objetivo: mayores de 18.
   - Seguridad de los datos, Delivery: nombre, teléfono (opcional), dirección, ubicación (si la comparte),
     historial de pedidos e identificador del dispositivo (avisos). Conductores: además DNI, fecha de nacimiento,
     fotos del documento y selfie. Datos cifrados en tránsito: sí. Pedido de eliminación: por el correo de la
     política de privacidad.
   - Eliminación de cuenta (Conductores crea cuentas): usá la misma URL de la política de privacidad.
4. **Ficha de Play Store**: descripción corta (80 caracteres), descripción completa, ícono de 512×512
   (`icons/icon-512.png`), gráfico de funciones de 1024×500 y al menos 2 capturas de teléfono. Categoría: Comida y
   bebida (Delivery), Empresa (Conductores).
5. **Subir el AAB**: Pruebas → **Prueba interna** → Crear versión → aceptá la **Firma de apps de Play** → subí el
   `.aab` → Guardar → Revisar → Iniciar lanzamiento. Sumá tu correo como tester e instalala desde el enlace.
6. Hacé el paso 1.2 (huella de Google en `assetlinks.json`) y verificá que la app abre sin barra de direcciones.
7. **Producción**: Países → Argentina. Con cuenta personal, antes pasá por la prueba cerrada (12 testers, 14 días)
   y pedí el acceso a producción desde el panel.

Las mejoras de la web llegan solas a las apps instaladas. Solo hace falta un AAB nuevo si cambia el nombre, el
ícono o el paquete; se genera en pwabuilder.com con el **mismo** keystore y un código de versión mayor.

## 3. Avisos push (Firebase Cloud Messaging)

Hoy las apps avisan con sonido mientras están abiertas. Con esto avisan también cerradas o con la pantalla apagada.

1. Firebase Console → proyecto `ringcon-go` → ⚙ **Configuración del proyecto** → **Cloud Messaging** →
   **Certificados push web** → **Generar par de claves**. Copiá la clave (empieza con `B`).
2. Pegala en `js/config.js` de los **dos** repos, en `VAPID_KEY`, reemplazando `COMPLETAR`. Es una clave pública.
3. Publicá (unir a `main`). No hay nada más que configurar: el servidor usa la misma cuenta de servicio de Firebase
   que ya está en Vercel.

A quién le llega cada aviso:

| Momento | Recibe |
|---|---|
| Entra un pedido a un local con panel | El local |
| El local acepta (o el local no usa panel) | Conductores **en línea** de ese pueblo, y el cliente |
| Un conductor lo toma, lo retira o lo entrega | El cliente |
| El local marca "Listo para despachar" | El conductor que lo tomó |
| El local rechaza o no responde en 10 minutos | El cliente |

El permiso se pide una sola vez: al cliente cuando hace su primer pedido, al conductor cuando se pone en línea y
al local cuando activa el sonido. Las apps de Android ya traen la delegación de notificaciones. En iPhone solo
funciona si la web está agregada a la pantalla de inicio.

## 4. Panel del local

1. Panel admin → **Locales** → editar el local → **Panel de pedidos del local** → cargá un email y una contraseña
   → **Crear acceso**.
2. Pasale al local esos datos y la dirección `https://ringcon-go-conductores.vercel.app/local.html`.
3. El local la abre en una tablet o PC, entra, toca la pantalla una vez para activar la alerta sonora y la deja
   abierta con volumen.

Cómo funciona desde ese momento:
- Cada pedido suena y aparece en **Nuevos**. La alerta se repite cada 4 segundos hasta que alguien lo atiende.
- **Aceptar pedido** → **En preparación** → **Listo para despachar**. El cliente y el conductor ven cada paso.
- Los conductores reciben el pedido recién cuando el local lo acepta.
- Si el local no responde en 10 minutos, el pedido se cancela solo y, si se pagó con tarjeta, se devuelve.
- El local puede rechazar un pedido (el cliente ve el motivo) y abrirse o cerrarse con el interruptor de arriba.
- Un local **sin** accesos creados sigue como antes: sus pedidos van directo a los conductores.

## 5. Cobro con tarjeta dividido (Mercado Pago)

Qué hace: el pago con tarjeta entra a la cuenta de Mercado Pago **del local** y, en ese mismo pago, Mercado Pago le
acredita a tu cuenta la comisión, el envío y la propina.

Lo que Mercado Pago no permite: dividir un pago entre **tres** cuentas. Su división automática es entre dos (el
modelo de más cuentas solo se habilita por acuerdo comercial). Por eso la parte del conductor entra a tu cuenta y
el sistema la anota como saldo a su favor (paso 6).

1. `mercadopago.com.ar/developers` → **Tus integraciones** → la aplicación cuya Public Key está en `js/config.js`:
   - Modelo de integración: **Marketplace** (si el panel lo pregunta).
   - **URL de redireccionamiento**: `https://ringcon-go.vercel.app/api/mp-oauth`.
   - Copiá el **Client ID** y el **Client Secret** de producción.
2. Vercel → proyecto de `ringcon-go-app` → Settings → **Environment Variables** (Production): agregá `MP_CLIENT_ID`
   y `MP_CLIENT_SECRET`. Volvé a desplegar.
3. Panel admin → **Locales** → editar el local → **Cobro con tarjeta** → **Generar enlace para conectar** →
   **Enviar por WhatsApp** al dueño.
4. El dueño abre el enlace con la sesión de **su** Mercado Pago y toca **Autorizar**. Ve "¡Listo!" y en el admin
   el estado pasa a **Conectado**. El enlace sirve 7 días y una sola vez.

Desde que activás el paso 2, solo ofrecen tarjeta los locales conectados; el resto queda en efectivo.

Antes de usarlo con clientes, hacé **una compra real chica** en un local conectado y revisá:
- que el pedido pase solo de "Falta pagar" a esperar al local;
- que en la cuenta del local figure el cobro y en la tuya tu parte;
- si el formulario de tarjeta da error al pagar, agregá en Vercel `MP_SPLIT_PUBLIC_KEY` con el valor `vendedor`,
  desplegá y probá de nuevo.

A tener en cuenta:
- La comisión de Mercado Pago se descuenta de lo que recibe **el local**, sobre el total del pedido. Tenelo
  presente al acordar tu comisión con cada local.
- La cuenta del local tiene que estar verificada en Mercado Pago.
- Una devolución sale de las dos cuentas en proporción. Si el local no tiene saldo, la devolución completa puede
  fallar: el pedido queda marcado `reembolso_fallido` en la pestaña Pedidos para resolverlo a mano.
- Las credenciales de cada local duran 180 días y el sistema las renueva solo. Si un local revoca el permiso,
  deja de ofrecer tarjeta y en el admin aparece "Se desconectó": hay que mandarle un enlace nuevo.

## 6. Liquidación de conductores (una vez por semana)

Panel admin → **Liquidaciones**. Por cada conductor muestra:
- **A su favor**: envío y propina de los pedidos con tarjeta (ese dinero entró a tu cuenta).
- **Rinde**: tu comisión de los pedidos que él cobró en efectivo.
- **Neto**: "Le transferís $X" o "Te transfiere $X".

Hacé la transferencia y tocá **Marcar liquidado**. El conductor ve su saldo sin liquidar en su app.

## Qué no se pudo probar desde el desarrollo

La lógica está probada de punta a punta con Firebase y Mercado Pago simulados. No se probó contra los servicios
reales, así que la primera vez verificá:
- **Reglas de la base**: si Firebase rechaza publicarlas, no cambia nada y avisa el motivo.
- **Mercado Pago**: la compra de prueba del paso 5.
- **Avisos push**: poné un conductor en línea, cerrá la app y hacé un pedido de prueba.
