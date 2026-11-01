"""Manager-only pages: menu management, dashboard numbers and reports."""
from datetime import date, timedelta

from flask import Blueprint, jsonify, request

from auth import login_required
from db import ApiError, execute, query, query_one
from helpers import body, number, text
from orders import process_overdue_orders

bp = Blueprint('admin', __name__, url_prefix='/api/admin')

# "Sales" everywhere = completed orders; "revenue" = money confirmed + orders put on
# monthly bills (earned, even if the bill isn't paid yet - see Amount receivable)
COMPLETED = "o.status = 'Completed'"
EARNED = "p.payment_status IN ('Confirmed', 'Billed')"


# ---------- Menu management ----------

@bp.get('/menu')
@login_required('admin')
def list_menu():
    items = query(
        'SELECT m.item_id, m.item_name, m.description, m.price, m.stock_quantity, m.low_stock_threshold, '
        '       m.is_available, m.image_url, m.category_id, c.category_name, '
        '       EXISTS (SELECT 1 FROM Order_Details od WHERE od.item_id = m.item_id) AS has_orders '
        'FROM Menu_Items m JOIN Categories c ON c.category_id = m.category_id '
        'ORDER BY c.category_name, m.item_name')
    return jsonify(items=items)


def _menu_fields():
    data = body()
    category_id = number(data, 'category_id', 'Category', integer=True)
    if not query_one('SELECT 1 AS ok FROM Categories WHERE category_id = %s', (category_id,)):
        raise ApiError('Choose a valid category')
    return (
        category_id,
        text(data, 'item_name', 'Item name', max_length=100),
        text(data, 'description', 'Description', required=False),
        round(number(data, 'price', 'Price'), 2),
        number(data, 'stock_quantity', 'Stock', integer=True),
        number(data, 'low_stock_threshold', 'Low-stock warning level', integer=True) if 'low_stock_threshold' in data else 5,
        bool(data.get('is_available', True)),
        text(data, 'image_url', 'Image URL', required=False, max_length=500),
    )


@bp.post('/menu')
@login_required('admin')
def create_item():
    item_id, _ = execute(
        'INSERT INTO Menu_Items (category_id, item_name, description, price, stock_quantity, '
        '                        low_stock_threshold, is_available, image_url) '
        'VALUES (%s, %s, %s, %s, %s, %s, %s, %s)', _menu_fields())
    return jsonify(item_id=item_id), 201


@bp.put('/menu/<int:item_id>')
@login_required('admin')
def update_item(item_id):
    fields = _menu_fields()
    if not query_one('SELECT 1 AS ok FROM Menu_Items WHERE item_id = %s', (item_id,)):
        raise ApiError('Menu item not found', 404)
    execute(
        'UPDATE Menu_Items SET category_id = %s, item_name = %s, description = %s, price = %s, '
        '       stock_quantity = %s, low_stock_threshold = %s, is_available = %s, image_url = %s '
        'WHERE item_id = %s', (*fields, item_id))
    return jsonify(ok=True)


@bp.delete('/menu/<int:item_id>')
@login_required('admin')
def delete_item(item_id):
    if query_one('SELECT 1 AS ok FROM Order_Details WHERE item_id = %s LIMIT 1', (item_id,)):
        raise ApiError('This item is part of past orders, so it cannot be deleted. Switch it off instead.', 409)
    _, deleted = execute('DELETE FROM Menu_Items WHERE item_id = %s', (item_id,))
    if not deleted:
        raise ApiError('Menu item not found', 404)
    return jsonify(ok=True)


# ---------- Dashboard ----------

