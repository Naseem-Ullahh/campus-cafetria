// Check admin session
document.addEventListener('DOMContentLoaded', function() {
    if (!localStorage.getItem('adminSession')) {
        window.location.href = 'login.html';
        return;
    }

    // Load dashboard data
    loadDashboardData();
});

// Load dashboard data from the shared orders and menu
function loadDashboardData() {
    const orders = getOrders();
    const menu = getMenuItems();

    // Today's stats (cancelled orders don't count towards revenue)
    const todayOrders = orders.filter(o => isToday(o.timestamp));
    const todayRevenue = todayOrders
        .filter(o => o.status !== 'Cancelled')
        .reduce((sum, o) => sum + o.total, 0);
    const pending = orders.filter(o => o.status === 'Received' || o.status === 'Preparing');
    const lowStock = menu.filter(item => item.stock <= LOW_STOCK_LIMIT);

    document.getElementById('todayOrders').textContent = todayOrders.length;
    document.getElementById('todayRevenue').textContent = formatPrice(todayRevenue);
    document.getElementById('pendingOrders').textContent = pending.length;
    document.getElementById('lowStockItems').textContent = lowStock.length;
    document.getElementById('ordersTrend').textContent = `${orders.length} orders in total`;
    document.getElementById('revenueTrend').textContent =
        `${todayOrders.filter(o => o.status === 'Completed').length} completed today`;

    // Low stock alert
    document.getElementById('lowStockAlert').style.display = lowStock.length ? '' : 'none';
    document.getElementById('lowStockList').innerHTML = lowStock.map(item => `
        <div class="stock-item">
            <span class="stock-name">${item.name}</span>
            <span class="stock-count">${item.stock > 0 ? `Only ${item.stock} left` : 'Out of stock'}</span>
        </div>
    `).join('');

    // 5 most recent orders
    const recent = [...orders].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 5);
    document.getElementById('recentOrdersBody').innerHTML = recent.length ? recent.map(o => `
        <tr>
            <td class="order-id">#${o.orderId}</td>
            <td>${o.fullName}</td>
            <td>${o.items.map(i => i.name).join(', ')}</td>
            <td>${formatPrice(o.total)}</td>
            <td><span class="status-badge status-${o.status.toLowerCase()}">${o.status}</span></td>
        </tr>
    `).join('') : '<tr><td colspan="5" style="text-align: center;">No orders yet</td></tr>';
}

// Toggle sidebar (mobile)
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('active');
}

// Logout function
function logout() {
    if (confirm('Are you sure you want to logout?')) {
        localStorage.removeItem('adminSession');
        window.location.href = 'login.html';
    }
}

// Refresh when an order is placed in another tab, and every 15 seconds
window.addEventListener('storage', e => {
    if (e.key === 'orders' || e.key === 'menuItems') loadDashboardData();
});
setInterval(loadDashboardData, 15000);
