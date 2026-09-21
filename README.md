# Myeonn Website

This folder contains the Myeonn storefront with a React frontend and a lightweight local Node backend.

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

## What The Backend Does

- Serves the built React app from `dist/`.
- Serves `myeonn-website.html` and the `images/` folder.
- Provides product catalogue search at `GET /api/products`.
- Saves checkout orders to `data/orders.json`.
- Saves contact form messages to `data/messages.json`.
- Saves new-arrival email signups to `data/subscribers.json`.
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

The admin dashboard shows stock details and every checkout order from `data/orders.json`. Product stock defaults to 50 units, and edited stock is saved in `data/products.json`. Stock is shown as opening stock minus ordered quantities. New orders start as `received`, then the admin can mark them as `confirmed`, then `shipped`.

## Data Files

- `data/products.json`: edit this to add, remove, or change products.
- `data/orders.json`: new checkout orders appear here.
- `data/messages.json`: contact form submissions appear here.
- `data/subscribers.json`: newsletter signups appear here.
- `data/users.json`: registered customers appear here with hashed passwords.
- `data/sessions.json`: active login sessions appear here.
- `data/admins.json`: admin accounts with hashed passwords.
- `data/admin-sessions.json`: active admin login sessions.

This backend is ready for local use. For real online selling, the next step is connecting a payment provider, email delivery, and a hosted database.

## Frontend

- `src/App.jsx`: React storefront, pages, cart, search, login/register, and contact UI.
- `src/main.jsx`: React entry point.
- `src/styles.css`: storefront styling.
- `index.html`: Vite HTML entry.
- `dist/`: production build served by `npm start`.
