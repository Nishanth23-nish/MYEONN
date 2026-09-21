import React, { useEffect, useMemo, useState } from 'react';
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut, updateProfile } from 'firebase/auth';
import { addDoc, collection, doc, getDocs, orderBy, query, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import storeProducts from '../data/products.json';
import { auth, db } from './firebaseClient';
import { supabaseClearSession, supabaseCurrentUser, supabaseListOrders, supabaseListProducts, supabaseLogin, supabaseLogout, supabaseRegister, supabaseSaveOrder, supabaseSaveProduct, supabaseSessionInfo, supabaseUpdateOrderStatus } from './supabaseClient';

const infoContent = {
  sale: ['Sale', 'Seasonal offers are available across selected kids and men styles. Extra bundle offers are available on kids sets.'],
  shipping: ['Shipping Info', 'Standard delivery takes 2-4 working days across India. Orders above ₹999 ship free.'],
  returns: ['Returns', 'Returns are accepted within 15 days of delivery for unworn items with original tags attached.'],
  sizes: ['Size Guide', 'Kids sizes are guided by age and height. Men sizes follow standard Indian sizing from S to 3XL.'],
  about: ['About Myeonn', 'Myeonn makes everyday clothing for kids and men with soft fabrics, practical fits, and a quiet premium feel.'],
  careers: ['Careers', 'For retail, operations, design, or content roles, send your profile to hello@myeonn.com.'],
  privacy: ['Privacy Policy', 'We use customer details only to process orders, provide support, improve service, and share opted-in updates.'],
  terms: ['Terms', 'By shopping with Myeonn, customers agree to our order, delivery, return, and exchange terms.']
};

const fallbackProducts = normalizeProducts(storeProducts);
const adminEmails = ['admin@myeonn.com', 'myeonnadmin@gmail.com'];
const useFirebaseBackend = typeof window !== 'undefined' && !['localhost', '127.0.0.1'].includes(window.location.hostname);
const useSupabaseBackend = useFirebaseBackend;

const price = value => '₹' + Number(value || 0).toLocaleString('en-IN');
const productMeta = product => [product.category, product.age || product.size].filter(Boolean).join(' · ');
const paymentMethodLabel = order => order?.customer?.paymentMethod || order?.paymentMethod || 'Online payment';
const defaultStock = () => 50;
const localOrdersKey = 'myeonn_customer_orders';
const kidsSizeOptions = ['5-6', '7-8', '9-10', '11-12', '13-14', '15-16'];
const adultSizeOptions = ['S', 'M', 'L', 'XL'];
const routePages = ['home', 'kids', 'men', 'arrivals', 'contact', 'login', 'orders', 'checkout', 'admin'];

function pageFromLocation() {
  if (typeof window === 'undefined') return 'home';
  const pathPage = window.location.pathname.replace(/^\/+|\/+$/g, '');
  if (pathPage === 'admin') return 'home';
  if (routePages.includes(pathPage)) return pathPage;
  const hashPage = window.location.hash.replace(/^#\/?/, '');
  if (hashPage === 'admin') return 'home';
  return routePages.includes(hashPage) ? hashPage : 'home';
}

function productSizeOptions(product) {
  const sizeText = [product.collection, product.age, product.size, product.category].filter(Boolean).join(' ').toLowerCase();
  if (sizeText.includes('kids') || /\b(ages?\s*)?1-16\b/.test(sizeText) || /\b(ages?\s*)?5-16\b/.test(sizeText)) return kidsSizeOptions;
  if (/\bs-?(xl|xxl|3xl)\b/.test(sizeText) || sizeText.includes('men')) return adultSizeOptions;
  return kidsSizeOptions;
}

function slugify(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `product-${Date.now()}`;
}

function productFromForm(form) {
  const id = slugify(form.id || form.name);
  const images = Array.isArray(form.images) ? form.images.filter(Boolean) : String(form.images || '').split('\n').map(item => item.trim()).filter(Boolean);
  const tags = Array.isArray(form.tags) ? form.tags.filter(Boolean) : String(form.tags || '').split(',').map(item => item.trim()).filter(Boolean);
  return {
    id,
    name: form.name.trim(),
    collection: form.collection,
    category: form.category.trim(),
    age: form.collection === 'kids' ? form.age.trim() : '',
    size: form.collection === 'men' ? form.size.trim() : form.size.trim(),
    price: Number(form.price),
    stock: Number(form.stock || 50),
    images,
    tags,
    createdAt: new Date().toISOString()
  };
}

async function fileToWebBlob(file) {
  const image = await createImageBitmap(file);
  const max = 1200;
  const scale = Math.min(max / image.width, max / image.height, 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not prepare image.')), 'image/jpeg', 0.86));
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read image.'));
    reader.readAsDataURL(blob);
  });
}

async function uploadProductImages(productId, files) {
  const uploads = await Promise.all(files.map(async (file, index) => {
    const blob = await fileToWebBlob(file);
    return blobToDataUrl(blob);
  }));
  return uploads;
}

function calculateStockRows(products, orders) {
  return products.map(product => {
    const sold = orders.reduce((sum, order) => sum + (order.items || []).filter(item => item.id === product.id || item.name === product.name).reduce((itemSum, item) => itemSum + Number(item.qty || 0), 0), 0);
    const opening = Number(product.stock ?? defaultStock(product));
    const available = Math.max(opening - sold, 0);
    const status = available === 0 ? 'out' : available <= 5 ? 'low' : 'ready';
    return { ...product, opening, sold, available, status };
  });
}

function ordersForUser(orders, user) {
  if (!user) return [];
  return (orders || []).filter(order => {
    const customer = order.customer || {};
    return order.user_id === user.id || order.userId === user.id || customer.userId === user.id || customer.email === user.email;
  });
}

function readLocalOrders(user) {
  try {
    const orders = JSON.parse(localStorage.getItem(localOrdersKey) || '[]');
    if (!user) return Array.isArray(orders) ? orders : [];
    return (Array.isArray(orders) ? orders : []).filter(order => {
      const customer = order.customer || {};
      return order.user_id === user.id || order.userId === user.id || customer.userId === user.id || customer.email === user.email;
    });
  } catch {
    return [];
  }
}

function saveLocalOrder(order) {
  try {
    const orders = readLocalOrders(null);
    const next = [order, ...orders.filter(item => item.id !== order.id)].slice(0, 30);
    localStorage.setItem(localOrdersKey, JSON.stringify(next));
  } catch {}
}

function mergeOrders(primary = [], secondary = []) {
  const seen = new Map();
  [...primary, ...secondary].forEach(order => {
    if (order?.id && !seen.has(order.id)) seen.set(order.id, order);
  });
  return [...seen.values()].sort((a, b) => new Date(b.createdAt || b.created_at || 0) - new Date(a.createdAt || a.created_at || 0));
}

function returnStorageKey(user) {
  return `myeonn_return_requests_${user?.id || user?.email || 'guest'}`;
}

function readReturnRequests(user) {
  try {
    return JSON.parse(localStorage.getItem(returnStorageKey(user)) || '{}');
  } catch {
    return {};
  }
}

function saveReturnRequests(user, requests) {
  localStorage.setItem(returnStorageKey(user), JSON.stringify(requests));
}

async function api(path, options = {}) {
  if (useSupabaseBackend) return supabaseApi(path, options);
  if (useFirebaseBackend) return firebaseApi(path, options);
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Online backend is not connected for this action yet.');
  }
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

async function supabaseApi(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};

  if (path === '/api/products' && method === 'GET') {
    const products = await supabaseListProducts();
    return products;
  }

  if (path === '/api/orders' && method === 'GET') {
    const current = supabaseCurrentUser();
    if (!current || adminEmails.includes(current.email)) return [];
    const orders = await supabaseListOrders();
    return ordersForUser(orders, current);
  }

  if (path === '/api/session' && method === 'GET') {
    const current = supabaseCurrentUser();
    if (!current || adminEmails.includes(current.email)) return { user: null };
    return { user: current };
  }

  if (path === '/api/admin/session' && method === 'GET') {
    const current = supabaseCurrentUser();
    return { admin: current && adminEmails.includes(current.email) ? { ...current, name: 'Myeonn Admin', role: 'admin' } : null };
  }

  if (path === '/api/register' && method === 'POST') {
    supabaseClearSession();
    const user = await supabaseRegister(body);
    return { user };
  }

  if (path === '/api/login' && method === 'POST') {
    supabaseClearSession();
    const user = await supabaseLogin(body);
    if (adminEmails.includes(user.email)) throw new Error('Use Admin login for this account.');
    return { user };
  }

  if (path === '/api/logout' && method === 'POST') {
    await supabaseLogout();
    return { ok: true };
  }

  if (path === '/api/admin/login' && method === 'POST') {
    supabaseClearSession();
    const user = await supabaseLogin(body);
    if (!adminEmails.includes(user.email)) {
      await supabaseLogout();
      throw new Error('This email is not an admin account.');
    }
    const session = supabaseSessionInfo();
    if (!session.hasToken) throw new Error('Supabase login did not save a session. Please try again.');
    if (session.uid !== 'a1592343-bf1f-43dc-a62c-88f1dea87465') throw new Error(`Wrong Supabase admin session: ${session.email || 'no email'}`);
    return { admin: { ...user, name: 'Myeonn Admin', role: 'admin' } };
  }

  if (path === '/api/admin/logout' && method === 'POST') {
    await supabaseLogout();
    return { ok: true };
  }

  if (path === '/api/admin/orders' && method === 'GET') return supabaseListOrders();

  const statusMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
  if (statusMatch && method === 'PATCH') return supabaseUpdateOrderStatus(decodeURIComponent(statusMatch[1]), body.status);

  const stockMatch = path.match(/^\/api\/admin\/products\/([^/]+)\/stock$/);
  if (stockMatch && method === 'PATCH') {
    const productId = decodeURIComponent(stockMatch[1]);
    const product = fallbackProducts.find(item => item.id === productId) || {};
    return supabaseSaveProduct({ ...product, id: productId, stock: Number(body.stock || 0) });
  }

  if (path === '/api/admin/products' && method === 'POST') {
    const session = supabaseSessionInfo();
    if (!session.hasToken) throw new Error('Please sign out and login again as Supabase admin.');
    if (session.uid !== 'a1592343-bf1f-43dc-a62c-88f1dea87465') throw new Error(`Wrong Supabase admin session: ${session.email || 'no email'}`);
    const product = productFromForm(body);
    if (!product.name || !product.category || !Number.isFinite(product.price) || product.price <= 0) {
      throw new Error('Please enter product name, category, and a valid price.');
    }
    if (!Number.isInteger(product.stock) || product.stock < 0) throw new Error('Stock must be a whole number.');
    return supabaseSaveProduct(product);
  }

  if (path === '/api/orders' && method === 'POST') {
    const items = (body.items || []).map(item => ({ ...item, lineTotal: Number(item.price || 0) * Number(item.qty || 0) }));
    const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
    const shipping = subtotal >= 999 ? 0 : 99;
    const order = {
      id: `MYN-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      created_at: new Date().toISOString(),
      status: 'received',
      customer: body.customer || {},
      items,
      subtotal,
      shipping,
      total: subtotal + shipping
    };
    return supabaseSaveOrder(order);
  }

  throw new Error('This Supabase action is not available yet.');
}

async function firebaseApi(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};

  if (path === '/api/products' && method === 'GET') {
    const snapshot = await getDocs(collection(db, 'products'));
    const items = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    return items.length ? items : fallbackProducts;
  }

  if (path === '/api/orders' && method === 'GET') {
    const current = auth.currentUser;
    if (!current || adminEmails.includes(current.email)) return [];
    const snapshot = await getDocs(query(collection(db, 'orders'), orderBy('createdAt', 'desc')));
    return ordersForUser(snapshot.docs.map(orderFromDoc), firebaseUser(current));
  }

  if (path === '/api/session' && method === 'GET') {
    const current = auth.currentUser;
    if (!current || adminEmails.includes(current.email)) return { user: null };
    return { user: firebaseUser(current) };
  }

  if (path === '/api/admin/session' && method === 'GET') {
    const current = auth.currentUser;
    return { admin: current && adminEmails.includes(current.email) ? firebaseAdmin(current) : null };
  }

  if (path === '/api/register' && method === 'POST') {
    if (!body.name || !body.email || !body.password) throw new Error('Please fill all register details.');
    const credential = await createUserWithEmailAndPassword(auth, body.email, body.password);
    await updateProfile(credential.user, { displayName: body.name });
    const user = firebaseUser({ ...credential.user, displayName: body.name });
    await setDoc(doc(db, 'users', credential.user.uid), { ...user, createdAt: serverTimestamp() });
    return { user };
  }

  if (path === '/api/login' && method === 'POST') {
    const credential = await signInWithEmailAndPassword(auth, body.email, body.password);
    if (adminEmails.includes(credential.user.email)) throw new Error('Use Admin login for this account.');
    return { user: firebaseUser(credential.user) };
  }

  if (path === '/api/logout' && method === 'POST') {
    await signOut(auth);
    return { ok: true };
  }

  if (path === '/api/admin/login' && method === 'POST') {
    const credential = await signInWithEmailAndPassword(auth, body.email, body.password);
    if (!adminEmails.includes(credential.user.email)) {
      await signOut(auth);
      throw new Error('This email is not an admin account.');
    }
    return { admin: firebaseAdmin(credential.user) };
  }

  if (path === '/api/admin/logout' && method === 'POST') {
    await signOut(auth);
    return { ok: true };
  }

  if (path === '/api/admin/orders' && method === 'GET') {
    const snapshot = await getDocs(query(collection(db, 'orders'), orderBy('createdAt', 'desc')));
    return snapshot.docs.map(orderFromDoc);
  }

  const statusMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
  if (statusMatch && method === 'PATCH') {
    const orderId = decodeURIComponent(statusMatch[1]);
    await updateDoc(doc(db, 'orders', orderId), { status: body.status, updatedAt: serverTimestamp() });
    const snapshot = await getDocs(query(collection(db, 'orders'), orderBy('createdAt', 'desc')));
    return snapshot.docs.map(orderFromDoc).find(order => order.id === orderId);
  }

  const stockMatch = path.match(/^\/api\/admin\/products\/([^/]+)\/stock$/);
  if (stockMatch && method === 'PATCH') {
    const productId = decodeURIComponent(stockMatch[1]);
    const product = fallbackProducts.find(item => item.id === productId) || {};
    const updated = { ...product, id: productId, stock: Number(body.stock || 0), updatedAt: new Date().toISOString() };
    await setDoc(doc(db, 'products', productId), updated, { merge: true });
    return updated;
  }

  if (path === '/api/admin/products' && method === 'POST') {
    const product = productFromForm(body);
    if (!product.name || !product.category || !Number.isFinite(product.price) || product.price <= 0) {
      throw new Error('Please enter product name, category, and a valid price.');
    }
    if (!Number.isInteger(product.stock) || product.stock < 0) throw new Error('Stock must be a whole number.');
    await setDoc(doc(db, 'products', product.id), product, { merge: true });
    return product;
  }

  if (path === '/api/orders' && method === 'POST') {
    const items = (body.items || []).map(item => ({ ...item, lineTotal: Number(item.price || 0) * Number(item.qty || 0) }));
    const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
    const shipping = subtotal >= 999 ? 0 : 99;
    const order = {
      id: `MYN-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      status: 'received',
      customer: body.customer || {},
      items,
      subtotal,
      shipping,
      total: subtotal + shipping
    };
    await setDoc(doc(db, 'orders', order.id), { ...order, createdAt: serverTimestamp() });
    return order;
  }

  if (path === '/api/contact' && method === 'POST') {
    await addDoc(collection(db, 'contacts'), { ...body, createdAt: serverTimestamp() });
    return { ok: true };
  }

  if (path === '/api/newsletter' && method === 'POST') {
    await addDoc(collection(db, 'newsletter'), { ...body, createdAt: serverTimestamp() });
    return { ok: true };
  }

  throw new Error('This online backend action is not available yet.');
}

