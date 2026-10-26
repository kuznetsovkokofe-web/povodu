const req = https.request(
  'https://water.net.ua/places/operator-window',
  { method: 'GET', timeout: 10000 },
  (res) => {
    console.log('WaterCRM HTTP status:', res.statusCode);
    console.log('Content-Type:', res.headers['content-type']);
    res.resume();
  }
);

req.on('timeout', () => req.destroy(new Error('Timeout')));
req.on('error', (err) =>
  console.error('WaterCRM connection error:', err.message)
);
req.end();
