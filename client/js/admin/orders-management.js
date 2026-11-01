// All orders: search, filter and full details with the audit trail.
// Status changes go through the same actions as the live boards.

let currentStatus = 'all';
let selectedOrder = null;
let searchTimer = null;

// The next step(s) staff can take from each status
const NEXT_ACTIONS = {
    Received: [
        { action: 'accept', label: 'Accept', icon: 'fa-check', style: 'btn-primary' },
        { action: 'reject', label: 'Reject...', icon: 'fa-times', style: 'btn-outline-danger', needsReason: true }
    ],
    Accepted: [{ action: 'start', label: 'Start cooking', icon: 'fa-fire', style: 'btn-primary' }],
    Preparing: [{ action: 'ready', label: 'Mark ready', icon: 'fa-bell', style: 'btn-primary' }],
    Ready: [{ action: 'complete', label: 'Take payment & hand over', icon: 'fa-hand-holding', style: 'btn-primary' }]
};

// No Show: the order went on the customer's monthly bill. Staff can correct it if
// the customer did collect it, or verify a wallet payment that wasn't checked in time.
function actionsFor(order) {
    if (order.status !== 'No Show') return NEXT_ACTIONS[order.status] || [];
    const actions = [{ action: 'collected', label: 'Was collected', icon: 'fa-hand-holding', style: 'btn-outline-primary',
                       confirm: `Mark ${order.number} as collected? Only do this if the customer took the food${order.paymentMethod === 'Account' ? '' : ' and paid'} - it comes off their monthly bill.` }];
    if (order.paymentStatus === 'Billed' && isWalletPayment(order.paymentMethod)) {
        actions.unshift({ action: 'confirm-payment', label: `${order.paymentMethod} payment verified`, icon: 'fa-check', style: 'btn-primary',
                          confirm: `Did you find ID ${order.transactionReference} for ${formatPrice(order.total)} in the ${order.paymentMethod} merchant app?` });
    }
    return actions;
}

function paymentText(order) {
    return `${PAYMENT_LABELS[order.paymentMethod] || order.paymentMethod} · ${PAYMENT_STATUS_LABELS[order.paymentStatus] || order.paymentStatus}`;
}

$(document).ready(async function() {
    const user = await requireStaffLogin('admin', 'cashier');
    if (!user) return;

    // Load navbar
    $('#navbar-placeholder').load('../../components/admin-navbar.html');

    await renderTable();
    setInterval(renderTable, 15000);

    // Search by order number, name or university ID (asks the server after typing stops)
    $('#searchInput').on('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderTable, 300);
    });

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
    $(document).on('click', '.order-action', function() {
        if (this.dataset.confirm && !confirm(this.dataset.confirm)) return;
        runAction($(this).data('action'), $(this).data('reason') === true);
    });
});

function getStatusBadge(status) {
    const classes = {
        Received: 'bg-danger',
        Accepted: 'bg-info',
        Preparing: 'bg-warning text-dark',
        Ready: 'bg-info',
        Completed: 'bg-success',
        Cancelled: 'bg-secondary',
        Rejected: 'bg-secondary',
        'No Show': 'bg-secondary'
    };
    return `<span class="badge ${classes[status] || 'bg-secondary'}">${status}</span>`;
}

async function renderTable() {
    const params = new URLSearchParams();
    if (currentStatus !== 'all') params.set('status', currentStatus);
    const query = ($('#searchInput').val() || '').trim();
    if (query) params.set('q', query);

    const tbody = $('#ordersTableBody');
    let orders;
    try {
        orders = (await api('/staff/orders?' + params)).orders.map(toOrder);
    } catch (error) {
        tbody.html(`<tr><td colspan="7" class="text-center text-danger py-4">${escapeHtml(error.message)}</td></tr>`);
        return;
    }

    if (orders.length === 0) {
        tbody.html('<tr><td colspan="7" class="text-center text-muted py-4">No orders found</td></tr>');
        return;
    }

    tbody.html(orders.map(order => `
        <tr>
            <td><strong>${order.number}</strong></td>
            <td>${escapeHtml(order.fullName)}<br><small class="text-muted">${escapeHtml(order.studentId)}</small></td>
            <td>${escapeHtml(order.itemsText)}</td>
            <td>${formatPrice(order.total)}<br><small class="text-muted">${paymentText(order)}</small></td>
            <td>${getStatusBadge(order.status)}</td>
            <td>${formatWhen(order.timestamp)}<br><small class="text-muted">Pickup ${order.pickupTime}</small></td>
            <td>
                <button class="btn btn-sm btn-primary view-btn" data-id="${order.orderId}" aria-label="View order ${order.number}"><i class="fas fa-eye"></i></button>
            </td>
        </tr>
    `).join(''));
}