function firebaseUser(user) {
  return { id: user.uid, name: user.displayName || user.email?.split('@')[0] || 'Customer', email: user.email };
}

function firebaseAdmin(user) {
  return { id: user.uid, name: user.displayName || 'Myeonn Admin', email: user.email, role: 'admin' };
}

function orderFromDoc(snapshot) {
  const data = snapshot.data();
  const createdAt = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt;
  return { ...data, id: data.id || snapshot.id, createdAt };
}

export default function App() {
  const [page, setPage] = useState(pageFromLocation);
  const [products, setProducts] = useState(useSupabaseBackend ? [] : fallbackProducts);
  const [cart, setCart] = useState([]);
  const [toast, setToast] = useState('');
  const [panel, setPanel] = useState(null);
  const [infoKey, setInfoKey] = useState(null);
  const [query, setQuery] = useState('');
  const [user, setUser] = useState(null);
  const [admin, setAdmin] = useState(null);
  const [siteOrders, setSiteOrders] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [sizeProduct, setSizeProduct] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    api('/api/products').then(items => setProducts(normalizeProducts(items))).catch(() => setProducts(useSupabaseBackend ? [] : fallbackProducts));
    api('/api/session').then(session => setUser(session.user)).catch(() => setUser(null));
    api('/api/admin/session').then(session => setAdmin(session.admin)).catch(() => setAdmin(null));
  }, []);

  useEffect(() => {
    if (!user) {
      setSiteOrders(readLocalOrders(null));
      return;
    }
    const localOrders = readLocalOrders(user);
    api('/api/orders')
      .then(orders => setSiteOrders(mergeOrders(Array.isArray(orders) ? orders : [], localOrders)))
      .catch(() => setSiteOrders(localOrders));
  }, [user]);

  useEffect(() => {
    const syncPage = () => setPage(pageFromLocation());
    window.addEventListener('popstate', syncPage);
    return () => window.removeEventListener('popstate', syncPage);
  }, []);

  useEffect(() => {
    const pathPage = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const hashPage = window.location.hash.replace(/^#\/?/, '');
    if (pathPage === 'admin' || hashPage === 'admin') window.history.replaceState({}, '', '/');
  }, []);

  useEffect(() => {
    if (useSupabaseBackend || !useFirebaseBackend) return undefined;
    return onAuthStateChanged(auth, current => {
      if (!current) {
        setUser(null);
        setAdmin(null);
        return;
      }
      if (adminEmails.includes(current.email)) {
        setAdmin(firebaseAdmin(current));
        setUser(null);
      } else {
        setUser(firebaseUser(current));
        setAdmin(null);
      }
    });
  }, []);

  useEffect(() => {
    if (admin) setUser(null);
  }, [admin]);

  useEffect(() => {
    if (!useSupabaseBackend || !admin) return;
    const session = supabaseSessionInfo();
    if (!session.hasToken) {
      setAdmin(null);
      setToast('Please login again as Supabase admin.');
    }
  }, [admin]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  const showPage = nextPage => {
    setPage(nextPage);
    const nextPath = nextPage === 'home' || nextPage === 'admin' ? '/' : `/${nextPage}`;
    if (window.location.pathname !== nextPath) window.history.pushState({}, '', nextPath);
    setPanel(null);
    setInfoKey(null);
    setMenuOpen(false);
    window.scrollTo(0, 0);
  };

  const addToCart = product => {
    setSizeProduct(product);
  };

  const addSizedToCart = (product, size) => {
    setCart(items => {
      const stock = stockByProduct[product.id];
      const currentQty = items.filter(item => item.id === product.id).reduce((sum, item) => sum + item.qty, 0);
      if (stock && currentQty >= stock.available) {
        setToast(`${product.name} has only ${stock.available} left in stock.`);
        return items;
      }
      const existing = items.find(item => item.id === product.id && item.size === size);
      setToast(`${product.name} size ${size} added to cart`);
      if (existing) return items.map(item => item.id === product.id && item.size === size ? { ...item, qty: item.qty + 1 } : item);
      return [...items, { id: product.id, name: product.name, price: product.price, meta: productMeta(product), size, qty: 1 }];
    });
    setSizeProduct(null);
    setSelectedProduct(null);
  };

  const openCheckout = () => {
    if (!cart.length) {
      setToast('Your cart is empty');
      return;
    }
    showPage('checkout');
  };

  const removeFromCart = itemToRemove => {
    setCart(items => items.filter(item => !(item.id === itemToRemove.id && item.size === itemToRemove.size)));
    setToast(`${itemToRemove.name} removed from cart`);
  };

  const placeOrder = async customer => {
    if (!cart.length) {
      setToast('Your cart is empty');
      showPage('orders');
      return;
    }
    try {
      const order = await api('/api/orders', { method: 'POST', body: JSON.stringify({ items: cart, customer: customer || user || {} }) });
      saveLocalOrder(order);
      setCart([]);
      setSiteOrders(orders => mergeOrders([order], orders));
      setToast(`Order ${order.id} received. Total ${price(order.total)}`);
      showPage('orders');
    } catch (error) {
      setToast(error.message);
    }
  };

  const searchResults = useMemo(() => {
    const text = query.trim().toLowerCase();
    return products.filter(product => {
      const haystack = [product.name, product.collection, product.category, product.age, product.size, ...(product.tags || [])].join(' ').toLowerCase();
      return !text || haystack.includes(text);
    }).slice(0, 8);
  }, [products, query]);

  const closePanels = () => {
    setPanel(null);
    setInfoKey(null);
    setSelectedProduct(null);
    setSizeProduct(null);
  };
  const stockRows = useMemo(() => calculateStockRows(products, siteOrders), [products, siteOrders]);
  const stockByProduct = useMemo(() => Object.fromEntries(stockRows.map(item => [item.id, item])), [stockRows]);

  return (
    <>
      <Toast message={toast} />
      <div className={`overlay ${panel || infoKey || selectedProduct || sizeProduct ? 'show' : ''}`} onClick={closePanels} />
      <SearchPanel show={panel === 'search'} query={query} setQuery={setQuery} results={searchResults} viewProduct={product => showProduct(product, showPage)} close={closePanels} />
      <CartPanel show={panel === 'cart'} cart={cart} checkout={openCheckout} removeItem={removeFromCart} close={closePanels} />
      <InfoModal info={infoKey ? infoContent[infoKey] : null} close={closePanels} />
      <ProductDetail product={selectedProduct} stock={selectedProduct ? stockByProduct[selectedProduct.id] : null} addToCart={addToCart} close={closePanels} />
      <SizeModal product={sizeProduct} chooseSize={size => addSizedToCart(sizeProduct, size)} close={closePanels} />
      <Nav page={page} user={user} admin={admin} cartCount={cart.reduce((sum, item) => sum + item.qty, 0)} menuOpen={menuOpen} setMenuOpen={setMenuOpen} showPage={showPage} openSearch={() => setPanel('search')} openCart={() => setPanel('cart')} />
      <Strip />
      {page === 'home' && <Home products={products} stockByProduct={stockByProduct} addToCart={addToCart} openProduct={setSelectedProduct} showPage={showPage} openInfo={setInfoKey} />}
      {page === 'kids' && <Collection title="Kids wear" collection="kids" products={products} stockByProduct={stockByProduct} addToCart={addToCart} openProduct={setSelectedProduct} showPage={showPage} openInfo={setInfoKey} />}
      {page === 'men' && <Collection title="Men's wear" collection="men" products={products} stockByProduct={stockByProduct} addToCart={addToCart} openProduct={setSelectedProduct} showPage={showPage} openInfo={setInfoKey} />}
      {page === 'arrivals' && <Arrivals products={products} stockByProduct={stockByProduct} addToCart={addToCart} openProduct={setSelectedProduct} openSubscribe={() => subscribeNewsletter(setToast)} />}
      {page === 'login' && <LoginPage user={user} setUser={setUser} setAdmin={setAdmin} showPage={showPage} setToast={setToast} />}
      {page === 'orders' && <UserOrdersPage user={user} orders={siteOrders} showPage={showPage} setToast={setToast} />}
      {page === 'admin' && <AdminPage admin={admin} products={products} setProducts={setProducts} setAdmin={setAdmin} setUser={setUser} showPage={showPage} setToast={setToast} />}
      {page === 'checkout' && <CheckoutPage user={user} cart={cart} placeOrder={placeOrder} showPage={showPage} setToast={setToast} />}
      {page === 'contact' && <ContactPage setToast={setToast} showPage={showPage} openInfo={setInfoKey} />}
    </>
  );
}

function normalizeProducts(products) {
  return products.map(product => ({
    ...product,
    createdAt: product.created_at || product.createdAt || '',
    image: normalizeImagePath(product.image),
    images: Array.isArray(product.images) ? product.images.map(normalizeImagePath).filter(Boolean) : undefined
  }));
}

function normalizeImagePath(image) {
  if (!image) return '';
  return image.startsWith('images/') ? '/' + image : image;
}

function productImages(product) {
  const images = Array.isArray(product.images) && product.images.length ? product.images : [product.image];
  return images.filter(Boolean);
}

function Nav({ page, user, admin, cartCount, menuOpen, setMenuOpen, showPage, openSearch, openCart }) {
  const links = [['home', 'Home'], ['kids', 'Kids'], ['men', 'Men'], ['arrivals', 'New arrivals'], ['contact', 'Contact'], ...(user ? [['orders', 'Orders']] : []), ['login', user ? 'Account' : 'Login'], ...(admin ? [['admin', 'Admin']] : [])].filter(([id]) => !admin || !['contact', 'login', 'orders'].includes(id));
  return (
    <nav>
      <div className="nav-logo" onClick={() => showPage('home')}>Myeonn</div>
      <div className={`nav-links ${menuOpen ? 'open' : ''}`}>
        {links.map(([id, label]) => <a key={id} onClick={() => showPage(id)} id={`nav-${id}`} className={page === id ? 'active' : ''}><span>{label}</span>{id === 'login' && user && page !== 'admin' && <span className="nav-account-name show"> · {user.name}</span>}</a>)}
      </div>
      <div className="nav-icons">
        <button type="button" onClick={openSearch} aria-label="Search"><i className="ti ti-search" /></button>
        <button type="button" onClick={() => showPage(admin ? 'admin' : 'login')} aria-label={admin ? 'Admin dashboard' : 'Account'} className={user || admin ? 'wishlist-on' : ''}><i className="ti ti-user" /></button>
        <button type="button" className={`cart-badge ${cartCount ? 'has-items' : ''}`} data-count={cartCount} onClick={openCart} aria-label="Cart"><i className="ti ti-shopping-bag" /></button>
        <button type="button" className="menu-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu"><i className="ti ti-menu-2" /></button>
      </div>
    </nav>
  );
}

function Strip() {
  const items = ['Free shipping over ₹999', '·', '15-day returns', '·', '100% quality guarantee', '·', 'New arrivals weekly', '·', 'Free shipping over ₹999', '·', '15-day returns', '·', '100% quality guarantee', '·', 'New arrivals weekly', '·'];
  return <div className="strip"><div className="strip-inner">{items.map((item, i) => <span className="strip-item" key={i}>{item}</span>)}</div></div>;
}

function Home({ products, stockByProduct, addToCart, openProduct, showPage, openInfo }) {
  const picks = [...products]
    .sort((a, b) => (stockByProduct[b.id]?.sold || 0) - (stockByProduct[a.id]?.sold || 0))
    .slice(0, 2);
  return <main className="page active" id="page-home">
    <section className="home-hero"><div><div className="hero-eye">New season · 2026</div><h1 className="hero-h1">Dressed for<br /><em>every moment</em></h1><p className="hero-body">Premium clothing for kids and men — soft on skin, built to last, styled to feel right from first wear to hundredth wash.</p><div className="hero-btns"><button className="btn-gold" onClick={() => showPage('kids')}>Shop kids →</button><button className="btn-ghost" onClick={() => showPage('men')}>Shop men</button></div></div><div className="hero-cards">{[['kids', 'ti-shirt', 'Kids wear', 'Ages 0-14 · Playful fits · Easy care'], ['men', 'ti-tie', "Men's wear", 'Casuals, formals & weekend styles'], ['arrivals', 'ti-sparkles', 'New arrivals', 'Fresh drops every week']].map(item => <div className="hcard" key={item[0]} onClick={() => showPage(item[0])}><div className="hcard-icon"><i className={`ti ${item[1]}`} /></div><div><div className="hcard-title">{item[2]}</div><div className="hcard-sub">{item[3]}</div></div></div>)}</div></section>
    <section className="sec"><div className="sec-label">Browse</div><div className="sec-title">Shop by category</div><div className="cat-grid">{[['kids', 'Kids', 'Little ones', 'Soft, playful & built for adventure'], ['men', 'Men', 'Gentlemen', 'Clean cuts, easy everyday fits'], ['arrivals', 'New', 'New arrivals', "This week's freshest pieces"]].map(cat => <div className="cat-card" key={cat[0]} onClick={() => showPage(cat[0])}><div className="cat-badge">{cat[1]}</div><div className="cat-name">{cat[2]}</div><div className="cat-sub">{cat[3]}</div></div>)}<div className="cat-card" onClick={() => openInfo('sale')}><div className="cat-badge">Sale</div><div className="cat-name">On sale</div><div className="cat-sub">Great styles, better prices</div></div></div></section>
    <ProductSection label="Picks" title="Bestsellers" subtitle="Our most-loved pieces — worn and reworn" products={picks} stockByProduct={stockByProduct} addToCart={addToCart} openProduct={openProduct} alt />
    <section className="sec"><div className="sec-label">Promise</div><div className="sec-title">Why Myeonn?</div><div className="feat-row">{[['ti-shirt', 'Soft fabrics', 'Gentle on skin, built for all-day wear and endless washes'], ['ti-star', 'Quality first', 'Stitched to survive a hundred washes and still look new'], ['ti-truck', 'Fast delivery', 'Delivered to your door in 2-4 working days'], ['ti-refresh', 'Easy returns', 'Hassle-free 15-day return policy, no questions asked']].map(feat => <div className="feat" key={feat[1]}><div className="feat-ico"><i className={`ti ${feat[0]}`} /></div><div className="feat-title">{feat[1]}</div><div className="feat-text">{feat[2]}</div></div>)}</div></section>
    <Testimonials />
    <CTA label="Limited time" title={<>New season, <em>new you</em></>} text="Fresh arrivals — free shipping on orders above ₹999" button="See new arrivals →" onClick={() => showPage('arrivals')} />
    <Footer showPage={showPage} openInfo={openInfo} />
  </main>;
}

function Collection({ title, collection, products, stockByProduct, addToCart, openProduct, showPage, openInfo }) {
  const [filter, setFilter] = useState('All');
  const filters = collection === 'kids' ? ['All', 'Tops', 'Bottoms', 'Sets'] : ['All', 'Shirts', 'T-shirts', 'Trousers', 'Formals', 'Casuals', 'S-XL', 'XXL+'];
  const list = products.filter(product => product.collection === collection).filter(product => filter === 'All' || productMeta(product).toLowerCase().includes(filter.toLowerCase()));
  return <main className="page active">
    <section className="coll-hero"><div><div className="hero-eye">{collection === 'kids' ? 'Kids collection' : "Men's collection"} · 2026</div><h1 className="hero-h1">{collection === 'kids' ? <>Made for<br /><em>little adventures</em></> : <>Effortless style,<br /><em>every day</em></>}</h1><p className="hero-body">{collection === 'kids' ? 'Soft, durable, and playful — clothing that grows with your kids and survives everything they put it through.' : 'From morning meetings to weekend outings — clothing that works as hard as you do and looks good doing it.'}</p></div><div className="coll-hero-img"><i className={`ti ${collection === 'kids' ? 'ti-shirt' : 'ti-tie'}`} /></div></section>
    <section className="sec"><div className="sec-label">Filter</div><div className="sec-title">{title}</div><div className="filter-row">{filters.map(item => <button key={item} className={`filter-btn ${filter === item ? 'active' : ''}`} onClick={() => setFilter(item)}>{item}</button>)}</div><div className="prod-grid-lg">{list.map(product => <ProductCard key={product.id} product={product} stock={stockByProduct[product.id]} addToCart={addToCart} openProduct={openProduct} />)}</div></section>
    <CTA label={collection === 'kids' ? 'For the gentlemen' : 'For the little ones'} title={collection === 'kids' ? <>Also check out <em>men's wear</em></> : <>Also check out <em>kids' wear</em></>} text={collection === 'kids' ? 'Casuals, formals, and weekend fits for dad too' : 'Soft, playful, and built to last — for ages 0 to 14'} button={collection === 'kids' ? "Shop men's →" : 'Shop kids →'} onClick={() => showPage(collection === 'kids' ? 'men' : 'kids')} />
    <Footer showPage={showPage} openInfo={openInfo} />
  </main>;
}

function Arrivals({ products, stockByProduct, addToCart, openProduct, openSubscribe }) {
  const newProducts = [...products].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 2);
  return <main className="page active">
    <section className="arrivals-hero"><div className="sec-label" style={{ color: '#D4AF82', textAlign: 'center' }}>Just dropped</div><h1 className="hero-h1" style={{ color: '#F5F0E8', textAlign: 'center', fontSize: 44 }}>New arrivals</h1><p style={{ color: '#A89F93', textAlign: 'center', marginTop: 12, fontSize: 14 }}>Fresh pieces added every week — be the first to wear them</p></section>
    <section className="sec"><div className="sec-label">This week</div><div className="sec-title">Latest drops</div><div className="arrivals-grid">{newProducts.slice(0, 2).map(product => <div className="arrival-big" key={product.id} onClick={() => openProduct(product)}><div className="arrival-big-img"><ProductCarousel product={product} compact /></div><div><div className="arrival-big-badge">New · {product.collection}</div><div className="arrival-big-name">{product.name} — 2026</div><div className="arrival-big-sub">Fresh fabric, easy care, and a clean Myeonn fit for the season.</div><button className="btn-gold" onClick={event => { event.stopPropagation(); addToCart(product); }}>Add to cart — {price(product.price)}</button></div></div>)}</div></section>
    <CTA label="Never miss a drop" title={<>Get <em>early access</em></>} text="Sign up and be first to know when new pieces land" button="Notify me →" onClick={openSubscribe} />
  </main>;
}

