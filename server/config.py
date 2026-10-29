"""Settings, read from environment variables (or server/.env)."""
import os
import secrets
from datetime import timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

SERVER_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SERVER_DIR.parent
CLIENT_DIR = PROJECT_DIR / 'client'
DATABASE_DIR = PROJECT_DIR / 'database'

load_dotenv(SERVER_DIR / '.env')

# Pakistan Standard Time has no daylight saving, so a fixed offset is exact.
# MySQL's NOW() and every time sent to / from the browser use this zone.
PKT = timezone(timedelta(hours=5))
MYSQL_TIME_ZONE = '+05:00'

DB = {
    'host': os.getenv('DB_HOST', '127.0.0.1'),
    'port': int(os.getenv('DB_PORT', '3306')),
    'user': os.getenv('DB_USER', 'root'),
    'password': os.getenv('DB_PASSWORD', ''),
    'database': os.getenv('DB_NAME', 'campus_cafeteria'),
}

SECRET_KEY = os.getenv('SECRET_KEY')
if not SECRET_KEY:
    # Fine for development: everyone is logged out when the server restarts.
    SECRET_KEY = secrets.token_hex(32)
    print(' * SECRET_KEY not set - using a temporary one (logins reset on restart)')
