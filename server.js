
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

function waterCrmCookieHeader(jar) {
  return [...jar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function waterCrmUpdateCookies(headers, jar) {
  let cookies = [];

  if (typeof headers.getSetCookie === 'function') {
    cookies = headers.getSetCookie();
  } else {
    const value = headers.get('set-cookie');
    if (value) cookies = [value];
  }

  for (const cookie of cookies) {
    const pair = cookie.split(';', 1)[0];
    const index = pair.indexOf('=');
    if (index > 0) {
      jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }
}

function waterCrmExtractCsrf(html) {
  const patterns = [
    /<input[^>]+name=["']_csrf["'][^>]+value=["']([^"']+)["']/i,
    /<input[^>]+value=["']([^"']+)["'][^>]+name=["']_csrf["']/i,
    /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1].replace(/&amp;/g, '&');
  }

  return null;
}

async function waterCrmLogin() {
  const username = process.env.WATERCRM_USERNAME;
  const password = process.env.WATERCRM_PASSWORD;

  if (!username || !password) {
    throw new Error('Не налаштовано логін або пароль WaterCRM');
  }

  const base = 'https://water.net.ua';
  const jar = new Map();

  const page = await fetch(`${base}/login`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15000)
  });

  waterCrmUpdateCookies(page.headers, jar);

  if (page.status !== 200) {
    throw new Error(`WaterCRM login page: HTTP ${page.status}`);
  }

  const html = await page.text();
  const csrf = waterCrmExtractCsrf(html);

  if (!csrf) {
    throw new Error('Не знайдено CSRF-поле форми WaterCRM');
  }

  const form = new URLSearchParams({
    '_csrf': csrf,
    'LoginForm[username]': username,
    'LoginForm[password]': password,
    'LoginForm[rememberMe]': '1',
    'login-button': 'Login'
  });

  const login = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': waterCrmCookieHeader(jar),
      'Referer': `${base}/login`,
      'Origin': base
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15000)
  });

  waterCrmUpdateCookies(login.headers, jar);

  if (![302, 303].includes(login.status)) {
    throw new Error(`WaterCRM login returned HTTP ${login.status}`);
  }

  const operator = await fetch(`${base}/places/operator-window`, {
    redirect: 'manual',
    headers: {
      'Cookie': waterCrmCookieHeader(jar),
      'Referer': `${base}/`
    },
    signal: AbortSignal.timeout(15000)
  });

  if (operator.status !== 200) {
    throw new Error(
      `WaterCRM operator window returned HTTP ${operator.status}`
    );
  }

  const operatorHtml = await operator.text();

  if (/\/login/.test(operator.headers.get('location') || '')) {
    throw new Error('WaterCRM не підтвердив авторизацію');
  }

  const operatorCsrf = waterCrmExtractCsrf(operatorHtml) || csrf;

  return { jar, csrf: operatorCsrf };
}

