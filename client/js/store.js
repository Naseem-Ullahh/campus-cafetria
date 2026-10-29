// Campus Cafeteria - shared data layer
// Every page reads and writes menu items, orders and users through these
// helpers so the student side and the admin side always see the same data.
// Storage is localStorage (frontend only) - swap these functions for API calls later.

const ORDER_STATUSES = ['Received', 'Preparing', 'Ready', 'Completed', 'Cancelled'];
const MENU_CATEGORIES = ['breakfast', 'lunch', 'snacks', 'beverages'];
const LOW_STOCK_LIMIT = 10;

// Default menu, used the first time the app runs
const DEFAULT_MENU = [
    { id: 1, name: 'Classic Burger', category: 'lunch', price: 120, stock: 40, popular: true, available: true,
      description: 'Juicy beef patty with fresh vegetables and special sauce',
      image: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&h=300&fit=crop' },
    { id: 2, name: 'Margherita Pizza', category: 'lunch', price: 180, stock: 25, popular: true, available: true,
      description: 'Classic pizza with tomato sauce, mozzarella, and basil',
      image: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=400&h=300&fit=crop' },
    { id: 3, name: 'French Fries', category: 'snacks', price: 60, stock: 0, popular: false, available: false,
      description: 'Crispy golden fries with ketchup',
      image: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400&h=300&fit=crop' },
    { id: 4, name: 'Orange Juice', category: 'beverages', price: 40, stock: 8, popular: false, available: true,
      description: 'Freshly squeezed orange juice',
      image: 'https://images.unsplash.com/photo-1600271886742-f049cd451bba?w=400&h=300&fit=crop' },
    { id: 5, name: 'Pancakes', category: 'breakfast', price: 90, stock: 20, popular: false, available: true,
      description: 'Fluffy pancakes with maple syrup and butter',
      image: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=400&h=300&fit=crop' },
    { id: 6, name: 'Chicken Sandwich', category: 'lunch', price: 100, stock: 30, popular: true, available: true,
      description: 'Grilled chicken breast with lettuce and mayo',
      image: 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=400&h=300&fit=crop' },
    { id: 7, name: 'Coffee', category: 'beverages', price: 50, stock: 100, popular: true, available: true,
      description: 'Hot brewed coffee - Americano, Latte, or Cappuccino',
      image: 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=400&h=300&fit=crop' },
    { id: 8, name: 'Samosa', category: 'snacks', price: 30, stock: 60, popular: true, available: true,
      description: 'Crispy fried pastry with spiced potato filling (2 pieces)',
      image: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&h=300&fit=crop' },
    { id: 9, name: 'Pasta Alfredo', category: 'lunch', price: 150, stock: 15, popular: false, available: true,
      description: 'Creamy alfredo pasta with parmesan cheese',
      image: 'https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?w=400&h=300&fit=crop' },
    { id: 10, name: 'Chocolate Shake', category: 'beverages', price: 80, stock: 6, popular: false, available: true,
      description: 'Rich and creamy chocolate milkshake',
      image: 'https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=400&h=300&fit=crop' },
    { id: 11, name: 'Egg Omelette', category: 'breakfast', price: 70, stock: 25, popular: false, available: true,
      description: 'Three-egg omelette with cheese and vegetables',
      image: 'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=400&h=300&fit=crop' },
    { id: 12, name: 'Spring Rolls', category: 'snacks', price: 80, stock: 35, popular: false, available: true,
      description: 'Crispy vegetable spring rolls (4 pieces)',
      image: 'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb?w=400&h=300&fit=crop' }
];

// Sample orders so the admin pages have something to show on first run
function buildSampleOrders() {
    const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
    const makeOrder = (orderId, studentId, fullName, phoneNumber, items, status, timestamp) => {
        const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
        return {
            orderId, studentId, fullName, phoneNumber,
            pickupTime: 'Today 1:30 PM', specialInstructions: '', paymentMethod: 'Cash',
            transactionReference: null, paymentStatus: status === 'Completed' ? 'Confirmed' : 'Pending',
            items, total, status, timestamp
        };
    };
    return [
        makeOrder('ORD1001', 'STU001', 'Ali Hassan', '03001234567',
            [{ id: 1, name: 'Classic Burger', price: 120, quantity: 2 }, { id: 7, name: 'Coffee', price: 50, quantity: 1 }],
            'Received', minutesAgo(5)),
        makeOrder('ORD1002', 'STU002', 'Fatima Khan', '03019876543',
            [{ id: 2, name: 'Margherita Pizza', price: 180, quantity: 1 }],
            'Preparing', minutesAgo(20)),
        makeOrder('ORD1003', 'STU003', 'Ahmed Malik', '03025551234',
            [{ id: 5, name: 'Pancakes', price: 90, quantity: 1 }, { id: 7, name: 'Coffee', price: 50, quantity: 2 }],
            'Completed', minutesAgo(26 * 60))
    ];
}

// ---------- Generic helpers ----------
function loadData(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : fallback;
    } catch (e) {
        return fallback;
    }
}

function saveData(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

function formatPrice(amount) {
    return 'Rs. ' + Math.round(amount || 0).toLocaleString();
}

// Pakistani mobile number: 03XXXXXXXXX or +923XXXXXXXXX (spaces/dashes allowed).
// Returns the number as 03XXXXXXXXX, or null if it isn't valid.
function normalizePakistaniMobile(value) {
    const digits = String(value || '').replace(/[\s-]/g, '');
    if (/^03\d{9}$/.test(digits)) return digits;
    if (/^\+923\d{9}$/.test(digits)) return '0' + digits.slice(3);
    if (/^923\d{9}$/.test(digits)) return '0' + digits.slice(2);
    return null;
}

function isToday(isoString) {
    return new Date(isoString).toDateString() === new Date().toDateString();
}

// ---------- Menu ----------
function getMenuItems() {
    let items = loadData('menuItems', null);
    if (!items) {
        items = DEFAULT_MENU;
        saveData('menuItems', items);
    }
    return items;
}

function saveMenuItems(items) {
    saveData('menuItems', items);
}

// Item can be ordered only if the admin marked it available and it has stock
function isInStock(item) {
    return item.available && item.stock > 0;
}

// ---------- Orders ----------
function getOrders() {
    let orders = loadData('orders', null);
    if (!orders) {
        orders = buildSampleOrders();
        saveData('orders', orders);
    }
    return orders;
}

function saveOrders(orders) {
    saveData('orders', orders);
}

function findOrder(orderId) {
    return getOrders().find(o => o.orderId === orderId);
}

function setOrderStatus(orderId, status) {
    const orders = getOrders();
    const order = orders.find(o => o.orderId === orderId);
    if (order) {
        order.status = status;
        saveOrders(orders);
    }
    return order;
}

// Save a new order and take the ordered quantities out of stock
function placeNewOrder(order) {
    const orders = getOrders();
    orders.push(order);
    saveOrders(orders);

    const menu = getMenuItems();
    order.items.forEach(cartItem => {
        const menuItem = menu.find(m => m.id === cartItem.id);
        if (menuItem) {
            menuItem.stock = Math.max(0, menuItem.stock - cartItem.quantity);
        }
    });
    saveMenuItems(menu);
}

// ---------- Users ----------
// Demo account (matches the first sample order) - login: STU001 / student123
const DEFAULT_USERS = [
    { name: 'Ali Hassan', studentId: 'STU001', email: 'ali.hassan@university.edu', phone: '03001234567',
      password: 'student123', department: 'Computer Science', address: 'Room 205, Boys Hostel' }
];

function getUsers() {
    let users = loadData('users', null);
    if (!users) {
        users = DEFAULT_USERS;
        saveData('users', users);
    }
    return users;
}

function saveUsers(users) {
    saveData('users', users);
}

function getCurrentUser() {
    return loadData('currentUser', null);
}

function setCurrentUser(user) {
    // Never keep the password in the session copy
    const { password, ...sessionUser } = user;
    saveData('currentUser', sessionUser);
}

function requireStudentLogin() {
    if (!getCurrentUser()) {
        window.location.href = 'login.html';
    }
}

function studentLogout() {
    localStorage.removeItem('currentUser');
    localStorage.removeItem('cart');
    window.location.href = 'login.html';
}

// ---------- Admin session ----------
function requireAdminLogin() {
    if (!localStorage.getItem('adminSession')) {
        window.location.href = 'login.html';
    }
}

function adminLogout() {
    localStorage.removeItem('adminSession');
    window.location.href = 'login.html';
}
