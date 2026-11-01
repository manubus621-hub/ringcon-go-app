/* POST /api/call  { fn, data }  con  Authorization: Bearer <ID token de Firebase> */
const { call, ApiError } = require('../server/backend');

module.exports = async (req, res) => {
  // La app de conductores vive en otro dominio. La autenticación va por token, no por cookies.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  try {
    const { fn, data } = req.body || {};
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    res.status(200).json({ data: await call(String(fn || ''), data, token) });
  } catch (e) {
    if (e instanceof ApiError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Algo salió mal. Probá de nuevo.' });
  }
};
