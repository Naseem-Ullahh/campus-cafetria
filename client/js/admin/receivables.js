// Amount receivable (manager / cashier): what customers owe on their monthly
// bills, online payments to check, and recording payments at the counter.
// The manager can also waive amounts, set limits and change the billing rules.

let user = null;
let show = new URLSearchParams(location.search).get('show') || 'owing';
let openUserId = null;
let searchTimer = null;

const USER_TYPES = { student: 'Student', gc: 'GC', army: 'Army', faculty: 'Faculty', staff: 'Staff' };

document.addEventListener('DOMContentLoaded', async function() {
    user = await requireStaffLogin('admin', 'cashier');
    if (!user) return;
    renderStaffBar(user, 'receivables.html');

    const isAdmin = user.role === 'admin';
    document.getElementById('settingsPanel').hidden = !isAdmin;
    document.getElementById('limitForm').hidden = !isAdmin;
    if (!isAdmin) document.querySelector('#payMethod option[data-admin]').remove();

    document.querySelectorAll('.segmented button').forEach(button => {
        button.classList.toggle('active', button.dataset.show === show);
        button.addEventListener('click', () => {
            show = button.dataset.show;
            document.querySelectorAll('.segmented button').forEach(b => b.classList.toggle('active', b === button));
            refresh();
        });
    });
    document.getElementById('search').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(refresh, 300);
    });
    document.getElementById('payMethod').addEventListener('change', updatePaymentFields);
    document.getElementById('paymentForm').addEventListener('submit', recordPayment);
    document.getElementById('limitForm').addEventListener('submit', saveLimit);
    document.getElementById('settingsForm').addEventListener('submit', saveSettings);

    await refresh();
    setInterval(() => { if (!document.getElementById('accountDialog').open) refresh(); }, 15000);
});

// ---------- List ----------
async function refresh() {
    const params = new URLSearchParams({ show });
    const search = document.getElementById('search').value.trim();
    if (search) params.set('q', search);
    let data;
    try {
        data = await api('/staff/accounts?' + params);
    } catch (error) {
        if (error.status === 401) window.location.href = 'login.html';
        document.getElementById('accountsBody').innerHTML = `<tr><td colspan="7" class="form-error">${escapeHtml(error.message)}</td></tr>`;
        return;
    }
    renderTotals(data.totals);
    renderPending(data.pending);
    renderAccounts(data.accounts);
    renderSettings(data.settings);
}

function renderTotals(t) {
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    document.getElementById('totalOutstanding').textContent = formatPrice(t.outstanding);
    document.getElementById('totalOwing').textContent = plural(t.customers_owing, 'customer');
    document.getElementById('totalOverdue').textContent = formatPrice(t.overdue);
    document.getElementById('totalOverdue').closest('.total').classList.toggle('is-bad', t.overdue > 0);
    document.getElementById('totalBlocked').textContent = t.customers_blocked ? `${plural(t.customers_blocked, 'customer')} can't order` : 'Nobody blocked';
    document.getElementById('totalToVerify').textContent = t.to_verify;
    document.getElementById('totalCollected').textContent = formatPrice(t.collected_this_month);
}

function renderPending(pending) {
    document.getElementById('pendingPanel').hidden = pending.length === 0;
    document.getElementById('pendingList').innerHTML = pending.map(p => `
        <article class="pending-card" data-payment="${p.account_payment_id}">
            <div>
                <strong>${formatPrice(p.amount)}</strong> by ${p.method} · ID <strong>${escapeHtml(p.transaction_reference)}</strong>
                <div class="muted small">${escapeHtml(p.full_name)} · ${escapeHtml(p.university_id)} · sent ${formatWhen(p.created_at)} · owes ${formatPrice(p.balance)}</div>
            </div>
            <div class="card-actions">
                <button class="btn-act primary" onclick="confirmPayment(${p.account_payment_id})"><i class="fas fa-check"></i> Found it - confirm</button>
                <button class="btn-act danger-outline" onclick="rejectPayment(${p.account_payment_id})">Not found</button>
            </div>
        </article>`).join('');
}

const EMPTY = {
    owing: 'Nobody owes anything right now.',
    overdue: 'No overdue bills.',
    verify: 'No online payments waiting to be checked.',
    all: 'No customers found.'
};

