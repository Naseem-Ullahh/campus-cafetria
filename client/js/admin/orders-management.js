// Orders Management JavaScript
// Reads the same orders the students place at checkout (store.js)
requireAdminLogin();

let currentStatus = 'all';
let selectedOrderId = null;

$(document).ready(function() {
    // Load navbar
    $('#navbar-placeholder').load('../../components/admin-navbar.html');

    renderTable();

    // Pick up new orders placed from another tab, and refresh every 15 seconds
    window.addEventListener('storage', e => { if (e.key === 'orders') renderTable(); });
    setInterval(renderTable, 15000);

    // Search by order ID or student
    $('#searchInput').on('input', renderTable);

    // Filter by status
    $('.dropdown-item[data-status]').on('click', function(e) {
        e.preventDefault();
        currentStatus = $(this).data('status');
        $('#statusFilterDropdown').text($(this).text());
        renderTable();
    });

    // View details buttons inside the table
    $(document).on('click', '.view-btn', function() {
        showOrderDetails($(this).data('id'));
    });

    // Update status from the modal
    $('#updateStatusBtn').on('click', function() {
        if (!selectedOrderId) return;
        const status = $('#statusUpdate').val();
        setOrderStatus(selectedOrderId, status);
        renderTable();
        $('#orderDetailsModal').modal('hide');
        showToast(`Order ${selectedOrderId} marked as ${status}`, 'success');
    });
});

function getStatusBadge(status) {
    const classes = {
        Received: 'bg-danger',
        Preparing: 'bg-warning text-dark',
        Ready: 'bg-info text-dark',
        Completed: 'bg-success',
        Cancelled: 'bg-secondary'
    };
    return `<span class="badge ${classes[status] || 'bg-secondary'}">${status}</span>`;
}

// Render table using current search text and status filter, newest first
function renderTable() {
    const query = ($('#searchInput').val() || '').toLowerCase();
    const orders = getOrders()
        .filter(order =>
            (currentStatus === 'all' || order.status === currentStatus) &&
            (order.orderId.toLowerCase().includes(query) ||
             (order.fullName || '').toLowerCase().includes(query) ||
             (order.studentId || '').toLowerCase().includes(query))
        )
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const tbody = $('#ordersTableBody');
    tbody.empty();

    if (orders.length === 0) {
        tbody.append('<tr><td colspan="7" class="text-center text-muted py-4">No orders found</td></tr>');
        return;
    }

    orders.forEach(order => {
        const itemsText = order.items.map(i => `${i.name} x${i.quantity}`).join(', ');
        tbody.append(`
            <tr>
                <td><strong>${order.orderId}</strong></td>
                <td>${order.fullName}<br><small class="text-muted">${order.studentId}</small></td>
                <td>${itemsText}</td>
                <td>${formatPrice(order.total)}</td>
                <td>${getStatusBadge(order.status)}</td>
                <td>${new Date(order.timestamp).toLocaleString()}</td>
                <td>
                    <button class="btn btn-sm btn-primary view-btn" data-id="${order.orderId}"><i class="fas fa-eye"></i></button>
                </td>
            </tr>
        `);
    });
}

function showOrderDetails(orderId) {
    const order = findOrder(orderId);
    if (!order) return;

    selectedOrderId = orderId;
    const itemRows = order.items.map(i => `
        <tr><td>${i.name}</td><td>${i.quantity}</td><td>${formatPrice(i.price)}</td><td>${formatPrice(i.price * i.quantity)}</td></tr>
    `).join('');

    $('#orderDetailsContent').html(`
        <div class="row mb-3">
            <div class="col-md-6">
                <p class="mb-1"><strong>Order ID:</strong> ${order.orderId}</p>
                <p class="mb-1"><strong>Student:</strong> ${order.fullName} (${order.studentId})</p>
                <p class="mb-1"><strong>Phone:</strong> ${order.phoneNumber || '-'}</p>
            </div>
            <div class="col-md-6">
                <p class="mb-1"><strong>Placed:</strong> ${new Date(order.timestamp).toLocaleString()}</p>
                <p class="mb-1"><strong>Pickup time:</strong> ${order.pickupTime || '-'}</p>
                <p class="mb-1"><strong>Payment:</strong> ${order.paymentMethod}${order.transactionReference ? ` (ID ${order.transactionReference})` : ''}</p>
            </div>
        </div>
        ${order.specialInstructions ? `<p><strong>Instructions:</strong> ${order.specialInstructions}</p>` : ''}
        <table class="table table-sm">
            <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
            <tbody>${itemRows}</tbody>
        </table>
        <h5 class="text-end">Total: ${formatPrice(order.total)}</h5>
    `);
    $('#statusUpdate').val(order.status);
    $('#orderDetailsModal').modal('show');
}

// Show toast notification
function showToast(message, type = 'info') {
    const colors = { success: 'var(--dark)', warning: 'var(--amber)', danger: 'var(--error)', info: 'var(--muted)' };
    const toast = $(`
        <div style="position: fixed; top: 80px; right: 20px; background: ${colors[type] || colors.info}; color: var(--on-dark);
                    padding: 12px 20px; border-radius: 0; box-shadow: var(--shadow-sm); z-index: 9999;">
            ${message}
        </div>
    `);
    $('body').append(toast);
    setTimeout(() => toast.fadeOut(300, () => toast.remove()), 3000);
}
