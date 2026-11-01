// Unit tests for client/js/store.js (the browser data layer), run in Node:
//     node --test tests/unit
// The browser pieces it uses (localStorage, location, fetch) are faked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../client/js/store.js'), 'utf8');
// Top-level const/class aren't visible outside a vm script, so export them explicitly
const EXPORTS = '\n;globalThis.__store = { ApiError, STAFF_HOME, PLACEHOLDER_IMAGE, MENU_CATEGORIES, getCurrentUserVar: () => currentUser };';

function loadStore({ fetchImpl, port = '5000', protocol = 'http:' } = {}) {
    const storage = new Map();
    const context = {
        console, URLSearchParams, Date, Math, JSON, Promise, String, Number, Object, Error,
        localStorage: {
            getItem: key => (storage.has(key) ? storage.get(key) : null),
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: key => storage.delete(key)
        },
        location: { port, protocol, search: '' },
        window: { location: { href: 'start' } },
        fetch: fetchImpl || (async () => { throw new TypeError('no network'); }),
        fetchCalls: []
    };
    vm.createContext(context);
    vm.runInContext(SOURCE + EXPORTS, context);
    return { s: context, storage };
}

// fetch fake: records calls, answers from a table of path -> [status, body]
function fakeFetch(routes, calls) {
    return async (url, options) => {
        calls.push({ url, options });
        const [status, body] = routes[url] || [404, { error: 'not found' }];
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => { if (body === undefined) throw new SyntaxError('not json'); return body; }
        };
    };
}

// ---------- formatting ----------
test('formatPrice rounds and groups thousands', () => {
    const { s } = loadStore();
    assert.equal(s.formatPrice(120), 'Rs. 120');
    assert.equal(s.formatPrice(1234.6), 'Rs. 1,235');
    assert.equal(s.formatPrice(0), 'Rs. 0');
    assert.equal(s.formatPrice(null), 'Rs. 0');
});

test('formatOrderNumber pads to 4 digits', () => {
    const { s } = loadStore();
    assert.equal(s.formatOrderNumber(1), '#0001');
    assert.equal(s.formatOrderNumber(42), '#0042');
    assert.equal(s.formatOrderNumber(12345), '#12345');
});

test('formatWhen says Today / Tomorrow / Yesterday, else the date', () => {
    const { s } = loadStore();
    const at = (days, hour = 13, minute = 30) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, minute, 0, 0); return d.toISOString(); };
    assert.equal(s.formatWhen(at(0)), 'Today 1:30 PM');
    assert.equal(s.formatWhen(at(1, 9, 0)), 'Tomorrow 9:00 AM');
    assert.equal(s.formatWhen(at(-1)), 'Yesterday 1:30 PM');
    assert.match(s.formatWhen(at(5)), /^[A-Z][a-z]{2},? \d{1,2} [A-Z][a-z]{2} 1:30 PM$/);
    assert.equal(s.formatWhen(null), '—');
});

test('escapeHtml neutralises markup', () => {
    const { s } = loadStore();
    assert.equal(s.escapeHtml(`<img src=x onerror="alert('1')">&`), '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;');
    assert.equal(s.escapeHtml(null), '');
    assert.equal(s.escapeHtml(42), '42');
});

// Same cases as server/tests/test_unit.py - the two copies of the rule must agree
const VALID = [['03001234567', '03001234567'], ['0300 1234567', '03001234567'], ['0300-123-4567', '03001234567'],
               ['+92 300 1234567', '03001234567'], ['+923001234567', '03001234567'], ['923001234567', '03001234567'],
               ['  0345 9876543 ', '03459876543']];
const INVALID = ['+91 9876543210', '9876543210', '0300123456', '030012345678', '04212345678', '+92 42 1234567', '0300 12a4567', '', null];

test('normalizePakistaniMobile accepts Pakistani mobiles', () => {
    const { s } = loadStore();
    for (const [raw, expected] of VALID) assert.equal(s.normalizePakistaniMobile(raw), expected, raw);
});

test('normalizePakistaniMobile rejects +91 and non-mobiles', () => {
    const { s } = loadStore();
    for (const raw of INVALID) assert.equal(s.normalizePakistaniMobile(raw), null, String(raw));
});

