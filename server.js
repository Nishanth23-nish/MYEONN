const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 5177);
const DEFAULT_STOCK = 50;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const extraHeaders = cookieHeader(body);
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(payload);
}

function cookieHeader(body) {
  if (!body || typeof body !== 'object' || !body.__cookie) return {};
  const cookie = body.__cookie;
  delete body.__cookie;
  return { 'Set-Cookie': cookie };
}

function sendError(res, status, message) {
  send(res, status, { error: message });
}

async function readJson(fileName, fallback) {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, fileName), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(fileName, value) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, fileName), JSON.stringify(value, null, 2) + '\n');
}

async function readArrayJson(fileName) {
  const value = await readJson(fileName, []);
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publicOrder(order) {
  return {
    id: order.id,
    createdAt: order.createdAt,
    status: order.status,
    items: order.items,
    subtotal: order.subtotal,
    shipping: order.shipping,
    total: order.total
  };
}

function publicProduct(product) {
  const { passwordHash, updatedBy, ...visibleProduct } = product;
  return visibleProduct;
}

function soldQuantity(product, orders) {
  return orders.reduce((sum, order) => sum + (order.items || []).reduce((itemSum, item) => {
    return itemSum + (item.id === product.id || item.name === product.name ? Number(item.qty || 0) : 0);
  }, 0), 0);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, originalHash] = String(stored || '').split(':');
  if (!salt || !originalHash) return false;
  const hash = crypto.scryptSync(String(password), salt, 64);
  const original = Buffer.from(originalHash, 'hex');
  return original.length === hash.length && crypto.timingSafeEqual(original, hash);
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map(part => {
    const [key, ...value] = part.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }));
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt
  };
}

function publicAdmin(admin) {
  if (!admin) return null;
  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role || 'admin'
  };
}

function sessionCookie(token, maxAge = 60 * 60 * 24 * 7) {
  return `myeonn_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function adminSessionCookie(token, maxAge = 60 * 60 * 12) {
  return `myeonn_admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function currentUser(req) {
  const token = parseCookies(req).myeonn_session;
  if (!token) return null;
  const sessions = await readJson('sessions.json', []);
  const session = sessions.find(item => item.token === token && new Date(item.expiresAt) > new Date());
  if (!session) return null;
  const users = await readJson('users.json', []);
  return users.find(user => user.id === session.userId) || null;
}

async function currentAdmin(req) {
  const token = parseCookies(req).myeonn_admin_session;
  if (!token) return null;
  const sessions = await readJson('admin-sessions.json', []);
  const session = sessions.find(item => item.token === token && new Date(item.expiresAt) > new Date());
  if (!session) return null;
  const admins = await readJson('admins.json', []);
  return admins.find(admin => admin.id === session.adminId) || null;
}

async function listProducts(url) {
  const products = await readArrayJson('products.json');
  const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
  const category = String(url.searchParams.get('category') || '').trim().toLowerCase();
  const collection = String(url.searchParams.get('collection') || '').trim().toLowerCase();

  return products.filter(product => {
    const searchable = [
      product.name,
      product.category,
      product.collection,
      product.age,
      product.size,
      ...(product.tags || [])
    ].join(' ').toLowerCase();
    return (!query || searchable.includes(query))
      && (!category || String(product.category).toLowerCase() === category)
      && (!collection || String(product.collection).toLowerCase() === collection);
  }).map(publicProduct);
}

async function createOrder(req, res) {
  const body = await readBody(req);
  const incomingItems = Array.isArray(body.items) ? body.items : [];
  if (!incomingItems.length) return sendError(res, 400, 'Add at least one item before checkout.');

  const products = await readArrayJson('products.json');
  const orders = await readArrayJson('orders.json');
  const requested = new Map();
  const totalsByProduct = new Map();
  for (const item of incomingItems) {
    const product = products.find(candidate => candidate.id === item.id || candidate.name === item.name);
    if (!product) throw new Error(`Product unavailable: ${item.name || item.id}`);
    const qty = Number(item.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
      throw new Error(`${product.name} quantity must be between 1 and 20.`);
    }
    const size = String(item.size || '').trim();
    const key = `${product.id}::${size || 'no-size'}`;
    const existing = requested.get(key);
    requested.set(key, {
      product,
      size,
      qty: (existing?.qty || 0) + qty
    });
    totalsByProduct.set(product.id, (totalsByProduct.get(product.id) || 0) + qty);
  }

  for (const [productId, qty] of totalsByProduct) {
    if (qty > 20) {
      const product = products.find(item => item.id === productId);
      throw new Error(`${product.name} quantity must be between 1 and 20.`);
    }
  }

  const items = Array.from(requested.values()).map(({ product, size, qty }) => {
    const stock = Number(product.stock ?? DEFAULT_STOCK);
    const available = Math.max(stock - soldQuantity(product, orders), 0);
    if ((totalsByProduct.get(product.id) || qty) > available) {
      throw new Error(`${product.name} has only ${available} left in stock.`);
    }
    return {
      id: product.id,
      name: product.name,
      size,
      price: product.price,
      qty,
      lineTotal: product.price * qty
    };
  });

  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const shipping = subtotal >= 999 ? 0 : 99;
  const account = publicUser(await currentUser(req));
  const order = {
    id: 'MYN-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    createdAt: new Date().toISOString(),
    status: 'received',
    customer: {
      ...(body.customer || {}),
      ...(account ? { account } : {})
    },
    items,
    subtotal,
    shipping,
    total: subtotal + shipping
  };

  orders.push(order);
  await writeJson('orders.json', orders);
  send(res, 201, publicOrder(order));
}

async function registerUser(req, res) {
  const body = await readBody(req);
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!name || !validateEmail(email) || password.length < 6) {
    return sendError(res, 400, 'Name, valid email, and a 6+ character password are required.');
  }

  const users = await readJson('users.json', []);
  if (users.some(user => user.email === email)) {
    return sendError(res, 409, 'An account already exists for this email.');
  }

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };
  users.push(user);
  await writeJson('users.json', users);
  await createSession(res, user, 201);
}

