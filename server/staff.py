"""Staff screens and order actions: /api/staff/...

    Incoming board  (admin, cashier)           accept / reject new orders
    Kitchen display (kitchen, admin, cashier)  start cooking / mark ready
    Pickup counter  (admin, cashier)           take payment / hand over

The roles are checked here for a clear 403, and again inside each stored
procedure, so the rule holds even if someone calls the database directly.
"""
from flask import Blueprint, g, jsonify, request

from auth import login_required
from db import call, query
from helpers import body, pk_datetime, text
from orders import order_detail, process_overdue_orders

bp = Blueprint('staff', __name__, url_prefix='/api/staff')

MANAGERS = ('admin', 'cashier')
KITCHEN = ('kitchen', 'admin')


@bp.get('/incoming')
@login_required(*MANAGERS)
def incoming():
    process_overdue_orders()
    bill_payments = query("SELECT COUNT(*) AS n FROM Account_Payments WHERE status = 'Pending'")[0]['n']
    return jsonify(orders=query('SELECT * FROM Incoming_Orders'), bill_payments_to_verify=bill_payments)


@bp.get('/kitchen')
@login_required('kitchen', 'admin', 'cashier')
def kitchen():
    process_overdue_orders()
    return jsonify(orders=query('SELECT * FROM Kitchen_Queue'))


@bp.get('/counter')
@login_required(*MANAGERS)
def counter():
    process_overdue_orders()
    return jsonify(orders=query('SELECT * FROM Pickup_Counter'))


@bp.get('/orders')
@login_required(*MANAGERS)
def all_orders():
    """Order history with optional ?status=, ?date= or ?from=&to= (YYYY-MM-DD) and ?q= (order no., name or ID)."""
    process_overdue_orders()
    where, args = [], []
    if request.args.get('status'):
        where.append('s.status = %s')
        args.append(request.args['status'])
    if request.args.get('date'):
        where.append('DATE(s.order_date) = %s')
        args.append(request.args['date'])
    if request.args.get('from') and request.args.get('to'):
        where.append('DATE(s.order_date) BETWEEN %s AND %s')
        args += [request.args['from'], request.args['to']]
    if request.args.get('q'):
        search = request.args['q'].strip().lstrip('#')
        where.append('(s.order_id = %s OR s.full_name LIKE %s OR s.university_id LIKE %s)')
        args += [search if search.isdigit() else 0, f'%{search}%', f'%{search}%']
    sql = ('SELECT s.*, GROUP_CONCAT(CONCAT(l.quantity, \' x \', l.item_name) ORDER BY l.item_name SEPARATOR \', \') AS items '
           'FROM Order_Summary s JOIN Order_Receipt_Lines l ON l.order_id = s.order_id '
           + ('WHERE ' + ' AND '.join(where) + ' ' if where else '') +
           'GROUP BY s.order_id ORDER BY s.order_date DESC LIMIT %s')
    args.append(5000 if request.args.get('from') else 300)    # exports get the whole range
    return jsonify(orders=query(sql, args))


def _done(order_id):
    return jsonify(order=order_detail(order_id))


@bp.post('/orders/<int:order_id>/accept')
@login_required(*MANAGERS)
def accept(order_id):
    data = body()
    ready = data.get('estimated_ready_time')
    ready = pk_datetime(ready, 'Estimated ready time') if ready else None
    call('AcceptOrder', order_id, g.user['user_id'], ready)
    return _done(order_id)


@bp.post('/orders/<int:order_id>/reject')
@login_required(*MANAGERS)
def reject(order_id):
    reason = text(body(), 'reason', 'A reason')
    call('RejectOrder', order_id, g.user['user_id'], reason)
    return _done(order_id)


@bp.post('/orders/<int:order_id>/start')
@login_required(*KITCHEN)
def start(order_id):
    call('StartPreparing', order_id, g.user['user_id'])
    return _done(order_id)


@bp.post('/orders/<int:order_id>/ready')
@login_required(*KITCHEN)
def ready(order_id):
    call('MarkReady', order_id, g.user['user_id'])
    return _done(order_id)


@bp.post('/orders/<int:order_id>/confirm-payment')
@login_required(*MANAGERS)
def confirm_payment(order_id):
    call('ConfirmPayment', order_id, g.user['user_id'])
    return _done(order_id)


@bp.post('/orders/<int:order_id>/complete')
@login_required(*MANAGERS)
def complete(order_id):
    call('CompletePickup', order_id, g.user['user_id'])
    return _done(order_id)


@bp.post('/orders/<int:order_id>/collected')
@login_required(*MANAGERS)
def collected(order_id):
    """A No Show the customer did collect - the pickup just wasn't recorded."""
    call('MarkCollected', order_id, g.user['user_id'])
    return _done(order_id)