function renderAccounts(accounts) {
    const body = document.getElementById('accountsBody');
    if (accounts.length === 0) {
        body.innerHTML = `<tr><td colspan="7" class="muted">${document.getElementById('search').value.trim() ? 'No customers match your search.' : EMPTY[show]}</td></tr>`;
        return;
    }
    body.innerHTML = accounts.map(a => `
        <tr class="${a.overdue > 0 ? 'is-overdue' : ''}">
            <td><strong>${escapeHtml(a.full_name)}</strong>
                <div class="muted small">${escapeHtml(a.university_id)} · ${USER_TYPES[a.user_type] || a.user_type}${a.phone ? ' · ' + escapeHtml(a.phone) : ''}
                ${a.account_enabled ? '' : ' · <span class="tag">Bill off</span>'}${a.pending_payment_count ? ' · <span class="tag warn">Payment to check</span>' : ''}</div></td>
            <td class="num">${formatPrice(a.balance)}</td>
            <td class="num">${a.overdue > 0 ? `<span class="overdue">${formatPrice(a.overdue)}</span>` : '—'}</td>
            <td class="num">${formatPrice(a.spent_this_month)}</td>
            <td class="num">${formatPrice(a.monthly_limit)}</td>
            <td>${a.last_payment_at ? formatDate(a.last_payment_at) : '—'}</td>
            <td><button class="btn-act" onclick="openAccount(${a.user_id})">Open</button></td>
        </tr>`).join('');
}

