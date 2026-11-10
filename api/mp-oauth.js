/* Vuelta de Mercado Pago cuando el dueño de un local autoriza a la plataforma a cobrar en su cuenta (OAuth).
   Es la "Redirect URL" de la aplicación de Mercado Pago: https://<dominio>/api/mp-oauth */
const { oauthCallback, ApiError } = require('../server/backend');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, text) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 24px;text-align:center;color:#111"><h1>${esc(title)}</h1><p style="font-size:18px;line-height:1.5">${esc(text)}</p></body></html>`;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    const { name } = await oauthCallback(req.query || {});
    res.status(200).send(page('¡Listo!', `${name} ya cobra con tarjeta en su cuenta de Mercado Pago. Podés cerrar esta página.`));
  } catch (e) {
    if (!(e instanceof ApiError)) console.error(e);
    res.status(e instanceof ApiError ? e.status : 500).send(page('No se pudo conectar', e instanceof ApiError ? e.message : 'Abrí el enlace de nuevo en un momento.'));
  }
};
