
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3000;
const MACHINES = ['31613', '31994', '32027', '393'];
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

app.disable('x-powered-by');
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 20,
  charset: 'utf8mb4',
  timezone: 'Z'
});

function clean(value, max = 160) {
  return String(value ?? '')
    .trim()
    .replace(/[<>\u0000-\u001f]/g, '')
    .slice(0, max);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send(
      'Адмін-доступ не налаштовано. Додайте ADMIN_PASSWORD у змінних середовища Hostinger.'
    );
  }

  const header = req.headers.authorization || '';
  const match = header.match(/^Basic\s+(.+)$/i);

  if (match) {
    let decoded = '';
    try {
      decoded = Buffer.from(match[1], 'base64').toString('utf8');
    } catch {}

    const colon = decoded.indexOf(':');
    const supplied = colon >= 0 ? decoded.slice(colon + 1) : '';
    const a = Buffer.from(supplied);
    const b = Buffer.from(ADMIN_PASSWORD);

    if (
      colon >= 0 &&
      a.length === b.length &&
      crypto.timingSafeEqual(a, b)
    ) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="PoVodu admin", charset="UTF-8"');
  return res.status(401).send('Потрібна авторизація адміністратора.');
}

// Створюємо таблицю автоматично, якщо її ще немає.
async function initDatabase() {
  const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length) {
    throw new Error(`Не задані змінні середовища: ${missing.join(', ')}`);
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS card_orders (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      created_at DATETIME(3) NOT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'Нове',
      last_name VARCHAR(80) NOT NULL,
      first_name VARCHAR(80) NOT NULL,
      phone VARCHAR(30) NOT NULL,
      machine_id VARCHAR(12) NOT NULL,
      city VARCHAR(100) NOT NULL,
      carrier VARCHAR(20) NOT NULL,
      branch VARCHAR(180) NOT NULL,
      INDEX idx_card_orders_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS water_payments (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      invoice_id VARCHAR(100) NULL UNIQUE,
      created_at DATETIME(3) NOT NULL,
      machine_id VARCHAR(12) NOT NULL,
      type_id INT NOT NULL,
      liters INT NOT NULL,
      amount INT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'creating',
      page_url TEXT NULL,
      INDEX idx_water_payments_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log('MySQL підключено, таблиця card_orders готова.');
}
// Створення тестового рахунку Monobank для водомата 393.
// Видача води на цьому етапі не виконується.

let monoWebhookPublicKey = null;

app.post('/api/payments/webhook', async (req, res) => {
  const token = process.env.MONO_TOKEN;
    console.log('MONO WEBHOOK RECEIVED', new Date().toISOString());
  console.log('WEBHOOK DEBUG', {
  method: req.method,
  url: req.originalUrl,
  hasSignature: !!req.get('X-Sign'),
  bodyKeys: Object.keys(req.body || {})
});
  const signature = req.get('X-Sign');

  if (!token || !signature || !req.rawBody) {
  console.log('MONO WEBHOOK MISSING DATA', {
    tokenPresent: !!token,
    signaturePresent: !!signature,
    rawBodyPresent: !!req.rawBody
  });
  return res.sendStatus(400);
}
  try {
    // Отримуємо відкритий ключ Monobank і кешуємо його.
    if (!monoWebhookPublicKey) {
      const keyResponse = await fetch(
        'https://api.monobank.ua/api/merchant/pubkey',
        {
          headers: { 'X-Token': token },
          signal: AbortSignal.timeout(10000)
        }
      );

      if (!keyResponse.ok) {
        throw new Error('Не вдалося отримати ключ Monobank');
      }

      const keyData = await keyResponse.json();

      if (!keyData.key) {
        throw new Error('Monobank не повернув відкритий ключ');
      }

      monoWebhookPublicKey = Buffer.from(keyData.key, 'base64');
    }

    // Перевіряємо підпис саме оригінального тіла запиту.
    const validSignature = crypto.verify(
      'sha256',
      req.rawBody,
      monoWebhookPublicKey,
      Buffer.from(signature, 'base64')
    );

    if (!validSignature) {
  console.error('MONO WEBHOOK INVALID SIGNATURE');
  return res.sendStatus(401);
}

console.log('MONO WEBHOOK SIGNATURE VALID');

    const event = JSON.parse(req.rawBody.toString('utf8'));
console.log('MONO WEBHOOK EVENT', {
  status: event.status,
  amount: event.amount,
  ccy: event.ccy,
  referencePresent: !!event.reference,
  invoiceIdPresent: !!event.invoiceId
});
    if (
      !event.invoiceId ||
      !event.reference ||
      !Number.isInteger(event.amount) ||
      event.ccy !== 980 ||
      !event.status
    ) {
      return res.sendStatus(400);
    }

    const [rows] = await pool.execute(
      `SELECT id, invoice_id, amount, status
       FROM water_payments
       WHERE id = ? AND invoice_id = ?
       LIMIT 1`,
      [event.reference, event.invoiceId]
    );
console.log('MONO WEBHOOK DB MATCH', { rowsFound: rows.length });
    if (rows.length !== 1) {
      console.error('Webhook: замовлення не знайдено');
      return res.sendStatus(200);
    }

    const payment = rows[0];

    if (Number(payment.amount) !== event.amount) {
      console.error('Webhook: сума не збігається');
      return res.sendStatus(200);
    }

    // Оплачене замовлення не можна понизити іншим webhook.
    if (payment.status === 'paid') {
      return res.sendStatus(200);
    }

    if (event.status === 'success') {
      await pool.execute(
        `UPDATE water_payments
         SET status = 'paid'
         WHERE id = ?
           AND invoice_id = ?
           AND amount = ?
           AND status <> 'paid'`,
        [payment.id, payment.invoice_id, event.amount]
      );
    } else {
      // Зберігаємо статуси для діагностики, але не видаємо воду.
      const safeStatus = [
        'created',
        'processing',
        'failure',
        'reversed'
      ].includes(event.status) ? event.status : 'unknown';

      await pool.execute(
        `UPDATE water_payments
         SET status = ?
         WHERE id = ?
           AND invoice_id = ?
           AND status <> 'paid'`,
        [safeStatus, payment.id, payment.invoice_id]
      );
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('Monobank webhook error:', error.message);
    return res.sendStatus(500);
  }
});

app.post('/api/payments/create', async (req, res) => {
  const token = process.env.MONO_TOKEN;

  if (!token) {
    return res.status(503).json({
      error: 'Оплата тимчасово недоступна.'
    });
  }

  const typeId = Number(req.body.typeId);
  const liters = Number(req.body.liters);

  if (![1, 2].includes(typeId)) {
    return res.status(400).json({
      error: 'Оберіть коректний тип води.'
    });
  }

  // Цілі літри; не дозволяємо випадкові чи надмірні суми.
  if (!Number.isInteger(liters) || liters < 1 || liters > 100) {
    return res.status(400).json({
      error: 'Кількість має бути від 1 до 100 літрів.'
    });
  }

  const pricePerLiter = typeId === 1 ? 3 : 4;
  const amount = liters * pricePerLiter * 100;
  const paymentId = crypto.randomUUID();
  const waterName = typeId === 1
    ? 'Очищена вода'
    : 'Мінералізована вода';

  try {
    // Спершу реєструємо замовлення в БД.
    await pool.execute(
      `INSERT INTO water_payments
        (id, created_at, machine_id, type_id, liters, amount, status)
       VALUES (?, UTC_TIMESTAMP(3), '393', ?, ?, ?, 'creating')`,
      [paymentId, typeId, liters, amount]
    );

    const monoResponse = await fetch(
      'https://api.monobank.ua/api/merchant/invoice/create',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Token': token
        },
        body: JSON.stringify({
          amount,
          ccy: 980,
          webHookUrl: 'https://povodu.online/api/payments/webhook',
          merchantPaymInfo: {
            reference: paymentId,
            destination: `${waterName}, ${liters} л, водомат 393`,
            comment: `Замовлення ${paymentId}`
          }
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    const monoData = await monoResponse.json().catch(() => ({}));

    if (
      !monoResponse.ok ||
      !monoData.invoiceId ||
      !monoData.pageUrl
    ) {
      console.error(
        'Monobank invoice creation failed:',
        monoResponse.status,
        JSON.stringify(monoData).slice(0, 1000)
      );

      await pool.execute(
        `UPDATE water_payments SET status = 'create_failed'
         WHERE id = ? AND status = 'creating'`,
        [paymentId]
      );

      return res.status(502).json({
        error: 'Не вдалося створити рахунок. Спробуйте пізніше.'
      });
    }

    await pool.execute(
      `UPDATE water_payments
       SET invoice_id = ?, page_url = ?, status = 'pending'
       WHERE id = ?`,
      [monoData.invoiceId, monoData.pageUrl, paymentId]
    );

    return res.status(201).json({
      ok: true,
      paymentId,
      amount: amount / 100,
      currency: 'UAH',
      pageUrl: monoData.pageUrl
    });
  } catch (error) {
    console.error('Payment creation failed:', error.message);

    await pool.execute(
      `UPDATE water_payments SET status = 'create_failed'
       WHERE id = ? AND status = 'creating'`,
      [paymentId]
    ).catch(() => {});

    return res.status(502).json({
      error: 'Помилка під час створення платежу.'
    });
  }
});

app.get('/api/watercrm-test', async (req, res) => {
  try {
    const response = await fetch(
      'https://water.net.ua/places/operator-window',
      {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(10000)
      }
    );

    console.log('WaterCRM test:', {
      status: response.status,
      redirect: response.headers.get('location')
    });

    return res.json({
      ok: true,
      status: response.status,
      redirected: response.status >= 300 && response.status < 400
    });
  } catch (error) {
    console.error('WaterCRM test failed:', error.message);
    return res.status(502).json({
      ok: false,
      error: 'Не вдалося підключитися до WaterCRM'
    });
  }
});

app.post('/api/card-orders', async (req, res) => {
  const lastName = clean(req.body.lastName, 80);
  const firstName = clean(req.body.firstName, 80);
  const phone = clean(req.body.phone, 30);
  const machineId = clean(req.body.machineId, 12);
  const city = clean(req.body.city, 100);
  const carrier = clean(req.body.carrier, 20);
  const branch = clean(req.body.branch, 180);
  const honeypot = clean(req.body.website, 100);

  if (honeypot) {
    return res.status(400).json({
      error: 'Не вдалося оформити замовлення.'
    });
  }

  if (!lastName || !firstName || !phone || !machineId ||
      !city || !carrier || !branch) {
    return res.status(400).json({
      error: 'Заповніть усі поля форми.'
    });
  }

  if (!MACHINES.includes(machineId)) {
    return res.status(400).json({
      error: 'Оберіть коректний номер водомату.'
    });
  }

  if (!/^\+?[0-9()\-\s]{9,20}$/.test(phone)) {
    return res.status(400).json({
      error: 'Перевірте номер телефону.'
    });
  }

  if (!['Нова пошта', 'Укрпошта'].includes(carrier)) {
    return res.status(400).json({
      error: 'Оберіть службу доставки.'
    });
  }

  try {
    const id = crypto.randomUUID();

    await pool.execute(
      `INSERT INTO card_orders
        (id, created_at, status, last_name, first_name, phone,
         machine_id, city, carrier, branch)
       VALUES (?, UTC_TIMESTAMP(3), ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, 'Нове', lastName, firstName, phone,
        machineId, city, carrier, branch
      ]
    );

    return res.status(201).json({
      ok: true,
      firstName,
      orderNumber: id.slice(0, 8).toUpperCase()
    });
  } catch (error) {
    console.error('Card order save failed:', error.message);
    return res.status(500).json({
      error: 'Не вдалося зберегти замовлення. Спробуйте пізніше.'
    });
  }
});

app.get('/admin', adminAuth, async (_req, res) => {
  try {
    const [orders] = await pool.execute(
      `SELECT id, created_at, status, last_name, first_name,
              phone, machine_id, city, carrier, branch
       FROM card_orders
       ORDER BY created_at DESC`
    );

    const rows = orders.map(o => {
      const date = new Date(
        String(o.created_at).replace(' ', 'T') + 'Z'
      );

      return `<tr>
        <td>${escapeHtml(date.toLocaleString('uk-UA', {
          timeZone: 'Europe/Kyiv'
        }))}</td>
        <td>${escapeHtml(o.last_name)} ${escapeHtml(o.first_name)}</td>
        <td>${escapeHtml(o.phone)}</td>
        <td>${escapeHtml(o.machine_id)}</td>
        <td>${escapeHtml(o.city)}</td>
        <td>${escapeHtml(o.carrier)}</td>
        <td>${escapeHtml(o.branch)}</td>
        <td>${escapeHtml(o.status)}</td>
      </tr>`;
    }).join('');

    res.type('html').send(`<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Замовлення карток — ПоВоду</title>
<style>
body{font:15px system-ui,sans-serif;margin:24px;color:#12314a}
h1{color:#0877bd}
p{color:#55748a}
.wrap{overflow:auto}
table{border-collapse:collapse;width:100%;min-width:950px}
th,td{padding:11px;border:1px solid #d7eaf5;text-align:left}
th{background:#eaf7ff}
tr:nth-child(even){background:#f7fbfe}
</style>
</head>
<body>
<h1>Замовлення карток постійного клієнта</h1>
<p>Усього замовлень: ${orders.length}.
Дані призначені для оформлення карток і доставки; зберігайте їх конфіденційно.</p>
<div class="wrap">
<table>
<thead><tr>
<th>Дата</th><th>Клієнт</th><th>Телефон</th><th>Водомат</th>
<th>Місто</th><th>Служба</th><th>Відділення</th><th>Статус</th>
</tr></thead>
<tbody>${rows || '<tr><td colspan="8">Замовлень поки немає.</td></tr>'}</tbody>
</table>
</div>
</body>
</html>`);
  } catch (error) {
    console.error('Admin orders load failed:', error.message);
    return res.status(500).send('Не вдалося завантажити замовлення.');
  }
});

app.get('/machine/:id', (req, res) => {
  if (!MACHINES.includes(String(req.params.id))) {
    return res.status(404).sendFile(
      path.join(__dirname, 'public', 'not-found.html')
    );
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  try {
    await initDatabase();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`ПоВоду запущено на порту ${PORT}`);
    });
  } catch (error) {
    console.error('Не вдалося запустити застосунок:', error.message);
    process.exit(1);
  }
}

start();
