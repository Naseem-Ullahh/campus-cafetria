// Signals Std. Cafe' - shared data layer
// Every page talks to the Flask API (server/) through these helpers.
// The only thing kept in the browser is the cart, until the order is placed;
// menu, orders and accounts all live in MySQL.

const MENU_CATEGORIES = ['breakfast', 'lunch', 'snacks', 'beverages'];
const PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=400&h=300&fit=crop';

// Which screen each staff role starts on (paths relative to pages/admin/)
const STAFF_HOME = { admin: 'dashboard.html', cashier: 'incoming.html', kitchen: 'kitchen.html' };

class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
    const options = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }
    let response;
    try {
        response = await fetch('/api' + path, options);
    } catch (e) {
        throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new ApiError(data.error || `Request failed (${response.status})`, response.status);
    }
    return data;
}

// ---------- Formatting ----------
function formatPrice(amount) {
    return 'Rs. ' + Math.round(amount || 0).toLocaleString();
}

function formatOrderNumber(orderId) {
    return '#' + String(orderId).padStart(4, '0');
}

// "Today 1:30 PM", "Tomorrow 9:00 AM" or "Mon, 3 Nov 1:30 PM"
function formatWhen(value) {
    if (!value) return '—';
    const date = new Date(value);
    const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const dayDiff = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
    if (dayDiff === 0) return `Today ${time}`;
    if (dayDiff === 1) return `Tomorrow ${time}`;
    if (dayDiff === -1) return `Yesterday ${time}`;
    return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + time;
}

function isToday(value) {
    return new Date(value).toDateString() === new Date().toDateString();
}

// Text from the server or the user, safe to put inside innerHTML
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Pakistani mobile number: 03XXXXXXXXX or +923XXXXXXXXX (spaces/dashes allowed).
// Returns the number as 03XXXXXXXXX, or null if it isn't valid. (Same rule on the server.)
function normalizePakistaniMobile(value) {
    const digits = String(value || '').replace(/[\s-]/g, '');
    if (/^03\d{9}$/.test(digits)) return digits;
    if (/^\+923\d{9}$/.test(digits)) return '0' + digits.slice(3);
    if (/^923\d{9}$/.test(digits)) return '0' + digits.slice(2);
    return null;
}

// ---------- Menu ----------
function toMenuItem(row) {
    return {
        id: row.item_id,
        name: row.item_name,
        category: row.category_name.toLowerCase(),
        categoryId: row.category_id,
        categoryName: row.category_name,
        price: row.price,
        stock: row.stock_quantity,
        lowStockThreshold: row.low_stock_threshold,
        available: row.is_available === undefined ? true : !!row.is_available,
        hasOrders: !!row.has_orders,
        description: row.description || '',
        image: row.image_url || PLACEHOLDER_IMAGE
    };
}

async function getMenuItems() {
    const { items } = await api('/menu');
    return items.map(toMenuItem);
}

// Item can be ordered only if the manager switched it on and it has stock
function isInStock(item) {
    return item.available && item.stock > 0;
}

// ---------- Orders ----------
function toOrder(row) {
    return {
        orderId: row.order_id,
        number: formatOrderNumber(row.order_id),
        status: row.status,
        timestamp: row.order_date,
        pickupAt: row.requested_pickup_time,
        pickupTime: formatWhen(row.requested_pickup_time),
        estimatedReady: row.estimated_ready_time,
        fullName: row.full_name,
        studentId: row.university_id,
        phoneNumber: row.phone,
        total: row.total_amount,
        paymentMethod: row.payment_method,
        paymentStatus: row.payment_status,
        transactionReference: row.transaction_reference,
        specialInstructions: row.special_instructions || '',
        closeReason: row.close_reason,
        cancellationDeadline: row.cancellation_deadline,
        itemsText: row.items || '',
        items: (row.lines || []).map(line => ({
            id: line.item_id, name: line.item_name, price: line.unit_price, quantity: line.quantity
        })),
        history: row.history || []
    };
}

async function getMyOrders() {
    const { orders } = await api('/orders/mine');
    return orders.map(toOrder);
}

async function getOrder(orderId) {
    const { order } = await api('/orders/' + encodeURIComponent(orderId));
    return toOrder(order);
}

// ---------- Cart (this browser only, until checkout) ----------
function loadCart() {
    try {
        return JSON.parse(localStorage.getItem('cart')) || [];
    } catch (e) {
        return [];
    }
}

function storeCart(cart) {
    localStorage.setItem('cart', JSON.stringify(cart));
}

function clearCart() {
    localStorage.removeItem('cart');
}

// ---------- Accounts ----------
let currentUser = null;

function toUser(row) {
    return {
        id: row.user_id,
        name: row.full_name,
        studentId: row.university_id,
        email: row.email,
        phone: row.phone,
        userType: row.user_type,
        role: row.role,
        createdAt: row.created_at
    };
}

async function loadCurrentUser() {
    try {
        currentUser = toUser((await api('/auth/me')).user);
    } catch (e) {
        if (e.status !== 401) throw e;
        currentUser = null;
    }
    return currentUser;
}

function getCurrentUser() {
    return currentUser;
}

// Pages call: const user = await requireStudentLogin(); if (!user) return;
async function requireStudentLogin() {
    const user = await loadCurrentUser();
    if (!user || user.role !== 'customer') {
        window.location.href = 'login.html';
        return null;
    }
    return user;
}

async function requireStaffLogin(...roles) {
    const user = await loadCurrentUser();
    if (!user || !STAFF_HOME[user.role]) {
        window.location.href = 'login.html';
        return null;
    }
    if (roles.length && !roles.includes(user.role)) {
        window.location.href = STAFF_HOME[user.role];     // send them to their own screen
        return null;
    }
    return user;
}

async function logout() {
    try {
        await api('/auth/logout', { method: 'POST', body: {} });
    } finally {
        clearCart();
        window.location.href = 'login.html';
    }
}

// Old names still used by some pages
const studentLogout = logout;
const adminLogout = logout;
