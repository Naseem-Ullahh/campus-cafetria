"""API tests against a real MySQL database.

They DROP and reinstall campus_cafeteria, so they only run when you ask:
    CAFETERIA_TEST_DB=1 server/.venv/bin/pytest server/tests -q
"""
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if os.getenv('CAFETERIA_TEST_DB') != '1':
    pytest.skip('set CAFETERIA_TEST_DB=1 to run (it reinstalls the database)', allow_module_level=True)

import init_db  # noqa: E402
from app import create_app  # noqa: E402


@pytest.fixture(scope='module')
def app():
    init_db.install(reset=True)
    return create_app()


def client_for(app, login=None, password=None, staff=False):
    client = app.test_client()
    if login:
        response = client.post('/api/auth/login', json={'login': login, 'password': password, 'staff': staff})
        assert response.status_code == 200, response.json
    return client


@pytest.fixture(scope='module')
def ali(app):
    return client_for(app, 'STU001', 'student123')


@pytest.fixture(scope='module')
def fatima(app):
    return client_for(app, 'fatima.khan@university.edu', 'student123')


@pytest.fixture(scope='module')
def cashier(app):
    return client_for(app, 'EMP-0002', 'Cashier@123', staff=True)


@pytest.fixture(scope='module')
def chef(app):
    return client_for(app, 'EMP-0003', 'Kitchen@123', staff=True)


@pytest.fixture(scope='module')
def manager(app):
    return client_for(app, 'EMP-0001', 'Admin@123', staff=True)


def in_minutes(minutes):
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat().replace('+00:00', 'Z')


def item_id(client, name):
    return next(i['item_id'] for i in client.get('/api/menu').json['items'] if i['item_name'] == name)


def place(client, items, minutes=60, method='Cash', reference=None):
    return client.post('/api/orders', json={
        'items': items, 'pickup_time': in_minutes(minutes),
        'payment_method': method, 'transaction_reference': reference})


# ---------- auth ----------

def test_menu_is_public(app):
    items = app.test_client().get('/api/menu').json['items']
    assert len(items) == 12 and all('price' in i for i in items)


def test_wrong_password(app):
    response = app.test_client().post('/api/auth/login', json={'login': 'STU001', 'password': 'nope'})
    assert response.status_code == 401


def test_logins_go_to_the_right_page(app):
    client = app.test_client()
    assert client.post('/api/auth/login', json={'login': 'STU001', 'password': 'student123', 'staff': True}).status_code == 403
    assert client.post('/api/auth/login', json={'login': 'EMP-0002', 'password': 'Cashier@123'}).status_code == 403


def test_register_rules(app):
    client = app.test_client()
    new = {'university_id': 'stu777', 'full_name': 'Naseem Ullah', 'email': 'Naseem@University.edu',
           'phone': '+91 9876543210', 'user_type': 'student', 'password': 'secret1', 'role': 'admin'}
    assert 'Pakistani mobile' in client.post('/api/auth/register', json=new).json['error']
    new['phone'] = '+92 300 1112233'
    response = client.post('/api/auth/register', json=new)
    assert response.status_code == 201
    user = response.json['user']
    assert user['role'] == 'customer', 'role in the request must be ignored'
    assert (user['university_id'], user['email'], user['phone']) == ('STU777', 'naseem@university.edu', '03001112233')
    assert client.get('/api/auth/me').json['user']['full_name'] == 'Naseem Ullah'
    duplicate = app.test_client().post('/api/auth/register', json=new)
    assert duplicate.status_code == 409 and 'university ID' in duplicate.json['error']


def test_protected_routes_need_login(app):
    client = app.test_client()
    assert client.get('/api/auth/me').status_code == 401
    assert client.get('/api/staff/incoming').status_code == 401


def test_changes_must_be_json(ali):
    response = ali.post('/api/orders', data='items=1', content_type='application/x-www-form-urlencoded')
    assert response.status_code == 415


# ---------- placing orders ----------

def test_order_is_priced_by_the_server(ali):
    burger = item_id(ali, 'Classic Burger')
    response = ali.post('/api/orders', json={
        'items': [{'item_id': burger, 'quantity': 2, 'price': 1}], 'total': 2,
        'pickup_time': in_minutes(45), 'payment_method': 'Cash'})
    assert response.status_code == 201, response.json
    order = response.json['order']
    assert order['total_amount'] == 240 and order['status'] == 'Received'
    assert order['requested_pickup_time'].endswith('+05:00')


def test_order_errors_come_from_the_database(ali):
    juice = item_id(ali, 'Orange Juice')
    assert 'Only 8 Orange Juice left' in place(ali, [{'item_id': juice, 'quantity': 9}]).json['error']
    assert 'at least 15 minutes' in place(ali, [{'item_id': juice, 'quantity': 1}], minutes=5).json['error']
    assert 'Cash, Easypaisa or JazzCash' in place(ali, [{'item_id': juice, 'quantity': 1}], method='Card').json['error']
    assert place(ali, []).json['error'] == 'Your cart is empty'


def test_wallet_reference_used_once(ali, fatima):
    coffee = item_id(ali, 'Coffee')
    assert place(ali, [{'item_id': coffee, 'quantity': 1}], method='JazzCash', reference='JC123456').status_code == 201
    second = place(fatima, [{'item_id': coffee, 'quantity': 1}], method='Easypaisa', reference='JC123456')
    assert second.status_code == 409 and 'already been used' in second.json['error']


