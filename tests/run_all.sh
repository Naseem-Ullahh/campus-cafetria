#!/usr/bin/env bash
# Runs every test layer, from smallest to biggest. Stops at the first failing layer.
#
#   Needs: MySQL (settings in server/.env), Chrome, and the Flask server running
#          (server/.venv/bin/python server/app.py) for the browser regression layer.
#   WARNING: the database layers reinstall the campus_cafeteria database.
#
#   Usage (from the project folder):  bash tests/run_all.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PY=server/.venv/bin/python
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

step "1/7 Unit: Python backend helpers"
server/.venv/bin/pytest server/tests/test_unit.py -q -p no:cacheprovider

step "2/7 Unit: browser data layer (store.js)"
(cd tests && npm run --silent unit)

step "3/7 Unit: database rules (74 SQL checks)"
$PY server/init_db.py --reset >/dev/null
$PY - <<'EOF'
import pymysql, sys
sys.path.insert(0, 'server')
import config
from init_db import statements
connection = pymysql.connect(**config.DB, autocommit=True, init_command=f"SET time_zone = '{config.MYSQL_TIME_ZONE}'")
with connection.cursor() as cursor:
    for statement in statements(open('database/tests/rule_tests.sql').read()):
        cursor.execute(statement)
        while cursor.nextset():
            pass
    cursor.execute('SELECT ok, label, detail FROM test_results ORDER BY id')
    rows = cursor.fetchall()
failed = [r for r in rows if not r[0]]
for ok, label, detail in failed:
    print(f'FAIL  {label}  -> {detail}')
print(f'{len(rows) - len(failed)}/{len(rows)} database rules passed')
sys.exit(1 if failed else 0)
EOF

step "4/7 Component: every page with a faked server"
(cd tests && npm run --silent component)

step "5/7 Integration: API against MySQL"
CAFETERIA_TEST_DB=1 server/.venv/bin/pytest server/tests/test_api.py -q -p no:cacheprovider

step "6/7 Regression: races, time rules, security, bad input, random simulation"
CAFETERIA_TEST_DB=1 server/.venv/bin/pytest server/tests/test_regression.py -q -p no:cacheprovider

step "7/7 Regression: real browsers against the running server"
(cd tests && npm run --silent regression)

$PY server/init_db.py --reset >/dev/null
printf '\n\033[1mAll layers passed.\033[0m The database has been reset to the demo data.\n'
