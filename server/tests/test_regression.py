"""Regression tests against a real MySQL database: race conditions, time
rules, security, bad input, and a randomized simulation that checks the
books still balance afterwards.

They DROP and reinstall campus_cafeteria, so they only run when you ask:
    CAFETERIA_TEST_DB=1 server/.venv/bin/pytest server/tests/test_regression.py -q
"""
import os
import random
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pymysql
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if os.getenv('CAFETERIA_TEST_DB') != '1':
    pytest.skip('set CAFETERIA_TEST_DB=1 to run (it reinstalls the database)', allow_module_level=True)

import config  # noqa: E402
import init_db  # noqa: E402
import orders as orders_module  # noqa: E402
from app import create_app  # noqa: E402

PKT = config.PKT


# ---------- setup ----------

@pytest.fixture(scope='module')
def app():
    init_db.install(reset=True)
    return create_app()


def connect():
    return pymysql.connect(**config.DB, autocommit=True, cursorclass=pymysql.cursors.DictCursor,
                           init_command=f"SET time_zone = '{config.MYSQL_TIME_ZONE}'")


def sql(statement, args=None):
    with connect() as connection, connection.cursor() as cursor:
        cursor.execute(statement, args)
        return cursor.fetchall()


def login(app, login_id, password, staff=False):
    client = app.test_client()
    response = client.post('/api/auth/login', json={'login': login_id, 'password': password, 'staff': staff})
    assert response.status_code == 200, response.json
    return client


def register(app, university_id, name='Test Customer'):
    client = app.test_client()
    response = client.post('/api/auth/register', json={
        'university_id': university_id, 'full_name': name, 'email': f'{university_id.lower()}@university.edu',
        'phone': '0300 1234567', 'user_type': 'student', 'password': 'secret123'})
    assert response.status_code == 201, response.json
    return client


def pickup(minutes=45):
    """A pickup time at least `minutes` ahead that is inside opening hours (8 AM - 10 PM)."""
    when = datetime.now(PKT).replace(second=0, microsecond=0) + timedelta(minutes=minutes)
    if when.hour < 8:
        when = when.replace(hour=8, minute=0)
    elif when.hour >= 22:
        when = (when + timedelta(days=1)).replace(hour=8, minute=0)
    return when.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def item(name):
    return sql('SELECT item_id, stock_quantity, price FROM Menu_Items WHERE item_name = %s', (name,))[0]


def place(client, items, method='Cash', reference=None, minutes=45, **extra):
    return client.post('/api/orders', json={'items': items, 'pickup_time': pickup(minutes), 'payment_method': method,
                                            'transaction_reference': reference, **extra})


def overdue_now():
    """Make the next request run ProcessOverdueOrders immediately (it's throttled to every 15 s)."""
    orders_module._last_overdue_run = 0


@pytest.fixture(scope='module')
def staff(app):
    return {
        'admin': login(app, 'EMP-0001', 'Admin@123', staff=True),
        'cashier': login(app, 'EMP-0002', 'Cashier@123', staff=True),
        'chef': login(app, 'EMP-0003', 'Kitchen@123', staff=True),
    }


# ==================================================================
# 1. Race conditions (real parallel database connections)
# ==================================================================

