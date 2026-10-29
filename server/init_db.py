"""Install the database from database/01-05*.sql (no MySQL Workbench needed).

    server/.venv/bin/python server/init_db.py           # install (fails if it already exists)
    server/.venv/bin/python server/init_db.py --reset   # DROP campus_cafeteria and reinstall

Uses the DB_* settings from server/.env. The SQL files use the mysql
client's DELIMITER command, which isn't SQL, so this script splits the
statements itself.
"""
import sys

import pymysql

import config

FILES = ['01_schema.sql', '02_triggers.sql', '03_procedures.sql', '04_views.sql', '05_seed.sql']


def statements(sql):
    delimiter, current = ';', []
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped.upper().startswith('DELIMITER '):
            delimiter = stripped.split()[1]
            continue
        if not current and (not stripped or stripped.startswith('--')):
            continue
        current.append(line)
        if stripped.endswith(delimiter):
            current[-1] = line.rstrip()[:-len(delimiter)]
            statement = '\n'.join(current).strip()
            current = []
            if statement:
                yield statement


def install(reset=False):
    settings = {key: value for key, value in config.DB.items() if key != 'database'}
    connection = pymysql.connect(**settings, autocommit=True,
                                 init_command=f"SET time_zone = '{config.MYSQL_TIME_ZONE}'")
    with connection.cursor() as cursor:
        if reset:
            cursor.execute('DROP DATABASE IF EXISTS campus_cafeteria')
        cursor.execute("SHOW DATABASES LIKE 'campus_cafeteria'")
        if cursor.fetchone():
            sys.exit('campus_cafeteria already exists. Use --reset to drop and reinstall it.')
        for name in FILES:
            for statement in statements((config.DATABASE_DIR / name).read_text()):
                cursor.execute(statement)
            print(f'  ran {name}')
    connection.close()


if __name__ == '__main__':
    install(reset='--reset' in sys.argv)
    print('Database campus_cafeteria is ready.')