function UserOrdersPage({ user, orders, showPage, setToast }) {
  const [returnRequests, setReturnRequests] = useState(() => readReturnRequests(user));
  const [openReturn, setOpenReturn] = useState(null);
  const [form, setForm] = useState({ reason: 'Size issue', condition: 'Unused with tags', solution: 'Refund', phone: '', description: '' });

  useEffect(() => {
    setReturnRequests(readReturnRequests(user));
  }, [user]);

  const update = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const requestKey = (order, item) => `${order.id}-${item.id || item.name}-${item.size || 'size'}`;
  const startReturn = (order, item) => {
    const key = requestKey(order, item);
    const existing = returnRequests[key];
    setOpenReturn(key);
    setForm(existing || { reason: 'Size issue', condition: 'Unused with tags', solution: 'Refund', phone: order.customer?.phone || '', description: '' });
  };
  const submitReturn = (order, item) => {
    if (!form.description.trim()) {
      setToast('Please add a detailed return description.');
      return;
    }
    const key = requestKey(order, item);
    const next = {
      ...returnRequests,
      [key]: {
        ...form,
        orderId: order.id,
        productId: item.id || '',
        productName: item.name,
        size: item.size || 'Not selected',
        qty: item.qty || 1,
        amount: item.lineTotal || Number(item.price || 0) * Number(item.qty || 1),
        requestedAt: new Date().toISOString(),
        status: 'Return requested'
      }
    };
    setReturnRequests(next);
    saveReturnRequests(user, next);
    setOpenReturn(null);
    setToast(`Return request saved for ${item.name}.`);
  };

  if (!user && !orders.length) {
    return <main className="page active"><section className="contact-hero"><div className="sec-label" style={{ color: '#D4AF82', textAlign: 'center' }}>Orders</div><h1 className="hero-h1" style={{ color: '#F5F0E8', textAlign: 'center', fontSize: 44 }}>Login to view orders</h1><p style={{ color: '#A89F93', textAlign: 'center', marginTop: 12, fontSize: 14 }}>Your past orders and returns are shown after login.</p></section><section className="sec"><button className="btn-gold" onClick={() => showPage('login')}>Login</button></section></main>;
  }

  return <main className="page active">
    <section className="contact-hero"><div className="sec-label" style={{ color: '#D4AF82', textAlign: 'center' }}>Your account</div><h1 className="hero-h1" style={{ color: '#F5F0E8', textAlign: 'center', fontSize: 44 }}>Your orders</h1><p style={{ color: '#A89F93', textAlign: 'center', marginTop: 12, fontSize: 14 }}>Track past orders and request returns for individual products.</p></section>
    <section className="sec">
      <div className="admin-section-title"><div><div className="sec-label">Order history</div><div className="sec-title">Past orders</div></div><button className="btn-outline-dark" onClick={() => showPage('kids')}>Continue shopping</button></div>
      <div className="user-order-list">{orders.length ? orders.map(order => <div className="user-order-card" key={order.id}>
        <div className="user-order-head"><div><strong>{order.id}</strong><span>{order.createdAt ? new Date(order.createdAt).toLocaleString('en-IN') : 'No date'}</span></div><span className={`status-pill status-${order.status || 'received'}`}>{order.status || 'received'}</span></div>
        <div className="user-order-summary"><span>Total {price(order.total)}</span><span>{paymentMethodLabel(order)}</span><span>{order.shipping ? `Shipping ${price(order.shipping)}` : 'Free shipping'}</span><span>{(order.items || []).length} product{(order.items || []).length === 1 ? '' : 's'}</span></div>
        <div className="return-items">{(order.items || []).map(item => {
          const key = requestKey(order, item);
          const saved = returnRequests[key];
          return <div className="return-item" key={key}>
            <div className="return-item-main"><div><div className="cart-name">{item.name}</div><div className="cart-meta">Size {item.size || 'Not selected'} · Qty {item.qty || 1} · {price(item.lineTotal || Number(item.price || 0) * Number(item.qty || 1))}</div></div>{saved ? <span className="return-status">{saved.status}</span> : <button className="btn-outline-dark" onClick={() => startReturn(order, item)}>Return product</button>}</div>
            {saved && <div className="return-saved"><strong>Return details</strong><span>Reason: {saved.reason}</span><span>Condition: {saved.condition}</span><span>Request: {saved.solution}</span><span>Phone: {saved.phone || 'Not added'}</span><p>{saved.description}</p><button className="btn-outline-dark" onClick={() => startReturn(order, item)}>Edit return details</button></div>}
            {openReturn === key && <div className="return-form"><div className="form-row"><div className="form-field"><label>Return reason</label><select value={form.reason} onChange={event => update('reason', event.target.value)}>{['Size issue', 'Wrong product received', 'Damaged product', 'Quality issue', 'Changed my mind', 'Other'].map(option => <option key={option}>{option}</option>)}</select></div><div className="form-field"><label>Product condition</label><select value={form.condition} onChange={event => update('condition', event.target.value)}>{['Unused with tags', 'Unused without tags', 'Tried once', 'Damaged on arrival', 'Other'].map(option => <option key={option}>{option}</option>)}</select></div></div><div className="form-row"><div className="form-field"><label>Preferred solution</label><select value={form.solution} onChange={event => update('solution', event.target.value)}>{['Refund', 'Exchange size', 'Exchange product', 'Store credit'].map(option => <option key={option}>{option}</option>)}</select></div><Field label="Return contact phone" type="tel" value={form.phone} onChange={phone => update('phone', phone)} placeholder="+91 98765 43210" /></div><div className="form-field"><label>Detailed product description</label><textarea value={form.description} onChange={event => update('description', event.target.value)} placeholder="Describe exactly why this product is being returned. Example: size too small, stitching issue near sleeve, color mismatch, damaged package, etc." /></div><div className="account-actions"><button className="btn-gold" onClick={() => submitReturn(order, item)}>Submit return request</button><button className="btn-outline-dark" onClick={() => setOpenReturn(null)}>Cancel</button></div></div>}
          </div>;
        })}</div>
      </div>) : <div className="cart-empty">No past orders yet. When you place an order, it will appear here.</div>}</div>
    </section>
  </main>;
}