async function loginUser(req, res) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const users = await readJson('users.json', []);
  const user = users.find(item => item.email === email);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    return sendError(res, 401, 'Email or password is incorrect.');
  }

  await createSession(res, user, 200);
}

async function createSession(res, user, status) {
  const sessions = await readJson('sessions.json', []);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.push({
    token,
    userId: user.id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  });
  await writeJson('sessions.json', sessions);
  send(res, status, { ok: true, user: publicUser(user), __cookie: sessionCookie(token) });
}

async function logoutUser(req, res) {
  const token = parseCookies(req).myeonn_session;
  const sessions = await readJson('sessions.json', []);
  await writeJson('sessions.json', sessions.filter(session => session.token !== token));
  send(res, 200, { ok: true, __cookie: sessionCookie('', 0) });
}

async function loginAdmin(req, res) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const admins = await readJson('admins.json', []);
  const admin = admins.find(item => item.email === email);

  if (!admin || !verifyPassword(password, admin.passwordHash)) {
    return sendError(res, 401, 'Admin email or password is incorrect.');
  }

  const sessions = await readJson('admin-sessions.json', []);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.push({
    token,
    adminId: admin.id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
  });
  await writeJson('admin-sessions.json', sessions);
  send(res, 200, { ok: true, admin: publicAdmin(admin), __cookie: adminSessionCookie(token) });
}

async function logoutAdmin(req, res) {
  const token = parseCookies(req).myeonn_admin_session;
  const sessions = await readJson('admin-sessions.json', []);
  await writeJson('admin-sessions.json', sessions.filter(session => session.token !== token));
  send(res, 200, { ok: true, __cookie: adminSessionCookie('', 0) });
}

async function listAdminOrders(req, res) {
  const admin = await currentAdmin(req);
  if (!admin) return sendError(res, 401, 'Admin login is required.');
  const orders = await readArrayJson('orders.json');
  send(res, 200, orders.slice().reverse());
}

