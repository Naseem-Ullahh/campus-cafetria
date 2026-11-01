"""Unit tests: small pieces of the backend in isolation (no database needed).

    server/.venv/bin/pytest server/tests/test_unit.py -q
"""
import json
import sys
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pymysql
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config  # noqa: E402
import db  # noqa: E402
import helpers  # noqa: E402
import init_db  # noqa: E402
from app import create_app  # noqa: E402
from db import ApiError  # noqa: E402


@pytest.fixture(scope='module')
def app():
    return create_app()


# ---------- helpers.pakistani_mobile ----------

@pytest.mark.parametrize('raw, expected', [
    ('03001234567', '03001234567'),
    ('0300 1234567', '03001234567'),
    ('0300-123-4567', '03001234567'),
    ('+92 300 1234567', '03001234567'),
    ('+923001234567', '03001234567'),
    ('923001234567', '03001234567'),
    ('  0345 9876543 ', '03459876543'),
])
def test_mobile_accepts_pakistani_formats(raw, expected):
    assert helpers.pakistani_mobile(raw) == expected


@pytest.mark.parametrize('raw', [
    '+91 9876543210',       # India
    '9876543210',           # no country / trunk prefix
    '0300123456',           # one digit short
    '030012345678',         # one digit long
    '04212345678',          # Lahore landline, not mobile
    '+92 42 1234567',
    '0300 12a4567',
    '', None,
])
def test_mobile_rejects_everything_else(raw):
    assert helpers.pakistani_mobile(raw) is None


# ---------- helpers.email ----------

def test_email_is_trimmed_and_lowercased():
    assert helpers.email('  Ali.Hassan@University.EDU ') == 'ali.hassan@university.edu'


@pytest.mark.parametrize('raw', ['ali', 'ali@', '@uni.edu', 'ali@uni', 'a li@uni.edu', '', None])
def test_email_rejects_invalid(raw):
    with pytest.raises(ApiError):
        helpers.email(raw)


# ---------- helpers.text ----------

def test_text_strips_and_returns_value():
    assert helpers.text({'n': '  Chai  '}, 'n', 'Name') == 'Chai'


def test_text_required_and_optional():
    with pytest.raises(ApiError, match='Name is required'):
        helpers.text({'n': '   '}, 'n', 'Name')
    assert helpers.text({}, 'n', 'Name', required=False) is None
    assert helpers.text({'n': 42}, 'n', 'Name', required=False) is None   # non-strings are ignored


def test_text_max_length():
    helpers.text({'n': 'x' * 10}, 'n', 'Name', max_length=10)
    with pytest.raises(ApiError, match='too long'):
        helpers.text({'n': 'x' * 11}, 'n', 'Name', max_length=10)


# ---------- helpers.number ----------

@pytest.mark.parametrize('raw, integer, expected', [(5, True, 5), ('7', True, 7), (12.5, False, 12.5), ('0', False, 0.0)])
def test_number_parses(raw, integer, expected):
    assert helpers.number({'v': raw}, 'v', 'Value', integer=integer) == expected


@pytest.mark.parametrize('raw', [True, None, [], 'abc', '1.5x', {}])
def test_number_rejects_non_numbers(raw):
    with pytest.raises(ApiError, match='must be a number'):
        helpers.number({'v': raw}, 'v', 'Value', integer=True)


def test_number_minimum():
    with pytest.raises(ApiError, match='cannot be less than 0'):
        helpers.number({'v': -1}, 'v', 'Value')


# ---------- helpers.pk_datetime ----------

def test_utc_time_converted_to_pakistan_time():
    assert helpers.pk_datetime('2026-10-30T08:00:00Z', 'T') == datetime(2026, 10, 30, 13, 0)


def test_other_offsets_converted_too():
    assert helpers.pk_datetime('2026-10-30T09:30:00+01:00', 'T') == datetime(2026, 10, 30, 13, 30)


def test_time_without_offset_is_taken_as_pakistan_time():
    assert helpers.pk_datetime('2026-10-30T13:00:00', 'T') == datetime(2026, 10, 30, 13, 0)


def test_milliseconds_dropped():
    assert helpers.pk_datetime('2026-10-30T08:00:00.987Z', 'T').microsecond == 0