function AdminPage({ admin, products, setProducts, setAdmin, setUser, showPage, setToast }) {
  const [showPassword, setShowPassword] = useState(false);
  const [login, setLogin] = useState({ email: '', password: '' });
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeSection, setActiveSection] = useState('inventory');
  const [editingProduct, setEditingProduct] = useState(null);
  const stockRows = useMemo(() => calculateStockRows(products, orders), [products, orders]);
  const supabaseSession = useMemo(() => useSupabaseBackend ? supabaseSessionInfo() : null, [admin]);
  const stockSummary = useMemo(() => ({
    totalProducts: stockRows.length,
    available: stockRows.reduce((sum, item) => sum + item.available, 0),
    low: stockRows.filter(item => item.status === 'low').length,
    out: stockRows.filter(item => item.status === 'out').length,
    sold: stockRows.reduce((sum, item) => sum + item.sold, 0)
  }), [stockRows]);

  const loadOrders = async () => {
    if (!admin) return;
    setLoading(true);
    try {
      const [latestOrders, latestProducts] = await Promise.all([api('/api/admin/orders'), api('/api/products')]);
      setOrders(latestOrders);
      setProducts(normalizeProducts(latestProducts));
    } catch (error) {
      setToast(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrders();
  }, [admin]);

  useEffect(() => {
    if (!admin) return;
    const lowCount = stockSummary.low + stockSummary.out;
    if (lowCount) setToast(`Stock alert: ${lowCount} product${lowCount === 1 ? '' : 's'} need attention.`);
  }, [admin, stockSummary.low, stockSummary.out]);

  const submitLogin = async () => {
    try {
      const result = await api('/api/admin/login', { method: 'POST', body: JSON.stringify(login) });
      if (!useSupabaseBackend) {
        try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
      }
      setUser(null);
      setAdmin(result.admin);
      setToast(`Admin signed in as ${result.admin.name}.`);
    } catch (error) {
      setToast(error.message);
    }
  };

  const logout = async () => {
    try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } catch {}
    setAdmin(null);
    setOrders([]);
    setToast('Admin signed out.');
  };

  const setStatus = async (orderId, status) => {
    try {
      const updated = await api(`/api/admin/orders/${encodeURIComponent(orderId)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setOrders(items => items.map(item => item.id === orderId ? updated : item));
      setToast(`Order ${orderId} marked ${status}.`);
    } catch (error) {
      setToast(error.message);
    }
  };

  const editStock = async product => {
    const value = window.prompt(`Enter stock for ${product.name}`, String(product.opening));
    if (value === null) return;
    const stock = Number(value);
    if (!Number.isInteger(stock) || stock < 0) {
      setToast('Stock must be a whole number.');
      return;
    }
    try {
      const updated = await api('/api/admin/products', { method: 'POST', body: JSON.stringify({ ...product, stock }) });
      setProducts(items => items.map(item => item.id === updated.id ? normalizeProducts([updated])[0] : item));
      setToast(`${updated.name} stock updated to ${stock}.`);
    } catch (error) {
      setToast(error.message);
    }
  };

  const addProduct = async form => {
    const product = productFromForm(form);
    if (!product.name || !product.category || !Number.isFinite(product.price) || product.price <= 0) {
      setToast('Please enter product name, category, and a valid price.');
      return;
    }
    if (!Number.isInteger(product.stock) || product.stock < 0) {
      setToast('Stock must be a whole number.');
      return;
    }
    try {
      if (form.imageFiles?.length) {
        setToast('Uploading product images...');
        product.images = [...(product.images || []), ...(await uploadProductImages(product.id, form.imageFiles))];
      }
      const saved = await api('/api/admin/products', { method: 'POST', body: JSON.stringify(product) });
      setProducts(items => {
        const normalized = normalizeProducts([saved])[0];
        return items.some(item => item.id === normalized.id) ? items.map(item => item.id === normalized.id ? normalized : item) : [normalized, ...items];
      });
      setEditingProduct(null);
      setToast(`${saved.name} saved to products.`);
      setActiveSection('listings');
    } catch (error) {
      setToast(error.message);
    }
  };

  const editProduct = product => {
    setEditingProduct(product);
    setActiveSection('add-product');
  };

  if (!admin) {
    return <main className="page active"><section className="contact-hero"><div className="sec-label" style={{ color: '#D4AF82', textAlign: 'center' }}>Admin</div><h1 className="hero-h1" style={{ color: '#F5F0E8', textAlign: 'center', fontSize: 44 }}>Admin login</h1><p style={{ color: '#A89F93', textAlign: 'center', marginTop: 12, fontSize: 14 }}>Sign in here to confirm orders and mark packs as shipped</p></section><section className="sec"><div className="admin-login-card"><div className="sec-label">Order desk</div><div className="sec-title" style={{ marginBottom: 24 }}>Manager access</div><Field label="Admin email" type="email" value={login.email} onChange={email => setLogin({ ...login, email })} placeholder="admin@myeonn.com" /><PasswordField value={login.password} onChange={password => setLogin({ ...login, password })} showing={showPassword} toggle={() => setShowPassword(!showPassword)} placeholder="Admin password" /><div className="account-actions"><button className="btn-gold" onClick={submitLogin}>Login as admin</button><button className="btn-outline-dark" onClick={() => showPage('login')}>Login as user</button></div></div></section></main>;
  }

  return <main className="page active admin-page"><AdminSidebar active={activeSection} setActive={setActiveSection} /><section className="admin-content"><div className="admin-toolbar"><div><div className="sec-label">Seller dashboard</div><div className="admin-name">{admin.name}</div><div className="admin-email">{admin.email}</div>{supabaseSession && <div className="admin-email">Supabase UID: {supabaseSession.uid || 'not logged in'}</div>}</div><div className="account-actions"><button className="btn-outline-dark" onClick={loadOrders}>{loading ? 'Refreshing...' : 'Refresh dashboard'}</button><button className="btn-dark" onClick={logout}>Sign out</button></div></div>{activeSection === 'home' && <AdminHome summary={stockSummary} orders={orders} />}{activeSection === 'listings' && <ListingsPanel rows={stockRows} />}{activeSection === 'add-product' && <AddProductPanel key={editingProduct?.id || 'new-product'} addProduct={addProduct} product={editingProduct} cancelEdit={() => setEditingProduct(null)} />}{activeSection === 'inventory' && <StockDashboard rows={stockRows} summary={stockSummary} editStock={editStock} editProduct={editProduct} />}{activeSection === 'orders' && <OrdersPanel orders={orders} setStatus={setStatus} />}{activeSection === 'payments' && <PaymentsPanel orders={orders} />}{['growth', 'ads', 'reports', 'partner'].includes(activeSection) && <AdminPlaceholder section={activeSection} />}</section></main>;
}

function AdminSidebar({ active, setActive }) {
  const items = [
    ['home', 'ti-home', 'Home'],
    ['listings', 'ti-list-details', 'Listings'],
    ['add-product', 'ti-square-plus', 'Add Product'],
    ['inventory', 'ti-building-warehouse', 'Inventory'],
    ['orders', 'ti-package', 'Orders'],
    ['payments', 'ti-credit-card', 'Payments'],
    ['growth', 'ti-chart-arrows-vertical', 'Growth'],
    ['ads', 'ti-speakerphone', 'Ads'],
    ['reports', 'ti-clipboard-list', 'Reports'],
    ['partner', 'ti-users-group', 'Partner Services']
  ];
  return <aside className="admin-sidebar">{items.map(([id, icon, label]) => <button key={id} className={active === id ? 'active' : ''} onClick={() => setActive(id)}><span className="admin-side-icon"><i className={`ti ${icon}`} />{id === 'ads' && <span className="admin-dot" />}</span><span>{label}</span></button>)}</aside>;
}

function AddProductPanel({ addProduct, product, cancelEdit }) {
  const categoryOptions = {
    kids: ['Tops', 'T Shirt', 'Hoodie', 'Bottoms', 'Sets'],
    men: ['Shirts', 'T-shirts', 'Trousers', 'Formals', 'Casuals']
  };
  const ageSizeOptions = {
    kids: ['Ages 5-16', 'Ages 0-4', 'Ages 4-8', 'Ages 8-14'],
    men: ['S-XL', 'XXL+', 'S', 'M', 'L', 'XL', 'XXL']
  };
  const [form, setForm] = useState({
    id: product?.id || '',
    name: product?.name || '',
    collection: product?.collection || 'kids',
    category: product?.category || 'Tops',
    age: product?.age || 'Ages 5-16',
    size: product?.size || '5-16',
    price: product?.price || '',
    stock: product?.stock ?? product?.opening ?? 50,
    images: productImages(product || {}),
    tags: (product?.tags || ['hoodie', 'kids']).join(', ')
  });
  const [existingImages, setExistingImages] = useState(productImages(product || {}));
  const [imageFiles, setImageFiles] = useState([]);
  const update = (key, value) => setForm(current => {
    if (key === 'collection') {
      return {
        ...current,
        collection: value,
        category: categoryOptions[value].includes(current.category) ? current.category : categoryOptions[value][0],
        age: value === 'kids' ? (current.age || ageSizeOptions.kids[0]) : '',
        size: value === 'men' ? (current.size || ageSizeOptions.men[0]) : ''
      };
    }
    return { ...current, [key]: value };
  });
  const chooseImages = event => {
    const files = Array.from(event.target.files || []).slice(0, 5);
    setImageFiles(current => [...current, ...files].slice(0, 5));
    event.target.value = '';
  };
  const removeImage = index => {
    setImageFiles(current => current.filter((_, itemIndex) => itemIndex !== index));
  };
  const removeExistingImage = index => {
    setExistingImages(current => current.filter((_, itemIndex) => itemIndex !== index));
  };
  const save = () => addProduct({ ...form, images: existingImages, imageFiles });
  return <div><div className="admin-section-title"><div><div className="sec-label">Supabase products</div><div className="sec-title">{product ? 'Edit product' : 'Add new product'}</div></div>{product && <button className="btn-outline-dark" onClick={cancelEdit}>New product</button>}</div><div className="admin-form-card"><div className="form-row"><Field label="Product name" value={form.name} onChange={value => update('name', value)} placeholder="Falcan hoodie" /><Field label="Price" type="number" value={form.price} onChange={value => update('price', value)} placeholder="525" /></div><div className="form-row"><div className="form-field"><label>Collection</label><select value={form.collection} onChange={event => update('collection', event.target.value)}><option value="kids">Kids</option><option value="men">Men</option></select></div><div className="form-field"><label>Category</label><select value={form.category} onChange={event => update('category', event.target.value)}>{categoryOptions[form.collection].map(option => <option key={option} value={option}>{option}</option>)}</select></div></div><div className="form-row"><div className="form-field"><label>Age / Size label</label><select value={form.collection === 'kids' ? form.age : form.size} onChange={event => update(form.collection === 'kids' ? 'age' : 'size', event.target.value)}>{ageSizeOptions[form.collection].map(option => <option key={option} value={option}>{option}</option>)}</select></div><Field label="Stock" type="number" value={form.stock} onChange={value => update('stock', value)} placeholder="50" /></div><div className="form-field"><label>Product images</label><input type="file" accept="image/*" multiple onChange={chooseImages} /><small className="field-hint">Free mode: choose one image, then click Choose Files again to add another. Existing images will stay. Maximum 5 images.</small></div>{(existingImages.length > 0 || imageFiles.length > 0) && <div className="image-preview-row">{existingImages.map((url, index) => <div className="image-preview" key={`${url}-${index}`}><img src={url} alt={`Existing product ${index + 1}`} /><span>{index + 1}</span><button type="button" className="image-remove" onClick={() => removeExistingImage(index)} aria-label="Remove image"><i className="ti ti-x" /></button></div>)}{imageFiles.map((file, index) => { const url = URL.createObjectURL(file); return <div className="image-preview" key={`${file.name}-${file.lastModified}-${index}`}><img src={url} alt={`Product preview ${existingImages.length + index + 1}`} onLoad={() => URL.revokeObjectURL(url)} /><span>{existingImages.length + index + 1}</span><button type="button" className="image-remove" onClick={() => removeImage(index)} aria-label="Remove image"><i className="ti ti-x" /></button></div>; })}</div>}<Field label="Tags" value={form.tags} onChange={value => update('tags', value)} placeholder="hoodie, black, kids" /><button className="btn-gold" onClick={save}>{product ? 'Save product changes' : 'Save product to Supabase'}</button></div></div>;
}

function AdminHome({ summary, orders }) {
  const pending = orders.filter(order => order.status !== 'shipped').length;
  const revenue = orders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  return <div><div className="admin-section-title"><div><div className="sec-label">Home</div><div className="sec-title">Overview</div></div></div><div className="seller-cards"><div className="seller-card"><span>Pending packs</span><strong>{pending}</strong></div><div className="seller-card"><span>Total sales</span><strong>{price(revenue)}</strong></div><div className="seller-card"><span>Products live</span><strong>{summary.totalProducts}</strong></div><div className="seller-card"><span>Stock available</span><strong>{summary.available}</strong></div></div></div>;
}

function ListingsPanel({ rows }) {
  return <div><div className="admin-section-title"><div><div className="sec-label">Listings</div><div className="sec-title">Product listings</div></div></div><div className="listing-table"><div className="listing-row listing-head"><span>Product</span><span>Collection</span><span>Category</span><span>Price</span><span>Stock</span></div>{rows.map(product => <div className="listing-row" key={product.id}><span><strong>{product.name}</strong><small>{product.id}</small></span><span>{product.collection}</span><span>{product.category}</span><span>{price(product.price)}</span><span>{product.available} available</span></div>)}</div></div>;
}

function StockDashboard({ rows, summary, editStock, editProduct }) {
  const cards = [['Listed products', summary.totalProducts], ['Units in stock', summary.available], ['Low stock', summary.low], ['Out of stock', summary.out], ['Units sold', summary.sold]];
  return <div className="stock-dashboard"><div className="admin-section-title"><div><div className="sec-label">Inventory</div><div className="sec-title">Stock details</div></div></div><div className="stock-metrics">{cards.map(card => <div className="stock-metric" key={card[0]}><span>{card[0]}</span><strong>{card[1]}</strong></div>)}</div>{summary.low + summary.out > 0 && <div className="stock-alert"><i className="ti ti-alert-triangle" /> Low stock alert: {summary.low + summary.out} product{summary.low + summary.out === 1 ? '' : 's'} need attention.</div>}<div className="stock-table"><div className="stock-row stock-head"><span>Product</span><span>Category</span><span>Opening</span><span>Sold</span><span>Available</span><span>Status</span><span>Action</span></div>{rows.map(item => <div className="stock-row" key={item.id}><span><strong>{item.name}</strong><small>{item.id}</small></span><span>{item.collection} · {item.category}</span><span>{item.opening}</span><span>{item.sold}</span><span>{item.available}</span><span><b className={`stock-status stock-${item.status}`}>{item.status === 'ready' ? 'In stock' : item.status === 'low' ? 'Low stock' : 'Out'}</b></span><span className="stock-actions"><button className="stock-edit-btn" onClick={() => editStock(item)}>Edit stock</button><button className="stock-edit-btn" onClick={() => editProduct(item)}>Edit product</button></span></div>)}</div></div>;
}

function OrdersPanel({ orders, setStatus }) {
  const tabs = [
    { id: 'received', label: 'Before confirmation', empty: 'No orders waiting for confirmation.' },
    { id: 'confirmed', label: 'After confirmation', empty: 'No confirmed orders waiting to ship.' },
    { id: 'shipped', label: 'Shipped', empty: 'No shipped orders yet.' }
  ];
  const [activeTab, setActiveTab] = useState('received');
  const [selectedOrders, setSelectedOrders] = useState([]);
  const visibleOrders = orders.filter(order => (order.status || 'received') === activeTab);
  const canBulkSelect = ['received', 'confirmed'].includes(activeTab);
  const selectedVisibleOrders = visibleOrders.filter(order => selectedOrders.includes(order.id));
  const allVisibleSelected = Boolean(visibleOrders.length) && visibleOrders.every(order => selectedOrders.includes(order.id));
  const toggleOrder = orderId => setSelectedOrders(items => items.includes(orderId) ? items.filter(id => id !== orderId) : [...items, orderId]);
  const toggleAll = () => setSelectedOrders(allVisibleSelected ? [] : visibleOrders.map(order => order.id));
  const bulkStatus = activeTab === 'received' ? 'confirmed' : 'shipped';
  const bulkLabel = activeTab === 'received' ? 'Confirm selected' : 'Mark selected shipped';
  const runBulkAction = async () => {
    for (const order of selectedVisibleOrders) await setStatus(order.id, bulkStatus);
    setSelectedOrders([]);
  };
  useEffect(() => {
    setSelectedOrders([]);
  }, [activeTab, orders.length]);
  return <div><div className="admin-section-title"><div><div className="sec-label">Orders</div><div className="sec-title">Packing queue</div></div></div><div className="order-tabs">{tabs.map(tab => <button key={tab.id} className={`order-tab ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}>{tab.label}<span>{orders.filter(order => (order.status || 'received') === tab.id).length}</span></button>)}</div>{canBulkSelect && visibleOrders.length > 0 && <div className="order-bulk-bar"><label className="order-select-all"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} /> Select all {visibleOrders.length} orders</label><div className="order-bulk-actions"><span>{selectedVisibleOrders.length} selected</span><button className="btn-gold" onClick={runBulkAction} disabled={!selectedVisibleOrders.length}>{bulkLabel}</button></div></div>}<div className="order-list">{visibleOrders.length ? visibleOrders.map(order => <AdminOrder key={order.id} order={order} setStatus={setStatus} selectable={canBulkSelect} selected={selectedOrders.includes(order.id)} onSelect={() => toggleOrder(order.id)} />) : <div className="cart-empty">{tabs.find(tab => tab.id === activeTab)?.empty}</div>}</div></div>;
}