function renderSettings(settings) {
    const day = settings.due_day;
    document.getElementById('dueDayText').textContent = day + (day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th');
    if (user.role !== 'admin' || document.getElementById('settingsForm').contains(document.activeElement)) return;
    document.getElementById('accountsOpen').checked = !!settings.accounts_open;
    document.getElementById('dueDay').value = settings.due_day;
    document.getElementById('defaultLimit').value = Math.round(settings.default_monthly_limit);
}

// ---------- Online payments ----------
async function confirmPayment(paymentId) {
    await paymentAction(paymentId, 'confirm', {}, 'Payment confirmed - taken off the bill');
}

async function rejectPayment(paymentId) {
    const reason = prompt('Why is it not accepted? The customer will see this.', 'No payment with this transaction ID');
    if (!reason || !reason.trim()) return;
    await paymentAction(paymentId, 'reject', { reason: reason.trim() }, 'Payment marked as not accepted');
}

async function paymentAction(paymentId, action, body, doneMessage) {
    const card = document.querySelector(`[data-payment="${paymentId}"]`);
    card?.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
        await api(`/staff/account-payments/${paymentId}/${action}`, { method: 'POST', body });
        showToast(doneMessage, 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
    await refresh();
    if (openUserId) openAccount(openUserId, true);
}

// ---------- One customer ----------
async function openAccount(userId, keepForm = false) {
    let data;
    try {
        data = await api('/staff/accounts/' + userId);
    } catch (error) {
        showToast(error.message, 'error');
        return;
    }
    openUserId = userId;
    renderAccount(data.account, data.entries, keepForm);
    const dialog = document.getElementById('accountDialog');
    if (!dialog.open) dialog.showModal();
}

function closeAccount() {
    openUserId = null;
    document.getElementById('accountDialog').close();
    refresh();
}

function renderAccount(a, entries, keepForm) {
    document.getElementById('dialogTitle').textContent = a.full_name;
    document.getElementById('dialogMeta').textContent = [a.university_id, USER_TYPES[a.user_type] || a.user_type, a.phone].filter(Boolean).join(' · ');
    const left = Math.max(a.monthly_limit - a.spent_this_month, 0);
    document.getElementById('dialogSummary').innerHTML = `
        <div class="total"><span class="label">Owes</span><strong>${formatPrice(a.balance)}</strong></div>
        <div class="total ${a.overdue > 0 ? 'is-bad' : ''}"><span class="label">Overdue</span><strong>${formatPrice(a.overdue)}</strong>
            <span class="sub">${a.overdue > 0 ? "Can't order until paid" : a.previous_unpaid > 0 ? 'Due by ' + formatDate(a.previous_due_date) : ''}</span></div>
        <div class="total"><span class="label">This month</span><strong>${formatPrice(a.spent_this_month)}</strong>
            <span class="sub">${formatPrice(left)} of ${formatPrice(a.monthly_limit)} left</span></div>
        ${a.pending_payments > 0 ? `<div class="total"><span class="label">Being checked</span><strong>${formatPrice(a.pending_payments)}</strong></div>` : ''}`;

    const owed = Math.max(a.balance, 0);
    const form = document.getElementById('paymentForm');
    form.hidden = owed <= 0;
    if (!keepForm) {
        form.reset();
        document.getElementById('payAmount').value = Math.ceil(owed) || '';
        document.getElementById('paymentError').textContent = '';
        updatePaymentFields();
    }
    document.getElementById('payAmount').max = Math.ceil(owed);

    if (user.role === 'admin') {
        document.getElementById('accountEnabled').checked = !!a.account_enabled;
        document.getElementById('customerLimit').value = a.uses_default_limit ? '' : Math.round(a.monthly_limit);
        document.getElementById('limitError').textContent = '';
    }

    document.getElementById('dialogStatement').innerHTML = entries.length === 0
        ? '<p class="muted">No monthly bill activity yet.</p>'
        : entries.map(e => {
            const when = formatDate(e.at);
            if (e.kind === 'charge') {
                const what = `Order ${formatOrderNumber(e.order_id)}${e.status === 'Pending' ? ' <span class="tag">Not collected yet</span>' : e.order_status === 'No Show' ? ' <span class="tag warn">No show</span>' : ''}`;
                return `<div class="statement-row"><span class="when">${when}</span>
                    <span class="what">${what}<small>${escapeHtml(e.items || '')}${e.method !== 'Account' ? ` · was ${e.method}` : ''}</small></span>
                    <span class="amount">${formatPrice(e.amount)}</span></div>`;
            }
            const tag = e.status === 'Pending' ? ' <span class="tag warn">To check</span>' : e.status === 'Rejected' ? ' <span class="tag bad">Not accepted</span>' : '';
            const detail = [e.transaction_reference && 'ID ' + escapeHtml(e.transaction_reference), e.note && escapeHtml(e.note), e.staff_name && 'by ' + escapeHtml(e.staff_name)].filter(Boolean).join(' · ');
            return `<div class="statement-row ${e.status === 'Rejected' ? 'is-muted' : ''}"><span class="when">${when}</span>
                <span class="what">${e.method === 'Waiver' ? 'Waived' : e.method}${tag}<small>${detail}</small></span>
                <span class="amount credit">&minus; ${formatPrice(e.amount)}</span></div>`;
        }).join('');
}

function updatePaymentFields() {
    const method = document.getElementById('payMethod').value;
    document.getElementById('payReferenceRow').hidden = !isWalletPayment(method);
    document.getElementById('payReference').required = isWalletPayment(method);
    document.getElementById('payNote').required = method === 'Waiver';
    document.getElementById('payNoteHint').textContent = method === 'Waiver' ? '(reason, required)' : '(optional)';
    document.getElementById('paymentBtn').innerHTML = method === 'Waiver'
        ? '<i class="fas fa-eraser"></i> Waive amount' : '<i class="fas fa-check"></i> Record payment';
}

async function recordPayment(event) {
    event.preventDefault();
    const method = document.getElementById('payMethod').value;
    const amount = Number(document.getElementById('payAmount').value);
    if (method === 'Waiver' && !confirm(`Write off ${formatPrice(amount)}? This can't be undone.`)) return;
    const button = document.getElementById('paymentBtn');
    button.disabled = true;
    try {
        const data = await api(`/staff/accounts/${openUserId}/payments`, {
            method: 'POST',
            body: {
                amount, method,
                transaction_reference: document.getElementById('payReference').value.trim() || null,
                note: document.getElementById('payNote').value.trim() || null
            }
        });
        renderAccount(data.account, data.entries, false);
        showToast(method === 'Waiver' ? `${formatPrice(amount)} waived` : `${formatPrice(amount)} recorded`, 'success');
    } catch (error) {
        document.getElementById('paymentError').textContent = error.message;
    }
    button.disabled = false;
}

async function saveLimit(event) {
    event.preventDefault();
    const limit = document.getElementById('customerLimit').value;
    try {
        const data = await api('/staff/accounts/' + openUserId, {
            method: 'PUT',
            body: { account_enabled: document.getElementById('accountEnabled').checked, monthly_limit: limit === '' ? null : Number(limit) }
        });
        renderAccount(data.account, data.entries, true);
        showToast('Saved', 'success');
    } catch (error) {
        document.getElementById('limitError').textContent = error.message;
    }
}

async function saveSettings(event) {
    event.preventDefault();
    try {
        const { settings } = await api('/admin/billing-settings', {
            method: 'PUT',
            body: {
                accounts_open: document.getElementById('accountsOpen').checked,
                due_day: Number(document.getElementById('dueDay').value),
                default_monthly_limit: Number(document.getElementById('defaultLimit').value)
            }
        });
        document.getElementById('settingsError').textContent = '';
        document.activeElement?.blur();
        renderSettings(settings);
        showToast('Billing settings saved', 'success');
        refresh();
    } catch (error) {
        document.getElementById('settingsError').textContent = error.message;
    }
}

function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = `board-toast ${type}`;
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    const dialog = document.getElementById('accountDialog');
    (dialog.open ? dialog : document.body).appendChild(toast);     // an open dialog covers the page
    setTimeout(() => toast.remove(), 3500);
}