// ---------- mapping server rows ----------
test('toMenuItem maps a public menu row', () => {
    const { s } = loadStore();
    const item = s.toMenuItem({ item_id: 3, item_name: 'Coffee', category_name: 'Beverages', category_id: 4, price: 50,
                                stock_quantity: 0, description: null, image_url: null });
    assert.equal(item.id, 3);
    assert.equal(item.category, 'beverages');
    assert.equal(item.categoryName, 'Beverages');
    assert.equal(item.available, true, 'public rows are always switched on');
    assert.equal(item.description, '');
    assert.equal(item.image, s.__store.PLACEHOLDER_IMAGE);
    assert.equal(s.isInStock(item), false, 'no stock = not orderable');
});

test('toMenuItem keeps the admin switch and has_orders', () => {
    const { s } = loadStore();
    const item = s.toMenuItem({ item_id: 1, item_name: 'X', category_name: 'Lunch', price: 1, stock_quantity: 9, is_available: 0, has_orders: 1 });
    assert.equal(item.available, false);
    assert.equal(item.hasOrders, true);
    assert.equal(s.isInStock(item), false, 'switched off = not orderable');
    assert.equal(s.isInStock({ ...item, available: true }), true);
});

test('toOrder maps a full order with lines and history', () => {
    const { s } = loadStore();
    const order = s.toOrder({
        order_id: 7, status: 'Accepted', order_date: '2026-10-30T12:00:00+05:00', requested_pickup_time: '2026-10-30T13:00:00+05:00',
        estimated_ready_time: '2026-10-30T12:55:00+05:00', full_name: 'Ali', university_id: 'STU001', phone: '03001234567',
        total_amount: 290, payment_method: 'Cash', payment_status: 'Pending', transaction_reference: null,
        special_instructions: null, close_reason: null, cancellation_deadline: '2026-10-30T12:40:00+05:00',
        lines: [{ item_id: 1, item_name: 'Burger', unit_price: 120, quantity: 2 }],
        history: [{ new_status: 'Received' }]
    });
    assert.equal(order.number, '#0007');
    assert.equal(order.total, 290);
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].price, 120);
    assert.equal(order.specialInstructions, '');
    assert.equal(order.history.length, 1);
});

test('toOrder works for list rows without lines', () => {
    const { s } = loadStore();
    const order = s.toOrder({ order_id: 1, status: 'Completed', items: '2 x Burger, 1 x Coffee' });
    assert.equal(order.items.length, 0);
    assert.equal(order.itemsText, '2 x Burger, 1 x Coffee');
    assert.equal(order.history.length, 0);
});

// ---------- cart ----------
test('cart survives a round trip and corrupt data', () => {
    const { s, storage } = loadStore();
    assert.equal(s.loadCart().length, 0);
    s.storeCart([{ id: 1, quantity: 2 }]);
    assert.equal(s.loadCart()[0].quantity, 2);
    storage.set('cart', '{broken');
    assert.equal(s.loadCart().length, 0, 'corrupt cart is treated as empty');
    s.clearCart();
    assert.equal(storage.has('cart'), false);
});

// ---------- api() ----------
test('api sends JSON bodies and returns the parsed reply', async () => {
    const calls = [];
    const { s } = loadStore({ fetchImpl: fakeFetch({ '/api/orders': [201, { order: { order_id: 5 } }] }, calls) });
    const reply = await s.api('/orders', { method: 'POST', body: { items: [] } });
    assert.equal(reply.order.order_id, 5);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].options.body, '{"items":[]}');
    assert.equal(calls[0].options.credentials, 'same-origin');
});

test('api GET sends no body or content type', async () => {
    const calls = [];
    const { s } = loadStore({ fetchImpl: fakeFetch({ '/api/menu': [200, { items: [] }] }, calls) });
    await s.api('/menu');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.body, undefined);
    assert.equal(calls[0].options.headers['Content-Type'], undefined);
});

test('api turns server errors into ApiError with the server message', async () => {
    const { s } = loadStore({ fetchImpl: fakeFetch({ '/api/orders': [400, { error: 'Only 8 Orange Juice left in stock' }] }, []) });
    await assert.rejects(s.api('/orders', { method: 'POST', body: {} }), e =>
        e instanceof s.__store.ApiError && e.status === 400 && e.message === 'Only 8 Orange Juice left in stock');
});