function paymentState(order) {
  const status = order.status || 'received';
  if (status === 'shipped') return { label: 'Settled', className: 'paid' };
  if (status === 'confirmed') return { label: 'Paid', className: 'paid' };
  return { label: 'Awaiting confirmation', className: 'pending' };
}

function downloadPaymentsReport(orders) {
  const rows = [['Order ID', 'Date', 'Customer', 'Email', 'Phone', 'Alternate Phone', 'Address', 'Landmark', 'City', 'State', 'Pincode', 'Country', 'Status', 'Payment Method', 'Payment', 'Subtotal', 'Shipping', 'Total']];
  orders.forEach(order => {
    const customer = order.customer || {};
    rows.push([
      order.id,
      order.createdAt ? new Date(order.createdAt).toLocaleString('en-IN') : '',
      customer.name || '',
      customer.email || '',
      customer.phone || '',
      customer.altPhone || '',
      customer.address || '',
      customer.landmark || '',
      customer.city || '',
      customer.state || '',
      customer.pincode || '',
      customer.country || '',
      order.status || 'received',
      paymentMethodLabel(order),
      paymentState(order).label,
      order.subtotal || 0,
      order.shipping || 0,
      order.total || 0
    ]);
  });
  const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `myeonn-payments-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function PaymentsPanel({ orders }) {
  const confirmedOrders = orders.filter(order => ['confirmed', 'shipped'].includes(order.status || 'received'));
  const pendingOrders = orders.filter(order => (order.status || 'received') === 'received');
  const shippedOrders = orders.filter(order => (order.status || 'received') === 'shipped');
  const totalSales = orders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const paidAmount = confirmedOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const pendingAmount = pendingOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const settledAmount = shippedOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  return <div><div className="admin-section-title"><div><div className="sec-label">Payments</div><div className="sec-title">Payment overview</div></div><button className="btn-outline-dark" onClick={() => downloadPaymentsReport(orders)} disabled={!orders.length}>Download report</button></div><div className="payment-metrics"><div className="stock-metric"><span>Total orders</span><strong>{orders.length}</strong></div><div className="stock-metric"><span>Total sales</span><strong>{price(totalSales)}</strong></div><div className="stock-metric"><span>Paid amount</span><strong>{price(paidAmount)}</strong></div><div className="stock-metric"><span>Pending</span><strong>{price(pendingAmount)}</strong></div><div className="stock-metric"><span>Settled</span><strong>{price(settledAmount)}</strong></div></div><div className="payment-card"><div className="payment-head"><div><div className="sec-label">Transactions</div><div className="payment-title">Order payments</div></div><span>Online payment</span></div>{orders.length ? <div className="payment-table"><div className="payment-row payment-row-head"><span>Order</span><span>Customer</span><span>Method</span><span>Status</span><span>Total</span></div>{orders.map(order => { const customer = order.customer || {}; const state = paymentState(order); return <div className="payment-row" key={order.id}><span><strong>{order.id}</strong><small>{order.createdAt ? new Date(order.createdAt).toLocaleString('en-IN') : 'No date'}</small></span><span><strong>{customer.name || 'Customer'}</strong><small>{customer.email || customer.phone || 'No contact'}</small></span><span>{paymentMethodLabel(order)}</span><span><b className={`payment-pill ${state.className}`}>{state.label}</b></span><span><strong>{price(order.total)}</strong><small>{order.shipping ? `Shipping ${price(order.shipping)}` : 'Free shipping'}</small></span></div>; })}</div> : <div className="cart-empty">No payments yet. New order payments will appear here.</div>}</div></div>;
}

function AdminPlaceholder({ section }) {
  const labels = { payments: 'Payments', growth: 'Growth', ads: 'Ads', reports: 'Reports', partner: 'Partner Services' };
  return <div><div className="admin-section-title"><div><div className="sec-label">{labels[section]}</div><div className="sec-title">{labels[section]}</div></div></div><div className="admin-empty-panel"><i className="ti ti-settings" /><strong>{labels[section]} tools</strong><span>This section is ready for the next backend feature.</span></div></div>;
}

function escapeLabelText(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function labelSeed(value) {
  return String(value || '').split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) || 37;
}

function labelBarcode(value, count = 52) {
  const seed = labelSeed(value);
  return Array.from({ length: count }, (_, index) => {
    const width = ((seed + index * 7) % 4) + 1;
    const gap = ((seed + index * 3) % 2) + 1;
    return `<span style="width:${width}px;margin-right:${gap}px"></span>`;
  }).join('');
}

function labelQr(value) {
  const seed = labelSeed(value);
  return Array.from({ length: 21 * 21 }, (_, index) => {
    const x = index % 21;
    const y = Math.floor(index / 21);
    const inTopLeft = x < 6 && y < 6;
    const inTopRight = x > 14 && y < 6;
    const inBottomLeft = x < 6 && y > 14;
    const finder = inTopLeft || inTopRight || inBottomLeft;
    const finderFill = finder && (x % 5 === 0 || y % 5 === 0 || (x % 5 > 1 && x % 5 < 4 && y % 5 > 1 && y % 5 < 4));
    const fill = finder ? finderFill : ((x * 11 + y * 7 + seed) % 5 !== 0);
    return `<span class="${fill ? 'black' : ''}"></span>`;
  }).join('');
}

function printShippingLabel(order) {
  const customer = order.customer || {};
  const orderDate = order.createdAt ? new Date(order.createdAt) : new Date();
  const printedDate = orderDate.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: '2-digit' });
  const printedTime = orderDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', '');
  const routeCode = String(customer.pincode || order.id || '000000').slice(-2).padStart(2, '0');
  const orderCode = escapeLabelText(String(order.id || 'MYEONN').toUpperCase());
  const awbCode = escapeLabelText(`FMPP${String(labelSeed(order.id)).padStart(8, '0')}`);
  const shortAddress = [customer.address, customer.landmark, customer.city, customer.state, customer.pincode, customer.country].filter(Boolean).join(', ');
  const itemRows = (order.items || []).map((item, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeLabelText(item.id || item.name || 'SKU')}</td>
      <td>${escapeLabelText(item.name || 'Product')}<br><small>Size ${escapeLabelText(item.size || 'Not selected')}</small></td>
      <td>${escapeLabelText(item.qty || 1)}</td>
    </tr>
  `).join('');
  const label = window.open('', '_blank', 'width=430,height=680');
  if (!label) return;
  label.document.write(`
    <html>
      <head>
        <title>Shipping label ${escapeLabelText(order.id)}</title>
        <style>
          *{box-sizing:border-box}
          @page{size:4in 6in;margin:0}
          html,body{width:4in;min-height:6in}
          body{font-family:Arial,sans-serif;margin:0;padding:0;color:#111;background:#fff}
          .label{width:4in;height:6in;border:2px solid #111;background:#fff;overflow:hidden}
          .row{display:grid;border-bottom:1px solid #111}
          .top{grid-template-columns:48px 1fr 142px 26px;height:.39in}
          .cell{border-right:1px solid #111;padding:3px 5px;font-size:10px;line-height:1.05}
          .cell:last-child{border-right:0}
          .std{font-weight:800;font-size:16px;text-align:center;padding-top:8px}
          .brand{font-weight:800;font-size:8px}
          .top-code{font-size:11px;border-top:1px solid #111;margin-top:2px;padding-top:1px}
          .surface{display:flex;align-items:end;font-weight:800;font-size:12px;letter-spacing:.5px;text-transform:uppercase;padding-bottom:4px}
          .big-e{font-size:20px;font-weight:800;text-align:center;padding-top:6px}
          .main{grid-template-columns:124px 1fr;height:2.31in}
          .ordered{height:.51in;border-bottom:1px solid #111;text-align:left;padding:3px 5px}
          .ordered-title{font-size:11px}
          .flip{font-weight:800;font-style:italic;font-size:15px;margin:3px 0 0 24px;display:inline-block}
          .vertical-code{writing-mode:vertical-rl;transform:rotate(180deg);font-size:11px;letter-spacing:1px;position:absolute;left:4px;top:1.35in}
          .left-block{position:relative;padding:0}
          .barcode-vertical{height:1.78in;display:flex;align-items:flex-end;gap:1px;transform:rotate(90deg);transform-origin:center;width:1.78in;position:absolute;left:-.13in;top:1.18in}
          .barcode-vertical span,.barcode-horizontal span{display:inline-block;background:#111;height:.95in}
          .awb{writing-mode:vertical-rl;font-weight:800;font-size:11px;letter-spacing:.8px;position:absolute;right:7px;top:.88in}
          .dates{position:absolute;left:6px;bottom:7px;font-size:14px;line-height:1.13}
          .right-main{display:grid;grid-template-rows:1.72in 1fr}
          .qr-wrap{display:flex;align-items:center;justify-content:center;border-bottom:1px solid #111}
          .qr{display:grid;grid-template-columns:repeat(21,7px);grid-template-rows:repeat(21,7px);gap:0;background:#fff;border:5px solid #fff}
          .qr span{width:7px;height:7px;background:#fff}
          .qr .black{background:#111}
          .address-box{padding:4px 5px;font-size:12px;line-height:1.08;overflow:hidden}
          .label-title{font-size:12px}
          .name{font-weight:400;font-size:14px;margin-top:1px}
          .address{font-size:11px;margin-top:1px;line-height:1.12}
          .seller{height:.55in;padding:4px 5px;font-size:9px;line-height:1.25;border-bottom:1px solid #111;overflow:hidden}
          .seller strong{font-size:10px}
          .gst{border-top:1px solid #111;margin:2px -5px 0;padding:1px 5px}
          table{width:100%;border-collapse:collapse;font-size:9px;height:.96in}
          th,td{border:1px solid #111;border-left:0;padding:2px 3px;text-align:left;vertical-align:top}
          th:last-child,td:last-child{border-right:0;text-align:center;width:28px}
          th{font-weight:800}
          small{font-size:8px}
          .bottom{display:grid;grid-template-columns:1fr 68px;align-items:end;padding:5px 8px 4px;border-bottom:1px solid #111;height:.56in}
          .barcode-horizontal{height:31px;display:flex;align-items:flex-end;gap:0;margin-top:2px;overflow:hidden}
          .barcode-horizontal span{height:28px}
          .cod{border:2px solid #111;font-size:25px;font-weight:800;text-align:center;padding:4px 2px;margin-left:8px}
          .footer{display:flex;justify-content:space-between;padding:3px 5px;font-size:9px;font-weight:800;height:.18in}
          @media screen{body{padding:12px}.label{box-shadow:0 8px 24px rgba(0,0,0,.18)}}
          @media print{html,body{width:4in;height:6in;padding:0}.label{width:4in;height:6in;border:2px solid #111;box-shadow:none}}
        </style>
      </head>
      <body>
        <div class="label">
          <div class="row top">
            <div class="cell std">STD</div>
            <div class="cell"><div class="brand">E-Kart Logistics</div><div class="top-code">${orderCode}</div></div>
            <div class="cell surface">PREPAID</div>
            <div class="cell big-e">E</div>
          </div>
          <div class="row main">
            <div class="cell left-block">
              <div class="ordered"><div class="ordered-title">Ordered through</div><span class="flip">Myeonn</span></div>
              <div class="vertical-code">${orderCode}</div>
              <div class="barcode-vertical">${labelBarcode(order.id, 34)}</div>
              <div class="awb">AWB No. - ${awbCode}</div>
              <div class="dates">HBD: DD - MM<br>CPD: DD - MM</div>
            </div>
            <div class="right-main">
              <div class="qr-wrap"><div class="qr">${labelQr(order.id)}</div></div>
              <div class="address-box">
                <div class="label-title">Shipping/Customer address:</div>
                <div class="name">${escapeLabelText(customer.name || 'Customer')}</div>
                <div class="address">${escapeLabelText(shortAddress || 'No address')}<br>Phone: ${escapeLabelText(customer.phone || 'No phone')}${customer.altPhone ? `<br>Alt: ${escapeLabelText(customer.altPhone)}` : ''}</div>
              </div>
            </div>
          </div>
          <div class="seller">Sold By:<strong>M/S Ultralabz Ventures</strong>, Near Reshape Fitness, Mahadev Talaab Road, Near By Giridih Public School Giridih, Jharkhand, Giridih - 815301<div class="gst">GSTIN: 20AAIFU3374R1ZO</div></div>
          <table>
            <thead><tr><th></th><th>SKU ID</th><th>Description</th><th>QTY</th></tr></thead>
            <tbody>${itemRows || '<tr><td>1</td><td>MYEONN</td><td>Product</td><td>1</td></tr>'}</tbody>
          </table>
          <div class="bottom">
            <div>
              <div>${awbCode}</div>
              <div class="barcode-horizontal">${labelBarcode(`${order.id}-${customer.pincode}`, 58)}</div>
            </div>
            <div class="cod">B${routeCode}</div>
          </div>
          <div class="footer"><span>Not for resale.</span><span>Printed at ${escapeLabelText(printedTime)} hrs, ${escapeLabelText(printedDate)}</span></div>
        </div>
        <script>window.onload = () => setTimeout(() => window.print(), 150);</script>
      </body>
    </html>
  `);
  label.document.close();
}

