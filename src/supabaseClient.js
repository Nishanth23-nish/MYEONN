const SUPABASE_URL = 'https://sojkfebovcrgaosoibam.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_D_aYH8r5OuEU1OvIWOqDbg_luW1l2wE';
const REST_URL = `${SUPABASE_URL}/rest/v1`;
const AUTH_URL = `${SUPABASE_URL}/auth/v1`;
const STORAGE_URL = `${SUPABASE_URL}/storage/v1`;
const BUCKET = 'product-images';
const SESSION_KEY = 'myeonn_supabase_session';

function storedSession() {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!session?.access_token || !session?.user) return null;
    return session;
  } catch {
    return null;
  }
}

function saveSession(session) {
  const authSession = session?.access_token ? session : session?.session;
  if (authSession?.access_token) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      ...authSession,
      user: authSession.user || session?.user
    }));
  }
  else localStorage.removeItem(SESSION_KEY);
}

export function supabaseClearSession() {
  saveSession(null);
}

function authHeaders() {
  const token = storedSession()?.access_token || SUPABASE_ANON_KEY;
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${REST_URL}${path}`, {
    ...options,
    headers: { ...authHeaders(), Prefer: 'return=representation', ...(options.headers || {}) }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (!response.ok) throw new Error(text || 'Supabase request failed.');
  }
  if (!response.ok) throw new Error(data?.message || data?.error_description || data?.error || 'Supabase request failed.');
  return data;
}

async function authRequest(path, body) {
  const response = await fetch(`${AUTH_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.msg || data?.message || data?.error_description || 'Supabase login failed.');
  if (data.access_token || data.session?.access_token) saveSession(data);
  return data;
}

export function supabaseCurrentUser() {
  const session = storedSession();
  if (!session?.access_token || !session?.user) return null;
  return {
    id: session.user.id,
    name: session.user.user_metadata?.name || session.user.email?.split('@')[0] || 'Customer',
    email: session.user.email
  };
}

export function supabaseSessionInfo() {
  const session = storedSession();
  return {
    hasToken: Boolean(session?.access_token),
    uid: session?.user?.id || '',
    email: session?.user?.email || ''
  };
}

export async function supabaseRegister({ name, email, password }) {
  const result = await authRequest('/signup', { email, password, data: { name } });
  return {
    id: result.user?.id,
    name,
    email: result.user?.email || email
  };
}

export async function supabaseLogin({ email, password }) {
  const result = await authRequest('/token?grant_type=password', { email, password });
  const authSession = result.access_token ? result : result.session;
  if (!authSession?.access_token) throw new Error('Supabase did not return a login session. Check that this user is confirmed in Supabase Auth.');
  return supabaseCurrentUser() || {
    id: authSession.user?.id || result.user?.id,
    name: authSession.user?.user_metadata?.name || result.user?.user_metadata?.name || email.split('@')[0],
    email: authSession.user?.email || result.user?.email || email
  };
}

export async function supabaseLogout() {
  const token = storedSession()?.access_token;
  if (token) {
    await fetch(`${AUTH_URL}/logout`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    }).catch(() => {});
  }
  saveSession(null);
}

export async function supabaseListProducts() {
  try {
    return await request('/products?select=*&order=created_at.desc', {
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
  } catch (error) {
    if (/schema cache|public\.products|PGRST205/i.test(error.message)) return [];
    throw error;
  }
}

export async function supabaseSaveProduct(product) {
  const row = {
    id: product.id,
    name: product.name,
    collection: product.collection,
    category: product.category,
    age: product.age || '',
    size: product.size || '',
    price: product.price,
    stock: product.stock,
    images: product.images || [],
    tags: product.tags || []
  };
  const rows = await request('/products?on_conflict=id', {
    method: 'POST',
    body: JSON.stringify(row),
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' }
  });
  return rows[0];
}

export async function supabaseListOrders() {
  let rows;
  try {
    rows = await request('/orders?select=*&order=created_at.desc');
  } catch (error) {
    if (!/created_at|schema cache/i.test(error.message)) throw error;
    rows = await request('/orders?select=*');
  }
  return rows.map(row => ({ ...row, createdAt: row.created_at || row.createdAt }));
}

export async function supabaseSaveOrder(order) {
  const session = storedSession();
  const cleanOrder = {
    id: order.id,
    user_id: session?.user?.id || null,
    created_at: order.created_at,
    status: order.status,
    customer: order.customer || {},
    items: order.items || [],
    subtotal: order.subtotal,
    shipping: order.shipping,
    total: order.total
  };
  let rows;
  try {
    rows = await request('/orders', {
      method: 'POST',
      body: JSON.stringify(cleanOrder)
    });
  } catch (error) {
    if (/row-level security|violates row-level security/i.test(error.message)) {
      rows = await request('/rpc/create_myeonn_order', {
        method: 'POST',
        body: JSON.stringify({ order_payload: cleanOrder })
      });
      return { ...rows[0], createdAt: rows[0]?.created_at || rows[0]?.createdAt };
    }
    if (!/created_?at|user_id|schema cache/i.test(error.message)) throw error;
    const { created_at, user_id, ...orderWithoutDate } = cleanOrder;
    rows = await request('/orders', {
      method: 'POST',
      body: JSON.stringify(orderWithoutDate)
    });
  }
  return { ...rows[0], createdAt: rows[0]?.created_at || rows[0]?.createdAt };
}

export async function supabaseUpdateOrderStatus(orderId, status) {
  const rows = await request(`/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status })
  });
  return { ...rows[0], createdAt: rows[0]?.created_at || rows[0]?.createdAt };
}

export async function supabaseUploadProductImage(productId, fileName, blob) {
  const cleanName = fileName.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '') || 'product.jpg';
  const objectPath = `products/${productId}/${Date.now()}-${cleanName}`;
  const token = storedSession()?.access_token;
  if (!token) throw new Error('Admin login is required before uploading images.');
  const response = await fetch(`${STORAGE_URL}/object/${BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'true'
    },
    body: blob
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Image upload failed.');
  }
  return `${STORAGE_URL}/object/public/${BUCKET}/${objectPath}`;
}
