// Reports from the database for the selected date range.
// Revenue = payments actually confirmed; item / category sales = collected orders.

$(document).ready(async function() {
    const user = await requireStaffLogin('admin');
    if (!user) return;
    $('#adminName').text(user.name);

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

function rangeQuery() {
    return `from=${$('#startDate').val()}&to=${$('#endDate').val()}`;
}

// Load report data
async function loadReportData() {
    let report;
    try {
        report = await api('/admin/reports?' + rangeQuery());
    } catch (error) {
        showToast(error.message, 'error');
        return;
    }
    const s = report.summary;

    $('#totalRevenue').text(formatPrice(s.revenue));
    $('#totalOrders').text(s.orders);
    $('#avgOrder').text(formatPrice(s.average_order));
    $('#totalCustomers').text(s.customers);
    $('#ordersChange').text(`${s.completed_orders || 0} collected · ${s.cancelled_or_rejected || 0} cancelled/rejected · ${s.no_shows || 0} no-show`);

    loadPopularItems(report.top_items);
    updateCharts(report);
}

function loadPopularItems(items) {
    const tbody = $('#popularItemsBody');
    tbody.empty();

    if (items.length === 0) {
        tbody.append('<tr><td colspan="6" class="text-center text-muted">No collected orders in this period</td></tr>');
        return;
    }

    items.forEach((item, index) => {
        const rankClass = index === 0 ? 'rank-1' : index === 1 ? 'rank-2' : index === 2 ? 'rank-3' : 'rank-other';
        tbody.append(`
            <tr>
                <td><span class="rank-badge ${rankClass}">${index + 1}</span></td>
                <td><strong>${escapeHtml(item.item_name)}</strong></td>
                <td><span class="item-badge">${escapeHtml(item.category_name)}</span></td>
                <td><strong>${item.units}</strong> sold</td>
                <td><strong>${formatPrice(item.sales)}</strong></td>
                <td>${formatPrice(item.sales / item.units)}</td>
            </tr>
        `);
    });
}

// Initialize Charts (empty - filled by updateCharts). Canvas can't read CSS
// variables, so the palette colours are written out here.
let revenueChart, categoryChart;
const CHART_COLORS = ['#FFB169', '#2F8F86', '#9A4F3C', '#8A8178', '#2B1D16'];

function initializeCharts() {
    revenueChart = new Chart(document.getElementById('revenueChart').getContext('2d'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Revenue (Rs.)',
                data: [],
                borderColor: '#2F8F86',
                backgroundColor: 'rgba(47, 143, 134, 0.12)',
                tension: 0.3,
                fill: true,
                pointRadius: 3,
                pointBackgroundColor: '#2F8F86'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { callback: value => formatPrice(value) } } }
        }
    });

    categoryChart = new Chart(document.getElementById('categoryChart').getContext('2d'), {
        type: 'doughnut',
        data: { labels: [], datasets: [{ data: [], backgroundColor: CHART_COLORS, borderWidth: 2, borderColor: '#F3E3A3' }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
}

function updateCharts(report) {
    // Revenue per day, with 0 for days without sales
    const byDay = Object.fromEntries(report.daily.map(d => [d.day, d.revenue]));
    const labels = [];
    const data = [];
    const end = new Date(report.end + 'T00:00:00');
    for (let day = new Date(report.start + 'T00:00:00'); day <= end; day.setDate(day.getDate() + 1)) {
        labels.push(day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        data.push(byDay[toInputDate(day)] || 0);
    }
    revenueChart.data.labels = labels;
    revenueChart.data.datasets[0].data = data;
    revenueChart.update();

    categoryChart.data.labels = report.categories.map(c => c.category_name);
    categoryChart.data.datasets[0].data = report.categories.map(c => c.sales);
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
}

// Export the orders in the selected range as a CSV file (opens in Excel)
async function exportReport() {
    let orders;
    try {
        orders = (await api('/staff/orders?' + rangeQuery())).orders.map(toOrder);
    } catch (error) {
        showToast(error.message, 'error');
        return;
    }
    if (orders.length === 0) {
        showToast('No orders to export in this period', 'error');
        return;
    }

    const rows = [['Order', 'Placed', 'Pickup', 'University ID', 'Name', 'Items', 'Payment', 'Payment status', 'Status', 'Total (Rs.)']];
    orders.forEach(o => rows.push([
        o.number, new Date(o.timestamp).toLocaleString(), new Date(o.pickupAt).toLocaleString(),
        o.studentId, o.fullName, o.itemsText, o.paymentMethod, o.paymentStatus, o.status, o.total
    ]));

    const csv = rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    link.download = `cafeteria-orders-${$('#startDate').val()}-to-${$('#endDate').val()}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);

    showToast(`Exported ${orders.length} orders`, 'success');
}

// Show toast notification
function showToast(message, type = 'info') {
    const bgColor = type === 'success' ? 'var(--dark)' : type === 'error' ? 'var(--error)' : 'var(--muted)';
    const toast = $(`
        <div role="status" style="position: fixed; top: 80px; right: 20px; background: ${bgColor}; color: var(--on-dark); padding: 15px 25px; border-radius: var(--radius-sm); box-shadow: var(--shadow-sm); z-index: 9999; display: flex; align-items: center; gap: 10px;">
            <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
            <span></span>
        </div>
    `);
    toast.find('span').text(message);
    $('body').append(toast);
    setTimeout(() => toast.fadeOut(300, function() { $(this).remove(); }), 3000);
}