async function updateOrderStatus(req, res, orderId) {
  const admin = await currentAdmin(req);
  if (!admin) return sendError(res, 401, 'Admin login is required.');

  const body = await readBody(req);
  const status = String(body.status || '').trim().toLowerCase();
  const allowed = ['received', 'confirmed', 'shipped'];
  if (!allowed.includes(status)) return sendError(res, 400, 'Choose received, confirmed, or shipped.');

  const orders = await readArrayJson('orders.json');
  const order = orders.find(item => item.id === orderId);
  if (!order) return sendError(res, 404, 'Order not found.');

  order.status = status;
  order.updatedAt = new Date().toISOString();
  order.updatedBy = publicAdmin(admin);
  if (status === 'confirmed' && !order.confirmedAt) order.confirmedAt = order.updatedAt;
  if (status === 'shipped' && !order.shippedAt) order.shippedAt = order.updatedAt;

  await writeJson('orders.json', orders);
  send(res, 200, order);
}

async function updateProductStock(req, res, productId) {
  const admin = await currentAdmin(req);
  if (!admin) return sendError(res, 401, 'Admin login is required.');

  const body = await readBody(req);
  const stock = Number(body.stock);
  if (!Number.isInteger(stock) || stock < 0) return sendError(res, 400, 'Stock must be a whole number.');

  const products = await readArrayJson('products.json');
  const product = products.find(item => item.id === productId);
  if (!product) return sendError(res, 404, 'Product not found.');

  product.stock = stock;
  product.updatedAt = new Date().toISOString();
  product.updatedBy = publicAdmin(admin);
  await writeJson('products.json', products);
  send(res, 200, publicProduct(product));
}

function slugify(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `product-${Date.now()}`;
}

async function createAdminProduct(req, res) {
  const admin = await currentAdmin(req);
  if (!admin) return sendError(res, 401, 'Admin login is required.');

  const body = await readBody(req);
  const name = String(body.name || '').trim();
  const category = String(body.category || '').trim();
  const price = Number(body.price);
  const stock = Number(body.stock ?? DEFAULT_STOCK);
  if (!name || !category || !Number.isFinite(price) || price <= 0) return sendError(res, 400, 'Please enter product name, category, and a valid price.');
  if (!Number.isInteger(stock) || stock < 0) return sendError(res, 400, 'Stock must be a whole number.');

  const products = await readArrayJson('products.json');
  const id = slugify(body.id || name);
  const product = {
    id,
    name,
    collection: String(body.collection || 'kids').trim().toLowerCase() === 'men' ? 'men' : 'kids',
    category,
    age: String(body.age || '').trim(),
    size: String(body.size || '').trim(),
    price,
    images: Array.isArray(body.images) ? body.images.map(item => String(item).trim()).filter(Boolean) : [],
    tags: Array.isArray(body.tags) ? body.tags.map(item => String(item).trim()).filter(Boolean) : [],
    stock,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updatedBy: publicAdmin(admin)
  };

  const existingIndex = products.findIndex(item => item.id === id);
  if (existingIndex >= 0) products[existingIndex] = { ...products[existingIndex], ...product };
  else products.unshift(product);

  await writeJson('products.json', products);
  send(res, 201, publicProduct(product));
}

async function createMessage(req, res) {
  const body = await readBody(req);
  if (!body.firstName || !body.email || !body.message) {
    return sendError(res, 400, 'First name, email, and message are required.');
  }
  if (!validateEmail(body.email)) return sendError(res, 400, 'Enter a valid email address.');

  const message = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'new',
    firstName: String(body.firstName).trim(),
    lastName: String(body.lastName || '').trim(),
    email: String(body.email).trim(),
    phone: String(body.phone || '').trim(),
    topic: String(body.topic || 'Other').trim(),
    message: String(body.message).trim()
  };

  const messages = await readJson('messages.json', []);
  messages.push(message);
  await writeJson('messages.json', messages);
  send(res, 201, { ok: true, id: message.id });
}