function AdminOrder({ order, setStatus, selectable, selected, onSelect }) {
  const customer = order.customer || {};
  const status = order.status || 'received';
  return <div className={`order-card ${selected ? 'selected' : ''}`}><div className="order-head"><div className="order-head-main">{selectable && <label className="order-select"><input type="checkbox" checked={selected} onChange={onSelect} /> Select</label>}<div><div className="order-id">{order.id}</div><div className="admin-email">{new Date(order.createdAt).toLocaleString()}</div></div></div><span className={`status-pill status-${status}`}>{status}</span></div><div className="order-grid"><div className="order-detail"><strong>Customer</strong><span>{customer.name || 'No name'}</span><span>{customer.email || 'No email'}</span><span>{customer.phone || 'No phone'}</span>{customer.altPhone && <span>Alt: {customer.altPhone}</span>}</div><div className="order-detail"><strong>Delivery</strong><span>{customer.address || 'No address'}</span>{customer.landmark && <span>{customer.landmark}</span>}<span>{[customer.city, customer.state, customer.pincode].filter(Boolean).join(' - ') || 'No city/state/pincode'}</span><span>{customer.country || 'India'}</span></div><div className="order-detail"><strong>Total</strong><span>{price(order.total)}</span><span>{paymentMethodLabel(order)}</span><span>{order.shipping ? `Shipping ${price(order.shipping)}` : 'Free shipping'}</span></div></div><div className="order-items">{(order.items || []).map(item => <div className="checkout-row" key={`${item.id}-${item.size || 'size'}`}><div><div className="cart-name">{item.name}</div><div className="cart-meta">Size {item.size || 'Not selected'} · Qty {item.qty}</div></div><div className="cart-name">{price(item.lineTotal)}</div></div>)}</div><div className="order-actions">{status === 'received' && <button className="btn-gold" onClick={() => setStatus(order.id, 'confirmed')}>Confirm order</button>}{status === 'confirmed' && <button className="btn-outline-dark" onClick={() => printShippingLabel(order)}>Print shipping label</button>}{status === 'confirmed' && <button className="btn-gold" onClick={() => setStatus(order.id, 'shipped')}>Mark shipped</button>}{status === 'shipped' && <button className="btn-outline-dark" onClick={() => printShippingLabel(order)}>Reprint label</button>}{status === 'shipped' && <button className="btn-outline-dark" disabled>Shipped</button>}</div></div>;
}