@bp.get('/dashboard')
@login_required('admin')
def dashboard():
    process_overdue_orders()
    today = query_one(
        'SELECT COUNT(*) AS orders, '
        f'       SUM({COMPLETED}) AS completed, '
        f"       COALESCE(SUM(CASE WHEN {EARNED} THEN p.amount END), 0) AS revenue "
        'FROM Orders o LEFT JOIN Payments p ON p.order_id = o.order_id '
        'WHERE DATE(o.order_date) = CURDATE()')
    counts = query_one(
        'SELECT COUNT(*) AS total_orders, '
        "       SUM(status = 'Received') AS waiting_review, "
        "       SUM(status IN ('Accepted', 'Preparing')) AS in_kitchen, "
        "       SUM(status = 'Ready') AS ready "
        'FROM Orders')
    low_stock = query('SELECT item_id, item_name, stock_quantity, is_available FROM Low_Stock_Items')
    recent = query(
        'SELECT s.order_id, s.full_name, s.total_amount, s.status, s.order_date, '
        '       GROUP_CONCAT(l.item_name ORDER BY l.item_name SEPARATOR \', \') AS items '
        'FROM Order_Summary s JOIN Order_Receipt_Lines l ON l.order_id = s.order_id '
        'GROUP BY s.order_id ORDER BY s.order_date DESC LIMIT 6')
    return jsonify(today=today, counts=counts, low_stock=low_stock, recent_orders=recent)


# ---------- Reports ----------

def _date_range():
    try:
        end = date.fromisoformat(request.args.get('to') or date.today().isoformat())
        start = date.fromisoformat(request.args.get('from') or (end - timedelta(days=29)).isoformat())
    except ValueError:
        raise ApiError('Dates must look like 2026-10-30') from None
    if start > end:
        raise ApiError('The start date is after the end date')
    return start, end


@bp.get('/reports')
@login_required('admin')
def reports():
    start, end = _date_range()
    in_range = 'DATE(o.order_date) BETWEEN %s AND %s'
    args = (start, end)

    summary = query_one(
        'SELECT COUNT(*) AS orders, '
        f'       SUM({COMPLETED}) AS completed_orders, '
        "       SUM(o.status IN ('Cancelled', 'Rejected')) AS cancelled_or_rejected, "
        "       SUM(o.status = 'No Show') AS no_shows, "
        f"       COALESCE(SUM(CASE WHEN {EARNED} THEN p.amount END), 0) AS revenue, "
        '       COUNT(DISTINCT o.user_id) AS customers '
        f'FROM Orders o LEFT JOIN Payments p ON p.order_id = o.order_id WHERE {in_range}', args)
    paid = int(summary['completed_orders'] or 0)
    summary['average_order'] = round(float(summary['revenue']) / paid, 2) if paid else 0

    daily = query(
        "SELECT DATE(o.order_date) AS day, "
        f"       COALESCE(SUM(CASE WHEN {EARNED} THEN p.amount END), 0) AS revenue, "
        '       COUNT(*) AS orders '
        f'FROM Orders o LEFT JOIN Payments p ON p.order_id = o.order_id WHERE {in_range} '
        'GROUP BY DATE(o.order_date) ORDER BY day', args)
    categories = query(
        'SELECT c.category_name, SUM(od.quantity * od.unit_price) AS sales, SUM(od.quantity) AS units '
        'FROM Orders o JOIN Order_Details od ON od.order_id = o.order_id '
        'JOIN Menu_Items m ON m.item_id = od.item_id JOIN Categories c ON c.category_id = m.category_id '
        f'WHERE {COMPLETED} AND {in_range} GROUP BY c.category_id ORDER BY sales DESC', args)
    top_items = query(
        'SELECT m.item_name, c.category_name, SUM(od.quantity) AS units, SUM(od.quantity * od.unit_price) AS sales '
        'FROM Orders o JOIN Order_Details od ON od.order_id = o.order_id '
        'JOIN Menu_Items m ON m.item_id = od.item_id JOIN Categories c ON c.category_id = m.category_id '
        f'WHERE {COMPLETED} AND {in_range} GROUP BY m.item_id ORDER BY units DESC, sales DESC LIMIT 10', args)
    payment_methods = query(
        "SELECT p.payment_method, COUNT(*) AS payments, SUM(p.amount) AS amount "
        f"FROM Orders o JOIN Payments p ON p.order_id = o.order_id WHERE {EARNED} AND {in_range} "
        'GROUP BY p.payment_method', args)

    return jsonify(start=start.isoformat(), end=end.isoformat(), summary=summary, daily=daily,
                   categories=categories, top_items=top_items, payment_methods=payment_methods)