@pytest.mark.parametrize('raw', ['', None, 'tomorrow', '30/10/2026 1pm', 12345])
def test_bad_times_rejected(raw):
    with pytest.raises(ApiError):
        helpers.pk_datetime(raw, 'Pickup time')


# ---------- helpers.body ----------

def test_body_requires_json_object(app):
    with app.test_request_context(json=[1, 2]):
        with pytest.raises(ApiError, match='JSON object'):
            helpers.body()
    with app.test_request_context(json={'a': 1}):
        assert helpers.body() == {'a': 1}


# ---------- db._translate: MySQL errors -> messages for the website ----------

def test_signal_message_passed_through():
    error = db._translate(pymysql.err.OperationalError(1644, 'Only 8 Orange Juice left in stock'))
    assert (error.message, error.status) == ('Only 8 Orange Juice left in stock', 400)


@pytest.mark.parametrize('key, expected', [
    ("'Payments.uq_payment_reference'", 'transaction ID has already been used'),
    ("'Users.university_id'", 'university ID already exists'),
    ("'Users.email'", 'email already exists'),
    ("'Menu_Items.item_name'", 'menu item with this name'),
    ("'something_else'", 'already exists'),
])
def test_duplicates_get_friendly_messages(key, expected):
    error = db._translate(pymysql.err.IntegrityError(1062, f"Duplicate entry 'x' for key {key}"))
    assert error.status == 409 and expected in error.message


def test_check_constraint_and_foreign_key_errors():
    assert db._translate(pymysql.err.OperationalError(3819, "Check constraint 'chk' is violated.")).status == 400
    assert db._translate(pymysql.err.IntegrityError(1451, 'Cannot delete')).status == 409


def test_unknown_errors_are_not_hidden():
    assert db._translate(pymysql.err.OperationalError(2003, "Can't connect")) is None


# ---------- init_db.statements: splitting the .sql files ----------

def test_statement_splitter_handles_delimiters_and_comments():
    sql = """-- a comment
CREATE TABLE A (id INT);

INSERT INTO A VALUES
    (1),
    (2);
DELIMITER $$
CREATE PROCEDURE P()
BEGIN
    SELECT 1;
    SELECT 2;
END$$
DELIMITER ;
SELECT 3;
"""
    parts = list(init_db.statements(sql))
    assert len(parts) == 4
    assert parts[1].startswith('INSERT') and '(2)' in parts[1] and not parts[1].endswith(';')
    assert parts[2].startswith('CREATE PROCEDURE') and 'SELECT 2;' in parts[2] and parts[2].endswith('END')
    assert parts[3] == 'SELECT 3'


def test_real_sql_files_split_cleanly():
    counts = {name: len(list(init_db.statements((config.DATABASE_DIR / name).read_text()))) for name in init_db.FILES}
    assert counts['02_triggers.sql'] == 8           # USE + 7 triggers
    assert counts['03_procedures.sql'] == 18        # USE + 17 procedures
    for name, count in counts.items():
        assert count > 0, name


# ---------- JSON output ----------

def test_json_provider_formats_database_values(app):
    out = json.loads(app.json.dumps({
        'price': Decimal('120.50'),
        'when': datetime(2026, 10, 30, 13, 0),
        'day': date(2026, 10, 30),
        'span': timedelta(minutes=2),
    }))
    assert out == {'price': 120.5, 'when': '2026-10-30T13:00:00+05:00', 'day': '2026-10-30', 'span': 120.0}


# ---------- app-level rules that need no database ----------

def test_changes_must_be_json(app):
    client = app.test_client()
    response = client.post('/api/auth/login', data='login=x&password=y', content_type='application/x-www-form-urlencoded')
    assert response.status_code == 415


def test_unknown_api_route_returns_json_404(app):
    response = app.test_client().get('/api/nope')
    assert response.status_code == 404 and 'error' in response.json


def test_static_site_served(app):
    client = app.test_client()
    assert b'Signals Std. Cafe' in client.get('/').data
    assert client.get('/pages/student/login.html').status_code == 200
    assert client.get('/favicon.ico').status_code == 204


def test_session_cookie_is_protected(app):
    assert app.config['SESSION_COOKIE_HTTPONLY'] is True
    assert app.config['SESSION_COOKIE_SAMESITE'] == 'Lax'
