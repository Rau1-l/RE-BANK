const windows = new Map();

function keyFor(req) {
  return `${req.ip}|${req.user?.id || 'anonymous'}`;
}

export function clickRateLimit(req, res, next) {
  const now = Date.now();
  const key = keyFor(req);
  const current = windows.get(key);
  if (!current || now - current.windowStart >= 1000) {
    windows.set(key, { windowStart: now, count: 1 });
    return next();
  }
  if (current.count >= 5) {
    res.set('Retry-After', '1');
    return res.status(429).json({ error: 'Too many clicks. Limit is 5 per second.' });
  }
  current.count += 1;
  return next();
}

setInterval(() => {
  const cutoff = Date.now() - 10000;
  for (const [key, value] of windows) {
    if (value.windowStart < cutoff) windows.delete(key);
  }
}, 10000).unref();
