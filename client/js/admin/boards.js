// The three live staff screens. Each page sets <body data-board="...">:
//   incoming - manager / cashier accept or reject new orders
//   kitchen  - chef starts cooking and marks orders ready
//   counter  - cashier takes payment and hands the food over
// Every board reads the same orders from the server every 5 seconds.

const BOARDS = {
    incoming: { title: 'Incoming orders', endpoint: '/staff/incoming', roles: ['admin', 'cashier'],
                empty: 'No new orders. New ones appear here automatically.' },
    kitchen:  { title: 'Kitchen', endpoint: '/staff/kitchen', roles: ['kitchen', 'admin', 'cashier'],
                empty: 'Nothing to cook right now.' },
    counter:  { title: 'Pickup counter', endpoint: '/staff/counter', roles: ['admin', 'cashier'],
                empty: 'No orders waiting to be collected.' }
};

// Links in the top bar, by role
const NAV = [
    { href: 'incoming.html', label: 'Incoming', icon: 'fa-inbox', roles: ['admin', 'cashier'] },
    { href: 'kitchen.html', label: 'Kitchen', icon: 'fa-fire', roles: ['kitchen', 'admin', 'cashier'] },
    { href: 'counter.html', label: 'Counter', icon: 'fa-cash-register', roles: ['admin', 'cashier'] },
    { href: 'orders-management.html', label: 'All orders', icon: 'fa-list', roles: ['admin', 'cashier'] },
    { href: 'dashboard.html', label: 'Dashboard', icon: 'fa-chart-line', roles: ['admin'] }
];

const REJECT_REASONS = ['An item is not available', "Can't be ready by the pickup time", 'Kitchen is closing'];

const boardName = document.body.dataset.board;
const board = BOARDS[boardName];
let user = null;
let knownOrderIds = null;      // to highlight orders that arrived since the last refresh

document.addEventListener('DOMContentLoaded', async function() {
    user = await requireStaffLogin(...board.roles);
    if (!user) return;

    document.getElementById('staffName').textContent = `${user.name} · ${user.role === 'admin' ? 'Manager' : user.role === 'kitchen' ? 'Kitchen' : 'Counter'}`;
    document.getElementById('boardNav').innerHTML = NAV
        .filter(link => link.roles.includes(user.role))
        .map(link => `<a href="${link.href}" class="${link.href === boardName + '.html' ? 'active' : ''}"
                         ${link.href === boardName + '.html' ? 'aria-current="page"' : ''}>
                         <i class="fas ${link.icon}"></i> ${link.label}</a>`)
        .join('');

    await refresh();
    setInterval(refresh, 5000);
    setInterval(tickCountdowns, 1000);
});

async function refresh() {
    let orders;
    try {
        orders = (await api(board.endpoint)).orders;
        setConnection(true);
    } catch (error) {
        setConnection(false, error.message);
        if (error.status === 401) window.location.href = 'login.html';
        return;
    }
    orders.forEach(order => { order.fetchedAt = Date.now(); });
    render(orders);
}

