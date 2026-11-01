# Database — Campus Cafeteria (MySQL 8.0)

## Install

Run the files **in order** (MySQL Workbench: *File → Open SQL Script → Execute*, or the CLI):

```bash
mysql -u root -p < 01_schema.sql
mysql -u root -p < 02_triggers.sql
mysql -u root -p < 03_procedures.sql
mysql -u root -p < 04_views.sql
mysql -u root -p < 05_seed.sql
```

The database is called **`campus_cafeteria`**, a new name, so it never touches the older `cafeteria_system` database.

To check everything works, run `tests/rule_tests.sql` on a **fresh** install. It prints one PASS/FAIL row per rule (74 rules).

## Demo accounts (from `05_seed.sql`)

| Role | University ID | Email | Password |
|---|---|---|---|
| admin | EMP-0001 | admin@university.edu | Admin@123 |
| cashier | EMP-0002 | cashier@university.edu | Cashier@123 |
| kitchen (chef) | EMP-0003 | kitchen@university.edu | Kitchen@123 |
| customer (student) | STU001 | ali.hassan@university.edu | student123 |
| customer (student) | STU002 | fatima.khan@university.edu | student123 |
| customer (faculty) | EMP-1001 | sana.iqbal@university.edu | faculty123 |

## What is where

| File | Contents |
|---|---|
| `01_schema.sql` | 11 tables: Users, Categories, Menu_Items, Orders, Order_Details, Payments, Billing_Settings, Account_Payments, Cart, Reviews, Order_Status_History |
| `02_triggers.sql` | 7 triggers: stock check + deduction, order total, status rules + timestamps, audit history (who + why), stock restore on cancel/reject, unpaid No Show onto the monthly bill, review only by buyers |
| `03_procedures.sql` | PlaceOrder, CancelOrder, AcceptOrder, RejectOrder, StartPreparing, MarkReady, ConfirmPayment, CompletePickup, MarkCollected, SubmitAccountPayment, RecordAccountPayment, ConfirmAccountPayment, RejectAccountPayment, ProcessOverdueOrders (+ helpers CheckStaff, MoveOrderStatus, CheckReferenceUnused) |
| `04_views.sql` | Menu_Catalog, Order_Summary, Order_Receipt_Lines, Incoming_Orders, Kitchen_Queue, Pickup_Counter, Daily_Sales, Popular_Items, Category_Sales, Low_Stock_Items, Account_Balances |
| `05_seed.sql` | 4 categories, 12 menu items, admin, cashier, chef, 3 customers |
| `06_join_queries.sql` | 15 JOIN queries (incl. LEFT JOIN, self-joins, 4-table joins, audit trail) |
| `tests/rule_tests.sql` | 114 automated rule checks |

## Business rules (decided for this project)

- **Identity:** everyone uses their university or service ID. `user_type` (student/GC/army/faculty/staff) is who they are; `role` is what they may do: **customer** orders; **admin** (the manager) and **cashier** accept/reject orders, take payments and hand food over; **kitchen** (chef) starts cooking and marks orders ready. Each procedure checks the role, so hiding a button is never the only protection.
- **One admin only:** enforced by a unique generated column. Students can only be customers (CHECK constraint). Registration never sets `role`.
- **Order lifecycle:** `Received → Accepted → Preparing → Ready → Completed`, plus `Rejected` (from Received, reason required), `Cancelled` (from Received/Accepted) and `No Show` (from Ready). Staff can correct a No Show the customer did collect to `Completed`. Any other change is blocked by a trigger.
- **Who does what:**

  | Step | Procedure | Allowed roles |
  |---|---|---|
  | Accept (promise a ready time, no later than the requested pickup) | `AcceptOrder` | admin, cashier |
  | Reject with a reason | `RejectOrder` | admin, cashier |
  | Start cooking | `StartPreparing` | kitchen, admin |
  | Mark ready | `MarkReady` | kitchen, admin |
  | Take payment / hand over | `ConfirmPayment`, `CompletePickup` | admin, cashier |
  | Correct a No Show that was collected | `MarkCollected` | admin, cashier |
  | Record a bill payment / check an online one | `RecordAccountPayment`, `ConfirmAccountPayment`, `RejectAccountPayment` | admin, cashier |
  | Waive (write off) part of a bill | `RecordAccountPayment` with `Waiver` | admin |
  | Pay own bill online | `SubmitAccountPayment` | the customer |
  | Cancel own order | `CancelOrder` | the customer |

- **Audit trail:** every status change is written to `Order_Status_History` with who did it (`changed_by`, NULL = automatic) and why (`note`). Each change locks the order row first, so two staff pressing Accept at once gives the second one an error instead of a silent double action.
- **Staff screens** read one view each: `Incoming_Orders` (manager), `Kitchen_Queue` (chef, no payment details), `Pickup_Counter` (cashier).
- **Timing:** pickup must be 15 min to 24 h ahead. The cafeteria must accept within 10 min, or the order is auto-rejected. The customer can cancel until 20 min before pickup (at least 5 min after ordering), and only until the kitchen starts cooking.
- **Payments:** Cash, Easypaisa, JazzCash or the monthly bill (`Account`). Wallet payments need a unique transaction reference and stay *Pending* until a cashier verifies them. An order can only be *Completed* once its payment is *Confirmed*, or *Billed* for a monthly-bill order.
- **Cancel / reject:** stock goes back (exactly once). Confirmed payments become *Refunded*, pending ones *Void*.
- **No Show** (not collected 30 min after pickup time): stock is **not** restored, because the food was made. A still-unpaid order is added to the customer's monthly bill (payment *Billed*).
- **Monthly bill:** customers can buy now and pay at the end of the month. What they owe = *Billed* order payments − confirmed `Account_Payments` (cash at the counter, Easypaisa / JazzCash checked by the cashier, or a manager's waiver with a reason), applied to the oldest charges first. A month's bill is due on `due_day` (default the 10th) of the next month; anything still unpaid after that is *overdue* and blocks new orders until paid. Each customer has a monthly limit (default Rs. 15,000) and the bill can be switched off per customer or for everyone (`Billing_Settings`). Payments can never add up to more than is owed. `Account_Balances` gives every figure for both the customer (Amount payable) and the staff (Amount receivable).
- **Receipt:** generated from `Order_Summary` + `Order_Receipt_Lines`; it isn't stored in its own table.
- **Prices:** `Order_Details.unit_price` stores the price at order time, so later menu price changes don't alter old orders.

`ProcessOverdueOrders` should run every few minutes (from the backend, or the MySQL event at the end of `03_procedures.sql`).
