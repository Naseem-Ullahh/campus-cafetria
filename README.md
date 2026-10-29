# Signals Std. Cafe' — Campus Cafeteria Ordering System

Students, faculty and staff pre-order from the campus cafeteria and pick their food up when it's ready.
The manager accepts orders, the kitchen cooks them, and the counter takes payment and hands them over.

```
client/     the website (HTML, CSS, JavaScript) - no build step
server/     Flask backend: serves client/ and a JSON API under /api/
database/   MySQL 8 schema, triggers, procedures, views, seed data and tests
```

## Run it

You need **Python 3.10+** and **MySQL 8**.

```bash
# 1. Python packages (once)
python3 -m venv server/.venv
server/.venv/bin/pip install -r server/requirements.txt
#    Windows: server\.venv\Scripts\pip install -r server\requirements.txt

# 2. Settings: copy the example and put in your MySQL password
cp server/.env.example server/.env

# 3. Create the database (or run database/01-05 in MySQL Workbench)
server/.venv/bin/python server/init_db.py

# 4. Start the server
server/.venv/bin/python server/app.py
```

Open **http://127.0.0.1:5000**. Always use this address: the pages need the API, so opening the HTML files directly won't work.

## Accounts

| Who | Login page | ID | Password | Lands on |
|---|---|---|---|---|
| Student | Sign in | `STU001` | `student123` | Menu |
| Manager (admin) | Staff login | `EMP-0001` | `Admin@123` | Dashboard |
| Cashier | Staff login | `EMP-0002` | `Cashier@123` | Incoming orders |
| Chef | Staff login | `EMP-0003` | `Kitchen@123` | Kitchen |

Anyone can register as a customer. Staff accounts are only created in the database.

## How an order flows

```
Student             Manager / cashier       Chef                  Cashier
places order  -->   Incoming: accept   -->  Kitchen: start  -->   Counter: take payment
(Received)          or reject + reason      then mark ready       and hand over
                    (Accepted)              (Preparing, Ready)    (Completed)
```

* All three staff screens refresh every 5 seconds, and the student's tracking page every 10 seconds.
* Orders not accepted within 10 minutes are rejected automatically. Ready orders not collected 30 minutes after pickup become *No Show*.
* Every step is recorded with who did it. You can see this in **All orders**, then open an order.

The rules (timing, payments, stock, roles) are listed in [database/README.md](database/README.md).

## API

| Method & path | Who | What |
|---|---|---|
| `POST /api/auth/register`, `/login`, `/logout` · `GET/PATCH /api/auth/me` · `POST /api/auth/password` | anyone / signed in | accounts |
| `GET /api/menu`, `/api/categories` | anyone | menu |
| `POST /api/orders` · `GET /api/orders/mine`, `/api/orders/<id>` · `POST /api/orders/<id>/cancel` | customer | ordering and tracking |
| `GET /api/staff/incoming`, `/kitchen`, `/counter`, `/orders` | staff | the boards and order history |
| `POST /api/staff/orders/<id>/accept`, `/reject`, `/start`, `/ready`, `/confirm-payment`, `/complete` | by role | moving an order along |
| `GET/POST /api/admin/menu`, `PUT/DELETE /api/admin/menu/<id>` · `GET /api/admin/dashboard`, `/reports` | manager | management |

Prices and totals always come from the database. The browser only sends item IDs and quantities.

## Tests

```bash
# Database rules (74 checks) - on a fresh install
mysql -u root -p campus_cafeteria < database/tests/rule_tests.sql

# API (16 tests) - WARNING: drops and reinstalls campus_cafeteria
CAFETERIA_TEST_DB=1 server/.venv/bin/pytest server/tests -q
```
