"""Login, registration and the role checks every protected route uses.

The browser only holds a signed session cookie with the user's id. The
user's role is re-read from the database on every request, so switching an
account off or changing its role takes effect immediately.
"""
from functools import wraps

from flask import Blueprint, g, jsonify, session
from werkzeug.security import check_password_hash, generate_password_hash

from db import ApiError, execute, query_one
from helpers import body, email, pakistani_mobile, text

bp = Blueprint('auth', __name__, url_prefix='/api/auth')

STAFF_ROLES = ('admin', 'cashier', 'kitchen')
CUSTOMER_TYPES = ('student', 'gc', 'army', 'faculty', 'staff')
USER_COLUMNS = 'user_id, university_id, full_name, email, phone, user_type, role, created_at'


def load_user():
    user_id = session.get('user_id')
    if user_id is None:
        return None
    user = query_one(f'SELECT {USER_COLUMNS}, is_active FROM Users WHERE user_id = %s', (user_id,))
    if not user or not user.pop('is_active'):
        session.clear()
        return None
    return user


def login_required(*roles):
    """@login_required() = any signed-in user; @login_required('admin', ...) = those roles only."""
    def decorator(view):
        @wraps(view)
        def wrapper(*args, **kwargs):
            g.user = load_user()
            if g.user is None:
                raise ApiError('Please sign in first', 401)
            if roles and g.user['role'] not in roles:
                raise ApiError('You do not have permission to do this', 403)
            return view(*args, **kwargs)
        return wrapper
    return decorator


def start_session(user):
    session.clear()
    session.permanent = True
    session['user_id'] = user['user_id']


@bp.post('/login')
def login():
    data = body()
    login_name = text(data, 'login', 'University ID or email', max_length=120)
    password = data.get('password') or ''

    user = query_one(
        f'SELECT {USER_COLUMNS}, is_active, password_hash FROM Users '
        'WHERE university_id = %s OR email = %s',
        (login_name.upper(), login_name.lower()))
    if not user or not check_password_hash(user.pop('password_hash'), password):
        raise ApiError('Incorrect university ID / email or password', 401)
    if not user.pop('is_active'):
        raise ApiError('This account has been deactivated. Please contact the cafeteria.', 403)

    # Staff sign in on the staff login page, customers on the student one
    wants_staff = bool(data.get('staff'))
    if wants_staff and user['role'] not in STAFF_ROLES:
        raise ApiError('This is a customer account. Please use the student login.', 403)
    if not wants_staff and user['role'] in STAFF_ROLES:
        raise ApiError('This is a staff account. Please use the staff login.', 403)

    start_session(user)
    return jsonify(user=user)


@bp.post('/register')
def register():
    data = body()
    university_id = text(data, 'university_id', 'University ID', max_length=30).upper()
    full_name = text(data, 'full_name', 'Full name', max_length=100)
    address = email(data.get('email'))
    phone = pakistani_mobile(data.get('phone'))
    if not phone:
        raise ApiError('Enter a Pakistani mobile number, e.g. 0300 1234567')
    user_type = data.get('user_type')
    if user_type not in CUSTOMER_TYPES:
        raise ApiError('Choose student, GC, army, faculty or staff')
    password = data.get('password') or ''
    if len(password) < 6:
        raise ApiError('Password must be at least 6 characters')

    # role is never taken from the request: public registration only creates customers
    user_id, _ = execute(
        'INSERT INTO Users (university_id, full_name, email, phone, user_type, password_hash) '
        'VALUES (%s, %s, %s, %s, %s, %s)',
        (university_id, full_name, address, phone, user_type, generate_password_hash(password)))
    user = query_one(f'SELECT {USER_COLUMNS} FROM Users WHERE user_id = %s', (user_id,))
    start_session(user)
    return jsonify(user=user), 201


@bp.post('/logout')
def logout():
    session.clear()
    return jsonify(ok=True)


@bp.get('/me')
@login_required()
def me():
    return jsonify(user=g.user)


@bp.patch('/me')
@login_required()
def update_me():
    data = body()
    full_name = text(data, 'full_name', 'Full name', max_length=100)
    address = email(data.get('email'))
    phone = pakistani_mobile(data.get('phone'))
    if not phone:
        raise ApiError('Enter a Pakistani mobile number, e.g. 0300 1234567')
    execute('UPDATE Users SET full_name = %s, email = %s, phone = %s WHERE user_id = %s',
            (full_name, address, phone, g.user['user_id']))
    return jsonify(user=load_user())


@bp.post('/password')
@login_required()
def change_password():
    data = body()
    current = query_one('SELECT password_hash FROM Users WHERE user_id = %s', (g.user['user_id'],))
    if not check_password_hash(current['password_hash'], data.get('current_password') or ''):
        raise ApiError('Your current password is incorrect')
    new_password = data.get('new_password') or ''
    if len(new_password) < 6:
        raise ApiError('New password must be at least 6 characters')
    execute('UPDATE Users SET password_hash = %s WHERE user_id = %s',
            (generate_password_hash(new_password), g.user['user_id']))
    return jsonify(ok=True)