function LoginPage({ user, setUser, setAdmin, showPage, setToast }) {
  const [mode, setMode] = useState('login');
  const [showPassword, setShowPassword] = useState({});
  const [login, setLogin] = useState({ email: '', password: '' });
  const [register, setRegister] = useState({ name: '', email: '', password: '' });
  const submitLogin = async () => {
    try {
      const result = await api('/api/login', { method: 'POST', body: JSON.stringify(login) });
      if (!useSupabaseBackend) {
        try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } catch {}
      }
      setAdmin(null);
      setUser(result.user);
      setToast(`Welcome back, ${result.user.name}.`);
      showPage('home');
    } catch (error) { setToast(error.message); }
  };
  const submitRegister = async () => {
    try {
      const result = await api('/api/register', { method: 'POST', body: JSON.stringify(register) });
      if (!useSupabaseBackend) {
        try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } catch {}
      }
      setAdmin(null);
      setUser(result.user);
      setToast(`Account created. Welcome, ${result.user.name}.`);
      showPage('home');
    } catch (error) { setToast(error.message); }
  };
  const logout = async () => {
    try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
    setUser(null);
    setToast('Signed out.');
  };
  return <main className="page active"><section className="contact-hero"><div className="sec-label" style={{ color: '#D4AF82', textAlign: 'center' }}>Account</div><h1 className="hero-h1" style={{ color: '#F5F0E8', textAlign: 'center', fontSize: 44 }}>Welcome back</h1><p style={{ color: '#A89F93', textAlign: 'center', marginTop: 12, fontSize: 14 }}>Sign in to checkout faster and keep your Myeonn details ready</p></section><section className="sec"><div className="account-grid"><div className="account-card"><div className="sec-label">Your account</div><div className="sec-title" style={{ marginBottom: 14 }}>Simple and secure</div><p className="account-note">Create an account with your name, email, and password. Your password is stored as a secure hash on the backend, and your browser receives a private session cookie.</p><div className="account-status">{user ? <>Signed in as <strong>{user.name}</strong><br />{user.email}</> : 'You are not signed in yet.'}</div><div className="account-actions">{user ? <><button className="btn-dark" onClick={logout}>Sign out</button><button className="btn-outline-dark" onClick={() => showPage('orders')}>View orders</button><button className="btn-outline-dark" onClick={() => showPage('kids')}>Continue shopping</button></> : <button className="btn-outline-dark" onClick={() => showPage('admin')}>Admin login</button>}</div></div><div className="account-card"><div className="account-tabs"><button className={`account-tab ${mode === 'login' ? 'active' : ''}`} onClick={() => setMode('login')}>Login</button><button className={`account-tab ${mode === 'register' ? 'active' : ''}`} onClick={() => setMode('register')}>Register</button></div>{mode === 'login' ? <div className="account-form active"><Field label="Email" value={login.email} onChange={email => setLogin({ ...login, email })} type="email" placeholder="you@email.com" /><PasswordField value={login.password} onChange={password => setLogin({ ...login, password })} showing={showPassword.login} toggle={() => setShowPassword({ ...showPassword, login: !showPassword.login })} placeholder="Your password" /><div className="account-actions"><button className="btn-gold" onClick={submitLogin}>Login</button>{!user && <button className="btn-outline-dark" onClick={() => showPage('admin')}>Admin login</button>}</div></div> : <div className="account-form active"><Field label="Name" value={register.name} onChange={name => setRegister({ ...register, name })} placeholder="Your name" /><Field label="Email" value={register.email} onChange={email => setRegister({ ...register, email })} type="email" placeholder="you@email.com" /><PasswordField value={register.password} onChange={password => setRegister({ ...register, password })} showing={showPassword.register} toggle={() => setShowPassword({ ...showPassword, register: !showPassword.register })} placeholder="Minimum 6 characters" /><button className="btn-gold" onClick={submitRegister}>Create account</button></div>}</div></div></section></main>;
}

function CheckoutPage({ user, cart, placeOrder, showPage, setToast }) {
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const shipping = subtotal >= 999 ? 0 : 99;
  const total = subtotal + shipping;
  const [form, setForm] = useState({
    name: user?.name || '',
    email: user?.email || '',
    phone: '',
    altPhone: '',
    address: '',
    landmark: '',
    city: '',
    state: '',
    pincode: '',
    country: 'India',
    paymentMethod: 'Online payment',
    paymentProvider: 'UPI / Card / Netbanking',
    paymentStatus: 'Payment pending'
  });

  const submit = () => {
    if (!form.name || !form.email || !form.phone || !form.address || !form.city || !form.state || !form.pincode) {
      setToast('Please fill all delivery details.');
      return;
    }
    placeOrder({ ...form, userId: user?.id || null });
  };

  if (!cart.length) {
    return <main className="page active"><section className="contact-hero"><div className="sec-label" style={{ color: '#D4AF82', textAlign: 'center' }}>Checkout</div><h1 className="hero-h1" style={{ color: '#F5F0E8', textAlign: 'center', fontSize: 44 }}>Your cart is empty</h1></section><section className="sec"><button className="btn-gold" onClick={() => showPage('kids')}>Continue shopping</button></section></main>;
  }

  return <main className="page active" id="page-checkout">
    <section className="contact-hero"><div className="sec-label" style={{ color: '#D4AF82', textAlign: 'center' }}>Checkout</div><h1 className="hero-h1" style={{ color: '#F5F0E8', textAlign: 'center', fontSize: 44 }}>Complete your order</h1><p style={{ color: '#A89F93', textAlign: 'center', marginTop: 12, fontSize: 14 }}>Review your cart and add delivery details</p></section>
    <section className="sec"><div className="checkout-grid"><div className="checkout-card"><div className="sec-label">Delivery</div><div className="sec-title" style={{ marginBottom: 24 }}>Shipping details</div><Field label="Full name" value={form.name} onChange={name => setForm({ ...form, name })} placeholder="Your name" /><Field label="Email" type="email" value={form.email} onChange={email => setForm({ ...form, email })} placeholder="you@email.com" /><div className="form-row"><Field label="Phone number" type="tel" value={form.phone} onChange={phone => setForm({ ...form, phone })} placeholder="+91 98765 43210" /><Field label="Alternate phone" type="tel" value={form.altPhone} onChange={altPhone => setForm({ ...form, altPhone })} placeholder="+91 98765 43210" /></div><div className="form-field"><label>Address</label><textarea value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="House number, street, area" /></div><Field label="Landmark / nearby place" value={form.landmark} onChange={landmark => setForm({ ...form, landmark })} placeholder="Near school, temple, main road" /><div className="form-row"><Field label="City" value={form.city} onChange={city => setForm({ ...form, city })} placeholder="Mumbai" /><Field label="State" value={form.state} onChange={state => setForm({ ...form, state })} placeholder="Maharashtra" /></div><div className="form-row"><Field label="Pincode" value={form.pincode} onChange={pincode => setForm({ ...form, pincode })} placeholder="400050" /><Field label="Country" value={form.country} onChange={country => setForm({ ...form, country })} placeholder="India" /></div><div className="payment-choice"><div className="sec-label">Payment</div><div className="payment-choice-title">Payment method</div><div className="payment-options"><button type="button" className="active"><i className="ti ti-credit-card" /><span>Online payment</span><small>UPI, card, netbanking</small></button></div><div className="payment-note">Online payment selected. The payment request will be handled with this order confirmation.</div></div><div className="account-actions"><button className="btn-gold" onClick={submit}>Confirm order & pay online</button><button className="btn-outline-dark" onClick={() => showPage('kids')}>Continue shopping</button></div></div><div className="checkout-card"><div className="sec-label">Summary</div><div className="sec-title" style={{ marginBottom: 24 }}>Order total</div><div className="checkout-items">{cart.map(item => <div className="checkout-row" key={`${item.id}-${item.size || 'size'}`}><div><div className="cart-name">{item.name}</div><div className="cart-meta">{item.meta} · Size {item.size || 'Not selected'} · Qty {item.qty}</div></div><div className="cart-name">{price(item.price * item.qty)}</div></div>)}</div><div className="checkout-totals"><div><span>Payment</span><strong>{form.paymentMethod}</strong></div><div><span>Subtotal</span><strong>{price(subtotal)}</strong></div><div><span>Shipping</span><strong>{shipping ? price(shipping) : 'Free'}</strong></div><div className="checkout-grand"><span>Total</span><strong>{price(total)}</strong></div></div></div></div></section>
  </main>;
}

function ContactPage({ setToast, showPage, openInfo }) {
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', topic: 'Order enquiry', message: '' });
  const submit = async () => {
    try {
      await api('/api/contact', { method: 'POST', body: JSON.stringify(form) });
      setForm({ firstName: '', lastName: '', email: '', phone: '', topic: 'Order enquiry', message: '' });
      setToast('Message sent. We will reply within 24 hours.');
    } catch (error) { setToast(error.message); }
  };
  return <main className="page active"><section className="contact-hero"><div className="sec-label" style={{ color: '#D4AF82', textAlign: 'center' }}>We're here</div><h1 className="hero-h1" style={{ color: '#F5F0E8', textAlign: 'center', fontSize: 44 }}>Get in touch</h1><p style={{ color: '#A89F93', textAlign: 'center', marginTop: 12, fontSize: 14 }}>Questions, feedback, or just want to say hello — we'd love to hear from you</p></section><section className="sec"><div className="contact-grid"><div><div className="contact-info-card"><div className="sec-label">Find us</div><div className="sec-title" style={{ marginBottom: 24 }}>Store info</div>{[['ti-map-pin', 'Address', <>12 Fashion Street, Bandra West,<br />Mumbai, Maharashtra 400050</>], ['ti-mail', 'Email', 'hello@myeonn.com'], ['ti-phone', 'Phone', '+91 98765 43210'], ['ti-clock', 'Hours', <>Mon-Sat: 10am - 7pm<br />Sunday: 11am - 5pm</>], ['ti-brand-instagram', 'Instagram', '@myeonn']].map(item => <div className="cinfo" key={item[1]}><div className="cinfo-icon"><i className={`ti ${item[0]}`} /></div><div><div className="cinfo-label">{item[1]}</div><div className="cinfo-val">{item[2]}</div></div></div>)}</div><div className="map-placeholder" style={{ marginTop: 20 }}><i className="ti ti-map-2" /><p>Bandra West, Mumbai</p><p style={{ fontSize: 11, color: '#9B9188' }}>Open in Maps →</p></div></div><div className="contact-form-card"><div className="sec-label">Write to us</div><div className="sec-title" style={{ marginBottom: 24 }}>Send a message</div><div className="form-row"><Field label="First name" value={form.firstName} onChange={firstName => setForm({ ...form, firstName })} placeholder="Rahul" /><Field label="Last name" value={form.lastName} onChange={lastName => setForm({ ...form, lastName })} placeholder="Sharma" /></div><Field label="Email" type="email" value={form.email} onChange={email => setForm({ ...form, email })} placeholder="rahul@email.com" /><Field label="Phone (optional)" type="tel" value={form.phone} onChange={phone => setForm({ ...form, phone })} placeholder="+91 98765 43210" /><div className="form-field"><label>Topic</label><select value={form.topic} onChange={e => setForm({ ...form, topic: e.target.value })}>{['Order enquiry', 'Returns & exchanges', 'Size help', 'Product question', 'Feedback', 'Other'].map(item => <option key={item}>{item}</option>)}</select></div><div className="form-field"><label>Message</label><textarea value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} placeholder="How can we help you?" /></div><button className="btn-gold" onClick={submit}>Send message →</button></div></div></section><section className="sec alt"><div className="sec-label">FAQ</div><div className="sec-title">Common questions</div><div className="faq-grid">{['How long does delivery take?', 'What is your return policy?', 'Do you have a size guide?', 'Can I track my order?'].map((question, i) => <div className="faq-card" key={question}><div className="faq-question">{question}</div><div className="faq-answer">{['Standard delivery takes 2-4 working days across India.', 'We accept returns within 15 days of delivery.', 'Yes. Kids use age and height. Men use S to 3XL sizing.', 'Yes. You will receive a tracking link after dispatch.'][i]}</div></div>)}</div></section><Footer showPage={showPage} openInfo={openInfo} /></main>;
}

