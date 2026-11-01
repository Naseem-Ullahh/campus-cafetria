"""Signals Std. Cafe' - Flask backend.

Serves the static website in client/ and a JSON API under /api/.
No templates: the HTML pages call the API with fetch().

Run (from the project folder):
    server/.venv/bin/python server/app.py
then open http://127.0.0.1:5000
"""
from datetime import date, datetime, timedelta
from decimal import Decimal

from flask import Flask, jsonify, request, send_from_directory
from flask.json.provider import DefaultJSONProvider
from werkzeug.exceptions import HTTPException

import admin
import auth
import billing
import config
import orders
import staff
from db import ApiError, close_db


class JSONProvider(DefaultJSONProvider):
    """Decimals as numbers, and times as ISO strings with the +05:00 offset
    so the browser's Date() reads them correctly in any time zone."""
    @staticmethod
    def default(value):
        if isinstance(value, Decimal):
            return float(value)
        if isinstance(value, datetime):
            return value.replace(tzinfo=config.PKT).isoformat()
        if isinstance(value, date):
            return value.isoformat()
        if isinstance(value, timedelta):
            return value.total_seconds()
        return DefaultJSONProvider.default(value)


def create_app():
    app = Flask(__name__, static_folder=str(config.CLIENT_DIR), static_url_path='')
    app.json_provider_class = JSONProvider
    app.json = JSONProvider(app)
    app.config.update(
        SECRET_KEY=config.SECRET_KEY,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Lax',
        PERMANENT_SESSION_LIFETIME=timedelta(days=7),
    )

    for module in (auth, orders, staff, admin, billing):
        app.register_blueprint(module.bp)
    app.teardown_appcontext(close_db)

    @app.before_request
    def json_only_for_changes():
        # Another site can submit a plain HTML form to us, but it cannot send
        # JSON (or a DELETE) without the browser blocking it - so requiring
        # JSON on every change stops cross-site request forgery.
        if (request.path.startswith('/api/') and request.method in ('POST', 'PUT', 'PATCH')
                and not request.is_json):
            return jsonify(error='Send the request as JSON'), 415

    @app.get('/')
    def home():
        return send_from_directory(config.CLIENT_DIR, 'index.html')

    @app.get('/favicon.ico')
    def favicon():
        return '', 204

    @app.errorhandler(ApiError)
    def api_error(error):
        return jsonify(error=error.message), error.status

    @app.errorhandler(HTTPException)
    def http_error(error):
        if request.path.startswith('/api/'):
            return jsonify(error=error.description), error.code
        return error

    @app.errorhandler(Exception)
    def server_error(error):
        app.logger.exception(error)
        return jsonify(error='Something went wrong on the server. Please try again.'), 500

    return app


app = create_app()

if __name__ == '__main__':
    app.run(debug=True)
