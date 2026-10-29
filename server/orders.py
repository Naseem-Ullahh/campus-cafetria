"""Menu and customer orders: /api/menu, /api/orders."""
import time

from flask import Blueprint, g, jsonify

from auth import STAFF_ROLES, login_required
from db import ApiError, call, execute, query, query_one
from helpers import body, pk_datetime, text

bp = Blueprint('orders', __name__, url_prefix='/api')

MAX_QUANTITY = 20
_last_overdue_run = 0.0


def process_overdue_orders():
    """Auto-reject orders nobody accepted in 10 minutes and mark uncollected
    ones as No Show. Runs at most every 15 seconds, whenever orders are
    read, so the project needs no separate scheduler."""
    global _last_overdue_run
    if time.monotonic() - _last_overdue_run < 15:
        return
    _last_overdue_run = time.monotonic()
    execute('CALL ProcessOverdueOrders(@rejected, @no_shows)')


def order_detail(order_id):
    order = query_one('SELECT * FROM Order_Summary WHERE order_id = %s', (order_id,))
    if not order:
        raise ApiError('Order not found', 404)
    extra = query_one(
        'SELECT estimated_ready_time, acceptance_deadline, accepted_at, preparing_at, '
        'ready_at, picked_up_at, closed_at FROM Orders WHERE order_id = %s', (order_id,))
    order.update(extra)
    order['lines'] = query(
        'SELECT item_id, item_name, category_name, quantity, unit_price, line_total '
        'FROM Order_Receipt_Lines WHERE order_id = %s ORDER BY item_name', (order_id,))
    order['history'] = query(
        'SELECT h.old_status, h.new_status, h.note, h.changed_at, '
        "       CASE WHEN s.role = 'customer' THEN 'Customer' ELSE COALESCE(s.full_name, 'System') END AS changed_by "
        'FROM Order_Status_History h LEFT JOIN Users s ON s.user_id = h.changed_by '
        'WHERE h.order_id = %s ORDER BY h.changed_at, h.history_id', (order_id,))
    return order


def own_order_or_staff(order_id):
    owner = query_one('SELECT user_id FROM Orders WHERE order_id = %s', (order_id,))
    if not owner or (owner['user_id'] != g.user['user_id'] and g.user['role'] not in STAFF_ROLES):
        raise ApiError('Order not found', 404)     # don't reveal other people's orders exist


@bp.get('/menu')
def menu():
    items = query(
        'SELECT item_id, item_name, description, price, image_url, category_id, category_name, '
        '       stock_quantity, can_order, is_low_stock, avg_rating, review_count '
        'FROM Menu_Catalog WHERE is_available ORDER BY category_name, item_name')
    return jsonify(items=items)


@bp.get('/categories')
def categories():
    return jsonify(categories=query('SELECT category_id, category_name FROM Categories ORDER BY category_name'))


@bp.post('/orders')
@login_required('customer')
def place_order():
    data = body()

    # Merge the cart: only item ids and quantities are trusted, never prices
    lines = {}
    for line in data.get('items') or []:
        try:
            item_id, quantity = int(line['item_id']), int(line['quantity'])
        except (KeyError, TypeError, ValueError):
            raise ApiError('Invalid item in cart') from None
        if quantity < 1:
            raise ApiError('Quantities must be at least 1')
        lines[item_id] = lines.get(item_id, 0) + quantity
    if not lines:
        raise ApiError('Your cart is empty')
    if any(quantity > MAX_QUANTITY for quantity in lines.values()):
        raise ApiError(f'You can order at most {MAX_QUANTITY} of one item')

    pickup = pk_datetime(data.get('pickup_time'), 'Pickup time')
    method = data.get('payment_method')
    reference = text(data, 'transaction_reference', 'Transaction ID', required=False, max_length=50)
    if reference and len(reference) < 6:
        raise ApiError('Enter the full transaction ID from your payment message')
    instructions = text(data, 'special_instructions', 'Special instructions', required=False)

    user_id = g.user['user_id']
    execute('DELETE FROM Cart WHERE user_id = %s', (user_id,))
    try:
        for item_id, quantity in lines.items():
            execute('INSERT INTO Cart (user_id, item_id, quantity) VALUES (%s, %s, %s)',
                    (user_id, item_id, quantity))
        # PlaceOrder checks stock, prices the lines from Menu_Items and
        # empties the cart, all in one transaction
        execute('CALL PlaceOrder(%s, %s, %s, %s, %s, @new_order_id)',
                (user_id, pickup, method, reference, instructions))
    except Exception:
        execute('DELETE FROM Cart WHERE user_id = %s', (user_id,))
        raise
    order_id = query_one('SELECT @new_order_id AS order_id')['order_id']
    return jsonify(order=order_detail(order_id)), 201


@bp.get('/orders/mine')
@login_required()
def my_orders():
    process_overdue_orders()
    orders = query(
        'SELECT s.*, GROUP_CONCAT(CONCAT(l.quantity, \' x \', l.item_name) ORDER BY l.item_name SEPARATOR \', \') AS items '
        'FROM Order_Summary s JOIN Order_Receipt_Lines l ON l.order_id = s.order_id '
        'WHERE s.user_id = %s GROUP BY s.order_id ORDER BY s.order_date DESC', (g.user['user_id'],))
    return jsonify(orders=orders)


@bp.get('/orders/<int:order_id>')
@login_required()
def get_order(order_id):
    own_order_or_staff(order_id)
    process_overdue_orders()
    return jsonify(order=order_detail(order_id))


@bp.post('/orders/<int:order_id>/cancel')
@login_required('customer')
def cancel_order(order_id):
    call('CancelOrder', order_id, g.user['user_id'])
    return jsonify(order=order_detail(order_id))