async function createSubscriber(req, res) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  if (!validateEmail(email)) return sendError(res, 400, 'Enter a valid email address.');

  const subscribers = await readJson('subscribers.json', []);
  if (!subscribers.some(item => item.email === email)) {
    subscribers.push({ email, createdAt: new Date().toISOString() });
    await writeJson('subscribers.json', subscribers);
  }
  send(res, 201, { ok: true });
}

async function serveStatic(req, res, url) {
  const staticRoot = await directoryExists(path.join(ROOT, 'dist')) ? path.join(ROOT, 'dist') : ROOT;
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  if (requested.startsWith('/images/')) {
    const imageRoot = path.join(ROOT, 'images');
    const imagePath = path.normalize(path.join(imageRoot, requested.replace('/images/', '')));
    if (!imagePath.startsWith(imageRoot)) return sendError(res, 403, 'Forbidden');
    try {
      const data = await fs.readFile(imagePath);
      const type = contentTypes[path.extname(imagePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
      return;
    } catch (error) {
      if (error.code === 'ENOENT') return sendError(res, 404, 'Not found');
      throw error;
    }
  }
  let filePath = path.normalize(path.join(staticRoot, requested));
  if (!filePath.startsWith(staticRoot)) return sendError(res, 403, 'Forbidden');

  try {
    const data = await fs.readFile(filePath);
    const type = contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (error) {
    if (error.code === 'ENOENT' && staticRoot.endsWith('dist')) {
      filePath = path.join(staticRoot, 'index.html');
      const data = await fs.readFile(filePath);
      res.writeHead(200, { 'Content-Type': contentTypes['.html'], 'Cache-Control': 'no-store' });
      res.end(data);
      return;
    }
    if (error.code === 'ENOENT') return sendError(res, 404, 'Not found');
    throw error;
  }
}

async function directoryExists(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const adminOrderStatus = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
  const adminProductStock = url.pathname.match(/^\/api\/admin\/products\/([^/]+)\/stock$/);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true, name: 'Myeonn backend' });
  }
  if (req.method === 'GET' && url.pathname === '/api/products') {
    return send(res, 200, await listProducts(url));
  }
  if (req.method === 'GET' && url.pathname === '/api/orders') {
    const orders = await readArrayJson('orders.json');
    return send(res, 200, orders.map(publicOrder));
  }
  if (req.method === 'GET' && url.pathname === '/api/messages') {
    return send(res, 200, await readJson('messages.json', []));
  }
  if (req.method === 'GET' && url.pathname === '/api/session') {
    return send(res, 200, { user: publicUser(await currentUser(req)) });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/session') {
    return send(res, 200, { admin: publicAdmin(await currentAdmin(req)) });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/orders') return listAdminOrders(req, res);
  if (req.method === 'POST' && url.pathname === '/api/admin/products') return createAdminProduct(req, res);
  if (req.method === 'POST' && url.pathname === '/api/orders') return createOrder(req, res);
  if (req.method === 'POST' && url.pathname === '/api/contact') return createMessage(req, res);
  if (req.method === 'POST' && url.pathname === '/api/newsletter') return createSubscriber(req, res);
  if (req.method === 'POST' && url.pathname === '/api/register') return registerUser(req, res);
  if (req.method === 'POST' && url.pathname === '/api/login') return loginUser(req, res);
  if (req.method === 'POST' && url.pathname === '/api/logout') return logoutUser(req, res);
  if (req.method === 'POST' && url.pathname === '/api/admin/login') return loginAdmin(req, res);
  if (req.method === 'POST' && url.pathname === '/api/admin/logout') return logoutAdmin(req, res);
  if ((req.method === 'PATCH' || req.method === 'POST') && adminOrderStatus) {
    return updateOrderStatus(req, res, decodeURIComponent(adminOrderStatus[1]));
  }
  if ((req.method === 'PATCH' || req.method === 'POST') && adminProductStock) {
    return updateProductStock(req, res, decodeURIComponent(adminProductStock[1]));
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
  sendError(res, 405, 'Method not allowed');
}

const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    console.error(error);
    sendError(res, 500, error.message || 'Server error');
  });
});

server.listen(PORT, () => {
  console.log(`Myeonn backend running at http://127.0.0.1:${PORT}`);
});