function ProductSection({ label, title, subtitle, products, stockByProduct = {}, addToCart, openProduct, alt }) {
  return <section className={`sec ${alt ? 'alt' : ''}`}><div className="sec-label">{label}</div><div className="sec-title">{title}</div>{subtitle && <div className="sec-sub">{subtitle}</div>}<div className="prod-grid">{products.map(product => <ProductCard key={product.id} product={product} stock={stockByProduct[product.id]} addToCart={addToCart} openProduct={openProduct} />)}</div></section>;
}

function ProductCard({ product, stock, addToCart, openProduct }) {
  const limited = stock && stock.status === 'low';
  const out = stock && stock.status === 'out';
  return <div className="prod-card" onClick={() => openProduct(product)}><div className="prod-img">{limited && <div className="limited-badge">Limited stock</div>}{out && <div className="limited-badge out">Out of stock</div>}<ProductCarousel product={product} compact /></div><div className="prod-info"><div className="prod-cat">{productMeta(product)}</div><div className="prod-name">{product.name}</div><div className="prod-price">{price(product.price)}</div>{limited && <div className="prod-stock-note">Limited stock · {stock.available} left</div>}{out && <div className="prod-stock-note out">Out of stock</div>}<button className="btn-outline-dark prod-add" onClick={event => { event.stopPropagation(); addToCart(product); }} disabled={out}>{out ? 'Out of stock' : 'Add to cart'}</button></div></div>;
}

function ProductCarousel({ product, compact }) {
  const images = productImages(product);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState({});
  const visibleImages = images.filter(image => !failed[image]);
  const currentIndex = visibleImages.length ? Math.min(index, visibleImages.length - 1) : 0;
  const current = visibleImages[currentIndex];
  const move = (event, direction) => {
    event.stopPropagation();
    if (!visibleImages.length) return;
    setIndex((currentIndex + direction + visibleImages.length) % visibleImages.length);
  };
  if (!current) {
    return <div className={`prod-art ${product.category === 'Winter' ? 'dark' : ''}`}><i className={`ti ${product.collection === 'men' ? 'ti-tie' : 'ti-shirt'}`} /></div>;
  }
  return <><img src={current} alt={product.name} onError={() => setFailed(items => ({ ...items, [current]: true }))} />{visibleImages.length > 1 && <><button type="button" className="carousel-btn prev" onClick={event => move(event, -1)} aria-label="Previous image"><i className="ti ti-chevron-left" /></button><button type="button" className="carousel-btn next" onClick={event => move(event, 1)} aria-label="Next image"><i className="ti ti-chevron-right" /></button><div className={`carousel-dots ${compact ? 'compact' : ''}`}>{visibleImages.map((image, imageIndex) => <button type="button" key={`${image}-${imageIndex}`} className={imageIndex === currentIndex ? 'active' : ''} onClick={event => { event.stopPropagation(); setIndex(imageIndex); }} aria-label={`Show image ${imageIndex + 1}`} />)}</div></>}</>;
}

function Field({ label, value, onChange, type = 'text', placeholder }) {
  return <div className="form-field"><label>{label}</label><input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} /></div>;
}

function PasswordField({ value, onChange, showing, toggle, placeholder }) {
  return <div className="form-field"><label>Password</label><div className="password-wrap"><input type={showing ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} /><button type="button" className="password-toggle" onClick={toggle} aria-label={showing ? 'Hide password' : 'Show password'}><i className={`ti ${showing ? 'ti-eye-off' : 'ti-eye'}`} /></button></div></div>;
}

function SearchPanel({ show, query, setQuery, results, viewProduct, close }) {
  return <aside id="search-panel" className={`panel ${show ? 'show' : ''}`} aria-label="Search products"><div className="panel-head"><div className="panel-title">Search Myeonn</div><button className="icon-btn" onClick={close} aria-label="Close search"><i className="ti ti-x" /></button></div><div className="panel-body"><div className="search-box"><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search tees, hoodies, shirts..." /><button className="btn-dark">Search</button></div><div className="search-results">{results.length ? results.map(product => <div className="result-row" key={product.id}><div><div className="result-name">{product.name}</div><div className="result-meta">{product.collection} · {productMeta(product)} · {price(product.price)}</div></div><button className="btn-outline-dark" onClick={() => viewProduct(product)}>View</button></div>) : <div className="cart-empty">No products found. Try tee, shirt, hoodie, or kids.</div>}</div></div></aside>;
}

function CartPanel({ show, cart, checkout, removeItem, close }) {
  const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  return <aside id="cart-panel" className={`panel ${show ? 'show' : ''}`} aria-label="Shopping cart"><div className="panel-head"><div className="panel-title">Your cart</div><button className="icon-btn" onClick={close} aria-label="Close cart"><i className="ti ti-x" /></button></div><div className="panel-body">{cart.length ? cart.map(item => <div className="cart-row" key={`${item.id}-${item.size || 'size'}`}><div><div className="cart-name">{item.name}</div><div className="cart-meta">{item.meta} · Size {item.size || 'Not selected'} · Qty {item.qty}</div><button className="cart-remove" onClick={() => removeItem(item)}>Remove</button></div><div className="cart-name">{price(item.price * item.qty)}</div></div>) : <div className="cart-empty">Your cart is empty. Add a few Myeonn favourites and they will appear here.</div>}</div><div className="cart-foot"><div className="cart-total"><span>Total</span><span>{price(total)}</span></div><button className="btn-gold" style={{ width: '100%' }} onClick={checkout}>Checkout</button></div></aside>;
}

function InfoModal({ info, close }) {
  return <div className={`modal ${info ? 'show' : ''}`} role="dialog" aria-modal="true"><div className="modal-head"><div className="panel-title">{info?.[0] || 'Myeonn'}</div><button className="icon-btn" onClick={close} aria-label="Close"><i className="ti ti-x" /></button></div><div className="modal-body"><p>{info?.[1]}</p></div></div>;
}

function ProductDetail({ product, stock, addToCart, close }) {
  if (!product) return null;
  const limited = stock && stock.status === 'low';
  const out = stock && stock.status === 'out';
  const tags = product.tags || [];
  return <div className="product-modal show" role="dialog" aria-modal="true"><div className="modal-head"><div className="panel-title">Product details</div><button className="icon-btn" onClick={close} aria-label="Close"><i className="ti ti-x" /></button></div><div className="product-detail-body"><div className="product-detail-image">{limited && <div className="limited-badge">Limited stock</div>}{out && <div className="limited-badge out">Out of stock</div>}<ProductCarousel product={product} /></div><div className="product-detail-info"><div className="sec-label">{product.collection}</div><h2>{product.name}</h2><div className="product-detail-price">{price(product.price)}</div><div className="product-detail-grid"><div><span>Category</span><strong>{product.category || 'Clothing'}</strong></div><div><span>Size/Age</span><strong>{product.age || product.size || 'Standard'}</strong></div><div><span>Stock</span><strong>{stock ? `${stock.available} available` : 'Available'}</strong></div><div><span>Status</span><strong>{out ? 'Out of stock' : limited ? 'Limited stock' : 'In stock'}</strong></div></div>{tags.length > 0 && <div className="detail-tags">{tags.map(tag => <span key={tag}>{tag}</span>)}</div>}<p className="product-detail-copy">Soft everyday clothing from Myeonn, made for easy wear, clean styling, and regular use.</p><button className="btn-gold" onClick={() => addToCart(product)} disabled={out}>{out ? 'Out of stock' : 'Add to cart'}</button></div></div></div>;
}

function SizeModal({ product, chooseSize, close }) {
  if (!product) return null;
  const sizes = productSizeOptions(product);
  return <div className="size-modal show" role="dialog" aria-modal="true"><div className="modal-head"><div className="panel-title">Choose size</div><button className="icon-btn" onClick={close} aria-label="Close"><i className="ti ti-x" /></button></div><div className="size-modal-body"><div className="sec-label">Add to cart</div><h2>{product.name}</h2><p>Select one size before adding this item.</p><div className={`size-options ${sizes.length === 4 ? 'adult' : ''}`}>{sizes.map(size => <button key={size} onClick={() => chooseSize(size)}>{size}</button>)}</div></div></div>;
}

function CTA({ label, title, text, button, onClick }) {
  return <section className="cta-banner"><div className="sec-label">{label}</div><h2>{title}</h2><p>{text}</p><button className="btn-gold" onClick={onClick}>{button}</button></section>;
}

function Testimonials() {
  const reviews = [['My kids live in these clothes. Washed a hundred times and still look new.', 'Priya M.', 'Mumbai'], ['The linen shirt is exactly what I needed — fits well, feels light, looks sharp.', 'Rahul S.', 'Delhi'], ['Fast delivery, great quality. My son refuses to wear anything else now!', 'Anita K.', 'Bengaluru']];
  return <section className="sec alt"><div className="sec-label">Reviews</div><div className="sec-title">What customers say</div><div className="testi-grid">{reviews.map(review => <div className="testi-card" key={review[1]}><div className="testi-stars">★★★★★</div><div className="testi-text">"{review[0]}"</div><div className="testi-author">{review[1]}</div><div className="testi-loc">{review[2]}</div></div>)}</div></section>;
}

function Footer({ showPage, openInfo }) {
  return <footer><div className="foot-top"><div><div className="foot-brand-name">Myeonn</div><div className="foot-brand-desc">Premium clothing for kids and men. Soft fabrics, easy fits, styles the whole family will love.</div></div><div className="foot-col"><div className="foot-col-title">Shop</div><a onClick={() => showPage('kids')}>Kids wear</a><a onClick={() => showPage('men')}>Men's wear</a><a onClick={() => showPage('arrivals')}>New arrivals</a><a onClick={() => openInfo('sale')}>Sale</a></div><div className="foot-col"><div className="foot-col-title">Help</div><a onClick={() => showPage('contact')}>Contact us</a><a onClick={() => openInfo('shipping')}>Shipping info</a><a onClick={() => openInfo('returns')}>Returns</a><a onClick={() => openInfo('sizes')}>Size guide</a></div><div className="foot-col"><div className="foot-col-title">Company</div><a onClick={() => openInfo('about')}>About us</a><a onClick={() => openInfo('careers')}>Careers</a><a onClick={() => openInfo('privacy')}>Privacy policy</a><a onClick={() => openInfo('terms')}>Terms</a></div></div><div className="foot-bottom"><div className="foot-copy">© 2026 Myeonn · All rights reserved</div><div className="foot-social"><i className="ti ti-brand-instagram" /><i className="ti ti-brand-facebook" /><i className="ti ti-brand-twitter" /></div></div></footer>;
}

function Toast({ message }) {
  return <div className={`toast ${message ? 'show' : ''}`}><i className="ti ti-check" /><span>{message}</span></div>;
}

function showProduct(product, showPage) {
  showPage(product.collection === 'men' ? 'men' : 'kids');
  setTimeout(() => {
    const card = [...document.querySelectorAll('.prod-card')].find(item => item.textContent.includes(product.name));
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 100);
}

async function subscribeNewsletter(setToast) {
  const email = prompt('Enter your email for new arrival alerts');
  if (!email) return;
  try {
    await api('/api/newsletter', { method: 'POST', body: JSON.stringify({ email }) });
    setToast('Thanks. You are on the list.');
  } catch (error) {
    setToast(error.message);
  }
}
