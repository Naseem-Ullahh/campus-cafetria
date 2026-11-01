# Setup guide

How to get Signals Std. Cafe' running on your own computer, from a fresh download.
It takes about 15 minutes the first time. Every command is run from the project folder
(the one with `client/`, `server/` and `database/` in it).

Commands are shown for **Linux / macOS**. Where Windows is different, the Windows
version is shown underneath (use **Command Prompt** or **PowerShell**).

---

## 1. Install what you need

| Tool | Version | Check with | Get it from |
|---|---|---|---|
| Python | 3.10 or newer | `python3 --version` (Windows: `py --version`) | python.org/downloads — on Windows tick **"Add python.exe to PATH"** |
| MySQL Server | 8.0 or newer | `mysql --version` | dev.mysql.com/downloads/installer (Windows) · `sudo apt install mysql-server` (Ubuntu) |
| Git | any | `git --version` | git-scm.com |

While installing MySQL you'll be asked for a **root password** — write it down, you need it in step 4.
(MySQL Workbench is optional; the project installs the database without it.)

<details>
<summary>Ubuntu: give root a password (it has none by default)</summary>

```bash
sudo mysql
```
```sql
ALTER USER 'root'@'localhost' IDENTIFIED WITH caching_sha2_password BY 'choose-a-password';
EXIT;
```
</details>

<details>
<summary>Already have Docker? Use it instead of installing MySQL</summary>

```bash
docker run -d --name cafeteria-mysql -p 3306:3306 -e MYSQL_ROOT_PASSWORD=choose-a-password mysql:8.0
```
Wait about 20 seconds for it to start. Next time, start it with `docker start cafeteria-mysql`.
</details>

## 2. Download the project

```bash
git clone https://github.com/Naseem-Ullahh/campus-cafetria.git
cd campus-cafetria
```

## 3. Install the Python packages

This makes a private Python environment in `server/.venv` so nothing is installed system-wide.

```bash
python3 -m venv server/.venv
server/.venv/bin/pip install -r server/requirements.txt
```
```bat
:: Windows
py -m venv server\.venv
server\.venv\Scripts\pip install -r server\requirements.txt
```

## 4. Settings: your MySQL password

Copy the example settings file:

```bash
cp server/.env.example server/.env
```
```bat
:: Windows
copy server\.env.example server\.env
```

Open `server/.env` in any text editor and fill in two lines:

```ini
DB_PASSWORD=the MySQL root password from step 1
SECRET_KEY=paste a long random text here
```

To make a `SECRET_KEY`, run this and paste what it prints:

```bash
server/.venv/bin/python -c "import secrets; print(secrets.token_hex(32))"
```
```bat
:: Windows
server\.venv\Scripts\python -c "import secrets; print(secrets.token_hex(32))"
```

Leave the other lines as they are (`DB_NAME` must stay `campus_cafeteria`).
`server/.env` holds your password, so it is **never** uploaded to GitHub (it's in `.gitignore`) —
everyone makes their own.

## 5. Create the database

```bash
server/.venv/bin/python server/init_db.py
```
```bat
:: Windows
server\.venv\Scripts\python server\init_db.py
```

You should see `ran 01_schema.sql` … `ran 05_seed.sql` and `Database campus_cafeteria is ready.`
This creates the tables, rules, menu and demo accounts.

To **start over with fresh demo data** at any time (this deletes all orders):

```bash
server/.venv/bin/python server/init_db.py --reset
```

## 6. Start the app

```bash
server/.venv/bin/python server/app.py
```
```bat
:: Windows
server\.venv\Scripts\python server\app.py
```

Leave that window open and go to **http://127.0.0.1:5000**.
Press **Ctrl+C** in the window to stop the server. Next time, only step 6 is needed
(plus starting MySQL / the Docker container if it isn't running).

> Always open the site through **http://127.0.0.1:5000**. Opening the HTML files directly, or
> with VS Code's Live Server, shows "Cannot reach the server" because the pages need the API.

## 7. Sign in

| Who | Login page | ID | Password |
|---|---|---|---|
| Student | Sign in | `STU001` (or `STU002`) | `student123` |
| Faculty customer | Sign in | `EMP-1001` | `faculty123` |
| Manager (admin) | Staff login | `EMP-0001` | `Admin@123` |
| Cashier | Staff login | `EMP-0002` | `Cashier@123` |
| Chef | Staff login | `EMP-0003` | `Kitchen@123` |

You can also register new customers on the Sign in page. To try the whole flow, use two browser
windows (one normal, one private/incognito): order as a student in one, and accept / cook / hand it
over as staff in the other.

---

## If something goes wrong

| You see | What it means | Fix |
|---|---|---|
| `(1045, "Access denied for user 'root'@...` | Wrong MySQL password in `server/.env` | Fix `DB_PASSWORD` (no quotes, no spaces around `=`) |
| `Can't connect to MySQL server on '127.0.0.1'` | MySQL isn't running | Windows: Services → start **MySQL80** · Ubuntu: `sudo systemctl start mysql` · Docker: `docker start cafeteria-mysql` |
| `campus_cafeteria already exists` | The database was created before | Nothing to do — or `init_db.py --reset` for fresh demo data |
| `No module named 'flask'` (or pymysql) | Ran the system Python instead of the project's | Use `server/.venv/bin/python` (Windows: `server\.venv\Scripts\python`), or redo step 3 |
| `'python3' is not recognized` (Windows) | Windows uses `py` | Use `py` in step 3, then the `server\.venv\Scripts\...` commands |
| `Address already in use` / port 5000 busy | The server is already running in another window | Use that one, or close it first |
| Page says **Cannot reach the server** | The server isn't running, or the site was opened from a file / another port | Start step 6 and use http://127.0.0.1:5000 |
| Everyone is logged out after restarting the server | `SECRET_KEY` is empty | Set it in `server/.env` (step 4) |
| `RSA public key is not available` / `cryptography is required` | A package is missing | Redo step 3 |

---

## Running the tests (optional)

The test suite checks the database rules, the API, every page and whole workflows in a real
browser (377 tests). It needs, on top of the above, **Node.js 18+** and **Google Chrome**
(or Chromium — set `CHROME_PATH` to its location if it isn't `/usr/bin/google-chrome`).

> **Warning:** the tests delete and reinstall the `campus_cafeteria` database. Don't run them on
> data you want to keep.

```bash
(cd tests && npm install)                 # once
server/.venv/bin/python server/app.py     # in one terminal - the browser tests use it
bash tests/run_all.sh                     # in another terminal (Linux / macOS / Git Bash)
```

`run_all.sh` runs every layer in order and stops at the first failure; at the end it puts the
demo data back. You can also run one layer at a time:

| Layer | Command |
|---|---|
| Python unit tests | `server/.venv/bin/pytest server/tests/test_unit.py -q` |
| JavaScript unit tests | `cd tests && npm run unit` |
| Pages with a faked server | `cd tests && npm run component` |
| API + regression (reinstalls the database) | `CAFETERIA_TEST_DB=1 server/.venv/bin/pytest server/tests -q` |
| Real browsers against the running server | `cd tests && npm run regression` |