def run_parallel(count, work):
    results, barrier = [None] * count, threading.Barrier(count)

    def runner(i):
        barrier.wait()          # everyone starts at the same moment
        try:
            results[i] = ('ok', work(i))
        except pymysql.MySQLError as error:
            results[i] = ('error', error.args[1] if len(error.args) > 1 else str(error))

    threads = [threading.Thread(target=runner, args=(i,)) for i in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results


def test_ten_customers_race_for_the_last_item(app):
    clients = [register(app, f'RACE{i:02d}') for i in range(10)]
    user_ids = [sql('SELECT user_id FROM Users WHERE university_id = %s', (f'RACE{i:02d}',))[0]['user_id'] for i in range(10)]
    shake = item('Chocolate Shake')
    sql('UPDATE Menu_Items SET stock_quantity = 1 WHERE item_id = %s', (shake['item_id'],))
    when = datetime.fromisoformat(pickup().replace('Z', '+00:00')).astimezone(PKT).replace(tzinfo=None)

    def order_last_shake(i):
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute('INSERT INTO Cart (user_id, item_id, quantity) VALUES (%s, %s, 1)', (user_ids[i], shake['item_id']))
            cursor.execute('CALL PlaceOrder(%s, %s, %s, NULL, NULL, @id)', (user_ids[i], when, 'Cash'))
            cursor.execute('SELECT @id AS id')
            return cursor.fetchone()['id']

    results = run_parallel(10, order_last_shake)
    winners = [r for r in results if r[0] == 'ok']
    assert len(winners) == 1, results
    assert all('out of stock' in r[1] or 'left in stock' in r[1] for r in results if r[0] == 'error'), results
    assert item('Chocolate Shake')['stock_quantity'] == 0, 'never negative, never oversold'
    assert len(clients) == 10


def test_ten_staff_press_accept_at_once(app):
    customer = register(app, 'RACEACC')
    order_id = place(customer, [{'item_id': item('Coffee')['item_id'], 'quantity': 1}]).json['order']['order_id']
    staff_ids = [r['user_id'] for r in sql("SELECT user_id FROM Users WHERE role IN ('admin', 'cashier')")]

    def accept(i):
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute('CALL AcceptOrder(%s, %s, NULL)', (order_id, staff_ids[i % len(staff_ids)]))

    results = run_parallel(10, accept)
    assert [r[0] for r in results].count('ok') == 1, results
    assert all('Only new orders can be accepted' in r[1] for r in results if r[0] == 'error'), results
    history = sql("SELECT COUNT(*) AS n FROM Order_Status_History WHERE order_id = %s AND new_status = 'Accepted'", (order_id,))
    assert history[0]['n'] == 1, 'accepted exactly once in the audit trail'


def test_accept_and_reject_at_the_same_moment(app):
    customer = register(app, 'RACEREJ')
    order_id = place(customer, [{'item_id': item('Coffee')['item_id'], 'quantity': 1}]).json['order']['order_id']
    stock_before = item('Coffee')['stock_quantity']
    admin_id, cashier_id = (sql('SELECT user_id FROM Users WHERE university_id = %s', (u,))[0]['user_id'] for u in ('EMP-0001', 'EMP-0002'))

    def act(i):
        with connect() as connection, connection.cursor() as cursor:
            if i % 2:
                cursor.execute('CALL AcceptOrder(%s, %s, NULL)', (order_id, admin_id))
            else:
                cursor.execute('CALL RejectOrder(%s, %s, %s)', (order_id, cashier_id, 'Busy'))

    results = run_parallel(8, act)
    assert [r[0] for r in results].count('ok') == 1, results
    status = sql('SELECT status FROM Orders WHERE order_id = %s', (order_id,))[0]['status']
    stock_after = item('Coffee')['stock_quantity']
    assert (status, stock_after) in (('Accepted', stock_before), ('Rejected', stock_before + 1)), 'stock restored only if rejected'


def test_double_hand_over_takes_payment_once(app, staff):
    customer = register(app, 'RACEHAND')
    order_id = place(customer, [{'item_id': item('Samosa')['item_id'], 'quantity': 1}]).json['order']['order_id']
    staff['cashier'].post(f'/api/staff/orders/{order_id}/accept', json={})
    staff['chef'].post(f'/api/staff/orders/{order_id}/start', json={})
    staff['chef'].post(f'/api/staff/orders/{order_id}/ready', json={})
    cashier_id = sql("SELECT user_id FROM Users WHERE role = 'cashier'")[0]['user_id']

    def hand_over(i):
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute('CALL CompletePickup(%s, %s)', (order_id, cashier_id))

    results = run_parallel(6, hand_over)
    assert [r[0] for r in results].count('ok') == 1, results
    assert sql("SELECT COUNT(*) AS n FROM Order_Status_History WHERE order_id = %s AND new_status = 'Completed'", (order_id,))[0]['n'] == 1


# ==================================================================
# 2. Time-based rules (clock moved by editing the stored times)
# ==================================================================

def test_unaccepted_order_is_auto_rejected_and_stock_returns(app, staff):
    customer = register(app, 'TIMEREJ')
    burger = item('Classic Burger')
    order_id = place(customer, [{'item_id': burger['item_id'], 'quantity': 2}]).json['order']['order_id']
    assert item('Classic Burger')['stock_quantity'] == burger['stock_quantity'] - 2
    sql('UPDATE Orders SET acceptance_deadline = NOW() - INTERVAL 1 SECOND WHERE order_id = %s', (order_id,))
    assert 'acceptance window' in staff['cashier'].post(f'/api/staff/orders/{order_id}/accept', json={}).json['error']
    overdue_now()
    assert order_id not in [o['order_id'] for o in staff['cashier'].get('/api/staff/incoming').json['orders']]
    order = customer.get(f'/api/orders/{order_id}').json['order']
    assert order['status'] == 'Rejected' and order['close_reason'] == 'Not accepted within 10 minutes'
    assert order['history'][-1]['changed_by'] == 'System'
    assert item('Classic Burger')['stock_quantity'] == burger['stock_quantity']


def test_no_show_goes_on_the_bill_and_blocks_only_once_overdue(app, staff):
    customer = register(app, 'TIMENS')
    coffee = item('Coffee')['item_id']
    order_id = place(customer, [{'item_id': coffee, 'quantity': 2}]).json['order']['order_id']
    for path, who in (('accept', 'cashier'), ('start', 'chef'), ('ready', 'chef')):
        assert staff[who].post(f'/api/staff/orders/{order_id}/{path}', json={}).status_code == 200
    stock_ready = item('Coffee')['stock_quantity']
    sql('UPDATE Orders SET requested_pickup_time = NOW() - INTERVAL 31 MINUTE WHERE order_id = %s', (order_id,))
    overdue_now()
    assert order_id not in [o['order_id'] for o in staff['cashier'].get('/api/staff/counter').json['orders']]
    assert customer.get(f'/api/orders/{order_id}').json['order']['status'] == 'No Show'
    assert item('Coffee')['stock_quantity'] == stock_ready, 'food was made: stock not restored'
    bill = customer.get('/api/account').json['account']
    assert bill['balance'] == 100 and bill['overdue'] == 0, 'on this month\'s bill, not due yet'
    assert place(customer, [{'item_id': coffee, 'quantity': 1}]).status_code == 201, 'can still order before the due date'
    sql('UPDATE Orders SET order_date = order_date - INTERVAL 2 MONTH WHERE order_id = %s', (order_id,))
    blocked = place(customer, [{'item_id': coffee, 'quantity': 1}])
    assert blocked.status_code == 400 and 'Rs. 100 of your monthly bill is overdue' in blocked.json['error']
    refused = staff['cashier'].post(f'/api/staff/orders/{order_id}/confirm-payment', json={})
    assert refused.status_code == 400, 'a cash No Show is paid through the bill, not per order'
    user_id = sql("SELECT user_id FROM Users WHERE university_id = 'TIMENS'")[0]['user_id']
    assert staff['cashier'].post(f'/api/staff/accounts/{user_id}/payments', json={'amount': 100, 'method': 'Cash'}).status_code == 201
    assert place(customer, [{'item_id': coffee, 'quantity': 1}]).status_code == 201


def test_ready_order_inside_grace_period_is_not_a_no_show(app, staff):
    customer = register(app, 'TIMEGRACE')
    order_id = place(customer, [{'item_id': item('Samosa')['item_id'], 'quantity': 1}]).json['order']['order_id']
    for path, who in (('accept', 'cashier'), ('start', 'chef'), ('ready', 'chef')):
        staff[who].post(f'/api/staff/orders/{order_id}/{path}', json={})
    sql('UPDATE Orders SET requested_pickup_time = NOW() - INTERVAL 29 MINUTE WHERE order_id = %s', (order_id,))
    overdue_now()
    assert order_id in [o['order_id'] for o in staff['cashier'].get('/api/staff/counter').json['orders']]


def test_cancel_deadline_is_enforced(app):
    customer = register(app, 'TIMECAN')
    order_id = place(customer, [{'item_id': item('Coffee')['item_id'], 'quantity': 1}]).json['order']['order_id']
    sql('UPDATE Orders SET cancellation_deadline = NOW() - INTERVAL 1 SECOND WHERE order_id = %s', (order_id,))
    response = customer.post(f'/api/orders/{order_id}/cancel', json={})
    assert response.status_code == 400 and 'deadline' in response.json['error']


# ==================================================================
# 3. Security
# ==================================================================

@pytest.mark.parametrize('attack', ["' OR '1'='1", "1; DROP TABLE Orders; --", '%', "\\' UNION SELECT password_hash FROM Users --"])
def test_search_is_safe_from_sql_injection(app, staff, attack):
    response = staff['cashier'].get('/api/staff/orders', query_string={'q': attack})
    assert response.status_code == 200
    assert 'password_hash' not in response.get_data(as_text=True)
    assert sql("SHOW TABLES LIKE 'Orders'"), 'table still there'


def test_login_is_safe_from_sql_injection(app):
    response = app.test_client().post('/api/auth/login', json={'login': "' OR 1=1 -- ", 'password': 'x'})
    assert response.status_code == 401


def test_no_response_leaks_password_hashes(app, staff):
    customer = register(app, 'SECLEAK')
    bodies = [
        customer.get('/api/auth/me'), customer.get('/api/orders/mine'),
        staff['admin'].get('/api/admin/dashboard'), staff['admin'].get('/api/staff/orders'),
        staff['admin'].get('/api/admin/reports'), staff['cashier'].get('/api/staff/incoming'),
    ]
    for response in bodies:
        assert 'pbkdf2' not in response.get_data(as_text=True) and 'password' not in response.get_data(as_text=True)


def test_deactivated_account_is_signed_out_immediately(app):
    customer = register(app, 'SECOFF')
    assert customer.get('/api/auth/me').status_code == 200
    sql("UPDATE Users SET is_active = FALSE WHERE university_id = 'SECOFF'")
    assert customer.get('/api/auth/me').status_code == 401
    response = app.test_client().post('/api/auth/login', json={'login': 'SECOFF', 'password': 'secret123'})
    assert response.status_code == 403 and 'deactivated' in response.json['error']


def test_role_change_takes_effect_on_the_next_request(app):
    sql("""INSERT INTO Users (university_id, full_name, email, phone, user_type, role, password_hash)
           SELECT 'EMP-0099', 'Temp Cashier', 'temp@university.edu', '03000000099', 'staff', 'cashier', password_hash
             FROM Users WHERE university_id = 'EMP-0002'""")
    temp = login(app, 'EMP-0099', 'Cashier@123', staff=True)
    assert temp.get('/api/staff/incoming').status_code == 200
    sql("UPDATE Users SET role = 'customer' WHERE university_id = 'EMP-0099'")
    assert temp.get('/api/staff/incoming').status_code == 403


def test_customers_cannot_touch_other_customers_orders(app):
    owner, other = register(app, 'SECOWN'), register(app, 'SECOTH')
    order_id = place(owner, [{'item_id': item('Coffee')['item_id'], 'quantity': 1}]).json['order']['order_id']
    assert other.get(f'/api/orders/{order_id}').status_code == 404
    response = other.post(f'/api/orders/{order_id}/cancel', json={})
    assert response.status_code in (400, 404) and 'not found' in response.json['error']
    assert owner.get(f'/api/orders/{order_id}').json['order']['status'] == 'Received'


def test_kitchen_cannot_reach_money_or_management(app, staff):
    for path in ('/api/staff/incoming', '/api/staff/counter', '/api/staff/orders', '/api/admin/menu', '/api/admin/reports'):
        assert staff['chef'].get(path).status_code == 403, path
    assert staff['chef'].post('/api/staff/orders/1/confirm-payment', json={}).status_code == 403


def test_forged_session_cookie_is_rejected(app):
    client = app.test_client()
    client.set_cookie('session', 'eyJ1c2VyX2lkIjoxfQ.forged.signature')
    assert client.get('/api/auth/me').status_code == 401


# ==================================================================
# 4. Bad and unusual input
# ==================================================================

def test_unknown_menu_item_is_a_clear_error(app):
    customer = register(app, 'BADITEM')
    response = place(customer, [{'item_id': 99999, 'quantity': 1}])
    assert response.status_code == 400, response.json
    assert 'not on the menu' in response.json['error']


@pytest.mark.parametrize('items, message', [
    ([{'item_id': 1, 'quantity': 0}], 'at least 1'),
    ([{'item_id': 1, 'quantity': -3}], 'at least 1'),
    ([{'item_id': 1, 'quantity': 21}], 'at most 20'),
    ([{'item_id': 'abc', 'quantity': 1}], 'Invalid item'),
    ([{'quantity': 1}], 'Invalid item'),
    ('not a list', 'Invalid item'),
])
def test_bad_cart_lines(app, items, message):
    customer = register(app, f'BADQ{abs(hash(str(items))) % 100000}')
    response = place(customer, items)
    assert response.status_code == 400 and message in response.json['error'], response.json


def test_duplicate_lines_are_merged(app):
    customer = register(app, 'MERGE')
    coffee = item('Coffee')['item_id']
    response = place(customer, [{'item_id': coffee, 'quantity': 1}, {'item_id': coffee, 'quantity': 2}])
    assert response.status_code == 201
    lines = response.json['order']['lines']
    assert len(lines) == 1 and lines[0]['quantity'] == 3


def test_pickup_outside_opening_hours_refused(app):
    customer = register(app, 'HOURS')
    late = (datetime.now(PKT) + timedelta(days=1)).replace(hour=3, minute=0, second=0, microsecond=0)
    if late - datetime.now(PKT) > timedelta(hours=24):
        late -= timedelta(days=1)
    if late - datetime.now(PKT) < timedelta(minutes=15):
        late += timedelta(days=1)
    response = customer.post('/api/orders', json={'items': [{'item_id': item('Coffee')['item_id'], 'quantity': 1}],
                                                  'pickup_time': late.isoformat(), 'payment_method': 'Cash'})
    assert response.status_code == 400 and '8 AM' in response.json['error'], response.json


def test_unicode_names_and_instructions_round_trip(app):
    customer = app.test_client()
    response = customer.post('/api/auth/register', json={
        'university_id': 'URDU01', 'full_name': 'محمد علی', 'email': 'urdu01@university.edu',
        'phone': '03001234567', 'user_type': 'student', 'password': 'secret123'})
    assert response.json['user']['full_name'] == 'محمد علی'
    order = place(customer, [{'item_id': item('Coffee')['item_id'], 'quantity': 1}], special_instructions='چینی کم 🙂').json['order']
    assert order['special_instructions'] == 'چینی کم 🙂'


def test_too_long_text_is_refused_cleanly(app):
    customer = register(app, 'LONGTXT')
    response = place(customer, [{'item_id': item('Coffee')['item_id'], 'quantity': 1}], special_instructions='x' * 256)
    assert response.status_code == 400 and 'too long' in response.json['error']


def test_staff_action_on_missing_order(app, staff):
    response = staff['cashier'].post('/api/staff/orders/987654/accept', json={})
    assert response.status_code in (400, 404) and 'not found' in response.json['error']


def test_menu_price_change_does_not_alter_old_orders(app, staff):
    customer = register(app, 'PRICE')
    pancakes = item('Pancakes')
    order_id = place(customer, [{'item_id': pancakes['item_id'], 'quantity': 1}]).json['order']['order_id']
    menu_row = next(i for i in staff['admin'].get('/api/admin/menu').json['items'] if i['item_id'] == pancakes['item_id'])
    staff['admin'].put(f"/api/admin/menu/{pancakes['item_id']}", json={**menu_row, 'price': 999})
    order = customer.get(f'/api/orders/{order_id}').json['order']
    assert order['total_amount'] == float(pancakes['price']) and order['lines'][0]['unit_price'] == float(pancakes['price'])
    staff['admin'].put(f"/api/admin/menu/{pancakes['item_id']}", json={**menu_row})


# ==================================================================
# 5. Randomized simulation: afterwards the books must balance
# ==================================================================

LEGAL = {
    ('Received', 'Accepted'), ('Received', 'Rejected'), ('Received', 'Cancelled'),
    ('Accepted', 'Preparing'), ('Accepted', 'Cancelled'), ('Preparing', 'Ready'),
    ('Ready', 'Completed'), ('Ready', 'No Show'), ('No Show', 'Completed'),
}


def test_random_simulation_keeps_every_invariant(app, staff):
    rng = random.Random(2026)
    sql('UPDATE Menu_Items SET stock_quantity = 500, is_available = TRUE')
    start_stock = {r['item_id']: r['stock_quantity'] for r in sql('SELECT item_id, stock_quantity FROM Menu_Items')}
    menu_ids = list(start_stock)
    customers = [register(app, f'SIM{i:02d}', name=f'Sim Customer {i}') for i in range(8)]
    order_ids = []

    for n in range(80):
        customer = rng.choice(customers)
        lines = [{'item_id': rng.choice(menu_ids), 'quantity': rng.randint(1, 3)} for _ in range(rng.randint(1, 3))]
        method = rng.choice(['Cash', 'Easypaisa', 'JazzCash', 'Account'])
        wallet = method in ('Easypaisa', 'JazzCash')
        response = place(customer, lines, method=method, reference=f'TX{n:06d}' if wallet else None)
        assert response.status_code == 201, response.json      # nothing is overdue and no limit is near
        if rng.random() < 0.2:                                   # someone pays part of their bill
            user_id = customer.get('/api/auth/me').json['user']['user_id']
            owed = customer.get('/api/account').json['account']['balance']
            if owed > 0:
                staff['cashier'].post(f'/api/staff/accounts/{user_id}/payments', json={'amount': rng.randint(1, int(owed)), 'method': 'Cash'})
        order_id = response.json['order']['order_id']
        order_ids.append(order_id)

        # Walk it along a random legal path
        roll = rng.random()
        if roll < 0.15:
            customer.post(f'/api/orders/{order_id}/cancel', json={})
            continue
        if roll < 0.25:
            staff['cashier'].post(f'/api/staff/orders/{order_id}/reject', json={'reason': 'Simulated'})
            continue
        if wallet and rng.random() < 0.5:
            staff['cashier'].post(f'/api/staff/orders/{order_id}/confirm-payment', json={})
        staff[rng.choice(['cashier', 'admin'])].post(f'/api/staff/orders/{order_id}/accept', json={})
        if rng.random() < 0.1:
            customer.post(f'/api/orders/{order_id}/cancel', json={})
            continue
        if rng.random() < 0.1:
            continue                                         # stays Accepted
        staff['chef'].post(f'/api/staff/orders/{order_id}/start', json={})
        if rng.random() < 0.1:
            continue                                         # stays Preparing
        staff['chef'].post(f'/api/staff/orders/{order_id}/ready', json={})
        roll = rng.random()
        if roll < 0.6:
            staff['cashier'].post(f'/api/staff/orders/{order_id}/complete', json={})
        elif roll < 0.75:
            sql('UPDATE Orders SET requested_pickup_time = NOW() - INTERVAL 31 MINUTE WHERE order_id = %s', (order_id,))
            overdue_now()
            staff['cashier'].get('/api/staff/counter')          # triggers the No Show sweep
            customer.post(f'/api/staff/orders/{order_id}/complete', json={})   # customer can't: ignored (403)
            staff['cashier'].post(f'/api/staff/orders/{order_id}/confirm-payment', json={})   # wallet checked late (cash/bill: refused)
            if rng.random() < 0.3:
                staff['cashier'].post(f'/api/staff/orders/{order_id}/collected', json={})     # they did collect it

    assert len(order_ids) >= 70
    rows = sql('SELECT o.order_id, o.user_id, o.status, o.total_amount, o.accepted_at, o.preparing_at, o.ready_at, o.picked_up_at, '
               '       o.closed_at, p.payment_status, p.payment_method, p.amount FROM Orders o JOIN Payments p ON p.order_id = o.order_id '
               'WHERE o.order_id IN %s', (order_ids,))
    lines = sql('SELECT order_id, item_id, quantity, unit_price FROM Order_Details WHERE order_id IN %s', (order_ids,))
    history = sql('SELECT order_id, old_status, new_status FROM Order_Status_History WHERE order_id IN %s ORDER BY history_id', (order_ids,))
    statuses = {r['order_id']: r['status'] for r in rows}

    # (a) every total equals its lines, and the payment amount matches
    for r in rows:
        line_sum = sum(l['quantity'] * l['unit_price'] for l in lines if l['order_id'] == r['order_id'])
        assert r['total_amount'] == line_sum == r['amount'], r

    # (b) stock = start - everything not given back (cancelled / rejected orders return their stock)
    now_stock = {r['item_id']: r['stock_quantity'] for r in sql('SELECT item_id, stock_quantity FROM Menu_Items')}
    for item_id in menu_ids:
        taken = sum(l['quantity'] for l in lines if l['item_id'] == item_id and statuses[l['order_id']] not in ('Cancelled', 'Rejected'))
        assert now_stock[item_id] == start_stock[item_id] - taken, item_id

    # (c) payment state fits the order state
    for r in rows:
        if r['status'] == 'Completed':
            assert r['payment_status'] == ('Billed' if r['payment_method'] == 'Account' else 'Confirmed'), r
        elif r['status'] in ('Cancelled', 'Rejected'):
            assert r['payment_status'] in ('Void', 'Refunded'), r
        elif r['status'] == 'No Show':
            assert r['payment_status'] in ('Billed', 'Confirmed'), r
            assert r['payment_status'] == 'Billed' or r['payment_method'] in ('Easypaisa', 'JazzCash'), r
        else:
            assert r['payment_status'] in ('Pending', 'Confirmed'), r
            assert r['payment_status'] == 'Pending' or r['payment_method'] in ('Easypaisa', 'JazzCash'), r

    # (d) history is a legal chain from Received to the current status
    for order_id in order_ids:
        chain = [h for h in history if h['order_id'] == order_id]
        assert chain[0]['old_status'] is None and chain[0]['new_status'] == 'Received'
        for previous, step in zip(chain, chain[1:]):
            assert step['old_status'] == previous['new_status']
            assert (step['old_status'], step['new_status']) in LEGAL, step
        assert chain[-1]['new_status'] == statuses[order_id]

    # (e) a timestamp for every step reached
    for r in rows:
        reached = {h['new_status'] for h in history if h['order_id'] == r['order_id']}
        assert ('Accepted' in reached) == (r['accepted_at'] is not None), r
        assert ('Preparing' in reached) == (r['preparing_at'] is not None), r
        assert ('Ready' in reached) == (r['ready_at'] is not None), r
        assert (r['status'] == 'Completed') == (r['picked_up_at'] is not None), r
        assert (r['status'] in ('Cancelled', 'Rejected', 'No Show')) == (r['closed_at'] is not None), r

    # (f) the staff screens and reports agree with the raw tables
    everything = sql('SELECT status, COUNT(*) AS n FROM Orders GROUP BY status')
    count = {r['status']: r['n'] for r in everything}
    assert len(staff['admin'].get('/api/staff/kitchen').json['orders']) == count.get('Accepted', 0) + count.get('Preparing', 0)
    assert len(staff['admin'].get('/api/staff/counter').json['orders']) == count.get('Ready', 0)
    earned = sql("SELECT COALESCE(SUM(p.amount), 0) AS s FROM Payments p JOIN Orders o ON o.order_id = p.order_id "
                 "WHERE p.payment_status IN ('Confirmed', 'Billed') AND DATE(o.order_date) = CURDATE()")[0]['s']
    assert staff['admin'].get('/api/admin/dashboard').json['today']['revenue'] == float(earned)
    assert staff['admin'].get('/api/admin/reports').json['summary']['revenue'] == float(earned)

    # (g) every customer's bill = what was billed - what was paid, never negative, and
    #     Amount payable (customer) agrees with Amount receivable (staff)
    receivable = {a['user_id']: a for a in staff['admin'].get('/api/staff/accounts?show=all').json['accounts']}
    for customer in customers:
        bill = customer.get('/api/account').json['account']
        billed = sum(float(r['amount']) for r in rows if r['user_id'] == bill['user_id'] and r['payment_status'] == 'Billed')
        paid = float(sql("SELECT COALESCE(SUM(amount), 0) AS s FROM Account_Payments WHERE user_id = %s AND status = 'Confirmed'",
                         (bill['user_id'],))[0]['s'])
        assert bill['balance'] == round(billed - paid, 2) >= 0, bill
        assert receivable[bill['user_id']]['balance'] == bill['balance']
        assert bill['overdue'] == 0, 'everything is from this month'


# ==================================================================
# 5b. Monthly bill: limits, payments, the due date, corrections
# ==================================================================

def user_id_of(university_id):
    return sql('SELECT user_id FROM Users WHERE university_id = %s', (university_id,))[0]['user_id']


def billed_order(customer, staff, items, method='Account', reference=None):
    """An order walked all the way to Completed (so a monthly-bill order is Billed)."""
    order_id = place(customer, items, method=method, reference=reference).json['order']['order_id']
    for path, who in (('accept', 'cashier'), ('start', 'chef'), ('ready', 'chef'), ('complete', 'cashier')):
        assert staff[who].post(f'/api/staff/orders/{order_id}/{path}', json={}).status_code == 200
    return order_id


def test_two_bill_orders_at_once_cannot_pass_the_limit_together(app):
    # One customer has one cart, so the second order mostly finds it emptied by the first;
    # either way the bill must never go over the limit.
    register(app, 'BILLRACE')
    user_id = user_id_of('BILLRACE')
    sql('UPDATE Users SET monthly_limit = 150 WHERE user_id = %s', (user_id,))
    coffee = item('Coffee')['item_id']                               # Rs. 50: two of them fit, three don't
    when = datetime.fromisoformat(pickup().replace('Z', '+00:00')).astimezone(PKT).replace(tzinfo=None)

    def order_on_bill(i):
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute('INSERT INTO Cart (user_id, item_id, quantity) VALUES (%s, %s, 2) '
                           'ON DUPLICATE KEY UPDATE quantity = 2', (user_id, coffee))
            cursor.execute("CALL PlaceOrder(%s, %s, 'Account', NULL, NULL, @id)", (user_id, when))
            return 'placed'

    results = run_parallel(2, order_on_bill)
    spent = sql('SELECT spent_this_month FROM Account_Balances WHERE user_id = %s', (user_id,))[0]['spent_this_month']
    assert spent <= 150, (spent, results)
    assert [r[0] for r in results].count('ok') >= 1, results
    assert all('limit' in r[1] or 'cart is empty' in r[1] for r in results if r[0] == 'error'), results


def test_simultaneous_payments_never_overpay_a_bill(app, staff):
    customer = register(app, 'BILLPAY')
    billed_order(customer, staff, [{'item_id': item('Coffee')['item_id'], 'quantity': 2}])     # owes Rs. 100
    user_id, cashier = user_id_of('BILLPAY'), user_id_of('EMP-0002')

    def pay_all(i):
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute("CALL RecordAccountPayment(%s, %s, 100, 'Cash', NULL, NULL, @id)", (user_id, cashier))
            return 'paid'

    results = run_parallel(5, pay_all)
    assert [r[0] for r in results].count('ok') == 1, results
    assert sql('SELECT balance FROM Account_Balances WHERE user_id = %s', (user_id,))[0]['balance'] == 0


def test_confirming_one_online_payment_twice_at_once_counts_it_once(app, staff):
    customer = register(app, 'BILLCONF')
    billed_order(customer, staff, [{'item_id': item('Coffee')['item_id'], 'quantity': 4}])     # owes Rs. 200
    assert customer.post('/api/account/payments', json={'amount': 150, 'method': 'Easypaisa', 'transaction_reference': 'EPRACE01'}).status_code == 201
    payment_id = sql("SELECT account_payment_id FROM Account_Payments WHERE transaction_reference = 'EPRACE01'")[0]['account_payment_id']
    staff_ids = [user_id_of('EMP-0001'), user_id_of('EMP-0002')]

    def confirm(i):
        with connect() as connection, connection.cursor() as cursor:
            cursor.execute('CALL ConfirmAccountPayment(%s, %s)', (payment_id, staff_ids[i % 2]))
            return 'confirmed'

    results = run_parallel(6, confirm)
    assert [r[0] for r in results].count('ok') == 1, results
    assert customer.get('/api/account').json['account']['balance'] == 50


def test_due_day_decides_when_last_months_bill_blocks(app, staff):
    customer = register(app, 'BILLDUE')
    order_id = billed_order(customer, staff, [{'item_id': item('Samosa')['item_id'], 'quantity': 2}])   # Rs. 60
    sql('UPDATE Orders SET order_date = order_date - INTERVAL 1 MONTH WHERE order_id = %s', (order_id,))
    today = datetime.now(PKT).day
    try:
        for due_day in (1, 10, 28):
            assert staff['admin'].put('/api/admin/billing-settings', json={'accounts_open': True, 'due_day': due_day,
                                                                          'default_monthly_limit': 15000}).status_code == 200
            bill = customer.get('/api/account').json['account']
            assert (bill['overdue'] == 60) == (today > due_day), (due_day, today, bill)
            assert bill['previous_unpaid'] == 60 and bill['charged_this_month'] == 0
            assert bill['previous_due_date'].endswith(f'-{due_day:02d}')
            response = place(customer, [{'item_id': item('Coffee')['item_id'], 'quantity': 1}])
            assert (response.status_code == 400) == (today > due_day), (due_day, response.json)
            if response.status_code == 201:
                customer.post(f"/api/orders/{response.json['order']['order_id']}/cancel", json={})
    finally:
        staff['admin'].put('/api/admin/billing-settings', json={'accounts_open': True, 'due_day': 10, 'default_monthly_limit': 15000})


def test_billing_roles_and_privacy(app, staff):
    customer = register(app, 'BILLSEC')
    other = register(app, 'BILLOTHER')
    billed_order(other, staff, [{'item_id': item('Coffee')['item_id'], 'quantity': 1}])
    other_id = user_id_of('BILLOTHER')
    # customers only ever see their own bill
    assert customer.get('/api/account').json['account']['university_id'] == 'BILLSEC'
    assert customer.get('/api/staff/accounts').status_code == 403
    assert customer.get(f'/api/staff/accounts/{other_id}').status_code == 403
    assert customer.post(f'/api/staff/accounts/{other_id}/payments', json={'amount': 50, 'method': 'Cash'}).status_code == 403
    assert customer.post('/api/staff/account-payments/1/confirm', json={}).status_code == 403
    # kitchen has nothing to do with money; the cashier can't change rules or waive
    assert staff['chef'].get('/api/staff/accounts').status_code == 403
    assert staff['cashier'].put('/api/admin/billing-settings', json={'accounts_open': False, 'due_day': 1, 'default_monthly_limit': 0}).status_code == 403
    assert staff['cashier'].put(f'/api/staff/accounts/{other_id}', json={'account_enabled': True, 'monthly_limit': 999999}).status_code == 403
    waive = staff['cashier'].post(f'/api/staff/accounts/{other_id}/payments', json={'amount': 50, 'method': 'Waiver', 'note': 'friend'})
    assert waive.status_code == 400 and 'Only the manager' in waive.json['error']
    # staff can't be billed and don't appear in the receivable list
    assert staff['admin'].get(f"/api/staff/accounts/{user_id_of('EMP-0003')}").status_code == 404
    assert all(a['university_id'] != 'EMP-0002' for a in staff['admin'].get('/api/staff/accounts?show=all').json['accounts'])
    assert staff['admin'].get('/api/staff/accounts?show=all&q=%27%20OR%201%3D1%20--').json['accounts'] == [], 'search is not injectable'


def test_bad_bill_payment_input_is_refused(app, staff):
    customer = register(app, 'BILLBAD')
    billed_order(customer, staff, [{'item_id': item('Coffee')['item_id'], 'quantity': 2}], method='Account')
    used = place(customer, [{'item_id': item('Coffee')['item_id'], 'quantity': 1}], method='JazzCash', reference='JCUSED001')
    assert used.status_code == 201
    for body, expected in (
        ({'amount': -5, 'method': 'JazzCash', 'transaction_reference': 'JCX00001'}, 'cannot be less than 0'),
        ({'amount': 0, 'method': 'JazzCash', 'transaction_reference': 'JCX00001'}, 'greater than zero'),
        ({'amount': 'lots', 'method': 'JazzCash', 'transaction_reference': 'JCX00001'}, 'must be a number'),
        ({'amount': 10 ** 9, 'method': 'JazzCash', 'transaction_reference': 'JCX00001'}, 'too large'),
        ({'amount': 50, 'method': 'Cash', 'transaction_reference': 'JCX00001'}, 'Easypaisa or JazzCash'),
        ({'amount': 50, 'method': 'JazzCash', 'transaction_reference': '12'}, 'full transaction ID'),
        ({'amount': 50, 'method': 'JazzCash'}, 'Transaction ID is required'),
        ({'amount': 50, 'method': 'JazzCash', 'transaction_reference': 'JCUSED001'}, 'already been used'),
        ({'amount': 101, 'method': 'JazzCash', 'transaction_reference': 'JCX00001'}, 'most you can pay is Rs. 100'),
    ):
        response = customer.post('/api/account/payments', json=body)
        assert response.status_code == 400 and expected in response.json['error'], (body, response.json)
    assert customer.get('/api/account').json['account']['pending_payments'] == 0, 'nothing half-saved'
    bad = staff['admin'].put('/api/admin/billing-settings', json={'accounts_open': True, 'due_day': 31, 'default_monthly_limit': 100})
    assert bad.status_code == 400 and 'between 1 and 28' in bad.json['error']


def test_limit_and_switches_set_by_the_manager_apply_at_once(app, staff):
    customer = register(app, 'BILLLIM')
    user_id = user_id_of('BILLLIM')
    coffee = [{'item_id': item('Coffee')['item_id'], 'quantity': 1}]
    assert staff['admin'].put(f'/api/staff/accounts/{user_id}', json={'account_enabled': True, 'monthly_limit': 0}).status_code == 200
    assert 'limit' in place(customer, coffee, method='Account').json['error']
    assert place(customer, coffee, method='Cash').status_code == 201, 'cash is never limited'
    staff['admin'].put(f'/api/staff/accounts/{user_id}', json={'account_enabled': False, 'monthly_limit': None})
    assert 'not available on your account' in place(customer, coffee, method='Account').json['error']
    staff['admin'].put(f'/api/staff/accounts/{user_id}', json={'account_enabled': True, 'monthly_limit': None})
    assert customer.get('/api/account').json['account']['monthly_limit'] == 15000, 'empty limit = the default'
    assert place(customer, coffee, method='Account').status_code == 201


def test_no_show_corrections_and_late_wallet_checks(app, staff):
    customer = register(app, 'BILLFIX')
    coffee = item('Coffee')['item_id']

    def no_show(method, reference=None):
        order_id = place(customer, [{'item_id': coffee, 'quantity': 1}], method=method, reference=reference).json['order']['order_id']
        for path, who in (('accept', 'cashier'), ('start', 'chef'), ('ready', 'chef')):
            staff[who].post(f'/api/staff/orders/{order_id}/{path}', json={})
        sql('UPDATE Orders SET requested_pickup_time = NOW() - INTERVAL 31 MINUTE WHERE order_id = %s', (order_id,))
        overdue_now()
        staff['cashier'].get('/api/staff/counter')
        return order_id

    wallet, cash, on_bill = no_show('JazzCash', 'JCLATE001'), no_show('Cash'), no_show('Account')
    assert customer.get('/api/account').json['account']['balance'] == 150, 'all three uncollected orders are billed'
    # the wallet payment is found in the merchant app after all: off the bill
    assert staff['cashier'].post(f'/api/staff/orders/{wallet}/confirm-payment', json={}).status_code == 200
    # the cash order was collected and paid, the cashier just forgot to press the button
    assert customer.post(f'/api/staff/orders/{cash}/collected', json={}).status_code == 403
    assert staff['chef'].post(f'/api/staff/orders/{cash}/collected', json={}).status_code == 403
    fixed = staff['cashier'].post(f'/api/staff/orders/{cash}/collected', json={}).json['order']
    assert fixed['status'] == 'Completed' and fixed['payment_status'] == 'Confirmed' and fixed['close_reason'] is None
    assert fixed['history'][-1]['changed_by'] == 'Counter Cashier'
    # a monthly-bill order that was collected stays on the bill
    assert staff['cashier'].post(f'/api/staff/orders/{on_bill}/collected', json={}).json['order']['payment_status'] == 'Billed'
    assert customer.get('/api/account').json['account']['balance'] == 50
    again = staff['cashier'].post(f'/api/staff/orders/{cash}/collected', json={})
    assert again.status_code == 400 and 'Only No Show' in again.json['error']


def test_receivable_lists_and_reports_agree_with_the_bills(app, staff):
    customer = register(app, 'BILLLIST')
    order_id = billed_order(customer, staff, [{'item_id': item('Pancakes')['item_id'], 'quantity': 1}])    # Rs. 90
    sql('UPDATE Orders SET order_date = order_date - INTERVAL 2 MONTH WHERE order_id = %s', (order_id,))
    customer.post('/api/account/payments', json={'amount': 40, 'method': 'JazzCash', 'transaction_reference': 'JCLIST001'})
    data = staff['cashier'].get('/api/staff/accounts?show=overdue').json
    row = next(a for a in data['accounts'] if a['university_id'] == 'BILLLIST')
    assert row['overdue'] == 90 and row['pending_payments'] == 40
    assert any(a['university_id'] == 'BILLLIST' for a in staff['cashier'].get('/api/staff/accounts?show=verify').json['accounts'])
    assert any(p['transaction_reference'] == 'JCLIST001' for p in data['pending'])
    assert staff['cashier'].get('/api/staff/incoming').json['bill_payments_to_verify'] >= 1
    everyone = staff['admin'].get('/api/staff/accounts?show=all').json['accounts']
    assert data['totals']['outstanding'] == sum(max(a['balance'], 0) for a in everyone)
    assert data['totals']['overdue'] == sum(a['overdue'] for a in everyone)
    payment_id = data['pending'][-1]['account_payment_id']
    rejected = staff['cashier'].post(f'/api/staff/account-payments/{payment_id}/reject', json={'reason': 'Not in the app'})
    assert rejected.status_code == 200
    entry = next(e for e in customer.get('/api/account').json['entries'] if e['kind'] == 'payment')
    assert entry['status'] == 'Rejected' and entry['note'] == 'Not in the app'


# ==================================================================
# 6. Speed with a busy day of data
# ==================================================================

def test_screens_stay_fast_with_many_orders(app, staff):
    customer = register(app, 'LOAD')
    coffee = item('Coffee')['item_id']
    for _ in range(150):
        assert place(customer, [{'item_id': coffee, 'quantity': 1}]).status_code == 201
    timings = {}
    for path, who in (('/api/staff/incoming', 'cashier'), ('/api/staff/orders', 'cashier'), ('/api/admin/dashboard', 'admin'),
                      ('/api/admin/reports', 'admin'), ('/api/orders/mine', None)):
        client = staff[who] if who else customer
        started = time.perf_counter()
        assert client.get(path).status_code == 200
        timings[path] = time.perf_counter() - started
    assert max(timings.values()) < 1.0, timings
