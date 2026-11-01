"""Monthly bill: customers buy now and pay at the end of the month.

    Customer   /api/account                 Amount Payable: balance, due dates, statement
               /api/account/payments        pay (part of) the bill online
    Staff      /api/staff/accounts          Amount Receivable: who owes what
               /api/staff/accounts/<id>     one customer's statement, record a payment
               /api/staff/account-payments  check online payments
    Manager    /api/admin/billing-settings  due day, default limit, switch the bill on/off
               PUT /api/staff/accounts/<id> per-customer limit / allow the bill

The money rules (limits, overpaying, who may waive) live in the stored
procedures; the routes only check input and roles.
"""
from flask import Blueprint, g, jsonify, request

from auth import login_required
from db import ApiError, call, execute, query, query_one
from helpers import body, number, text
from orders import process_overdue_orders

bp = Blueprint('billing', __name__, url_prefix='/api')

MANAGERS = ('admin', 'cashier')
MAX_AMOUNT = 1_000_000
SHOW_FILTERS = {
    'owing': 'balance > 0',
    'overdue': 'overdue > 0',
    'verify': 'pending_payment_count > 0',
    'all': '1 = 1',
}


def settings():
    return query_one('SELECT accounts_open, due_day, default_monthly_limit, updated_at FROM Billing_Settings')


def account_detail(user_id):
    account = query_one('SELECT * FROM Account_Balances WHERE user_id = %s', (user_id,))
    if not account:
        raise ApiError('Customer not found', 404)
    entries = query(
        "SELECT 'charge' AS kind, o.order_id, NULL AS account_payment_id, o.order_date AS at, p.amount, "
        '       p.payment_method AS method, p.payment_status AS status, o.status AS order_status, '
        '       NULL AS transaction_reference, NULL AS note, NULL AS staff_name, '
        "       (SELECT GROUP_CONCAT(CONCAT(l.quantity, ' x ', l.item_name) ORDER BY l.item_name SEPARATOR ', ') "
        '          FROM Order_Receipt_Lines l WHERE l.order_id = o.order_id) AS items '
        'FROM Orders o JOIN Payments p ON p.order_id = o.order_id '
        "WHERE o.user_id = %s AND (p.payment_status = 'Billed' OR (p.payment_method = 'Account' AND p.payment_status = 'Pending')) "
        'UNION ALL '
        "SELECT 'payment', NULL, ap.account_payment_id, ap.created_at, ap.amount, ap.method, ap.status, NULL, "
        '       ap.transaction_reference, ap.note, s.full_name, NULL '
        'FROM Account_Payments ap LEFT JOIN Users s ON s.user_id = COALESCE(ap.verified_by, ap.submitted_by) '
        "  AND s.role <> 'customer' "
        'WHERE ap.user_id = %s '
        'ORDER BY at DESC LIMIT 500', (user_id, user_id))
    return account, entries


def _amount(data):
    amount = round(number(data, 'amount', 'Amount'), 2)
    if amount <= 0:
        raise ApiError('Enter an amount greater than zero')
    if amount > MAX_AMOUNT:
        raise ApiError('That amount is too large')
    return amount


# ---------- Customer: Amount Payable ----------

@bp.get('/account')
@login_required('customer')
def my_account():
    process_overdue_orders()
    account, entries = account_detail(g.user['user_id'])
    return jsonify(account=account, entries=entries, settings=settings())


@bp.post('/account/payments')
@login_required('customer')
def pay_online():
    data = body()
    reference = text(data, 'transaction_reference', 'Transaction ID', max_length=50)
    if len(reference) < 6:
        raise ApiError('Enter the full transaction ID from your payment message')
    execute('CALL SubmitAccountPayment(%s, %s, %s, %s, @new_id)',
            (g.user['user_id'], _amount(data), data.get('method'), reference))
    account, entries = account_detail(g.user['user_id'])
    return jsonify(account=account, entries=entries, settings=settings()), 201


# ---------- Staff: Amount Receivable ----------

