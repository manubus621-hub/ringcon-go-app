/* Notificaciones de pago de Mercado Pago (configurar en Tus integraciones → Webhooks → Pagos) */
const { webhook, ApiError } = require('../server/backend');

module.exports = async (req, res) => {
  try { res.status(200).send(await webhook(req.query || {}, req.body || {}, req.headers)); }
  catch (e) {
    if (e instanceof ApiError) return res.status(e.status).send(e.message);
    console.error(e);
    res.status(500).send('error');
  }
};