function setConnection(ok, message) {
    const status = document.getElementById('liveStatus');
    status.classList.toggle('offline', !ok);
    status.innerHTML = ok
        ? `<span class="dot"></span> Live · updated ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
        : `<span class="dot"></span> ${escapeHtml(message)} - retrying`;
}

// ---------- Rendering: cards are only replaced when their order changed ----------
function render(orders) {
    const columns = boardName === 'kitchen'
        ? { todo: orders.filter(o => o.status === 'Accepted'), cooking: orders.filter(o => o.status === 'Preparing') }
        : { all: orders };

    for (const [column, list] of Object.entries(columns)) {
        const container = document.getElementById('column-' + column);
        const seen = new Set();
        list.forEach((order, index) => {
            const key = String(order.order_id);
            seen.add(key);
            const signature = JSON.stringify({ ...order, fetchedAt: 0, seconds_to_decide: 0, minutes_waiting: 0, minutes_until_due: 0 });
            let card = container.querySelector(`[data-order="${key}"]`);
            if (!card || card.dataset.signature !== signature) {
                const fresh = document.createElement('article');
                fresh.className = 'order-card';
                fresh.dataset.order = key;
                fresh.dataset.signature = signature;
                fresh.innerHTML = cardHtml(order);
                if (knownOrderIds && !knownOrderIds.has(order.order_id)) fresh.classList.add('is-new');
                // Keep a reject reason someone is halfway through typing
                const openForm = card && card.querySelector('.reject-form:not([hidden])');
                if (openForm) {
                    const form = fresh.querySelector('.reject-form');
                    form.hidden = false;
                    form.reason.value = openForm.reason.value;
                }
                if (card) card.replaceWith(fresh); else container.appendChild(fresh);
                card = fresh;
            }
            // Unchanged cards are kept, but their countdowns restart from the fresh numbers
            card.querySelectorAll('[data-deadline]').forEach(el => {
                el.dataset.deadline = el.dataset.mode === 'due' ? order.minutes_until_due * 60 : order.seconds_to_decide;
                el.dataset.fetchedAt = order.fetchedAt;
            });
            if (container.children[index] !== card) container.insertBefore(card, container.children[index] || null);
        });
        [...container.children].forEach(card => { if (!seen.has(card.dataset.order)) card.remove(); });
        const counter = document.getElementById('count-' + column);
        if (counter) counter.textContent = list.length;
        container.classList.toggle('is-empty', list.length === 0);
    }

    knownOrderIds = new Set(orders.map(o => o.order_id));
    document.getElementById('emptyState').hidden = orders.length > 0;
    document.getElementById('emptyState').textContent = board.empty;
    document.title = `${orders.length ? `(${orders.length}) ` : ''}${board.title} - Signals Std. Cafe'`;
    tickCountdowns();
}

function itemsHtml(itemsText) {
    return `<ul class="card-items">${itemsText.split(', ').map(part => {
        const [quantity, ...name] = part.split(' x ');
        return `<li><span class="qty">${escapeHtml(quantity)}×</span> ${escapeHtml(name.join(' x '))}</li>`;
    }).join('')}</ul>`;
}

const time = value => new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function cardHtml(order) {
    const head = `
        <header class="card-head">
            <span class="card-number">${formatOrderNumber(order.order_id)}</span>
            ${order.full_name ? `<span class="card-customer">${escapeHtml(order.full_name)}${order.university_id ? ` · ${escapeHtml(order.university_id)}` : ''}</span>` : ''}
        </header>`;
    const note = order.special_instructions
        ? `<p class="card-note"><i class="fas fa-comment-dots"></i> ${escapeHtml(order.special_instructions)}</p>` : '';

    if (boardName === 'incoming') {
        const wallet = order.payment_method !== 'Cash';
        return `${head}
            <div class="card-meta">
                <span class="countdown" data-deadline="${order.seconds_to_decide}"></span>
                <span>Pickup <strong>${formatWhen(order.requested_pickup_time)}</strong></span>
            </div>
            ${itemsHtml(order.items)}${note}
            <div class="card-pay">
                <span>${formatPrice(order.total_amount)} · ${order.payment_method}</span>
                ${wallet ? `<span class="muted">ID ${escapeHtml(order.transaction_reference)} - verify at pickup</span>` : ''}
            </div>
            <div class="card-actions">
                <label class="sr-only" for="ready-${order.order_id}">Ready by</label>
                <select id="ready-${order.order_id}" class="ready-select">${readyOptions(order.requested_pickup_time)}</select>
                <button class="btn-act primary" onclick="accept(${order.order_id})"><i class="fas fa-check"></i> Accept</button>
                <button class="btn-act danger-outline" onclick="toggleReject(${order.order_id})">Reject</button>
            </div>
            <form class="reject-form" id="reject-${order.order_id}" hidden onsubmit="reject(event, ${order.order_id})">
                <p class="reject-title">Why can't you take it? The customer will see this.</p>
                <div class="reason-chips">${REJECT_REASONS.map(r =>
                    `<button type="button" class="chip" onclick="this.form.reason.value=this.textContent">${r}</button>`).join('')}</div>
                <input name="reason" class="form-control" maxlength="255" placeholder="Reason" required>
                <div class="card-actions">
                    <button type="submit" class="btn-act danger">Reject order</button>
                    <button type="button" class="btn-act" onclick="toggleReject(${order.order_id})">Back</button>
                </div>
            </form>`;
    }

    if (boardName === 'kitchen') {
        const cooking = order.status === 'Preparing';
        return `${head}
            <div class="card-meta">
                <span class="due" data-deadline="${order.minutes_until_due * 60}" data-mode="due"></span>
                <span>Ready by <strong>${time(order.estimated_ready_time)}</strong></span>
            </div>
            ${itemsHtml(order.items)}${note}
            <div class="card-actions">
                ${cooking
                    ? `<button class="btn-act primary big" onclick="act(${order.order_id}, 'ready', 'Marked ready')"><i class="fas fa-bell"></i> Mark ready</button>`
                    : `<button class="btn-act primary big" onclick="act(${order.order_id}, 'start', 'Cooking started')"><i class="fas fa-fire"></i> Start cooking</button>`}
            </div>`;
    }

    // counter
    const pending = order.payment_status === 'Pending';
    const wallet = order.payment_method !== 'Cash';
    let payment;
    if (!pending) {
        payment = `<span class="paid"><i class="fas fa-check-circle"></i> Paid · ${order.payment_method}</span>`;
    } else if (wallet) {
        payment = `<span>Check ${order.payment_method} for <strong>${formatPrice(order.total_amount)}</strong>, ID <strong>${escapeHtml(order.transaction_reference)}</strong></span>`;
    } else {
        payment = `<span>Collect <strong>${formatPrice(order.total_amount)}</strong> cash</span>`;
    }
    return `${head}
        <div class="card-meta">
            <span>Ready since <strong>${time(order.ready_at)}</strong></span>
            <span class="muted">No show after ${time(order.no_show_after)}</span>
        </div>
        ${itemsHtml(order.items)}
        <div class="card-pay">${payment}</div>
        <div class="card-actions">
            ${pending && wallet
                ? `<button class="btn-act primary" onclick="act(${order.order_id}, 'confirm-payment', 'Payment confirmed')"><i class="fas fa-check"></i> Payment received</button>
                   <button class="btn-act" disabled title="Confirm the payment first">Hand over</button>`
                : `<button class="btn-act primary big" onclick="act(${order.order_id}, 'complete', 'Handed over')"><i class="fas fa-hand-holding"></i>
                       ${pending ? 'Cash taken - hand over' : 'Hand over'}</button>`}
        </div>`;
}

