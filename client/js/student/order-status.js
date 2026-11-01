// Live tracking for ?order=<id> (or the order just placed).
// The page asks the server for the latest status every 10 seconds.

const STEPS = [
    { status: 'Received',  icon: 'fa-receipt',      title: 'Order placed',      text: 'Waiting for the cafeteria to accept it' },
    { status: 'Accepted',  icon: 'fa-thumbs-up',    title: 'Accepted',          text: 'The cafeteria has confirmed your order' },
    { status: 'Preparing', icon: 'fa-fire',         title: 'Preparing',         text: 'The kitchen is cooking your food' },
    { status: 'Ready',     icon: 'fa-bell',         title: 'Ready for pickup',  text: 'Collect it at the counter' },
    { status: 'Completed', icon: 'fa-check-circle', title: 'Collected',         text: 'Enjoy your meal!' }
];

const CLOSED = {
    Cancelled: { title: 'Order cancelled', icon: 'fa-ban' },
    Rejected: { title: 'The cafeteria could not take this order', icon: 'fa-times-circle' },
    'No Show': { title: 'Not collected', icon: 'fa-user-clock' }
};

const PAYMENT_LABELS = { Cash: 'Cash at the counter', Easypaisa: 'Easypaisa', JazzCash: 'JazzCash' };

let currentOrder = null;
let pollTimer = null;

document.addEventListener('DOMContentLoaded', async function() {
    const user = await requireStudentLogin();
    if (!user) return;

    const orderId = new URLSearchParams(location.search).get('order') || localStorage.getItem('currentOrderId');
    if (!orderId) {
        // No order chosen: show the order history instead
        window.location.href = 'profile.html';
        return;
    }

    try {
        currentOrder = await getOrder(orderId);
    } catch (error) {
        showToast(error.message, 'error');
        return;
    }
    render();
    pollTimer = setInterval(checkForStatusUpdate, 10000);
});

function render() {
    const order = currentOrder;
    document.getElementById('orderIdDisplay').textContent = `Order ${order.number}`;
    const badge = document.getElementById('orderStatus');
    badge.textContent = order.status === 'Ready' ? 'Ready for pickup' : order.status;
    badge.classList.toggle('is-closed', !!CLOSED[order.status]);
    badge.classList.toggle('is-done', order.status === 'Completed');
    renderHeader();

    // Pickup banner: the promised ready time once accepted, else the requested time
    const ready = order.estimatedReady && order.status !== 'Received';
    document.querySelector('.pickup-info h4').textContent = ready ? 'Ready by' : 'Requested pickup';
    document.getElementById('pickupTimeDisplay').textContent = formatWhen(ready ? order.estimatedReady : order.pickupAt);

    document.getElementById('customerName').textContent = order.fullName;
    document.getElementById('studentId').textContent = order.studentId;
    document.getElementById('phoneNumber').textContent = order.phoneNumber || '—';
    const reference = order.transactionReference ? ` · ID ${order.transactionReference}` : '';
    document.getElementById('paymentMethod').textContent =
        `${PAYMENT_LABELS[order.paymentMethod] || order.paymentMethod}${reference}`;
    document.getElementById('paymentStatus').textContent = PAYMENT_STATUS_LABELS[order.paymentStatus] || order.paymentStatus;
    document.getElementById('totalAmount').textContent = formatPrice(order.total);
    document.getElementById('grandTotal').textContent = formatPrice(order.total);

    document.getElementById('orderItemsList').innerHTML = order.items.map(item => `
        <div class="item-row">
            <div class="item-details">
                <span class="item-qty">${item.quantity}x</span>
                <span class="item-name">${escapeHtml(item.name)}</span>
            </div>
            <span class="item-price">${formatPrice(item.price * item.quantity)}</span>
        </div>
    `).join('');

    renderTimeline();
    renderCancel();
}

const PAYMENT_STATUS_LABELS = {
    Pending: 'Not paid yet',
    Confirmed: 'Paid',
    Refunded: 'Refunded',
    Void: 'Not charged'
};

// Big banner at the top: what the customer should know right now
const HEADERS = {
    Received:  ['fa-check', 'Order placed!', 'The cafeteria will accept it within 10 minutes - this page updates on its own.'],
    Accepted:  ['fa-thumbs-up', 'Order accepted', 'The kitchen will start on it soon.'],
    Preparing: ['fa-fire', 'Being prepared', 'Your food is cooking.'],
    Ready:     ['fa-bell', 'Ready for pickup!', 'Show your order number at the counter.'],
    Completed: ['fa-check-circle', 'Enjoy your meal!', 'Thanks for ordering with us.'],
    Cancelled: ['fa-ban', 'Order cancelled', ''],
    Rejected:  ['fa-times', "We couldn't take this order", 'See the reason below. '],
    'No Show': ['fa-user-clock', 'Order not collected', 'Please pay at the counter before ordering again.']
};

function renderHeader() {
    let [icon, title, text] = HEADERS[currentOrder.status];
    if (['Cancelled', 'Rejected'].includes(currentOrder.status)) {
        text += currentOrder.paymentStatus === 'Refunded'
            ? 'Your payment is marked for a refund - collect it at the counter.'
            : 'Nothing was charged for this order.';
    }
    document.getElementById('headerIcon').className = 'fas ' + icon;
    document.getElementById('headerTitle').textContent = title;
    document.getElementById('headerText').textContent = text;
    document.querySelector('.success-hero').classList.toggle('is-closed', !!CLOSED[currentOrder.status]);
}

