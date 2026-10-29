// Manager dashboard: today's numbers from the server, refreshed every 15 seconds
document.addEventListener('DOMContentLoaded', async function() {
    const user = await requireStaffLogin('admin');
    if (!user) return;

    document.getElementById('adminName').textContent = user.name;
    document.getElementById('adminInitial').textContent = user.name.charAt(0);

    await loadDashboardData();
    setInterval(loadDashboardData, 15000);
});

async function loadDashboardData() {
    let data;
    try {
        data = await api('/admin/dashboard');
    } catch (error) {
        document.getElementById('recentOrdersBody').innerHTML =
            `<tr><td colspan="5" style="text-align: center;">${escapeHtml(error.message)}</td></tr>`;
        return;
    }
    const { today, counts, low_stock: lowStock, recent_orders: recent } = data;
    const inProgress = Number(counts.waiting_review) + Number(counts.in_kitchen) + Number(counts.ready);

    document.getElementById('todayOrders').textContent = today.orders;
    document.getElementById('todayRevenue').textContent = formatPrice(today.revenue);
    document.getElementById('pendingOrders').textContent = inProgress;
    document.getElementById('lowStockItems').textContent = lowStock.length;
    document.getElementById('ordersTrend').textContent = `${counts.total_orders} orders in total`;
    document.getElementById('revenueTrend').textContent = `${today.completed || 0} collected today`;
    const badge = document.getElementById('reviewBadge');
    badge.hidden = !Number(counts.waiting_review);
    badge.textContent = counts.waiting_review;
    document.getElementById('pendingTrend').textContent =
        `${counts.waiting_review} to review · ${counts.in_kitchen} in kitchen · ${counts.ready} ready`;

    // Low stock alert
    document.getElementById('lowStockAlert').style.display = lowStock.length ? '' : 'none';
    document.getElementById('lowStockList').innerHTML = lowStock.map(item => `
        <div class="stock-item">
            <span class="stock-name">${escapeHtml(item.item_name)}</span>
            <span class="stock-count">${item.stock_quantity > 0 ? `Only ${item.stock_quantity} left` : 'Out of stock'}</span>
        </div>
    `).join('');

    document.getElementById('recentOrdersBody').innerHTML = recent.length ? recent.map(o => `
        <tr>
            <td class="order-id">${formatOrderNumber(o.order_id)}</td>
            <td>${escapeHtml(o.full_name)}</td>
            <td>${escapeHtml(o.items)}</td>
            <td>${formatPrice(o.total_amount)}</td>
            <td><span class="status-badge status-${o.status.toLowerCase().replace(' ', '-')}">${o.status}</span></td>
        </tr>
    `).join('') : '<tr><td colspan="5" style="text-align: center;">No orders yet</td></tr>';
}

// Toggle sidebar (mobile)
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('active');
}

function confirmLogout() {
    if (confirm('Are you sure you want to logout?')) {
        logout();
    }
}