async function showOrderDetails(orderId) {
    try {
        selectedOrder = await getOrder(orderId);
    } catch (error) {
        showToast(error.message, 'danger');
        return;
    }
    const order = selectedOrder;
    const itemRows = order.items.map(i => `
        <tr><td>${escapeHtml(i.name)}</td><td>${i.quantity}</td><td>${formatPrice(i.price)}</td><td>${formatPrice(i.price * i.quantity)}</td></tr>
    `).join('');
    const history = order.history.map(h => `
        <li><strong>${h.new_status}</strong> · ${formatWhen(h.changed_at)} · ${escapeHtml(h.changed_by)}${h.note ? ` - <em>${escapeHtml(h.note)}</em>` : ''}</li>
    `).join('');

    $('#orderDetailsModalLabel').html(`<i class="fas fa-info-circle"></i> Order ${order.number} ${getStatusBadge(order.status)}`);
    $('#orderDetailsContent').html(`
        <div class="row mb-3">
            <div class="col-md-6">
                <p class="mb-1"><strong>Customer:</strong> ${escapeHtml(order.fullName)} (${escapeHtml(order.studentId)})</p>
                <p class="mb-1"><strong>Phone:</strong> ${escapeHtml(order.phoneNumber || '-')}</p>
                <p class="mb-1"><strong>Payment:</strong> ${paymentText(order)}${order.transactionReference ? ` (ID ${escapeHtml(order.transactionReference)})` : ''}</p>
            </div>
            <div class="col-md-6">
                <p class="mb-1"><strong>Placed:</strong> ${formatWhen(order.timestamp)}</p>
                <p class="mb-1"><strong>Pickup requested:</strong> ${order.pickupTime}</p>
                ${order.estimatedReady ? `<p class="mb-1"><strong>Promised ready by:</strong> ${formatWhen(order.estimatedReady)}</p>` : ''}
            </div>
        </div>
        ${order.specialInstructions ? `<p><strong>Instructions:</strong> ${escapeHtml(order.specialInstructions)}</p>` : ''}
        ${order.closeReason ? `<p><strong>Reason:</strong> ${escapeHtml(order.closeReason)}</p>` : ''}
        <table class="table table-sm">
            <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
            <tbody>${itemRows}</tbody>
        </table>
        <h5 class="text-end">Total: ${formatPrice(order.total)}</h5>
        <h6 class="mt-3">History</h6>
        <ul class="small mb-0">${history}</ul>
    `);

    const actions = actionsFor(order);
    const confirmWallet = order.status === 'Ready' && order.paymentStatus === 'Pending' && isWalletPayment(order.paymentMethod);
    $('#orderActions').html(actions.length ? `
        ${confirmWallet ? `<p class="small text-muted mb-2">Check the ${order.paymentMethod} merchant app for ID ${escapeHtml(order.transactionReference)} before handing over.</p>` : ''}
        ${order.status === 'No Show' ? `<p class="small text-muted mb-2">${formatPrice(order.total)} ${order.paymentStatus === 'Billed' ? 'is on the customer\'s monthly bill.' : 'is paid.'}
            Customer did collect it? Use <em>Was collected</em>.</p>` : ''}
        <div class="d-flex flex-wrap gap-2">
            ${actions.map(a => `<button class="btn ${a.style} order-action" data-action="${a.action}" data-reason="${!!a.needsReason}" data-confirm="${escapeHtml(a.confirm || '')}">
                <i class="fas ${a.icon}"></i> ${a.label}</button>`).join('')}
        </div>` : '');
    $('#orderDetailsModal').modal('show');
}

async function runAction(action, needsReason) {
    const body = {};
    if (needsReason) {
        const reason = prompt('Why are you rejecting this order? The customer will see this.');
        if (!reason || !reason.trim()) return;
        body.reason = reason.trim();
    }
    try {
        await api(`/staff/orders/${selectedOrder.orderId}/${action}`, { method: 'POST', body });
    } catch (error) {
        showToast(error.message, 'danger');
        return;
    }
    showToast(`Order ${selectedOrder.number} updated`, 'success');
    $('#orderDetailsModal').modal('hide');
    renderTable();
}

// Show toast notification
function showToast(message, type = 'info') {
    const colors = { success: 'var(--dark)', warning: 'var(--amber)', danger: 'var(--error)', info: 'var(--muted)' };
    const toast = $(`
        <div role="status" style="position: fixed; top: 80px; right: 20px; background: ${colors[type] || colors.info}; color: var(--on-dark);
                    padding: 12px 20px; border-radius: var(--radius-sm); box-shadow: var(--shadow-sm); z-index: 9999;"></div>
    `).text(message);
    $('body').append(toast);
    setTimeout(() => toast.fadeOut(300, () => toast.remove()), 3000);
}
