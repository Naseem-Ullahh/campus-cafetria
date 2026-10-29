"""Small input helpers shared by the route modules."""
import re
from datetime import datetime

from flask import request

import config
from db import ApiError

EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


def body():
    """The JSON request body (mutating requests are required to be JSON)."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError('Expected a JSON object')
    return data


def text(data, field, label, required=True, max_length=255):
    value = data.get(field)
    value = value.strip() if isinstance(value, str) else ''
    if required and not value:
        raise ApiError(f'{label} is required')
    if len(value) > max_length:
        raise ApiError(f'{label} is too long (max {max_length} characters)')
    return value or None


def number(data, field, label, minimum=0, integer=False):
    value = data.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ApiError(f'{label} must be a number')
    try:
        value = int(value) if integer else float(value)
    except ValueError:
        raise ApiError(f'{label} must be a number') from None
    if value < minimum:
        raise ApiError(f'{label} cannot be less than {minimum}')
    return value


def pakistani_mobile(value):
    """03XXXXXXXXX, +92 3XX XXXXXXX or 923XXXXXXXXX -> 03XXXXXXXXX, else None.
    Same rule as normalizePakistaniMobile() in client/js/store.js."""
    digits = re.sub(r'[\s-]', '', value or '')
    match = re.fullmatch(r'(?:\+?92|0)(3\d{9})', digits)
    return '0' + match.group(1) if match else None


def email(value):
    value = (value or '').strip().lower()
    if not EMAIL_RE.match(value):
        raise ApiError('Enter a valid email address')
    return value


def pk_datetime(value, label):
    """ISO date-time from the browser -> naive Pakistan time for MySQL.
    Browsers send UTC ('...Z'); a value without an offset is taken as PKT."""
    if not isinstance(value, str) or not value:
        raise ApiError(f'{label} is required')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ApiError(f'{label} is not a valid date and time') from None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(config.PKT).replace(tzinfo=None)
    return parsed.replace(microsecond=0)