// "By pickup" or a few minutes earlier, only times still in the future
function readyOptions(pickup) {
    const pickupTime = new Date(pickup);
    return [0, 5, 10, 15]
        .map(minutes => new Date(pickupTime.getTime() - minutes * 60000))
        .filter(date => date > new Date(Date.now() + 60000))
        .map((date, i) => `<option value="${date.toISOString()}">${i === 0 ? 'Ready by pickup' : 'Ready by'} ${time(date)}</option>`)
        .join('');
}

// Countdowns run every second between refreshes
function tickCountdowns() {
    document.querySelectorAll('[data-deadline]').forEach(el => {
        const elapsed = (Date.now() - Number(el.dataset.fetchedAt || Date.now())) / 1000;
        const seconds = Math.round(Number(el.dataset.deadline) - elapsed);
        if (el.dataset.mode === 'due') {
            const minutes = Math.round(seconds / 60);
            const span = m => m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
            el.textContent = minutes > 0 ? `Due in ${span(minutes)}` : minutes === 0 ? 'Due now' : `${span(-minutes)} late`;
            el.classList.toggle('urgent', minutes <= 5);
        } else {
            const left = Math.max(seconds, 0);
            el.textContent = left > 0
                ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left to accept`
                : 'Time up - will be auto-rejected';
            el.classList.toggle('urgent', left < 180);
        }
    });
}

// ---------- Actions ----------
async function act(orderId, action, doneMessage, body = {}) {
    const card = document.querySelector(`[data-order="${orderId}"]`);
    card?.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
        await api(`/staff/orders/${orderId}/${action}`, { method: 'POST', body });
        showToast(`${formatOrderNumber(orderId)}: ${doneMessage}`, 'success');
    } catch (error) {
        showToast(error.message, 'error');
        card?.querySelectorAll('button').forEach(button => { button.disabled = false; });
    }
    await refresh();
}

function accept(orderId) {
    const ready = document.getElementById('ready-' + orderId).value;
    act(orderId, 'accept', 'Accepted - sent to the kitchen', ready ? { estimated_ready_time: ready } : {});
}

function toggleReject(orderId) {
    const form = document.getElementById('reject-' + orderId);
    form.hidden = !form.hidden;
    if (!form.hidden) form.reason.focus();
}

function reject(event, orderId) {
    event.preventDefault();
    act(orderId, 'reject', 'Rejected', { reason: event.target.reason.value.trim() });
}

function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = `board-toast ${type}`;
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}
