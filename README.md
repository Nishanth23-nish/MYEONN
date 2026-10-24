# Myeonn Website

This folder contains the Myeonn React storefront and Node backend. The backend can use MySQL for products, orders, customers, stock, messages, and sessions.

## Run

```powershell
npm install
npm run build
npm start
```

Open:

```text
http://127.0.0.1:5177
```

For local development without MySQL, the server uses the JSON files in `data/`. For a real deployed store, add a `MYSQL_URL` value as shown in `.env.example` before starting the backend.

## MySQL Setup

1. Create a MySQL database with your hosting provider.
2. Run the SQL in `mysql-schema.sql` once, or let the server create the table automatically on its first connection.
3. Create a `.env` file based on `.env.example` and add the connection URL supplied by your MySQL provider.
4. Start the Node backend with `npm start`.
5. When the backend is deployed on a public URL, build the storefront with `VITE_API_URL` set to that URL.

Example Windows PowerShell build for a deployed API:

```powershell
$env:VITE_API_URL = "https://your-myeonn-api.example.com"
npm run build
```

`MYSQL_URL` is a server secret. Never add it to the React app or GitHub. The browser only talks to the Node API, and the Node API talks to MySQL.

## Payment Details

The online payment option collects a simple payment reference (UPI ID, last four card digits, or bank name) and then places the order. It does not process or charge a real payment. Customers must never enter a full card number, CVV, OTP, or UPI PIN.

## What The Backend Does

- Serves the built React app from `dist/`.
- Serves `myeonn-website.html` and the `images/` folder.
- Provides product catalogue search at `GET /api/products`.
- Saves checkout orders, stock changes, and catalogue edits to MySQL.
- Saves contact form messages and new-arrival email signups to MySQL.
- Handles account registration, login, logout, and sessions.
- Handles a separate admin login for confirming orders and marking packs as shipped.
- Provides a health check at `GET /api/health`.

## Admin Login

Open the website and click `Admin` in the top navigation.

Default local admin:

```text
Email: admin@myeonn.com
Password: admin123
```

The admin dashboard shows stock details and every checkout order. Product stock defaults to 50 units, and edited stock is stored by the backend. Stock is shown as opening stock minus ordered quantities. New orders start as `received`, then the admin can mark them as `confirmed`, then `shipped`.

## Local Data Files

- `data/products.json`: edit this to add, remove, or change products.
- `data/orders.json`: new checkout orders appear here.
- `data/messages.json`: contact form submissions appear here.
- `data/subscribers.json`: newsletter signups appear here.
- `data/users.json`: registered customers appear here with hashed passwords.
- `data/sessions.json`: active login sessions appear here.
- `data/admins.json`: admin accounts with hashed passwords.
- `data/admin-sessions.json`: active admin login sessions.

These are used only when `MYSQL_URL` is not set. On its first MySQL connection, the backend imports the existing contents as starter data.

## Frontend

- `src/App.jsx`: React storefront, pages, cart, search, login/register, and contact UI.
- `src/main.jsx`: React entry point.
- `src/styles.css`: storefront styling.
- `index.html`: Vite HTML entry.
- `dist/`: production build served by `npm start`.
