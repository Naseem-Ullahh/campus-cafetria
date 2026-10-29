// Initialize
requireAdminLogin();

$(document).ready(function() {
    initializeCharts();
    setDateRange(30);
    loadReportData();

    // Mobile menu toggle
    $('#mobileMenuToggle').click(function() {
        $('.admin-sidebar').toggleClass('show');
    });
});

// yyyy-mm-dd in local time, for <input type="date">
function toInputDate(date) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().split('T')[0];
}

// Set the date inputs to the last N days (including today)
function setDateRange(days) {
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - (days - 1));

    $('#endDate').val(toInputDate(today));
    $('#startDate').val(toInputDate(start));
}

// Orders inside the selected date range (cancelled orders don't count)
function getFilteredOrders() {
    const start = new Date($('#startDate').val() + 'T00:00:00');
    const end = new Date($('#endDate').val() + 'T23:59:59');

    return getOrders().filter(order => {
        const time = new Date(order.timestamp);
        return order.status !== 'Cancelled' && time >= start && time <= end;
    });
}

// Category of an ordered item, looked up in the current menu
function getItemCategory(orderItem, menu) {
    const menuItem = menu.find(m => m.id === orderItem.id) || menu.find(m => m.name === orderItem.name);
    return menuItem ? menuItem.category : 'other';
}

// Load report data
function loadReportData() {
    const orders = getFilteredOrders();

    const totalRevenue = orders.reduce((sum, order) => sum + order.total, 0);
    const avgOrderValue = orders.length > 0 ? totalRevenue / orders.length : 0;
    const uniqueCustomers = new Set(orders.map(o => o.studentId)).size;

    $('#totalRevenue').text(formatPrice(totalRevenue));
    $('#totalOrders').text(orders.length);
    $('#avgOrder').text(formatPrice(avgOrderValue));
    $('#totalCustomers').text(uniqueCustomers);

    loadPopularItems(orders);
    updateCharts(orders);
}

// Load popular items
function loadPopularItems(orders) {
    const menu = getMenuItems();
    const itemStats = {};

    orders.forEach(order => {
        order.items.forEach(item => {
            if (!itemStats[item.name]) {
                itemStats[item.name] = {
                    name: item.name,
                    category: getItemCategory(item, menu),
                    orders: 0,
                    revenue: 0
                };
            }
            itemStats[item.name].orders += item.quantity;
            itemStats[item.name].revenue += item.price * item.quantity;
        });
    });

    // Convert to array and sort by orders
    const sortedItems = Object.values(itemStats)
        .sort((a, b) => b.orders - a.orders)
        .slice(0, 10);

    const tbody = $('#popularItemsBody');
    tbody.empty();

    if (sortedItems.length === 0) {
        tbody.append('<tr><td colspan="6" class="text-center text-muted">No orders in this period</td></tr>');
        return;
    }

    sortedItems.forEach((item, index) => {
        const rankClass = index === 0 ? 'rank-1' : index === 1 ? 'rank-2' : index === 2 ? 'rank-3' : 'rank-other';

        tbody.append(`
            <tr>
                <td><span class="rank-badge ${rankClass}">${index + 1}</span></td>
                <td><strong>${item.name}</strong></td>
                <td><span class="item-badge text-capitalize">${item.category}</span></td>
                <td><strong>${item.orders}</strong> sold</td>
                <td><strong>${formatPrice(item.revenue)}</strong></td>
                <td>${formatPrice(item.revenue / item.orders)}</td>
            </tr>
        `);
    });
}

// Initialize Charts (empty - filled by updateCharts)
let revenueChart, categoryChart;