async function waterCrmDispense({ liters, typeId }) {
  if (!Number.isInteger(Number(liters)) || Number(liters) < 1) {
    throw new Error('Некоректна кількість літрів');
  }

  if (![1, 2].includes(Number(typeId))) {
    throw new Error('Некоректний тип води');
  }

  const base = 'https://water.net.ua';
  const { jar, csrf } = await waterCrmLogin();

  const response = await fetch(`${base}/places/set-remainder`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': waterCrmCookieHeader(jar),
      'X-CSRF-Token': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${base}/places/operator-window`,
      'Origin': base
    },
    body: new URLSearchParams({
      '_csrf': csrf,
      'device_id': '1193',
      'value': String(Number(liters)),
      'type_id': String(Number(typeId))
    }).toString(),
    signal: AbortSignal.timeout(15000)
  });

  waterCrmUpdateCookies(response.headers, jar);

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `WaterCRM command returned HTTP ${response.status}: ${responseText.slice(0, 300)}`
    );
  }

  let result;

  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(
      `WaterCRM повернув не JSON: ${responseText.slice(0, 300)}`
    );
  }

  if (
    result.status !== 'success' &&
    result.answer !== 'ok' &&
    result.ok !== true
  ) {
    throw new Error(
      `WaterCRM не підтвердив команду: ${responseText.slice(0, 300)}`
    );
  }

  return result;
}
// SIM4 / Gteh — окрема інтеграція.
// Водомат 393 продовжує працювати через WaterCRM.

function sim4CookieHeader(jar) {
  return [...jar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function sim4UpdateCookies(headers, jar) {
  let cookies = [];

  if (typeof headers.getSetCookie === 'function') {
    cookies = headers.getSetCookie();
  } else {
    const value = headers.get('set-cookie');
    if (value) cookies = [value];
  }

  for (const cookie of cookies) {
    const pair = cookie.split(';', 1)[0];
    const index = pair.indexOf('=');

    if (index > 0) {
      jar.set(
        pair.slice(0, index).trim(),
        pair.slice(index + 1).trim()
      );
    }
  }
}

function sim4ExtractCsrf(html) {
  const patterns = [
    /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i,
    /<input[^>]+name=["']_token["'][^>]+value=["']([^"']+)["']/i,
    /<input[^>]+value=["']([^"']+)["'][^>]+name=["']_token["']/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1].replace(/&amp;/g, '&');
  }

  return null;
}

async function sim4Login() {
  const username = process.env.SIM4_LOGIN;
  const password = process.env.SIM4_PASSWORD;

  if (!username || !password) {
    throw new Error(
      'Не налаштовано SIM4_LOGIN або SIM4_PASSWORD у Hostinger'
    );
  }

  const base = 'https://sim4.gteh.com.ua/sim4';
  const jar = new Map();

  const loginPage = await fetch(`${base}/login`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15000)
  });

  sim4UpdateCookies(loginPage.headers, jar);

  if (loginPage.status !== 200) {
    throw new Error(`SIM4 сторінка входу: HTTP ${loginPage.status}`);
  }

  const loginHtml = await loginPage.text();
  const csrf = sim4ExtractCsrf(loginHtml);

  if (!csrf) {
    throw new Error('Не знайдено CSRF-токен на сторінці входу SIM4');
  }

  const loginResponse = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: sim4CookieHeader(jar),
      Referer: `${base}/login`,
      Origin: 'https://sim4.gteh.com.ua'
    },
    body: new URLSearchParams({
      _token: csrf,
      login: username,
      password
    }).toString(),
    signal: AbortSignal.timeout(15000)
  });

  sim4UpdateCookies(loginResponse.headers, jar);

  const loginLocation = loginResponse.headers.get('location') || '';

  if (
    ![302, 303].includes(loginResponse.status) ||
    /\/login(?:\?|$)/.test(loginLocation)
  ) {
    throw new Error(
      `SIM4 не підтвердив вхід (HTTP ${loginResponse.status})`
    );
  }

  const news = await fetch(`${base}/news`, {
    redirect: 'manual',
    headers: {
      Cookie: sim4CookieHeader(jar),
      Referer: `${base}/login`
    },
    signal: AbortSignal.timeout(15000)
  });

  sim4UpdateCookies(news.headers, jar);

  if (news.status !== 200) {
    throw new Error(`SIM4 перевірка сесії: HTTP ${news.status}`);
  }

  const newsHtml = await news.text();

  if (
    !newsHtml.includes('funds_replenishment') ||
    /name=["']login["']/i.test(newsHtml)
  ) {
    throw new Error('SIM4 сесія не пройшла перевірку авторизації');
  }

  return { base, jar };
}

async function sim4TopUpOnce({ machineId, amountUah }) {
  const allowedMachines = ['31613', '31994', '32027'];

  if (!allowedMachines.includes(String(machineId))) {
    throw new Error(`Непідтримуваний SIM4 термінал: ${machineId}`);
  }

  if (!Number.isFinite(Number(amountUah)) || Number(amountUah) <= 0) {
    throw new Error('Некоректна сума поповнення SIM4');
  }

  const { base, jar } = await sim4Login();

  const page = await fetch(`${base}/funds_replenishment`, {
    redirect: 'manual',
    headers: {
      Cookie: sim4CookieHeader(jar),
      Referer: `${base}/news`
    },
    signal: AbortSignal.timeout(15000)
  });

  sim4UpdateCookies(page.headers, jar);

  if (page.status !== 200) {
    throw new Error(
      `SIM4 сторінка поповнення: HTTP ${page.status}`
    );
  }

  const html = await page.text();
  const csrf = sim4ExtractCsrf(html);

  if (!csrf) {
    throw new Error(
      'Не знайдено CSRF-токен на сторінці поповнення SIM4'
    );
  }

  const response = await fetch(`${base}/funds_replenishment`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: sim4CookieHeader(jar),
      Referer: `${base}/funds_replenishment`,
      Origin: 'https://sim4.gteh.com.ua'
    },
    body: new URLSearchParams({
      _token: csrf,
      _method: 'POST',
      object: '2291',
      box: String(machineId),
      amount: Number(amountUah).toFixed(2),
      kop: '0',
      submit: ''
    }).toString(),
    signal: AbortSignal.timeout(15000)
  });

  sim4UpdateCookies(response.headers, jar);

  if (![302, 303].includes(response.status)) {
    const responseText = await response.text();

    throw new Error(
      `SIM4 поповнення: HTTP ${response.status}: ` +
      responseText.slice(0, 250)
    );
  }

  const location =
    response.headers.get('location') || '/funds_replenishment';

  const resultUrl = new URL(location, `${base}/`);

  if (resultUrl.origin !== 'https://sim4.gteh.com.ua') {
    throw new Error('SIM4 повернув неочікуване перенаправлення');
  }

  const resultPage = await fetch(resultUrl, {
    redirect: 'manual',
    headers: {
      Cookie: sim4CookieHeader(jar),
      Referer: `${base}/funds_replenishment`
    },
    signal: AbortSignal.timeout(15000)
  });

  sim4UpdateCookies(resultPage.headers, jar);

  if (resultPage.status !== 200) {
    throw new Error(
      `SIM4 перевірка результату: HTTP ${resultPage.status}`
    );
  }

  const resultHtml = await resultPage.text();

if (!resultHtml.includes('Кошти успішно зараховані на термінал')) {

  const diagnosticText = resultHtml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<meta\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();

  console.error('SIM4 UNEXPECTED RESPONSE', {
    machineId: String(machineId),
    amountUah: Number(amountUah),
    httpStatus: resultPage.status,
    finalUrl: resultUrl.pathname,
    responseText: diagnosticText.slice(0, 5000)
  
  });

  throw new Error(
    `SIM4 не підтвердив зарахування. HTTP ${resultPage.status}; ` +
    `відповідь записана в лог SIM4 UNEXPECTED RESPONSE`
  );
}
// Черга поповнень SIM4: виконуємо лише одну операцію одночасно.
let sim4Queue = Promise.resolve();

function sim4TopUp(args) {
  const job = sim4Queue.then(() => sim4TopUpOnce(args));

  // Помилка одного поповнення не повинна блокувати наступні.
  sim4Queue = job.catch(() => {});

  return job;
}
  return {
    ok: true,
    machineId: String(machineId),
    amountUah: Number(amountUah)
  };
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
      `SELECT id, invoice_id, amount, status,
        machine_id, type_id, liters, dispense_status
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
   
if (event.status === 'success') {
  // Спершу фіксуємо підтверджену оплату.
  await pool.execute(
    `UPDATE water_payments
     SET status = 'paid'
     WHERE id = ?
       AND invoice_id = ?
       AND amount = ?
       AND status <> 'paid'`,
    [payment.id, payment.invoice_id, event.amount]
  );

  // Атомарно дозволяємо лише одному webhook запустити видачу.
  const [claim] = await pool.execute(
    `UPDATE water_payments
     SET dispense_status = 'processing'
     WHERE id = ?
       AND invoice_id = ?
       AND status = 'paid'
       AND dispense_status = 'pending'`,
    [payment.id, payment.invoice_id]
  );

    if (claim.affectedRows === 1) {
    try {
      let result;

      const machineId = String(payment.machine_id);

      if (machineId === '393') {
        // Старий водомат: WaterCRM не змінюємо.
        result = await waterCrmDispense({
          liters: payment.liters,
          typeId: payment.type_id
        });
      } else if (
        ['31613', '31994', '32027'].includes(machineId)
      ) {
        // Інші водомати: поповнення через SIM4.
        result = await sim4TopUp({
          machineId,
          amountUah: Number(payment.amount) / 100
        });
      } else {
        throw new Error(
          `Непідтримуваний водомат: ${machineId}`
        );
      }

      await pool.execute(
        `UPDATE water_payments
         SET dispense_status = 'command_sent',
             dispense_message = ?
         WHERE id = ?
           AND dispense_status = 'processing'`,
        [
          machineId === '393'
            ? 'Команду передано через WaterCRM'
            : 'SIM4 підтвердив зарахування коштів на термінал',
          payment.id
        ]
      );

      console.log('WATER DISPENSING REQUEST ACCEPTED', {
        paymentId: payment.id,
        machineId,
        liters: payment.liters,
        typeId: payment.type_id,
        result
      });
    } catch (dispenseError) {
      await pool.execute(
        `UPDATE water_payments
         SET dispense_status = 'failed',
             dispense_message = ?
         WHERE id = ?
           AND dispense_status = 'processing'`,
        [
          String(dispenseError.message || 'Невідома помилка').slice(0, 2000),
          payment.id
        ]
      );

      console.error('WATER DISPENSING FAILED', {
        paymentId: payment.id,
        machineId: String(payment.machine_id),
        error: dispenseError.message
      });
    }
  } else {
    console.log('Water dispensing already claimed or processed', {
      paymentId: payment.id
    });
  }
} else {
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

  const machineId = String(req.body.machineId || '');
  const allowedMachines = ['31613', '31994', '32027', '393'];

  if (!allowedMachines.includes(machineId)) {
    return res.status(400).json({
      error: 'Оберіть коректний водомат.'
    });
  }

  const typeId = Number(req.body.typeId);
  const liters = Number(req.body.liters);

  if (![1, 2].includes(typeId)) {
    return res.status(400).json({
      error: 'Оберіть коректний тип води.'
    });
  }

  if (!Number.isInteger(liters) || liters < 1 || liters > 100) {
    return res.status(400).json({
      error: 'Кількість має бути від 1 до 100 літрів.'
    });
  }

  const PRICES = {
  "31613": { 1: 2.50, 2: 3.00 },
  "31994": { 1: 2.00, 2: 2.50 },
  "32027": { 1: 2.00, 2: 2.50 },
  "393":   { 1: 3.00, 2: 4.00 }
};

const pricePerLiter = PRICES[machineId]?.[typeId];

if (pricePerLiter == null) {
  return res.status(400).json({
    error: "Для цього водомата або типу води не налаштовано ціну."
  });
}

const amount = Math.round(liters * pricePerLiter * 100);
  const paymentId = crypto.randomUUID();

  const waterName = typeId === 1
    ? 'Очищена вода'
    : 'Мінералізована вода';

  try {
    // Реєструємо замовлення для вибраного водомата.
    await pool.execute(
      `INSERT INTO water_payments
        (id, created_at, machine_id, type_id, liters, amount, status)
       VALUES (?, UTC_TIMESTAMP(3), ?, ?, ?, ?, 'creating')`,
      [paymentId, machineId, typeId, liters, amount]
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
            destination:
              `${waterName}, ${liters} л, водомат ${machineId}`,
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
        `UPDATE water_payments
         SET status = 'create_failed'
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
      machineId,
      amount: amount / 100,
      currency: 'UAH',
      pageUrl: monoData.pageUrl
    });
  } catch (error) {
    console.error('Payment creation failed:', error.message);

    await pool.execute(
      `UPDATE water_payments
       SET status = 'create_failed'
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
      'https://water.net.ua/',
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
  redirected: response.status >= 300 && response.status < 400,
  redirectTo: response.headers.get('location')
});
  } catch (error) {
    console.error('WaterCRM test failed:', error.message);
    return res.status(502).json({
      ok: false,
      error: 'Не вдалося підключитися до WaterCRM'
    });
  }
});

app.get('/api/watercrm-auth-test', adminAuth, async (req, res) => {
  try {
    const session = await waterCrmLogin();

    console.log('WaterCRM auth test: successful');

    return res.json({
      ok: true,
      authenticated: true,
      operatorWindow: 'accessible'
    });
  } catch (error) {
    console.error('WaterCRM auth test failed:', error.message);

    return res.status(502).json({
      ok: false,
      authenticated: false,
      error: error.message
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