def test_customers_cannot_see_each_other(ali, fatima):
    order_id = ali.get('/api/orders/mine').json['orders'][0]['order_id']
    assert fatima.get(f'/api/orders/{order_id}').status_code == 404
    assert ali.get(f'/api/orders/{order_id}').status_code == 200


def test_customers_cannot_use_staff_routes(ali):
    order_id = ali.get('/api/orders/mine').json['orders'][0]['order_id']
    assert ali.get('/api/staff/incoming').status_code == 403
    assert ali.post(f'/api/staff/orders/{order_id}/accept', json={}).status_code == 403
    assert ali.get('/api/admin/reports').status_code == 403


# ---------- the full workflow ----------

def test_manager_accepts_chef_cooks_cashier_hands_over(fatima, cashier, chef):
    pizza = item_id(fatima, 'Margherita Pizza')
    order_id = place(fatima, [{'item_id': pizza, 'quantity': 1}], minutes=40).json['order']['order_id']

    assert order_id in [o['order_id'] for o in cashier.get('/api/staff/incoming').json['orders']]
    assert chef.post(f'/api/staff/orders/{order_id}/accept', json={}).status_code == 403
    too_late = cashier.post(f'/api/staff/orders/{order_id}/accept', json={'estimated_ready_time': in_minutes(90)})
    assert 'ready by the requested pickup time' in too_late.json['error']
    accepted = cashier.post(f'/api/staff/orders/{order_id}/accept', json={'estimated_ready_time': in_minutes(30)})
    assert accepted.json['order']['status'] == 'Accepted'
    assert 'Only new orders' in cashier.post(f'/api/staff/orders/{order_id}/accept', json={}).json['error']

    assert order_id in [o['order_id'] for o in chef.get('/api/staff/kitchen').json['orders']]
    assert chef.get('/api/staff/counter').status_code == 403
    assert cashier.post(f'/api/staff/orders/{order_id}/start', json={}).status_code == 403
    chef.post(f'/api/staff/orders/{order_id}/start', json={})
    assert chef.post(f'/api/staff/orders/{order_id}/ready', json={}).json['order']['status'] == 'Ready'

    assert order_id in [o['order_id'] for o in cashier.get('/api/staff/counter').json['orders']]
    done = cashier.post(f'/api/staff/orders/{order_id}/complete', json={}).json['order']
    assert done['status'] == 'Completed' and done['payment_status'] == 'Confirmed'
    assert [h['changed_by'] for h in done['history']] == ['Customer', 'Counter Cashier', 'Head Chef', 'Head Chef', 'Counter Cashier']


def test_reject_needs_a_reason_and_is_shown_to_the_customer(ali, cashier):
    coffee = item_id(ali, 'Coffee')
    order_id = place(ali, [{'item_id': coffee, 'quantity': 1}]).json['order']['order_id']
    assert cashier.post(f'/api/staff/orders/{order_id}/reject', json={'reason': ' '}).status_code == 400
    cashier.post(f'/api/staff/orders/{order_id}/reject', json={'reason': 'Coffee machine is broken'})
    order = ali.get(f'/api/orders/{order_id}').json['order']
    assert order['status'] == 'Rejected' and order['close_reason'] == 'Coffee machine is broken'


def test_cancel_only_before_cooking_starts(fatima, manager, chef):
    coffee = item_id(fatima, 'Coffee')
    first = place(fatima, [{'item_id': coffee, 'quantity': 1}]).json['order']['order_id']
    assert fatima.post(f'/api/orders/{first}/cancel', json={}).json['order']['status'] == 'Cancelled'
    second = place(fatima, [{'item_id': coffee, 'quantity': 1}]).json['order']['order_id']
    manager.post(f'/api/staff/orders/{second}/accept', json={})
    chef.post(f'/api/staff/orders/{second}/start', json={})
    assert 'can no longer be cancelled' in fatima.post(f'/api/orders/{second}/cancel', json={}).json['error']


# ---------- manager pages ----------

def test_menu_management(manager, cashier):
    assert cashier.get('/api/admin/menu').status_code == 403
    categories = manager.get('/api/categories').json['categories']
    new = {'category_id': categories[0]['category_id'], 'item_name': 'Chai', 'price': 40, 'stock_quantity': 30}
    item = manager.post('/api/admin/menu', json=new).json['item_id']
    assert manager.post('/api/admin/menu', json=new).status_code == 409
    manager.put(f'/api/admin/menu/{item}', json={**new, 'price': 45, 'is_available': False})
    chai = next(i for i in manager.get('/api/admin/menu').json['items'] if i['item_id'] == item)
    assert chai['price'] == 45 and not chai['is_available']
    assert 'Chai' not in [i['item_name'] for i in manager.get('/api/menu').json['items']]
    assert manager.delete(f'/api/admin/menu/{item}').status_code == 200
    burger = item_id(manager, 'Classic Burger')
    assert manager.delete(f'/api/admin/menu/{burger}').status_code == 409


def test_dashboard_and_reports(manager):
    dashboard = manager.get('/api/admin/dashboard').json
    assert dashboard['today']['orders'] >= 5 and dashboard['recent_orders']
    report = manager.get('/api/admin/reports').json
    pizza_price = next(i['price'] for i in manager.get('/api/menu').json['items'] if i['item_name'] == 'Margherita Pizza')
    assert report['summary']['revenue'] == pizza_price   # only the completed pizza order was paid
    assert report['top_items'][0]['item_name'] == 'Margherita Pizza'
    assert manager.get('/api/admin/reports?from=2026-12-01&to=2026-01-01').status_code == 400