function initializeCharts() {
    const revenueCtx = document.getElementById('revenueChart').getContext('2d');
    revenueChart = new Chart(revenueCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Revenue (Rs.)',
                data: [],
                borderColor: 'rgb(54, 69, 42)',
                backgroundColor: 'rgba(54, 69, 42, 0.1)',
                tension: 0.4,
                fill: true,
                pointRadius: 4,
                pointBackgroundColor: 'rgb(54, 69, 42)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: function(value) {
                            return formatPrice(value);
                        }
                    }
                }
            }
        }
    });

    const categoryCtx = document.getElementById('categoryChart').getContext('2d');
    categoryChart = new Chart(categoryCtx, {
        type: 'doughnut',
        data: {
            labels: MENU_CATEGORIES.map(c => c.charAt(0).toUpperCase() + c.slice(1)),
            datasets: [{
                data: [],
                backgroundColor: [
                    'rgba(255, 177, 105, 0.8)',
                    'rgba(54, 69, 42, 0.8)',
                    'rgba(169, 27, 13, 0.8)',
                    'rgba(143, 151, 119, 0.8)'
                ],
                borderWidth: 2,
                borderColor: '#FDFDF6'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom'
                }
            }
        }
    });
}

// Fill both charts from the orders in the selected range
function updateCharts(orders) {
    // Revenue per day
    const labels = [];
    const data = [];
    const end = new Date($('#endDate').val() + 'T00:00:00');
    for (let day = new Date($('#startDate').val() + 'T00:00:00'); day <= end; day.setDate(day.getDate() + 1)) {
        labels.push(day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        data.push(orders
            .filter(o => new Date(o.timestamp).toDateString() === day.toDateString())
            .reduce((sum, o) => sum + o.total, 0));
    }
    revenueChart.data.labels = labels;
    revenueChart.data.datasets[0].data = data;
    revenueChart.update();

    // Revenue per menu category
    const menu = getMenuItems();
    categoryChart.data.datasets[0].data = MENU_CATEGORIES.map(category =>
        orders.reduce((sum, order) => sum + order.items
            .filter(item => getItemCategory(item, menu) === category)
            .reduce((s, item) => s + item.price * item.quantity, 0), 0)
    );
    categoryChart.update();
}

// Period dropdown: show the last N days
function updateRevenueChart() {
    setDateRange(parseInt($('#revenueChartPeriod').val()));
    loadReportData();
}

// Apply date filter
function applyDateFilter() {
    const startDate = $('#startDate').val();
    const endDate = $('#endDate').val();

    if (!startDate || !endDate) {
        showToast('Please select both start and end dates', 'error');
        return;
    }
    if (startDate > endDate) {
        showToast('Start date must be before end date', 'error');
        return;
    }

    loadReportData();
    showToast('Filter applied successfully!', 'success');
}

// Export the orders in the selected range as a CSV file (opens in Excel)
function exportReport() {
    const orders = getFilteredOrders();
    if (orders.length === 0) {
        showToast('No orders to export in this period', 'error');
        return;
    }

    const rows = [['Order ID', 'Date', 'Student ID', 'Name', 'Items', 'Payment', 'Status', 'Total (Rs.)']];
    orders.forEach(o => rows.push([
        o.orderId,
        new Date(o.timestamp).toLocaleString(),
        o.studentId,
        o.fullName,
        o.items.map(i => `${i.name} x${i.quantity}`).join('; '),
        o.paymentMethod,
        o.status,
        o.total
    ]));

    const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = `cafeteria-report-${$('#startDate').val()}-to-${$('#endDate').val()}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);

    showToast('Report exported successfully!', 'success');
}

// Show toast notification
function showToast(message, type = 'info') {
    const bgColor = type === 'success' ? 'var(--dark)' : type === 'error' ? 'var(--error)' : 'var(--muted)';
    
    const toast = $(`
        <div style="position: fixed; top: 80px; right: 20px; background: ${bgColor}; color: var(--on-dark); padding: 15px 25px; border-radius: 0; box-shadow: var(--shadow-sm); z-index: 9999; display: flex; align-items: center; gap: 10px; animation: slideIn 0.3s ease;">
            <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
            <span>${message}</span>
        </div>
    `);
    
    $('body').append(toast);
    
    setTimeout(() => {
        toast.fadeOut(300, function() {
            $(this).remove();
        });
    }, 3000);
}