test('api copes with an error reply that is not JSON', async () => {
    const { s } = loadStore({ fetchImpl: fakeFetch({ '/api/menu': [502, undefined] }, []) });
    await assert.rejects(s.api('/menu'), e => e.status === 502 && e.message === 'Request failed (502)');
});

test('api explains how to fix "cannot reach the server" when opened the wrong way', async () => {
    const wrongPort = loadStore({ port: '8765' }).s;
    await assert.rejects(wrongPort.api('/menu'), e => e.status === 0 && e.message.includes('http://127.0.0.1:5000'));
    const asFile = loadStore({ port: '', protocol: 'file:' }).s;
    await assert.rejects(asFile.api('/menu'), e => e.message.includes('server/app.py'));
    const rightPort = loadStore({ port: '5000' }).s;
    await assert.rejects(rightPort.api('/menu'), e => e.message.includes('Check your connection'));
});

// ---------- login guards ----------
const CUSTOMER = { user_id: 1, full_name: 'Naseem Ullah', university_id: 'STU001', email: 'n@u.edu', phone: '0300', user_type: 'student', role: 'customer' };
const CASHIER = { ...CUSTOMER, user_id: 2, role: 'cashier', full_name: 'Counter Cashier' };

test('requireStudentLogin returns the user when signed in', async () => {
    const { s } = loadStore({ fetchImpl: fakeFetch({ '/api/auth/me': [200, { user: CUSTOMER }] }, []) });
    const user = await s.requireStudentLogin();
    assert.equal(user.name, 'Naseem Ullah');
    assert.equal(s.getCurrentUser().studentId, 'STU001');
    assert.equal(s.window.location.href, 'start', 'no redirect');
});

test('requireStudentLogin sends signed-out visitors to the login page', async () => {
    const { s } = loadStore({ fetchImpl: fakeFetch({ '/api/auth/me': [401, { error: 'Please sign in first' }] }, []) });
    assert.equal(await s.requireStudentLogin(), null);
    assert.equal(s.window.location.href, 'login.html');
});

test('requireStudentLogin turns staff away', async () => {
    const { s } = loadStore({ fetchImpl: fakeFetch({ '/api/auth/me': [200, { user: CASHIER }] }, []) });
    assert.equal(await s.requireStudentLogin(), null);
    assert.equal(s.window.location.href, 'login.html');
});

test('requireStaffLogin sends staff to their own screen when not allowed here', async () => {
    const { s } = loadStore({ fetchImpl: fakeFetch({ '/api/auth/me': [200, { user: CASHIER }] }, []) });
    assert.equal(await s.requireStaffLogin('admin'), null);
    assert.equal(s.window.location.href, 'incoming.html');
});

test('requireStaffLogin lets allowed roles in and keeps customers out', async () => {
    const allowed = loadStore({ fetchImpl: fakeFetch({ '/api/auth/me': [200, { user: CASHIER }] }, []) }).s;
    assert.equal((await allowed.requireStaffLogin('admin', 'cashier')).role, 'cashier');
    const customer = loadStore({ fetchImpl: fakeFetch({ '/api/auth/me': [200, { user: CUSTOMER }] }, []) }).s;
    assert.equal(await customer.requireStaffLogin(), null);
    assert.equal(customer.window.location.href, 'login.html');
});

test('loadCurrentUser passes on errors other than 401', async () => {
    const { s } = loadStore({ fetchImpl: fakeFetch({ '/api/auth/me': [500, { error: 'boom' }] }, []) });
    await assert.rejects(s.loadCurrentUser(), e => e.status === 500);
});

test('logout clears the cart and goes to the login page', async () => {
    const calls = [];
    const { s, storage } = loadStore({ fetchImpl: fakeFetch({ '/api/auth/logout': [200, { ok: true }] }, calls) });
    storage.set('cart', '[{"id":1}]');
    await s.logout();
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(storage.has('cart'), false);
    assert.equal(s.window.location.href, 'login.html');
});

test('every staff role has a home screen', () => {
    const { s } = loadStore();
    assert.deepEqual({ ...s.__store.STAFF_HOME }, { admin: 'dashboard.html', cashier: 'incoming.html', kitchen: 'kitchen.html' });
});