// When each status was reached, from the order's history
function reachedAt(status) {
    const entry = currentOrder.history.find(h => h.new_status === status);
    return entry ? entry.changed_at : null;
}

function renderTimeline() {
    const order = currentOrder;
    const closed = CLOSED[order.status];
    const banner = document.getElementById('closedBanner');
    banner.hidden = !closed;
    if (closed) {
        banner.innerHTML = `
            <i class="fas ${closed.icon}"></i>
            <div>
                <strong>${closed.title}</strong>
                ${order.closeReason ? `<p>${escapeHtml(order.closeReason)}</p>` : ''}
                ${order.status === 'No Show' && order.paymentStatus === 'Pending'
                    ? `<p>${formatPrice(order.total)} is still owed - please pay at the counter before your next order.</p>` : ''}
            </div>`;
    }

    // For a closed order, show the steps it actually reached
    const lastIndex = closed
        ? Math.max(...STEPS.map((step, i) => reachedAt(step.status) ? i : -1))
        : STEPS.findIndex(step => step.status === order.status);

    document.getElementById('timeline').innerHTML = STEPS.map((step, i) => {
        const time = reachedAt(step.status);
        let state = i < lastIndex || (closed && i === lastIndex) || order.status === 'Completed' ? 'completed'
                  : i === lastIndex ? 'active' : 'pending';
        let note = time ? new Date(time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                        : state === 'active' ? 'Now' : 'Pending';
        if (step.status === 'Accepted' && time && order.estimatedReady) {
            note += ` · ready by ${formatWhen(order.estimatedReady)}`;
        }
        if (closed && i > lastIndex) state = 'pending skipped';
        return `
            <div class="timeline-item ${state}">
                <div class="timeline-icon"><i class="fas ${state === 'completed' ? 'fa-check' : step.icon}"></i></div>
                ${i < STEPS.length - 1 ? '<div class="timeline-connector"></div>' : ''}
                <div class="timeline-content">
                    <h4>${step.title}</h4>
                    <p>${step.text}</p>
                    <span class="timeline-time">${note}</span>
                </div>
            </div>`;
    }).join('');
}

// Customers may cancel until the kitchen starts, and until 20 min before pickup
function renderCancel() {
    const order = currentOrder;
    const canCancel = ['Received', 'Accepted'].includes(order.status)
        && new Date(order.cancellationDeadline) > new Date();
    document.getElementById('cancelRow').hidden = !canCancel;
    if (canCancel) {
        document.getElementById('cancelHint').textContent =
            `Changed your mind? You can cancel until ${formatWhen(order.cancellationDeadline)}.`;
    }
}

async function cancelOrder() {
    if (!confirm('Cancel this order?')) return;
    try {
        const { order } = await api(`/orders/${currentOrder.orderId}/cancel`, { method: 'POST', body: {} });
        currentOrder = toOrder(order);
        render();
        showToast('Order cancelled', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

const STATUS_MESSAGES = {
    Accepted: 'The cafeteria accepted your order',
    Preparing: 'Your order is being prepared',
    Ready: 'Your order is ready for pickup!',
    Completed: 'Order collected. Enjoy!',
    Rejected: 'The cafeteria could not take your order',
    'No Show': 'Your order was not collected in time'
};

async function checkForStatusUpdate(manual = false) {
    try {
        const latest = await getOrder(currentOrder.orderId);
        const changed = latest.status !== currentOrder.status;
        currentOrder = latest;
        render();
        if (changed && STATUS_MESSAGES[latest.status]) {
            showToast(STATUS_MESSAGES[latest.status], ['Rejected', 'No Show'].includes(latest.status) ? 'error' : 'success');
        } else if (manual) {
            showToast('Status is up to date', 'success');
        }
        if (CLOSED[latest.status] || latest.status === 'Completed') clearInterval(pollTimer);
    } catch (error) {
        if (manual) showToast(error.message, 'error');
    }
}

async function refreshStatus() {
    const icon = document.querySelector('.refresh-btn i');
    icon.classList.add('spinning');
    await checkForStatusUpdate(true);
    icon.classList.remove('spinning');
}

function downloadReceipt() {
    window.location.href = 'receipt.html?order=' + currentOrder.orderId;
}

// Show toast notification
function showToast(message, type = 'success') {
    const bgColor = type === 'success' ? 'var(--success-color)' : 'var(--error)';

    const toast = document.createElement('div');
    toast.setAttribute('role', 'status');
    toast.style.cssText = `
        position: fixed;
        top: 100px;
        right: 20px;
        background: ${bgColor};
        color: var(--on-dark);
        padding: 15px 25px;
        border-radius: 0;
        box-shadow: var(--shadow-sm);
        z-index: 9999;
        animation: slideIn 0.3s ease;
    `;
    toast.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i> ${escapeHtml(message)}`;

    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Add animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(400px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(400px); opacity: 0; }
    }
`;
document.head.appendChild(style);
