"""MySQL access: one connection per request, and database errors turned
into messages the website can show.

The stored procedures and triggers raise readable errors with SIGNAL
(e.g. "Only 8 Orange Juice left in stock"); those become HTTP 400s with
that exact message.
"""
import re

import pymysql
from flask import g

import config

ER_DUP_ENTRY = 1062
ER_CHECK_CONSTRAINT = 3819
ER_ROW_IS_REFERENCED = 1451
ER_SIGNAL = 1644            # raised by SIGNAL SQLSTATE '45000' in our SQL

DUPLICATE_MESSAGES = {
    'uq_payment_reference': 'This transaction ID has already been used for another order',
    'university_id': 'An account with this university ID already exists',
    'email': 'An account with this email already exists',
    'item_name': 'A menu item with this name already exists',
    'category_name': 'This category already exists',
}


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def get_db():
    if 'db' not in g:
        g.db = pymysql.connect(
            **config.DB,
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=True,
            charset='utf8mb4',
            init_command=f"SET time_zone = '{config.MYSQL_TIME_ZONE}'",
        )
    return g.db


def close_db(_error=None):
    db = g.pop('db', None)
    if db is not None:
        db.close()


def _translate(error):
    code = error.args[0]
    message = error.args[1] if len(error.args) > 1 else str(error)
    if code == ER_SIGNAL:
        return ApiError(message, 400)
    if code == ER_DUP_ENTRY:
        key = re.search(r"for key '(?:\w+\.)?(\w+)'", message)
        return ApiError(DUPLICATE_MESSAGES.get(key.group(1) if key else '', 'This record already exists'), 409)
    if code == ER_CHECK_CONSTRAINT:
        return ApiError('One of the values is not allowed', 400)
    if code == ER_ROW_IS_REFERENCED:
        return ApiError('This record is used elsewhere and cannot be deleted', 409)
    return None


def _run(sql, args):
    cursor = get_db().cursor()
    try:
        cursor.execute(sql, args)
    except pymysql.MySQLError as error:
        cursor.close()
        raise _translate(error) or error
    return cursor


def query(sql, args=None):
    """All rows as a list of dicts."""
    with _run(sql, args) as cursor:
        rows = cursor.fetchall()
        while cursor.nextset():     # CALL returns an extra status result
            pass
    return list(rows)


def query_one(sql, args=None):
    rows = query(sql, args)
    return rows[0] if rows else None


def execute(sql, args=None):
    """Runs an INSERT / UPDATE / DELETE / CALL; returns (lastrowid, rowcount)."""
    with _run(sql, args) as cursor:
        while cursor.nextset():
            pass
        return cursor.lastrowid, cursor.rowcount


def call(procedure, *args):
    placeholders = ', '.join(['%s'] * len(args))
    execute(f'CALL {procedure}({placeholders})', args)