@bp.get('/staff/accounts')
@login_required(*MANAGERS)
def receivables():
    """Customers, filtered by ?show=owing (default) | overdue | verify | all and ?q= (name or ID)."""
    process_overdue_orders()
    where = [SHOW_FILTERS.get(request.args.get('show') or 'owing', SHOW_FILTERS['owing'])]
    args = []
    if request.args.get('q'):
        search = f"%{request.args['q'].strip()}%"
        where.append('(full_name LIKE %s OR university_id LIKE %s OR phone LIKE %s)')
        args += [search, search, search]
    accounts = query(
        'SELECT * FROM Account_Balances WHERE ' + ' AND '.join(where) +
        ' ORDER BY overdue DESC, balance DESC, full_name LIMIT 500', args)
    totals = query_one(
        'SELECT COALESCE(SUM(GREATEST(balance, 0)), 0) AS outstanding, COALESCE(SUM(overdue), 0) AS overdue, '
        '       COALESCE(SUM(balance > 0), 0) AS customers_owing, COALESCE(SUM(overdue > 0), 0) AS customers_blocked, '
        '       COALESCE(SUM(pending_payment_count), 0) AS to_verify '
        'FROM Account_Balances')
    totals.update(query_one(
        'SELECT COALESCE(SUM(amount), 0) AS collected_this_month FROM Account_Payments '
        "WHERE status = 'Confirmed' AND method <> 'Waiver' AND verified_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')"))
    pending = query(
        'SELECT ap.account_payment_id, ap.user_id, ap.amount, ap.method, ap.transaction_reference, ap.created_at, '
        '       u.full_name, u.university_id, b.balance '
        'FROM Account_Payments ap JOIN Users u ON u.user_id = ap.user_id '
        'JOIN Account_Balances b ON b.user_id = ap.user_id '
        "WHERE ap.status = 'Pending' ORDER BY ap.created_at")
    return jsonify(accounts=accounts, totals=totals, pending=pending, settings=settings())


@bp.get('/staff/accounts/<int:user_id>')
@login_required(*MANAGERS)
def customer_account(user_id):
    process_overdue_orders()
    account, entries = account_detail(user_id)
    return jsonify(account=account, entries=entries)


@bp.post('/staff/accounts/<int:user_id>/payments')
@login_required(*MANAGERS)
def record_payment(user_id):
    data = body()
    method = data.get('method')
    reference = text(data, 'transaction_reference', 'Transaction ID', required=False, max_length=50)
    note = text(data, 'note', 'Note', required=method == 'Waiver')
    execute('CALL RecordAccountPayment(%s, %s, %s, %s, %s, %s, @new_id)',
            (user_id, g.user['user_id'], _amount(data), method, reference, note))
    account, entries = account_detail(user_id)
    return jsonify(account=account, entries=entries), 201


@bp.put('/staff/accounts/<int:user_id>')
@login_required('admin')
def update_account(user_id):
    data = body()
    limit = data.get('monthly_limit')
    limit = None if limit in (None, '') else round(number(data, 'monthly_limit', 'Monthly limit'), 2)
    if limit is not None and limit > MAX_AMOUNT:
        raise ApiError('That limit is too large')
    _, changed = execute(
        "UPDATE Users SET account_enabled = %s, monthly_limit = %s WHERE user_id = %s AND role = 'customer'",
        (bool(data.get('account_enabled', True)), limit, user_id))
    if not changed and not query_one("SELECT 1 AS ok FROM Users WHERE user_id = %s AND role = 'customer'", (user_id,)):
        raise ApiError('Customer not found', 404)
    account, entries = account_detail(user_id)
    return jsonify(account=account, entries=entries)


@bp.post('/staff/account-payments/<int:payment_id>/confirm')
@login_required(*MANAGERS)
def confirm_online_payment(payment_id):
    call('ConfirmAccountPayment', payment_id, g.user['user_id'])
    return jsonify(ok=True)


@bp.post('/staff/account-payments/<int:payment_id>/reject')
@login_required(*MANAGERS)
def reject_online_payment(payment_id):
    call('RejectAccountPayment', payment_id, g.user['user_id'], text(body(), 'reason', 'A reason'))
    return jsonify(ok=True)


# ---------- Manager: billing settings ----------

@bp.get('/admin/billing-settings')
@login_required('admin')
def get_settings():
    return jsonify(settings=settings())


@bp.put('/admin/billing-settings')
@login_required('admin')
def update_settings():
    data = body()
    due_day = number(data, 'due_day', 'Due day', minimum=1, integer=True)
    if due_day > 28:
        raise ApiError('The due day must be between 1 and 28 (every month has one)')
    limit = round(number(data, 'default_monthly_limit', 'Default monthly limit'), 2)
    if limit > MAX_AMOUNT:
        raise ApiError('That limit is too large')
    execute('UPDATE Billing_Settings SET accounts_open = %s, due_day = %s, default_monthly_limit = %s, updated_by = %s',
            (bool(data.get('accounts_open', True)), due_day, limit, g.user['user_id']))
    return jsonify(settings=settings())
