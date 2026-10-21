const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const MACHINES = ['31613', '31994', '32027', '393'];
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'card-orders.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]', { mode: 0o600 });
}
function readOrders() {
  ensureStorage();
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); }
  catch { throw new Error('Не вдалося прочитати файл замовлень'); }
}
function writeOrders(orders) {
  ensureStorage();
  const temp = `${ORDERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(orders, null, 2), { mode: 0o600 });
  fs.renameSync(temp, ORDERS_FILE);
}
function clean(value, max = 160) {
  return String(value ?? '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, max);
}
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send('Адмін-доступ не налаштовано. Додайте ADMIN_PASSWORD у змінних середовища Hostinger.');
  const header = req.headers.authorization || '';
  const match = header.match(/^Basic\s+(.+)$/i);
  if (match) {
    let decoded = '';
    try { decoded = Buffer.from(match[1], 'base64').toString('utf8'); } catch {}
    const supplied = decoded.slice(decoded.indexOf(':') + 1);
    const a = Buffer.from(supplied);
    const b = Buffer.from(ADMIN_PASSWORD);
    if (decoded.includes(':') && a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="PoVodu admin", charset="UTF-8"');
  return res.status(401).send('Потрібна авторизація адміністратора.');
}

app.post('/api/card-orders', (req, res) => {
  const lastName = clean(req.body.lastName, 80);
  const firstName = clean(req.body.firstName, 80);
  const phone = clean(req.body.phone, 30);
  const machineId = clean(req.body.machineId, 12);
  const city = clean(req.body.city, 100);
  const carrier = clean(req.body.carrier, 20);
  const branch = clean(req.body.branch, 180);
  const honeypot = clean(req.body.website, 100);
  if (honeypot) return res.status(400).json({ error: 'Не вдалося оформити замовлення.' });
  if (!lastName || !firstName || !phone || !machineId || !city || !carrier || !branch) {
    return res.status(400).json({ error: 'Заповніть усі поля форми.' });
  }
  if (!MACHINES.includes(machineId)) return res.status(400).json({ error: 'Оберіть коректний номер водомату.' });
  if (!/^\+?[0-9()\-\s]{9,20}$/.test(phone)) return res.status(400).json({ error: 'Перевірте номер телефону.' });
  if (!['Нова пошта', 'Укрпошта'].includes(carrier)) return res.status(400).json({ error: 'Оберіть службу доставки.' });
  try {
    const orders = readOrders();
    const order = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'Нове',
      lastName, firstName, phone, machineId, city, carrier, branch
    };
    orders.unshift(order);
    writeOrders(orders);
    return res.status(201).json({ ok: true, firstName, orderNumber: order.id.slice(0, 8).toUpperCase() });
  } catch (error) {
    console.error('Card order save failed:', error.message);
    return res.status(500).json({ error: 'Не вдалося зберегти замовлення. Спробуйте пізніше.' });
  }
});

app.get('/admin', adminAuth, (_req, res) => {
  const orders = readOrders();
  const rows = orders.map(o => `<tr><td>${escapeHtml(new Date(o.createdAt).toLocaleString('uk-UA'))}</td><td>${escapeHtml(o.lastName)} ${escapeHtml(o.firstName)}</td><td>${escapeHtml(o.phone)}</td><td>${escapeHtml(o.machineId)}</td><td>${escapeHtml(o.city)}</td><td>${escapeHtml(o.carrier)}</td><td>${escapeHtml(o.branch)}</td><td>${escapeHtml(o.status)}</td></tr>`).join('');
  res.type('html').send(`<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Замовлення карток — ПоВоду</title><style>body{font:15px system-ui,sans-serif;margin:24px;color:#12314a}h1{color:#0877bd}p{color:#55748a} .wrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:950px}th,td{padding:11px;border:1px solid #d7eaf5;text-align:left}th{background:#eaf7ff}tr:nth-child(even){background:#f7fbfe}</style></head><body><h1>Замовлення карток постійного клієнта</h1><p>Усього замовлень: ${orders.length}. Дані призначені для оформлення карток і доставки; зберігайте їх конфіденційно.</p><div class="wrap"><table><thead><tr><th>Дата</th><th>Клієнт</th><th>Телефон</th><th>Водомат</th><th>Місто</th><th>Служба</th><th>Відділення</th><th>Статус</th></tr></thead><tbody>${rows || '<tr><td colspan="8">Замовлень поки немає.</td></tr>'}</tbody></table></div></body></html>`);
});
function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

app.get('/machine/:id', (req, res) => {
  if (!MACHINES.includes(String(req.params.id))) return res.status(404).sendFile(path.join(__dirname, 'public', 'not-found.html'));
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`ПоВоду запущено на порту ${PORT}`));
